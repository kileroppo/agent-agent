import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { cleanTranscript, composeDelivery, qualityCheck } from './domain.js';
import { classifyFailure } from './recovery.js';
import { createOneShotFailpoint } from './test-failpoint.js';
import { JobPausedError } from './job-pause-controller.js';
import { ContentAcquisitionError } from '../../../integrations/access/content-acquisition-center.js';
import { automaticConfirmationDecision, buildEvidenceRecords, parseTimedTranscript, sha256, timedTranscriptMarkdown } from './transcript-evidence.js';
import { createTranscriptConfirmationFiles } from './transcript-review.js';
import { createVisualEvidencePackage, VisualEvidenceError } from './visual-evidence.js';

const REFINER_PROMPT = `你是中文音视频内容编辑。你只负责写“内容导览”，完整校对文本会由系统另行附在后面。

目标：让读者先在几分钟内掌握长内容讲了什么、每个判断的理由和案例，再按需回到完整校对文本核对细节。

严格要求：
1. 忠实于原文。保留关键判断、案例、数字、类比、论证链和有辨识度的原话；不新增事实、不猜测身份或动机、不替原文下结论。
2. 不是十条要点式摘要。每个主题写成连贯、可读的短段落；必要时用短列表列出互相并列的对象、步骤或案例。
3. 不要复述寒暄、抽奖、刷屏、口头重复和无意义转场；但不要为了“精炼”删掉支撑判断的限定条件。
4. 标题必须来自真实内容，具体到读者能预测该段会讲什么；禁止“其他有效观点”“补充说明”等垃圾桶标题。
5. 重要判断、数字、案例或金句可适度加粗。不要使用表格，不要写“以下是总结”之类套话。

只返回以下 Markdown 结构，不要另写总标题或“完整校对文本”：
## 概述
一到两段，交代内容主题、说话者在讨论什么以及最重要的结论范围。

## 主题详述
### 具体主题标题
连贯阐述该主题的主张、理由、案例和限定条件。根据实际内容写 3–7 个主题。

## 核心观点与洞察
### 具体观点标题
写出重要观点及其依据；根据实际内容写 2–5 条。

如果原文确实没有足够证据，不要硬造“逻辑分析”“框架与心智模型”等章节。`;

export class MediaPipeline {
  constructor({ store, workDir, contentCenter = null, pauseController = null, failpoint = createOneShotFailpoint(config.testFailOnceAt) }) {
    this.store = store;
    this.workDir = workDir;
    this.contentCenter = contentCenter;
    this.pauseController = pauseController;
    this.failpoint = failpoint;
  }

