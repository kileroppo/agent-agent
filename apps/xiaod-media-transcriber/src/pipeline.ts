import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.ts';
import { cleanTranscript, composeDelivery, qualityCheck } from './domain.ts';
import { classifyFailure, knownLarkDeliveryRecoveryPatch } from './recovery.ts';
import { createOneShotFailpoint } from './test-failpoint.ts';
import { JobPausedError } from './job-pause-controller.ts';
import { ContentAcquisitionError } from 'ajun-common-access/content-acquisition-center';
import { automaticConfirmationDecision, buildEvidenceRecords, parseTimedTranscript, sha256, timedTranscriptMarkdown } from './transcript-evidence.ts';
import { createTranscriptConfirmationFiles } from './transcript-review.ts';
import { VisualEvidenceError } from './visual-evidence.ts';
import { AdaptiveAsrRuntime, compactAsrRouting, createSubtitleRoutingRecord } from './adaptive-asr-runtime.ts';
import { attachAsrCapabilityResult } from './asr-capability-adapter.ts';
import { LarkDeliveryCoordinator } from './lark-delivery.ts';
import { createLocalVisualEvidenceAdapter } from './visual-capability-adapter.ts';
import { createTaskRunEventBridge } from './task-run-event-bridge.ts';
type DynamicRecord = Record<string, any>;
type StoreInterface = Readonly<{
  get(id: string): DynamicRecord | null;
  update(id: string, patch: DynamicRecord, event?: Readonly<{ stage: string; message: string }> | null): Promise<DynamicRecord | null>;
}>;
type ContentCenterInterface = Pick<import('ajun-common-access/content-acquisition-center').ContentAcquisitionCenter, 'fetch'>;
type PauseControllerInterface = Readonly<{ checkpoint(id: string, safePoint: string): Promise<unknown> }>;
type Failpoint = (stage: string) => unknown | Promise<unknown>;
type VisualAdapter = ReturnType<typeof createLocalVisualEvidenceAdapter>;
type RunEvents = ReturnType<typeof createTaskRunEventBridge>;