  async run(jobId) {
    const job = this.store.get(jobId);
    if (!job) return;
    const jobDir = path.join(this.workDir, 'jobs', job.id);
    try {
      await this.checkpoint(job.id, '开始处理前');
      await fs.mkdir(jobDir, { recursive: true });
      await this.stage(job.id, 'preparing', 8, '正在检查素材格式与可读性');
      const acquired = await this.acquire(this.store.get(job.id), jobDir);
      await this.checkpoint(job.id, '素材检查完成');
      const resolvedTitle = deliveryTitle(this.store.get(job.id), acquired.contentPackage);
      if (resolvedTitle !== this.store.get(job.id).title) await this.store.update(job.id, { title: resolvedTitle });
      const currentJob = this.store.get(job.id);
      await this.stage(job.id, 'transcribing', 45, acquired.kind === 'subtitle' ? '正在读取可用字幕' : '正在进行本地 ASR 转录');
      // The source has already been copied/normalized into jobDir. Failing here
      // exercises retry without creating any external delivery side effect.
      await this.failpoint('transcribing');
      const transcription = acquired.kind === 'subtitle'
        ? { text:await fs.readFile(acquired.path, 'utf8'), timed:null }
        : await this.transcribe(acquired.path, jobDir);
      const rawTranscript = transcription.text;
      await this.checkpoint(job.id, '转录完成');
      const transcript = cleanTranscript(rawTranscript);
      if (transcript.length < 20) throw new Error('未得到有效文字，请检查素材是否有声音、是否受限或更换转录模型。');
      const rawTranscriptPath = path.join(jobDir, acquired.kind === 'subtitle' ? 'raw-transcript.vtt' : 'raw-transcript.txt');
      await fs.writeFile(rawTranscriptPath, rawTranscript);
      const transcriptPath = path.join(jobDir, 'transcript-clean.txt');
      await fs.writeFile(transcriptPath, transcript);
      const timedSource = transcription.timed || rawTranscript;
      const segments = parseTimedTranscript(timedSource, { kind:transcription.timed ? 'subtitle' : acquired.kind });
      const timedTranscriptPath = path.join(jobDir, 'transcript-timed.md');
      await fs.writeFile(timedTranscriptPath, timedTranscriptMarkdown(currentJob.title, segments));
      const reportedMediaDurationSeconds = Number(acquired.contentPackage?.contentItems?.basic_content?.durationSeconds) || null;
      const audioDurationSeconds = acquired.kind === 'audio' ? await probeDuration(acquired.path) : null;
      const mediaDurationSeconds = qualityGateDuration({
        reportedDurationSeconds:reportedMediaDurationSeconds,
        probedAudioDurationSeconds:audioDurationSeconds
      });
      const evidence = buildEvidenceRecords({
        sourceType:currentJob.sourceType,
        sourceUrl:currentJob.sourceUrl,
        contentPackage:acquired.contentPackage,
        rawTranscript,
        cleanTranscript:transcript,
        segments,
        mediaDurationSeconds,
        audioDurationSeconds
      });
      const sourceEvidencePath = path.join(jobDir, 'source-evidence.json');
      const qualityReportPath = path.join(jobDir, 'transcript-quality-report.json');
      await fs.writeFile(sourceEvidencePath, JSON.stringify(evidence.sourceEvidence, null, 2));
      await fs.writeFile(qualityReportPath, JSON.stringify(evidence.qualityReport, null, 2));
      if (evidence.qualityReport.hardFailures.length) {
        const failure = new Error(`转录完整性检查未通过：${evidence.qualityReport.hardFailures.join(', ')}`);
        failure.code = 'transcript_integrity_failed';
        throw failure;
      }
      const visual = await this.prepareVisualEvidence({
        job:currentJob,
        jobDir,
        acquired,
        segments,
        sourceMetadata:evidence.sourceEvidence.sourceMetadata
      });

      await this.stage(job.id, 'distilling', 70, '正在去噪并按内容组织文稿');
      const refined = await refineText(currentJob.title, transcript);
      await this.checkpoint(job.id, '文稿整理完成');
      const guidePath = path.join(jobDir, '内容导览.md');
      const proofreadPath = path.join(jobDir, '完整校对文本.md');
      const markdown = composeDelivery(currentJob.title, refined.markdown, transcript);
      const markdownPath = path.join(jobDir, '分享式整理稿.md');
      await fs.writeFile(guidePath, refined.markdown);
      await fs.writeFile(proofreadPath, `# ${currentJob.title}\n\n${transcript}\n`);
      await fs.writeFile(markdownPath, markdown);
      const quality = qualityCheck(markdown, { usedRefiner: refined.usedRefiner, refinerFallback: Boolean(refined.refinerFallbackReason) });

      await this.stage(job.id, 'delivering', 88, '正在准备本地交付物');
      await this.checkpoint(job.id, '交付前');
      const lark = currentJob.deliveryMode === 'local_only'
        ? { configured:false, localOnly:true }
        : await deliverToLark(currentJob.title, markdown).catch((error) => ({ error: error.message }));
      const warnings = [...quality.issues];
      if (refined.refinerFallbackReason) warnings.unshift(refined.refinerFallbackReason);
      if (lark.error) warnings.push(`飞书交付未完成：${lark.error}`);
      if (lark.configured === false && !lark.localOnly) warnings.push('未配置飞书 App；已生成本地 Markdown 交付物。');
      if (visual.warning) warnings.unshift(visual.warning);
      const autoConfirmation = automaticConfirmationDecision({ qualityReport:evidence.qualityReport, transcript });
      const reviewRequired = currentJob.reviewPolicy === 'required' || !autoConfirmation.eligible;
      const confirmation = reviewRequired
        ? null
        : await createTranscriptConfirmationFiles({
            directory:jobDir,
            jobId:job.id,
            title:currentJob.title,
            transcript:stripDocumentHeading(await fs.readFile(timedTranscriptPath, 'utf8')),
            machineChecksum:sha256(transcript),
            confirmationMode:'automatic',
            confirmerRef:'xiaod-quality-gate',
            version:1
          });
      if (currentJob.reviewPolicy !== 'required' && !autoConfirmation.eligible) {
        warnings.unshift(`自动确认未通过：${autoConfirmation.reasons.join(', ')}`);
      }
      await this.store.update(job.id, {
        status: reviewRequired ? 'awaiting_review' : 'completed',
        progress: reviewRequired ? 92 : 100,
        stageMessage: reviewRequired
          ? currentJob.reviewPolicy === 'required'
            ? '已按要求保留人工完整听审确认'
            : '自动质量确认未通过，等待人工完整听审'
          : warnings.length
            ? '系统已自动确认转录，存在非阻断提示'
            : '系统已自动确认转录并完成交付',
        completedAt: reviewRequired ? null : new Date().toISOString(), quality, warnings,
        output: {
          rawTranscriptPath, transcriptPath, timedTranscriptPath, sourceEvidencePath, qualityReportPath,
          visualEvidencePath:visual.manifestPath || null,
          visualCoverage:visual.coverage,
          visualFailureCode:visual.failureCode || null,
          transcriptChecksum:sha256(transcript), evidenceLevel:evidence.qualityReport.evidenceLevel,
          reviewStatus:reviewRequired ? 'awaiting_review' : 'auto_confirmed',
          confirmationMode:reviewRequired ? null : 'automatic',
          automaticConfirmation:autoConfirmation,
          ...(confirmation || {}),
          guidePath, proofreadPath, markdownPath,
          rawCharacters: transcript.length, guideCharacters: refined.markdown.length,
          larkUrl: lark.url || null, larkPermissionGranted: lark.permissionGranted || false,
          deliveryMode:currentJob.deliveryMode,
          sourceAcquisition: acquired.contentPackage ? {
            provider: acquired.contentPackage.provider,
            acquisitionPath: acquired.contentPackage.acquisitionPath,
            providedCapabilities: acquired.contentPackage.providedCapabilities,
            adapterRef: acquired.contentPackage.adapterRef
          } : null
        }
      }, {
        stage:reviewRequired ? 'awaiting_review' : 'completed',
        message:reviewRequired ? '自动确认未完成，等待人工听审' : '系统质量确认完成，确认稿已生成'
      });
    } catch (error) {
      if (error instanceof JobPausedError) return;
      const errorMessage = humanizeError(error);
      const failure = classifyFailure(error);
      const current = this.store.get(job.id);
      await this.store.update(job.id, {
        status: 'failed', progress: 100, stageMessage: '处理失败', error: errorMessage, failure,
        failureHistory: [...(current?.failureHistory || []), { at: new Date().toISOString(), error: errorMessage, failure }]
      }, { stage: 'failed', message: errorMessage });
    }
  }

  async stage(id, status, progress, message) {
    await this.checkpoint(id, '进入下一步前');
    await this.store.update(id, { status, progress, stageMessage: message, error: null }, { stage: status, message });
  }

  async checkpoint(id, safePoint) {
    if (this.pauseController) await this.pauseController.checkpoint(id, safePoint);
  }

  async acquire(job, jobDir) {
    if (job.sourceType === 'upload') {
      const normalized = path.join(jobDir, 'audio.wav');
      await run('ffmpeg', ['-y', '-i', job.sourcePath, '-vn', '-ac', '1', '-ar', '16000', normalized]);
      return { kind: 'audio', path: normalized, visualSourcePath:job.sourcePath };
    }
    if (this.contentCenter) {
      const acquired = await this.contentCenter.fetch({
        taskId: job.id,
        source: job.sourceUrl,
        requestedCapabilities: ['basic_content', 'subtitles', 'media'],
        connectionId: job.connectionId,
        requestingAgentId: 'xiaod',
        workspace: jobDir,
        runtimeRequirement: 'media_transcription',
        onProgress: ({ stage, progress, message }) => this.stage(job.id, stage, progress, message)
      });
      if (!acquired.ok) throw new ContentAcquisitionError(acquired);
      if (acquired.runtime?.kind === 'video' && acquired.runtime.path) {
        await this.stage(job.id, 'acquiring', 35, '正在将已授权媒体转为本地转录音频');
        const normalized = path.join(jobDir, 'audio.wav');
        await run('ffmpeg', ['-y', '-i', acquired.runtime.path, '-vn', '-ac', '1', '-ar', '16000', normalized]);
        return { kind: 'audio', path: normalized, contentPackage: acquired.contentPackage, visualSourcePath:acquired.runtime.path };
      }
      if (acquired.runtime?.kind === 'remote_media' && acquired.runtime.url) {
        await this.stage(job.id, 'acquiring', 35, '正在将已授权媒体转为本地转录音频');
        const normalized = path.join(jobDir, 'audio.wav');
        await run('ffmpeg', ['-y', '-i', acquired.runtime.url, '-vn', '-ac', '1', '-ar', '16000', normalized]);
        return { kind: 'audio', path: normalized, contentPackage: acquired.contentPackage };
      }
      if (acquired.runtime?.kind === 'audio' && acquired.runtime.path) {
        const normalized = path.join(jobDir, 'audio.wav');
        if (path.resolve(acquired.runtime.path) === path.resolve(normalized)) {
          return { kind:'audio', path:normalized, contentPackage:acquired.contentPackage };
        }
        await this.stage(job.id, 'acquiring', 35, '正在规范化已授权音轨');
        await run('ffmpeg', ['-y', '-i', acquired.runtime.path, '-vn', '-ac', '1', '-ar', '16000', normalized]);
        return { kind:'audio', path:normalized, contentPackage:acquired.contentPackage };
      }
      return { ...acquired.runtime, contentPackage: acquired.contentPackage };
    }
    return this.acquireLegacyUrl(job, jobDir);
  }