export { deliverToLark, markdownToBlocks } from './lark-delivery.ts';

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
  private readonly store: StoreInterface;
  private readonly workDir: string;
  private readonly contentCenter: ContentCenterInterface | null;
  private readonly pauseController: PauseControllerInterface | null;
  private readonly runEvents: RunEvents;
  private readonly asrRuntime: AdaptiveAsrRuntime;
  private readonly visualAdapter: VisualAdapter;
  private readonly failpoint: Failpoint;
  private readonly delivery: LarkDeliveryCoordinator;

  constructor({ store, workDir, contentCenter = null, pauseController = null, asrRuntime = null, visualAdapter = null, failpoint = createOneShotFailpoint(config.testFailOnceAt), delivery = null, onRunEvent = null, runEventBridge = null }: Readonly<{
    store: StoreInterface;
    workDir: string;
    contentCenter?: ContentCenterInterface | null;
    pauseController?: PauseControllerInterface | null;
    asrRuntime?: AdaptiveAsrRuntime | null;
    visualAdapter?: VisualAdapter | null;
    failpoint?: Failpoint;
    delivery?: LarkDeliveryCoordinator | null;
    onRunEvent?: ((event: unknown) => unknown | Promise<unknown>) | null;
    runEventBridge?: RunEvents | null;
  }>) {
    this.store = store;
    this.workDir = workDir;
    this.contentCenter = contentCenter;
    this.pauseController = pauseController;
    this.runEvents = runEventBridge || createTaskRunEventBridge({ onRunEvent });
    this.asrRuntime = asrRuntime || new AdaptiveAsrRuntime({ runEventBridge:this.runEvents });
    this.visualAdapter = visualAdapter || createLocalVisualEvidenceAdapter();
    this.failpoint = failpoint;
    this.delivery = delivery || new LarkDeliveryCoordinator({ store, runEventBridge:this.runEvents });
    this.delivery.attachRunEventBridge?.(this.runEvents);
  }

  async run(jobId: string): Promise<void> {
    const job = this.store.get(jobId);
    if (!job) return;
    const jobDir = path.join(this.workDir, 'jobs', job.id);
    try {
      await this.checkpoint(job.id, '开始处理前');
      await fs.mkdir(jobDir, { recursive:true, mode:0o700 });
      await fs.chmod(jobDir, 0o700);
      await this.stage(job.id, 'preparing', 8, '正在检查素材格式与可读性');
      const acquired = await this.acquire(this.store.get(job.id) || job, jobDir);
      await this.checkpoint(job.id, '素材检查完成');
      const resolvedTitle = deliveryTitle(this.store.get(job.id), acquired.contentPackage);
      if (resolvedTitle !== (this.store.get(job.id) || job).title) await this.store.update(job.id, { title: resolvedTitle });
      const currentJob = this.store.get(job.id) || job;
      await this.stage(job.id, 'transcribing', 45, acquired.kind === 'subtitle'
        ? '正在读取可用字幕'
        : currentJob.asrProvider === 'stepfun'
          ? '正在使用 StepAudio 2.5 ASR 转录'
          : '正在进行本机 ASR 转录');
      // The source has already been copied/normalized into jobDir. Failing here
      // exercises retry without creating any external delivery side effect.
      await this.failpoint('transcribing');
      const audioDurationSeconds = acquired.kind === 'audio' ? await probeDuration(acquired.path) : null;
      const subtitleText = acquired.kind === 'subtitle' ? await fs.readFile(acquired.path, 'utf8') : null;
      const transcription: DynamicRecord = acquired.kind === 'subtitle'
        ? {
            text:subtitleText,
            timed:null,
            routing:attachAsrCapabilityResult({
              job:currentJob,
              routing:createSubtitleRoutingRecord(currentJob),
              input:{ subtitleText },
              payload:{ text:subtitleText, timed:null }
            })
          }
        : await this.transcribe(acquired.path, jobDir, { job:currentJob, durationSeconds:audioDurationSeconds });
      if (acquired.kind === 'subtitle') {
        await this.runEvents.recordExecutionReceipt(transcription.routing.executionReceipt, {
          qualityResult:transcription.routing.qualityResult
        });
      }
      const rawTranscript = String(transcription.text || '');
      await this.checkpoint(job.id, '转录完成');
      const transcript = cleanTranscript(rawTranscript);
      if (transcript.length < 20) throw new Error('未得到有效文字，请检查素材是否有声音、是否受限或更换转录模型。');
      const rawTranscriptPath = path.join(jobDir, acquired.kind === 'subtitle' ? 'raw-transcript.vtt' : 'raw-transcript.txt');
      await writePrivateFile(rawTranscriptPath, rawTranscript);
      const transcriptPath = path.join(jobDir, 'transcript-clean.txt');
      await writePrivateFile(transcriptPath, transcript);
      const timedSource = transcription.timed || rawTranscript;
      const segments = parseTimedTranscript(timedSource, { kind:transcription.timed ? 'subtitle' : acquired.kind });
      const timedTranscriptPath = path.join(jobDir, 'transcript-timed.md');
      await writePrivateFile(timedTranscriptPath, timedTranscriptMarkdown(currentJob.title, segments));
      const asrRoutingPath = path.join(jobDir, 'asr-routing.json');
      await writePrivateFile(asrRoutingPath, JSON.stringify(transcription.routing, null, 2));
      const reportedMediaDurationSeconds = Number(acquired.contentPackage?.contentItems?.basic_content?.durationSeconds) || null;
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
        audioDurationSeconds,
        transcriptionQuality:transcription.qualitySignals || null
      });
      const qualityReport = evidence.qualityReport as DynamicRecord;
      qualityReport.asrRouting = compactAsrRouting(transcription.routing);
      const sourceEvidencePath = path.join(jobDir, 'source-evidence.json');
      const qualityReportPath = path.join(jobDir, 'transcript-quality-report.json');
      await writePrivateFile(sourceEvidencePath, JSON.stringify(evidence.sourceEvidence, null, 2));
      await writePrivateFile(qualityReportPath, JSON.stringify(qualityReport, null, 2));
      if (qualityReport.hardFailures.length) {
        throw Object.assign(new Error(`转录完整性检查未通过：${qualityReport.hardFailures.join(', ')}`), { code:'transcript_integrity_failed' });
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
      await writePrivateFile(guidePath, refined.markdown);
      await writePrivateFile(proofreadPath, `# ${currentJob.title}\n\n${transcript}\n`);
      await writePrivateFile(markdownPath, markdown);
      const quality = qualityCheck(markdown, { usedRefiner: refined.usedRefiner, refinerFallback: Boolean(refined.refinerFallbackReason) });

      const warnings = [...quality.issues];
      if (refined.refinerFallbackReason) warnings.unshift(refined.refinerFallbackReason);
      if (visual.warning) warnings.unshift(visual.warning);
      const baseAutoConfirmation = automaticConfirmationDecision({ qualityReport, transcript });
      const autoConfirmation = transcription.routing.requiresHumanReview
        ? {
            ...baseAutoConfirmation,
            eligible:false,
            reasons:[...new Set([...baseAutoConfirmation.reasons, 'asr_fallback_requires_human_review'])]
          }
        : baseAutoConfirmation;
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
      if (transcription.routing.requiresHumanReview) {
        warnings.unshift('质量模型暂时不可用；已生成本机应急转录，必须人工完整听审后才能正式使用。');
      } else if (currentJob.reviewPolicy !== 'required' && !autoConfirmation.eligible) {
        warnings.unshift(`自动确认未通过：${autoConfirmation.reasons.join(', ')}`);
      }

      const localOutput = {
        ...(this.store.get(job.id)?.output || {}),
        rawTranscriptPath, transcriptPath, timedTranscriptPath, sourceEvidencePath, qualityReportPath, asrRoutingPath,
        asrProvider:transcription.routing.selectedProvider,
        asrModel:transcription.routing.selectedModel,
        asrEscalated:transcription.routing.escalated === true,
        visualEvidencePath:visual.manifestPath || null,
        visualCoverage:visual.coverage,
        visualQualityResult:visual.qualityResult || null,
        visualFailureCode:visual.failureCode || null,
        transcriptChecksum:sha256(transcript), evidenceLevel:qualityReport.evidenceLevel,
        reviewStatus:reviewRequired ? 'awaiting_review' : 'auto_confirmed',
        confirmationMode:reviewRequired ? null : 'automatic',
        automaticConfirmation:autoConfirmation,
        ...(confirmation || {}),
        guidePath, proofreadPath, markdownPath,
        rawCharacters: transcript.length, guideCharacters: refined.markdown.length,
        deliveryMode:currentJob.deliveryMode,
        sourceAcquisition: acquired.contentPackage ? {
          provider: acquired.contentPackage.provider,
          acquisitionPath: acquired.contentPackage.acquisitionPath,
          providedCapabilities: acquired.contentPackage.providedCapabilities,
          adapterRef: acquired.contentPackage.adapterRef,
          access:acquired.contentPackage.access || null
        } : null
      };
      await this.store.update(job.id, {
        status:'delivering', progress:88, stageMessage:'本地交付物已落账，正在准备飞书交付',
        quality, warnings, output:localOutput
      }, { stage:'delivering', message:'本地交付物及校验凭据已落账' });
      await this.checkpoint(job.id, '交付前');
      const lark = reviewRequired
        ? { configured:true, deferredForReview:true, state:'deferred_for_review' }
        : currentJob.deliveryMode === 'local_only'
        ? { configured:false, localOnly:true, state:'local_only' }
        : await this.delivery.deliver({ jobId:job.id, title:currentJob.title, markdown });
      if (lark.configured === false && !lark.localOnly) warnings.push('未配置飞书 App；本地交付物已完成，等待配置后交付。');
      if (!lark.deferredForReview && lark.configured !== false && !lark.permissionGranted) warnings.push('飞书文档已创建，但目标用户权限尚未确认。');
      const deliveryComplete = lark.localOnly || (lark.url && lark.permissionGranted);
      const finalStatus = reviewRequired ? 'awaiting_review' : deliveryComplete ? 'completed' : 'awaiting_delivery';
      const finalMessage = reviewRequired
        ? currentJob.reviewPolicy === 'required'
          ? '已按要求保留人工完整听审确认'
          : transcription.routing.requiresHumanReview
            ? '质量模型暂时不可用，已生成应急转录并等待人工完整听审'
            : '自动质量确认未通过，等待人工完整听审'
        : finalStatus === 'awaiting_delivery'
          ? '本地交付物已完成，等待飞书交付确认'
          : warnings.length
            ? '系统已自动确认转录，存在非阻断提示'
            : '系统已自动确认转录并完成交付';
      await this.store.update(job.id, {
        status:finalStatus,
        progress:finalStatus === 'completed' ? 100 : 92,
        stageMessage:finalMessage,
        completedAt:finalStatus === 'completed' ? new Date().toISOString() : null,
        quality, warnings,
        output: {
          ...(this.store.get(job.id)?.output || localOutput),
          larkUrl: lark.url || null, larkPermissionGranted: lark.permissionGranted || false,
        }
      }, {
        stage:finalStatus,
        message:reviewRequired
          ? '自动确认未完成，等待人工听审'
          : finalStatus === 'awaiting_delivery'
            ? '本地确认稿已生成，飞书交付尚未完成'
            : '系统质量确认完成，确认稿已生成'
      });
    } catch (error: unknown) {
      if (error instanceof JobPausedError) return;
      const knownDelivery = knownLarkDeliveryRecoveryPatch(this.store.get(job.id) || job);
      if (knownDelivery) {
        await this.store.update(job.id, knownDelivery, {
          stage:String(knownDelivery.status),
          message:'已从持久化飞书交付凭据恢复任务状态'
        });
        return;
      }
      const errorMessage = humanizeError(error);
      const failure = classifyFailure(error);
      const current = this.store.get(job.id);
      await this.store.update(job.id, {
        status: 'failed', progress: 100, stageMessage: '处理失败', error: errorMessage, failure,
        failureHistory: [...(current?.failureHistory || []), { at: new Date().toISOString(), error: errorMessage, failure }]
      }, { stage: 'failed', message: errorMessage });
    }
  }

  async stage(id: string, status: string, progress: number, message: string): Promise<void> {
    await this.checkpoint(id, '进入下一步前');
    await this.store.update(id, { status, progress, stageMessage: message, error: null }, { stage: status, message });
  }

  async checkpoint(id: string, safePoint: string): Promise<void> {
    if (this.pauseController) await this.pauseController.checkpoint(id, safePoint);
  }

  async acquire(job: DynamicRecord, jobDir: string): Promise<DynamicRecord> {
    if (job.sourceType === 'upload') {
      const normalized = path.join(jobDir, 'audio.wav');
      await run('ffmpeg', ['-y', '-i', job.sourcePath, '-vn', '-ac', '1', '-ar', '16000', normalized]);
      await fs.chmod(normalized, 0o600);
      return { kind: 'audio', path: normalized, visualSourcePath:job.sourcePath };
    }
    if (this.contentCenter) {
      const acquired = await this.contentCenter.fetch({
        taskId: job.agentArmyTaskId || job.taskId || job.id,
        source: job.sourceUrl,
        requestedCapabilities: ['basic_content', 'subtitles', 'media'],
        connectionId: job.connectionId,
        requestingAgentId: 'xiaod',
        workspace: jobDir,
        runtimeRequirement: 'media_transcription',
        onProgress: ({ stage, progress, message }) => this.stage(job.id, stage, progress, message)
      });
      await this.runEvents.recordExecutionReceipt(acquired.acquisitionReceipt);
      if (!acquired.ok) throw new ContentAcquisitionError(acquired);
      if (acquired.runtime?.kind === 'video' && acquired.runtime.path) {
        await this.stage(job.id, 'acquiring', 35, '正在将已授权媒体转为本地转录音频');
        const normalized = path.join(jobDir, 'audio.wav');
        await run('ffmpeg', ['-y', '-i', acquired.runtime.path, '-vn', '-ac', '1', '-ar', '16000', normalized]);
        await fs.chmod(normalized, 0o600);
        return { kind: 'audio', path: normalized, contentPackage: acquired.contentPackage, visualSourcePath:acquired.runtime.path };
      }
      if (acquired.runtime?.kind === 'remote_media' && acquired.runtime.url) {
        await this.stage(job.id, 'acquiring', 35, '正在将已授权媒体转为本地转录音频');
        const normalized = path.join(jobDir, 'audio.wav');
        await run('ffmpeg', ['-y', '-i', acquired.runtime.url, '-vn', '-ac', '1', '-ar', '16000', normalized]);
        await fs.chmod(normalized, 0o600);
        return { kind: 'audio', path: normalized, contentPackage: acquired.contentPackage };
      }
      if (acquired.runtime?.kind === 'audio' && acquired.runtime.path) {
        const normalized = path.join(jobDir, 'audio.wav');
        if (path.resolve(acquired.runtime.path) === path.resolve(normalized)) {
          return { kind:'audio', path:normalized, contentPackage:acquired.contentPackage };
        }
        await this.stage(job.id, 'acquiring', 35, '正在规范化已授权音轨');
        await run('ffmpeg', ['-y', '-i', acquired.runtime.path, '-vn', '-ac', '1', '-ar', '16000', normalized]);
        await fs.chmod(normalized, 0o600);
        return { kind:'audio', path:normalized, contentPackage:acquired.contentPackage };
      }
      return { ...acquired.runtime, contentPackage: acquired.contentPackage };
    }
    return this.acquireLegacyUrl(job, jobDir);
  }

  async acquireLegacyUrl(job: DynamicRecord, jobDir: string): Promise<DynamicRecord> {
    await this.stage(job.id, 'acquiring', 22, '正在优先查找可用字幕');
    const subtitleTemplate = path.join(jobDir, 'subtitle.%(ext)s');
    await run('yt-dlp', ['--no-playlist', '--write-subs', '--write-auto-subs', '--sub-langs', 'zh-Hans,zh-Hant,en', '--skip-download', '-o', subtitleTemplate, job.sourceUrl], { allowFailure: true });
    const subtitle = await findFirst(jobDir, (name) => /\.vtt$|\.srt$/i.test(name));
    if (subtitle) {
      await fs.chmod(subtitle, 0o600);
      return { kind: 'subtitle', path: subtitle };
    }

    await this.stage(job.id, 'acquiring', 32, '未找到字幕，正在下载音频');
    const audioTemplate = path.join(jobDir, 'source.%(ext)s');
    await run('yt-dlp', ['--no-playlist', '-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'mp3', '-o', audioTemplate, job.sourceUrl]);
    const downloaded = await findFirst(jobDir, (name) => /^source\./.test(name));
    if (!downloaded) throw new Error('下载命令结束但没有找到音频文件。');
    await fs.chmod(downloaded, 0o600);
    const normalized = path.join(jobDir, 'audio.wav');
    await run('ffmpeg', ['-y', '-i', downloaded, '-vn', '-ac', '1', '-ar', '16000', normalized]);
    await fs.chmod(normalized, 0o600);
    return { kind: 'audio', path: normalized };
  }

  async transcribe(audioPath: string, jobDir: string, { job = {}, durationSeconds = null }: Readonly<{ job?: DynamicRecord; durationSeconds?: number | null }> = {}) {
    return this.asrRuntime.transcribe(audioPath, jobDir, { job, durationSeconds });
  }

  async prepareVisualEvidence({ job, jobDir, acquired, segments, sourceMetadata }: Readonly<{
    job: DynamicRecord;
    jobDir: string;
    acquired: DynamicRecord;
    segments: readonly DynamicRecord[];
    sourceMetadata: unknown;
  }>): Promise<DynamicRecord> {
    const visualMode = job.visualMode === 'off' || job.visualMode === 'required' ? job.visualMode : 'auto';
    if (visualMode === 'off') return {
      manifestPath:null,
      coverage:{ status:'disabled', mode:'off', selectedFrames:0 },
      failureCode:null,
      warning:null
    };
    const startedAt = new Date().toISOString();
    try {
      await this.stage(job.id, 'analyzing_visual', 62, '正在提取受控关键帧并建立画面证据');
      let videoPath = acquired.visualSourcePath || null;
      if (!videoPath && job.sourceType === 'upload') videoPath = job.sourcePath;
      if (!videoPath && this.contentCenter && job.sourceUrl) {
        const visualWorkspace = path.join(jobDir, 'visual-source');
        await fs.mkdir(visualWorkspace, { recursive:true, mode:0o700 });
        const visualSource = await this.contentCenter.fetch({
          taskId:job.agentArmyTaskId || job.taskId || job.id,
          source:job.sourceUrl,
          requestedCapabilities:['media'],
          connectionId:job.connectionId,
          requestingAgentId:'xiaod',
          workspace:visualWorkspace,
          runtimeRequirement:'visual_analysis'
        });
        await this.runEvents.recordExecutionReceipt(visualSource.acquisitionReceipt);
        if (!visualSource.ok) throw new ContentAcquisitionError(visualSource);
        if (visualSource.runtime?.kind !== 'video' || !visualSource.runtime.path) {
          throw new VisualEvidenceError('visual_video_stream_required', '内容通道只返回了音频，无法建立画面证据。');
        }
        videoPath = visualSource.runtime.path;
      }
      if (!videoPath) throw new VisualEvidenceError('visual_video_stream_required', '没有取得可用于画面分析的视频。');
      const result = await this.visualAdapter.invoke({
        payload:{
          videoPath,
          outputDir:path.join(jobDir, 'visual-evidence'),
          depth:job.analysisDepth,
          transcriptSegments:segments,
          sourceMetadata
        }
      });
      const created = result.output;
      await this.runEvents.recordVisualResult({ job, result, startedAt, completedAt:new Date().toISOString() });
      return {
        manifestPath:created.manifestPath,
        coverage:{
          status:'available',
          mode:visualMode,
          selectedFrames:created.payload.frames.length,
          maxFrames:created.payload.selection.maxFrames,
          storyboardCount:created.payload.storyboards.length
        },
        qualityResult:created.qualityResult,
        failureCode:null,
        warning:null
      };
    } catch (error: unknown) {
      await this.runEvents.recordVisualResult({ job, startedAt, completedAt:new Date().toISOString(), error:error instanceof Error ? error : new Error(String(error)) });
      if (visualMode === 'required') {
        const failure = new VisualEvidenceError('visual_evidence_required', error instanceof Error ? error.message : '没有生成必须的画面证据。');
        failure.cause = error;
        throw failure;
      }
      return {
        manifestPath:null,
        coverage:{ status:'unavailable', mode:'auto', selectedFrames:0 },
        failureCode:String(errorValue(error, 'code') || errorValue(errorValue(error, 'accessFailure'), 'code') || 'visual_evidence_unavailable').slice(0, 120),
        warning:'画面证据未生成；本次只交付字幕拆解，不能视为完整图文分析。'
      };
    }
  }
}

function stripDocumentHeading(value: unknown): string {
  return String(value || '').replace(/^#\s+[^\n]+\n+/m, '').trim();
}

async function probeDuration(filePath: string): Promise<number | null> {
  const output = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { allowFailure:true });
  const value = Number(String(output).trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function qualityGateDuration({ reportedDurationSeconds, probedAudioDurationSeconds }: Readonly<{ reportedDurationSeconds?: unknown; probedAudioDurationSeconds?: unknown }> = {}): number | null {
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

export function deliveryTitle(job: DynamicRecord | null, contentPackage: DynamicRecord | null = null): string {
  const acquiredTitle = String(contentPackage?.contentItems?.basic_content?.title || '').trim();
  if (acquiredTitle && isUrlLikeTitle(job?.title)) return acquiredTitle.slice(0, 200);
  return job?.title || '未命名素材';
}

function isUrlLikeTitle(value: unknown): boolean {
  try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch { return false; }
}

async function findFirst(directory: string, predicate: (name: string) => boolean): Promise<string | null> {
  const files = await fs.readdir(directory);
  const name = files.find(predicate);
  return name ? path.join(directory, name) : null;
}

export async function refineText(title: string, transcript: string): Promise<{ markdown: string; usedRefiner: boolean; refinerFallbackReason?: string }> {
  if (!config.refiner.url || !config.refiner.model) return { markdown: fallbackGuide(title), usedRefiner: false };
  return requestRefinement(config.refiner, title, transcript);
}

export async function requestRefinement(refiner: typeof config.refiner, title: string, transcript: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30000): Promise<{ markdown: string; usedRefiner: boolean; refinerFallbackReason?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`语义整理请求超过 ${timeoutMs}ms`)), timeoutMs);
  try {
    const request = buildRefinerRequest(refiner, title, transcript);
    const response = await fetchImpl(request.url, { ...request.options, signal: controller.signal });
    const payload = await response.json().catch(() => ({})) as DynamicRecord;
    if (!response.ok) throw new Error(formatRefinerError(request.provider, response.status, payload));
    const markdown = extractRefinerMarkdown(payload);
    if (!markdown) throw new Error('语义整理服务没有返回正文。');
    return { markdown, usedRefiner: true };
  } catch (error: unknown) {
    return {
      markdown: fallbackGuide(title),
      usedRefiner: false,
      refinerFallbackReason: `语义整理未完成（${error instanceof Error ? error.message : String(error)}）；已生成完整校对文本和待人工确认导览。`
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractRefinerMarkdown(payload: DynamicRecord): string {
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

function extractText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n').trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return [record.text, record.value, record.content].map(extractText).find(Boolean) || '';
}

export function fallbackGuide(title: string): string {
  return `## 概述\n\n《${title}》已完成时间轴、标签、重复行和明显格式噪音的机械清理。未配置语义整理模型，因此系统不对主题、观点或术语作推断。\n\n## 主题详述\n\n### 完整校对文本\n\n请直接阅读下方完整校对文本；它保留了可用于人工复核的全部有效内容。\n\n## 核心观点与洞察\n\n### 待人工确认\n\n未启用语义模型时，不自动提炼观点，以避免把原文误写成摘要。`;
}

export function buildRefinerRequest(refiner: typeof config.refiner, title: string, transcript: string) {
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

function formatRefinerError(provider: string, status: number, payload: DynamicRecord): string {
  const detail = payload.error?.message || payload.message || payload.msg || payload.error?.code || payload.code;
  return `${provider === 'stepfun' ? 'StepFun' : '语义整理服务'} 返回 HTTP ${status}${detail ? `：${String(detail).slice(0, 500)}` : ''}`;
}


async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { mode:0o600 });
  await fs.chmod(filePath, 0o600);
}

function run(command: string, args: readonly string[], { allowFailure = false }: Readonly<{ allowFailure?: boolean }> = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk; });
    child.on('error', (error) => reject(new Error(`${command} 无法启动：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0 || allowFailure) return resolve(output);
      reject(new Error(`${command} 执行失败（退出码 ${code}）：${output.slice(-900)}`));
    });
  });
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 403|private|login|sign in|cookies/i.test(message)) return '素材需要登录、Cookie 或额外授权；本服务不会绕过访问控制。';
  if (/^ffmpeg 执行失败|Error opening input|Invalid data found/i.test(message)) return '素材无法被识别为可转录的音视频文件，请重新上传原始音频或视频文件。';
  if (new RegExp(`^${config.asrBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 执行失败`).test(message)) return '本地转录未成功完成，请检查转录模型与素材格式后重试。';
  return message.slice(0, 1400);
}

function errorValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