  async acquireLegacyUrl(job, jobDir) {
    await this.stage(job.id, 'acquiring', 22, '正在优先查找可用字幕');
    const subtitleTemplate = path.join(jobDir, 'subtitle.%(ext)s');
    await run('yt-dlp', ['--no-playlist', '--write-subs', '--write-auto-subs', '--sub-langs', 'zh-Hans,zh-Hant,en', '--skip-download', '-o', subtitleTemplate, job.sourceUrl], { allowFailure: true });
    const subtitle = await findFirst(jobDir, (name) => /\.vtt$|\.srt$/i.test(name));
    if (subtitle) return { kind: 'subtitle', path: subtitle };

    await this.stage(job.id, 'acquiring', 32, '未找到字幕，正在下载音频');
    const audioTemplate = path.join(jobDir, 'source.%(ext)s');
    await run('yt-dlp', ['--no-playlist', '-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'mp3', '-o', audioTemplate, job.sourceUrl]);
    const downloaded = await findFirst(jobDir, (name) => /^source\./.test(name));
    if (!downloaded) throw new Error('下载命令结束但没有找到音频文件。');
    const normalized = path.join(jobDir, 'audio.wav');
    await run('ffmpeg', ['-y', '-i', downloaded, '-vn', '-ac', '1', '-ar', '16000', normalized]);
    return { kind: 'audio', path: normalized };
  }

  async transcribe(audioPath, jobDir) {
    await run(config.asrBin, [
      audioPath,
      '--model', config.asrModel,
      '--output-dir', jobDir,
      '--output-name', 'transcript',
      '--output-format', 'all',
      '--word-timestamps', 'True',
      '--language', 'zh',
      '--verbose', 'False'
    ]);
    const transcript = path.join(jobDir, 'transcript.txt');
    try { await fs.access(transcript); } catch { throw new Error('ASR 已运行但没有生成 transcript.txt。'); }
    const text = await fs.readFile(transcript, 'utf8');
    const vttPath = path.join(jobDir, 'transcript.vtt');
    let timed = null;
    try {
      timed = await fs.readFile(vttPath, 'utf8');
    } catch {
      const jsonPath = path.join(jobDir, 'transcript.json');
      try {
        timed = jsonTranscriptToVtt(JSON.parse(await fs.readFile(jsonPath, 'utf8')));
      } catch {
        timed = null;
      }
    }
    return { text, timed };
  }

  async prepareVisualEvidence({ job, jobDir, acquired, segments, sourceMetadata }) {
    const visualMode = job.visualMode === 'off' || job.visualMode === 'required' ? job.visualMode : 'auto';
    if (visualMode === 'off') return {
      manifestPath:null,
      coverage:{ status:'disabled', mode:'off', selectedFrames:0 },
      failureCode:null,
      warning:null
    };
    try {
      await this.stage(job.id, 'analyzing_visual', 62, '正在提取受控关键帧并建立画面证据');
      let videoPath = acquired.visualSourcePath || null;
      if (!videoPath && job.sourceType === 'upload') videoPath = job.sourcePath;
      if (!videoPath && this.contentCenter && job.sourceUrl) {
        const visualWorkspace = path.join(jobDir, 'visual-source');
        await fs.mkdir(visualWorkspace, { recursive:true, mode:0o700 });
        const visualSource = await this.contentCenter.fetch({
          taskId:job.id,
          source:job.sourceUrl,
          requestedCapabilities:['media'],
          connectionId:job.connectionId,
          requestingAgentId:'xiaod',
          workspace:visualWorkspace,
          runtimeRequirement:'visual_analysis'
        });
        if (!visualSource.ok) throw new ContentAcquisitionError(visualSource);
        if (visualSource.runtime?.kind !== 'video' || !visualSource.runtime.path) {
          throw new VisualEvidenceError('visual_video_stream_required', '内容通道只返回了音频，无法建立画面证据。');
        }
        videoPath = visualSource.runtime.path;
      }
      if (!videoPath) throw new VisualEvidenceError('visual_video_stream_required', '没有取得可用于画面分析的视频。');
      const created = await createVisualEvidencePackage({
        videoPath,
        outputDir:path.join(jobDir, 'visual-evidence'),
        depth:job.analysisDepth,
        transcriptSegments:segments,
        sourceMetadata
      });
      return {
        manifestPath:created.manifestPath,
        coverage:{
          status:'available',
          mode:visualMode,
          selectedFrames:created.payload.frames.length,
          maxFrames:created.payload.selection.maxFrames,
          storyboardCount:created.payload.storyboards.length
        },
        failureCode:null,
        warning:null
      };
    } catch (error) {
      if (visualMode === 'required') {
        const failure = new VisualEvidenceError('visual_evidence_required', error?.message || '没有生成必须的画面证据。');
        failure.cause = error;
        throw failure;
      }
      return {
        manifestPath:null,
        coverage:{ status:'unavailable', mode:'auto', selectedFrames:0 },
        failureCode:String(error?.code || error?.accessFailure?.code || 'visual_evidence_unavailable').slice(0, 120),
        warning:'画面证据未生成；本次只交付字幕拆解，不能视为完整图文分析。'
      };
    }
  }
}

function jsonTranscriptToVtt(payload) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const cues = segments.map((segment, index) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const text = String(segment?.text || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return null;
    return `${index + 1}\n${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${text}`;
  }).filter(Boolean);
  return cues.length ? `WEBVTT\n\n${cues.join('\n\n')}\n` : '';
}

function vttTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function stripDocumentHeading(value) {
  return String(value || '').replace(/^#\s+[^\n]+\n+/m, '').trim();
}

async function probeDuration(filePath) {
  const output = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { allowFailure:true });
  const value = Number(String(output).trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function qualityGateDuration({ reportedDurationSeconds, probedAudioDurationSeconds } = {}) {
  const reported = Number(reportedDurationSeconds);
  const probed = Number(probedAudioDurationSeconds);
  if (!Number.isFinite(reported) || reported <= 0) return Number.isFinite(probed) && probed > 0 ? probed : null;
  if (!Number.isFinite(probed) || probed <= 0) return reported;
  // Platform metadata is commonly rounded to whole seconds. The local probe is
  // more precise, so a sub-second difference must not become a false 99.9%
  // coverage failure. A larger discrepancy still uses the platform duration
  // and is rejected by the existing integrity gate.
  return Math.abs(reported - probed) <= 1 ? probed : reported;
}

export function deliveryTitle(job, contentPackage = null) {
  const acquiredTitle = String(contentPackage?.contentItems?.basic_content?.title || '').trim();
  if (acquiredTitle && isUrlLikeTitle(job?.title)) return acquiredTitle.slice(0, 200);
  return job?.title || '未命名素材';
}

function isUrlLikeTitle(value) {
  try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch { return false; }
}

async function findFirst(directory, predicate) {
  const files = await fs.readdir(directory);
  const name = files.find(predicate);
  return name ? path.join(directory, name) : null;
}

export async function refineText(title, transcript) {
  if (!config.refiner.url || !config.refiner.model) return { markdown: fallbackGuide(title), usedRefiner: false };
  return requestRefinement(config.refiner, title, transcript);
}

export async function requestRefinement(refiner, title, transcript, fetchImpl = fetch, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`语义整理请求超过 ${timeoutMs}ms`)), timeoutMs);
  try {
    const request = buildRefinerRequest(refiner, title, transcript);
    const response = await fetchImpl(request.url, { ...request.options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(formatRefinerError(request.provider, response.status, payload));
    const markdown = extractRefinerMarkdown(payload);
    if (!markdown) throw new Error('语义整理服务没有返回正文。');
    return { markdown, usedRefiner: true };
  } catch (error) {
    return {
      markdown: fallbackGuide(title),
      usedRefiner: false,
      refinerFallbackReason: `语义整理未完成（${error.message}）；已生成完整校对文本和待人工确认导览。`
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractRefinerMarkdown(payload) {
  const candidates = [
    payload?.content,
    payload?.choices?.[0]?.message?.content,
    payload?.choices?.[0]?.text,
    payload?.output_text,
    payload?.response?.output_text,
    payload?.output
  ];
  return candidates.map(extractText).find(Boolean) || '';
}

function extractText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n').trim();
  if (!value || typeof value !== 'object') return '';
  return [value.text, value.value, value.content].map(extractText).find(Boolean) || '';
}

export function fallbackGuide(title) {
  return `## 概述\n\n《${title}》已完成时间轴、标签、重复行和明显格式噪音的机械清理。未配置语义整理模型，因此系统不对主题、观点或术语作推断。\n\n## 主题详述\n\n### 完整校对文本\n\n请直接阅读下方完整校对文本；它保留了可用于人工复核的全部有效内容。\n\n## 核心观点与洞察\n\n### 待人工确认\n\n未启用语义模型时，不自动提炼观点，以避免把原文误写成摘要。`;
}

export function buildRefinerRequest(refiner, title, transcript) {
  const userContent = `标题：${title}\n\n原始转录：\n${transcript}`;
  const target = new URL(refiner.url);
  if (target.hostname === 'api.stepfun.com') {
    const stepPlan = refiner.model === 'step-router-v1';
    target.pathname = stepPlan ? '/step_plan/v1/messages' : '/v1/messages';
    target.search = '';
    return {
      provider: 'stepfun', url: target.toString(),
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(refiner.apiKey ? { Authorization: `Bearer ${refiner.apiKey}` } : {}) },
        body: JSON.stringify({ model: refiner.model, max_tokens: refiner.maxTokens || 8192, temperature: 0.2, system: REFINER_PROMPT, messages: [{ role: 'user', content: userContent }] })
      }
    };
  }
  return {
    provider: 'openai-compatible', url: target.toString(),
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(refiner.apiKey ? { Authorization: `Bearer ${refiner.apiKey}` } : {}) },
      body: JSON.stringify({ model: refiner.model, temperature: 0.2, messages: [{ role: 'system', content: REFINER_PROMPT }, { role: 'user', content: userContent }] })
    }
  };
}

function formatRefinerError(provider, status, payload) {
  const detail = payload.error?.message || payload.message || payload.msg || payload.error?.code || payload.code;
  return `${provider === 'stepfun' ? 'StepFun' : '语义整理服务'} 返回 HTTP ${status}${detail ? `：${String(detail).slice(0, 500)}` : ''}`;
}

export async function deliverToLark(title, markdown) {
  if (!config.lark.appId || !config.lark.appSecret) return { configured: false };
  const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.lark.appId, app_secret: config.lark.appSecret })
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || tokenPayload.code) throw new Error(tokenPayload.msg || '无法获取飞书 tenant_access_token');
  const headers = { Authorization: `Bearer ${tokenPayload.tenant_access_token}`, 'Content-Type': 'application/json' };
  const create = await fetch('https://open.feishu.cn/open-apis/docx/v1/documents', { method: 'POST', headers, body: JSON.stringify({ title }) });
  const created = await create.json();
  if (!create.ok || created.code) throw new Error(created.msg || '无法创建飞书文档');
  const document = created.data?.document || created.data;
  if (!document?.document_id) throw new Error('飞书未返回文档标识。');
  const children = markdownToBlocks(markdown);
  // Feishu permits at most 50 children per request. The document id is also its
  // root block id, so the new document can be populated without a second read.
  for (const childrenBatch of chunk(children, 50)) {
    const write = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${document.document_id}/blocks/${document.document_id}/children`, {
      method: 'POST', headers, body: JSON.stringify({ index: -1, children: childrenBatch })
    });
    const written = await write.json();
    if (!write.ok || written.code) throw new Error(written.msg || '飞书文档已创建，但写入正文失败');
    if (children.length > 50) await delay(360);
  }
  let permissionGranted = false;
  if (config.lark.userOpenId) {
    const permission = await fetch(`https://open.feishu.cn/open-apis/drive/v1/permissions/${document.document_id}/members?type=docx&need_notification=false`, {
      method: 'POST', headers,
      body: JSON.stringify({ member_type: 'openid', member_id: config.lark.userOpenId, perm: 'full_access' })
    });
    const permissionResult = await permission.json().catch(() => ({}));
    permissionGranted = permission.ok && !permissionResult.code;
  }
  return { configured: true, url: `https://feishu.cn/docx/${document.document_id}`, permissionGranted };
}

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function markdownToBlocks(markdown) {
  let firstMeaningfulLine = true;
  return markdown.split('\n').flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line || line === '---' || line.startsWith('>')) return [];
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    // The Feishu document already has a title. Repeating the Markdown H1 makes
    // URL-sourced tasks show a distracting second, auto-linked URL heading.
    if (firstMeaningfulLine && heading?.[1].length === 1) {
      firstMeaningfulLine = false;
      return [];
    }
    firstMeaningfulLine = false;
    if (heading) {
      const level = heading[1].length;
      const blockType = level === 1 ? 3 : level === 2 ? 4 : 5;
      const key = level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
      return [{ block_type: blockType, [key]: { elements: inlineElements(heading[2]) } }];
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) return [{ block_type: 12, bullet: { elements: inlineElements(bullet[1]) } }];
    return [{ block_type: 2, text: { elements: inlineElements(line) } }];
  });
}

function inlineElements(value) {
  const elements = [];
  const parts = String(value).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  for (const part of parts) {
    const bold = part.startsWith('**') && part.endsWith('**');
    const content = bold ? part.slice(2, -2) : part;
    if (content) elements.push({ text_run: { content, ...(bold ? { text_element_style: { bold: true } } : {}) } });
  }
  return elements.length ? elements : [{ text_run: { content: String(value) } }];
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => reject(new Error(`${command} 无法启动：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0 || allowFailure) return resolve(output);
      reject(new Error(`${command} 执行失败（退出码 ${code}）：${output.slice(-900)}`));
    });
  });
}

function humanizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 403|private|login|sign in|cookies/i.test(message)) return '素材需要登录、Cookie 或额外授权；本服务不会绕过访问控制。';
  if (/^ffmpeg 执行失败|Error opening input|Invalid data found/i.test(message)) return '素材无法被识别为可转录的音视频文件，请重新上传原始音频或视频文件。';
  if (new RegExp(`^${config.asrBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 执行失败`).test(message)) return '本地转录未成功完成，请检查转录模型与素材格式后重试。';
  return message.slice(0, 1400);
}
