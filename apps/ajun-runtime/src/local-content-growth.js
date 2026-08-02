import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildM5PlatformCopy,
  deriveM5ContentVersionId,
  validM5MediaChecksum,
} from './m5-content-version.js';
import { validM5ProductionTemplateBinding } from './m5-production-template-resolver.js';

const FULL_ANALYSIS_MODULES = [
  '基本信息',
  '标题诊断',
  '开头诊断',
  '爆点拆解',
  '全文逐句作用拆解',
  '结构分析',
  '话术技巧与文字洁癖',
  '表达效率检测',
  '认知落差检测',
  '素材盘点',
  'AI辅助创作建议',
  '可模仿点 Top3',
  '爆款结构模板'
];
const FAST_ANALYSIS_MODULES = ['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'];
export const CONTENT_PERFORMANCE_NEXT_ACTIONS = Object.freeze([
  '保留表现较好的开场和结构变量。',
  '下一版只调整一个主要变量，并继续关联原任务与版本。',
]);

export class LocalVideoContentAnalyst {
  constructor({ store, artifactsDir, allowedArtifactRoots = [], advisor = null, now = () => new Date() } = {}) {
    this.store = store;
    this.artifactsDir = artifactsDir;
    this.allowedArtifactRoots = allowedArtifactRoots.map((item) => path.resolve(item));
    this.advisor = advisor;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'video-content-analyst'; }

  async execute(task, {
    sourceArtifacts = null,
    allowAdvisor = true,
    providerVision = null,
  } = {}) {
    if (task.taskType === 'content.performance-review') return this.performanceReview(task, { sourceArtifacts });
    if (task.taskType === 'content.campaign-visual-analysis') {
      return this.m5VisualAnalysis(task, {
        sourceArtifacts,
        allowAdvisor,
        providerVision,
      });
    }
    const evidenceMode = task.input?.evidenceMode === 'preliminary' ? 'preliminary' : 'formal';
    const depth = task.input?.depth === 'full' ? 'full' : 'fast';
    const sources = Array.isArray(sourceArtifacts) ? sourceArtifacts : await referencedArtifacts(task, this.store);
    const transcriptArtifact = evidenceMode === 'formal'
      ? findArtifact(sources, 'confirmed_transcript')
      : findArtifact(sources, 'confirmed_transcript') || findArtifact(sources, 'raw_asr_transcript');
    if (!transcriptArtifact) {
      return needsInput(
        this.now(),
        evidenceMode === 'formal' ? 'confirmed_transcript_required' : 'transcript_artifact_required',
        evidenceMode === 'formal' ? '正式拆解必须引用小D质量门禁通过后的系统确认稿或人工确认稿。' : '初步拆解至少需要引用一份机器转录。'
      );
    }
    const confirmationMode = transcriptArtifact.validation?.confirmationMode === 'automatic' ? 'automatic' : 'human';
    const transcript = await readArtifactText(transcriptArtifact, this.allowedArtifactRoots);
    if (transcript.length < 20) return needsInput(this.now(), 'transcript_artifact_empty', '引用的转录产物为空或不可读。');
    const sourceEvidenceArtifact = findArtifact(sources, 'source_evidence_record');
    const visualArtifact = findArtifact(sources, 'visual_evidence_package');
    const visualMode = task.input?.visualMode === 'off' || task.input?.visualMode === 'required' ? task.input.visualMode : 'auto';
    if (visualMode === 'required' && !visualArtifact) {
      return needsInput(this.now(), 'visual_evidence_required', '本次拆解要求分析画面，但没有可读取的关键帧证据。请补充本地视频、授权素材读取或改用自动模式。');
    }
    const sourceEvidence = sourceEvidenceArtifact ? await readArtifactJson(sourceEvidenceArtifact, this.allowedArtifactRoots) : null;
    const sourceMetadata = normalizeSourceMetadata(sourceEvidence?.sourceMetadata);
    const boomSignal = normalizeBoomSignalContext(task.input?.context?.boomSignal);
    const visualEvidence = visualArtifact && visualMode !== 'off'
      ? await readVisualEvidence(visualArtifact, this.allowedArtifactRoots)
      : null;
    if (visualEvidence) {
      return needsInput(
        this.now(),
        'controlled_provider_vision_required',
        '已有故事板，但普通拆解尚未接入可核验的受控 Provider 视觉观察。Hermes 不会直接读取本机图片；请接入受控视觉回执或将 visualMode 设为 off 后仅做文本拆解。',
      );
    }
    const effectiveTitle = sourceMetadata.title || clean(task.input?.title, 300) || transcriptArtifact.title || '视频内容';
    const segments = evidenceSegments(transcript);
    const advisorTranscript = segments.map((segment) => (
      segment.timestamp ? `[${segment.timestamp}] ${segment.text}` : segment.text
    )).join('\n\n');
    const fallback = buildAnalysis({ title:effectiveTitle, transcript, segments, depth, evidenceMode, confirmationMode, focus:task.input?.focus, sourceMetadata });
    let report = fallback;
    let modelUsage = null;
    let advisorApplied = false;
    let advisorFailure = null;
    let semanticRepairApplied = false;
    if (allowAdvisor && this.advisor?.analyze) {
      try {
        const advisedResult = await this.advisor.analyze({
          title:effectiveTitle,
          transcript:advisorTranscript,
          depth,
          evidenceMode,
          focus:task.input?.focus,
          sourceMetadata,
          boomSignal,
          visualEvidence,
          priorRuntimeMs:Number(visualEvidence?.selection?.processingDurationMs) || 0,
          validate:(value) => validAdvisedAnalysis(
            normalizeAdvisedAnalysis(value, transcript, visualEvidence),
            transcript,
            depth,
            visualEvidence
          )
        });
        const advised = normalizeAdvisedAnalysis(advisedResult?.data || advisedResult, transcript, visualEvidence);
        modelUsage = advisedResult?.usage || null;
        if (validAdvisedAnalysis(advised, transcript, depth, visualEvidence)) {
          report = { ...fallback, ...advised, evidenceMode, confirmationMode, depth };
          advisorApplied = true;
        } else {
          advisorFailure = 'content_analysis_semantic_validation_failed';
        }
      } catch (error) {
        modelUsage = error?.usage || null;
        const repaired = error?.code === 'content_analysis_semantic_validation_failed'
          ? repairAdvisedAnalysis(error?.data, fallback, transcript, depth, visualEvidence)
          : null;
        if (repaired && validAdvisedAnalysis(repaired, transcript, depth, visualEvidence)) {
          report = { ...fallback, ...repaired, evidenceMode, confirmationMode, depth };
          advisorApplied = true;
          semanticRepairApplied = true;
        } else {
          advisorFailure = clean(error?.code, 120) || 'content_analysis_advisor_failed';
          /* deterministic evidence-linked report remains available */
        }
      }
    }
    const completedAt = this.now().toISOString();
    const visualCoverage = visualEvidence
      ? {
          status:'available',
          mode:visualMode,
          selectedFrames:visualEvidence.frames.length,
          storyboardCount:visualEvidence.storyboards.length,
          firstFrameAt:visualEvidence.coverage?.firstFrameAt || null,
          lastFrameAt:visualEvidence.coverage?.lastFrameAt || null
        }
      : {
          status:visualMode === 'off' ? 'disabled' : 'unavailable',
          mode:visualMode,
          selectedFrames:0,
          storyboardCount:0
        };
    const visualAnalysisApplied = visualMode === 'off'
      || (advisorApplied && validVisualFindings(report.visualFindings, visualEvidence, {
        minFindings:depth === 'full' ? 5 : 3,
        minCategories:depth === 'full' ? 3 : 2
      }));
    const completeness = visualAnalysisApplied ? 'complete' : 'partial';
    report = {
      ...report,
      title:effectiveTitle,
      sourceMetadata,
      boomSignal,
      visualCoverage,
      visualFindings:Array.isArray(report.visualFindings) ? report.visualFindings : [],
      completeness,
      boomSignal
    };
    const sourceRefs = [
      transcriptArtifact.artifactId,
      sourceEvidenceArtifact?.artifactId,
      visualArtifact?.artifactId
    ].filter(Boolean);
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'video_content_analysis_report',
      title:`${effectiveTitle}｜${depth === 'full' ? '完整拆解' : '快速拆解'}`,
      data:{ ...report, generationMode:advisorApplied ? semanticRepairApplied ? 'hermes_advisor_evidence_repaired' : 'hermes_advisor' : 'deterministic_fallback', advisorFailure, semanticRepairApplied, sourceTranscriptArtifactId:transcriptArtifact.artifactId, sourceTranscriptChecksum:transcriptArtifact.checksum || null, generatedAt:completedAt },
      sourceRefs,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        evidenceMode,
        claimsEvidenceLinked:true,
        formalSourceConfirmed:evidenceMode !== 'formal' || transcriptArtifact.type === 'confirmed_transcript',
        confirmationMode:evidenceMode === 'formal' ? confirmationMode : null,
        moduleCount:report.modules.length,
        advisorApplied,
        semanticValidationPassed:advisorApplied,
        boomSignalAttached:Boolean(boomSignal),
        semanticRepairApplied,
        visualMode,
        visualCoverage:visualCoverage.status,
        visualClaimsEvidenceLinked:validVisualFindings(report.visualFindings, visualEvidence),
        visualAnalysisApplied,
        completeness
      },
      completedAt
    });
    return successResult(task, artifact, completedAt, depth === 'full' ? 'full_analysis' : 'fast_analysis', modelUsage);
  }

  async m5VisualAnalysis(task, {
    sourceArtifacts = null,
    allowAdvisor = true,
    providerVision = null,
  } = {}) {
    const sources = Array.isArray(sourceArtifacts) ? sourceArtifacts : await referencedArtifacts(task, this.store);
    const assetPackage = findArtifact(sources, 'asset_package');
    if (!assetPackage) {
      return needsInput(this.now(), 'm5_asset_package_required', 'M5 画面分析必须引用同一活动、同一日期已核验的 AssetPackage。');
    }
    const visualEvidence = await visualEvidenceFromM5AssetPackage(
      assetPackage,
      this.allowedArtifactRoots,
    );
    if (typeof providerVision !== 'function') {
      return needsInput(
        this.now(),
        'm5_provider_vision_required',
        'M5 正式画面分析缺少受控 StepFun 视觉工具回调，不能只用岗位主模型冒充视觉调用。',
      );
    }
    const selectedFrame = visualEvidence.frames[0];
    const selectedStoryboard = visualEvidence.storyboards.find((item) =>
      item.frameId === selectedFrame.frameId
    );
    if (!selectedStoryboard) {
      throw m5VisualError(
        'm5_provider_vision_frame_missing',
        'M5 视觉工具没有找到与关键帧一致的受控图片。',
      );
    }
    const actionId = m5VisionActionId(task, selectedFrame);
    let providerVisionResult;
    try {
      providerVisionResult = await providerVision({
        actionId,
        relativePath:selectedFrame.relativePath,
        prompt:[
          '只分析这张已核验关键帧的可见事实。',
          `帧ID：${selectedFrame.frameId}；时间点：${selectedFrame.timestamp}。`,
          '请描述开场作用、信息层级、镜头节奏线索和可执行剪辑建议；不要推断画面外事实。',
        ].join(''),
      });
    } catch (error) {
      error.code = clean(error?.code, 120) || 'm5_provider_vision_failed';
      error.retryable = error?.retryable !== false;
      throw error;
    }
    const providerReceipt = confirmedM5VisionReceipt({
      value:providerVisionResult?.receipt || providerVisionResult,
      expectedProjectId:providerVisionResult?.projectId,
      expectedActionId:actionId,
      selectedFrame,
    });
    const analysisVisualEvidence = {
      ...visualEvidence,
      frames:[selectedFrame],
      storyboards:[selectedStoryboard],
      coverage:{
        firstFrameAt:selectedFrame.timestamp,
        lastFrameAt:selectedFrame.timestamp,
      },
    };
    if (!allowAdvisor || !this.advisor?.analyze) {
      return needsInput(this.now(), 'm5_visual_analysis_executor_required', 'M5 画面分析执行器不可用，不能用通用建议冒充视觉判断。');
    }
    const transcript = analysisVisualEvidence.frames
      .map((frame) => `[${frame.timestamp}] ${frame.frameId} 是当前可读取的关键帧证据。`)
      .join('\n');
    let advised;
    try {
      advised = await this.advisor.analyze({
        title:clean(task.input?.title, 300) || 'M5 画面分析',
        transcript,
        depth:'fast',
        evidenceMode:'formal',
        focus:'只描述可见事实、画面作用、镜头节奏和可执行剪辑建议。',
        sourceMetadata:null,
        visualEvidence:analysisVisualEvidence,
        providerVisionObservation:providerReceipt.observation,
        validate:(value) => validVisualFindings(
          value?.visualFindings,
          analysisVisualEvidence,
          { minFindings:3, minCategories:2 },
        ),
      });
    } catch (error) {
      error.code = clean(error?.code, 120) || 'm5_visual_analysis_failed';
      error.retryable = true;
      throw error;
    }
    const rawAdvised = advised?.data || advised;
    if (!validVisualFindings(
      rawAdvised?.visualFindings,
      analysisVisualEvidence,
      { minFindings:3, minCategories:2 },
    )) {
      const error = new Error('M5 画面分析结果没有通过原始帧引用和时间点门禁。');
      error.code = 'm5_visual_analysis_evidence_invalid';
      error.retryable = true;
      throw error;
    }
    const normalized = normalizeAdvisedAnalysis(rawAdvised, transcript, analysisVisualEvidence);
    const findings = Array.isArray(normalized?.visualFindings) ? normalized.visualFindings : [];
    if (!validVisualFindings(findings, analysisVisualEvidence, { minFindings:3, minCategories:2 })) {
      const error = new Error('M5 画面分析结果没有通过帧引用和时间点门禁。');
      error.code = 'm5_visual_analysis_evidence_invalid';
      error.retryable = true;
      throw error;
    }
    const completedAt = this.now().toISOString();
    const insights = findings.slice(0, 12).map((item, index) => ({
      insightId:`visual-${String(index + 1).padStart(3, '0')}`,
      category:item.category,
      finding:clean(item.finding, 1_000),
      frameRef:clean(item.evidence?.frameRef, 120),
      timestamp:clean(item.evidence?.timestamp, 40),
      evidenceKind:'stepfun_vision_frame',
      confidence:item.confidence,
    }));
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'visual_analysis_package',
      title:`${clean(task.input?.title, 300) || 'M5 内容'}｜画面分析包`,
      data:{
        schemaVersion:'agent.army/visual-analysis-package/v1',
        sourceAssetPackageId:assetPackage.artifactId,
        providerReceipt:providerReceipt.lineage,
        insights,
        generatedAt:completedAt,
      },
      sourceRefs:[assetPackage.artifactId],
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        sourceAssetPackageBound:true,
        insightCount:insights.length,
        everyInsightEvidenceBound:true,
        providerVisionConfirmed:true,
        externalWrites:0,
      },
      completedAt,
    });
    return successResult(task, artifact, completedAt, 'm5_visual_analysis', advised?.usage || null);
  }

  async performanceReview(task, { sourceArtifacts = null } = {}) {
    const sources = Array.isArray(sourceArtifacts) ? sourceArtifacts : await referencedArtifacts(task, this.store);
    const analysis = findArtifact(sources, 'video_content_analysis_report');
    const draft = findArtifact(sources, 'platform_content_draft');
    const script = findArtifact(sources, 'video_script_package');
    const metrics = normalizeMetrics(task.input?.metrics, task.input?.description);
    if ((!analysis || !draft) && !script) return needsInput(this.now(), 'content_lineage_required', '表现复盘必须引用原拆解与平台草稿，或明确引用已经采用的可拍脚本。');
    if (!Object.keys(metrics).length) return needsInput(this.now(), 'performance_metrics_required', '请提供真实发布指标或指标截图形成的结构化数据。');
    const lifecycle = script ? await templateLifecycleForReview({ store:this.store, script, metrics }) : null;
    const completedAt = this.now().toISOString();
    const data = {
      summary:`已记录 ${Object.keys(metrics).length} 项真实表现指标；本报告只做版本关联和观察，不把单次结果解释为确定因果。`,
      metrics,
      observations:metricObservations(metrics),
      nextActions:[...CONTENT_PERFORMANCE_NEXT_ACTIONS],
      lineage:{
        analysisArtifactId:analysis?.artifactId || null,
        draftArtifactId:draft?.artifactId || null,
        templateArtifactId:script?.artifactId || null
      },
      ...(lifecycle ? { templateLifecycle:lifecycle } : {}),
      generatedAt:completedAt
    };
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'content_performance_report',
      title:`${task.input?.title || '内容'}｜表现复盘`,
      data,
      sourceRefs:[analysis?.artifactId, draft?.artifactId, script?.artifactId].filter(Boolean),
      validation:{ exists:true, readable:true, nonEmpty:true, metricsProvided:true, causalClaimAvoided:true, ...(lifecycle ? { templateState:lifecycle.state } : {}) },
      completedAt
    });
    return successResult(task, artifact, completedAt, 'performance_review');
  }
}

export class LocalContentCreator {
  constructor({
    store,
    artifactsDir,
    allowedArtifactRoots = [],
    advisor = null,
    scriptPackage = null,
    now = () => new Date(),
  } = {}) {
    this.store = store;
    this.artifactsDir = artifactsDir;
    this.allowedArtifactRoots = allowedArtifactRoots.map((item) => path.resolve(item));
    this.advisor = advisor;
    this.scriptPackage = scriptPackage;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'content-creator'; }

  async execute(task, { sourceArtifacts = null, allowAdvisor = true } = {}) {
    if (task.taskType === 'content.video-script-package') {
      if (!this.scriptPackage?.execute) return needsInput(this.now(), 'video_script_package_unavailable', '可拍脚本能力暂时不可用。');
      return this.scriptPackage.execute(task, { allowAdvisor });
    }
    const sources = Array.isArray(sourceArtifacts) ? sourceArtifacts : await referencedArtifacts(task, this.store);
    if (task.input?.context?.paperclipRoutineKey === 'm5-platform-adapt') {
      return this.m5PlatformAdapt(task, sources);
    }
    const transcriptArtifact = findArtifact(sources, 'confirmed_transcript');
    const analysisArtifact = findArtifact(sources, 'video_content_analysis_report');
    if (!transcriptArtifact) return needsInput(this.now(), 'confirmed_transcript_required', '小创必须引用系统质量确认稿或人工确认稿。');
    if (!analysisArtifact || analysisArtifact.data?.evidenceMode !== 'formal') return needsInput(this.now(), 'formal_analysis_required', '小创必须引用小拆基于确认稿生成的正式分析。');
    const platforms = normalizePlatforms(task.input?.platforms, `${task.input?.title || ''}\n${task.input?.description || ''}`);
    if (!platforms.length) return needsInput(this.now(), 'platform_required', '请明确至少一个目标平台。');
    if (platforms.length > 3) return needsInput(this.now(), 'platform_limit_exceeded', '首版一次最多生成三个平台版本。');
    const transcript = await readArtifactText(transcriptArtifact, this.allowedArtifactRoots);
    const evidence = evidenceSegments(transcript);
    const fallback = buildDrafts({
      title:task.input?.title,
      contentGoal:task.input?.contentGoal || task.input?.description,
      platforms,
      analysis:analysisArtifact.data,
      evidence
    });
    let drafts = fallback;
    let modelUsage = null;
    let advisorApplied = false;
    if (allowAdvisor && this.advisor?.draft) {
      try {
        const advisedResult = await this.advisor.draft({ title:task.input?.title, contentGoal:task.input?.contentGoal, platforms, transcript, analysis:analysisArtifact.data });
        const advised = advisedResult?.data || advisedResult;
        modelUsage = advisedResult?.usage || null;
        if (validAdvisedDrafts(advised, platforms)) {
          drafts = advised;
          advisorApplied = true;
        }
      } catch (error) {
        modelUsage = error?.usage || null;
        /* safe local draft remains available */
      }
    }
    const completedAt = this.now().toISOString();
    const data = {
      contentGoal:clean(task.input?.contentGoal || task.input?.description, 500) || '基于已确认内容生成可审核草稿',
      platforms,
      drafts,
      sourceTranscriptChecksum:transcriptArtifact.checksum || null,
      analysisArtifactId:analysisArtifact.artifactId,
      publishingStatus:'draft_only',
      generationMode:advisorApplied ? 'hermes_advisor' : 'deterministic_fallback',
      generatedAt:completedAt
    };
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'platform_content_draft',
      title:`${task.input?.title || '内容'}｜平台草稿`,
      data,
      sourceRefs:[transcriptArtifact.artifactId, analysisArtifact.artifactId],
      validation:{ exists:true, readable:true, nonEmpty:true, confirmedTranscriptUsed:true, formalAnalysisUsed:true, platformCount:platforms.length, externalSideEffects:0, humanChecklistPresent:true, advisorApplied },
      completedAt
    });
    return successResult(task, artifact, completedAt, 'platform_draft', modelUsage);
  }

  async m5PlatformAdapt(task, sources) {
    const script = findArtifact(sources, 'video_script_package');
    const render = findArtifact(sources, 'render_package');
    const context = task.input?.context || {};
    const platform = String(context.pipelineCase?.fields?.platform || '').trim();
    const renderOutput = render?.data?.outputs?.[platform] || render?.data;
    const mediaPath = safeM5RelativePath(renderOutput?.relativePath || renderOutput?.outputPath);
    const checksum = String(renderOutput?.checksum || '').trim().toLowerCase();
    const audioHash = String(renderOutput?.audioHash || '').trim().toLowerCase();
    const voiceProviderActionId = String(renderOutput?.voiceProviderActionId || '').trim();
    const pipelineCaseId = String(context.pipelineCaseId || '').trim();
    const dayCaseId = String(context.pipelineCase?.parentCaseId || '').trim();
    const scheduledDate = String(context.pipelineCase?.fields?.scheduledDate || '').trim();
    if (!script?.data?.fullScript) {
      return needsInput(this.now(), 'm5_script_package_required', 'M5 平台适配缺少同一 Case 的可核验 ScriptPackage。');
    }
    if (!['douyin', 'xiaohongshu'].includes(platform)) {
      return needsInput(this.now(), 'm5_platform_required', 'M5 平台适配缺少同一 Case 的可信平台字段。');
    }
    if (
      !mediaPath
      || !validM5MediaChecksum(checksum)
      || !/^sha256:[0-9a-f]{64}$/i.test(audioHash)
      || !voiceProviderActionId
    ) {
      return needsInput(this.now(), 'm5_render_package_required', 'M5 平台适配缺少带真实相对路径和 sha256 的 RenderPackage。');
    }
    const contentVersionId = deriveM5ContentVersionId({
      pipelineCaseId,
      platform,
      mediaChecksum:checksum,
    });
    if (!contentVersionId) {
      return needsInput(this.now(), 'm5_content_version_identity_invalid', 'M5 平台版本身份无法从当前 Case、平台和成片哈希派生。');
    }
    const completedAt = this.now().toISOString();
    if (!dayCaseId || !scheduledDate) {
      return needsInput(this.now(), 'm5_day_case_lineage_required', 'M5 平台适配缺少日期父 Case 或预约日期血缘。');
    }
    const renderVariantKey = String(renderOutput?.variantKey || 'baseline');
    const grayScriptVariant = script.data?.variants?.gray_douyin || null;
    if (!['baseline', 'gray_douyin'].includes(renderVariantKey)) {
      return needsInput(this.now(), 'm5_variant_lineage_mismatch', '平台成片声明了未知脚本变体，已停止适配。');
    }
    if (platform === 'xiaohongshu' && renderVariantKey !== 'baseline') {
      return needsInput(this.now(), 'm5_cross_platform_gray_rejected', '小红书禁止消费 gray_douyin 脚本、配音或成片。');
    }
    if (platform === 'douyin' && grayScriptVariant && renderVariantKey !== 'gray_douyin') {
      return needsInput(this.now(), 'm5_gray_variant_render_required', '当前抖音 Case 已绑定灰度脚本，但成片不是 gray_douyin，禁止降级为 baseline 继续发布。');
    }
    const expectedVariantKey = renderVariantKey;
    const scriptVariant = script.data?.variants?.[expectedVariantKey]
      || (expectedVariantKey === 'baseline' ? {
        ...script.data,
        variantKey:'baseline',
        templateBinding:script.data?.templateLifecycle?.templateBinding,
      } : null);
    const templateBinding = scriptVariant?.templateBinding;
    const exactGrayTarget = templateBinding?.source === 'approved_single_gray'
      && templateBinding?.grayRelease === true
      && templateBinding?.applicationScope === 'full_content_variant'
      && templateBinding?.grayTargetCaseId === pipelineCaseId
      && templateBinding?.grayTargetDayCaseId === dayCaseId
      && templateBinding?.grayTargetScheduledDate === scheduledDate
      && templateBinding?.grayTargetPlatform === platform
      && platform === 'douyin';
    if (expectedVariantKey === 'gray_douyin' && !exactGrayTarget) {
      return needsInput(this.now(), 'm5_gray_target_mismatch', 'gray_douyin 没有精确绑定当前抖音平台 Case、日期父 Case和预约日期，已停止适配。');
    }
    if (
      expectedVariantKey === 'baseline'
      && (templateBinding?.source === 'approved_single_gray' || templateBinding?.grayRelease === true)
    ) {
      return needsInput(this.now(), 'm5_gray_variant_lineage_mismatch', 'baseline 成片不得携带灰度模板绑定，已停止适配。');
    }
    if (
      !scriptVariant?.fullScript
      || !validM5ProductionTemplateBinding(templateBinding)
      || renderVariantKey !== expectedVariantKey
      || renderOutput?.templateBindingHash !== templateBinding.bindingHash
      || (renderOutput?.scriptHash || null) !== (scriptVariant.scriptHash || null)
    ) {
      return needsInput(this.now(), 'm5_variant_lineage_mismatch', '平台脚本、配音或成片的 variant/binding/scriptHash 血缘不一致。');
    }
    const copy = buildM5PlatformCopy(scriptVariant, platform);
    const templateApplication = {
      mode:'verified_full_content_variant',
      variantKey:expectedVariantKey,
      bindingHash:templateBinding.bindingHash,
      scriptHash:scriptVariant.scriptHash,
      renderChecksum:checksum,
    };
    const contentVersion = {
      contentVersionId,
      platform,
      dayCaseId,
      platformCaseId:pipelineCaseId,
      scheduledDate,
      checksum,
      mediaPath,
      ...copy,
      sourceScriptArtifactId:script.artifactId,
      sourceRenderArtifactId:render.artifactId,
      publishingStatus:'draft_only',
      generatedAt:completedAt,
      templateVersionId:String(
        templateBinding?.templateVersionId || 'm5-template-default-v1',
      ),
      templateWorkProductId:templateBinding?.templateWorkProductId || null,
      templateBindingHash:templateBinding.bindingHash,
      templateApplication,
      audioHash,
      voiceProviderActionId,
      grayRelease:expectedVariantKey === 'gray_douyin' && exactGrayTarget,
    };
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'platform_content_draft',
      title:`${task.input?.title || 'M5 内容'}｜${platform === 'douyin' ? '抖音' : '小红书'}版本`,
      data:{
        contentVersion,
        publishingStatus:'draft_only',
        adaptationMode:'m5_deterministic_from_verified_script_and_render',
      },
      sourceRefs:[script.artifactId, render.artifactId],
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        sourceScriptVerified:true,
        sourceRenderVerified:true,
        mediaChecksumBound:true,
        externalSideEffects:0,
      },
      completedAt,
    });
    return successResult(task, artifact, completedAt, 'm5_platform_adapt');
  }
}

async function referencedArtifacts(task, store) {
  const tasks = typeof store?.list === 'function' ? await store.list() : [];
  const ids = new Set([
    ...(Array.isArray(task.input?.context?.sourceTaskIds) ? task.input.context.sourceTaskIds : []),
    ...(task.parentTaskId ? tasks.filter((item) => item.parentTaskId === task.parentTaskId && item.taskId !== task.taskId).map((item) => item.taskId) : [])
  ].map(String));
  return tasks.filter((item) => ids.has(item.taskId)).flatMap((item) => item.artifactRefs || []);
}

function findArtifact(artifacts, type) {
  return artifacts.find((artifact) => artifact.type === type && artifact.validation?.exists === true && artifact.validation?.readable === true && artifact.validation?.nonEmpty === true) || null;
}

async function readArtifactText(artifact, allowedRoots) {
  const location = String(artifact?.location || '');
  if (!location.startsWith('file://')) throw new Error('内容增长执行器只读取受控本机文件产物。');
  const filePath = path.resolve(fileURLToPath(location));
  const allowed = allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error('产物路径不在内容增长执行器允许范围内。');
  return fs.readFile(filePath, 'utf8');
}

async function readArtifactJson(artifact, allowedRoots) {
  return JSON.parse(await readArtifactText(artifact, allowedRoots));
}

async function readVisualEvidence(artifact, allowedRoots) {
  const payload = await readArtifactJson(artifact, allowedRoots);
  const manifestPath = controlledArtifactPath(artifact, allowedRoots);
  const baseDir = path.dirname(manifestPath);
  const frames = Array.isArray(payload?.frames) ? payload.frames : [];
  const storyboards = Array.isArray(payload?.storyboards) ? payload.storyboards : [];
  if (payload?.schemaVersion !== 'agent.army/visual-evidence/v1' || !frames.length || !storyboards.length) {
    throw new Error('关键帧证据包结构无效。');
  }
  const controlledStoryboards = storyboards.map((storyboard) => {
    const filePath = path.resolve(baseDir, String(storyboard?.localRef || ''));
    const allowed = allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
    if (!allowed || !filePath.startsWith(`${baseDir}${path.sep}`)) throw new Error('关键帧故事板路径超出受控目录。');
    return { ...storyboard, filePath };
  });
  return { ...payload, frames, storyboards:controlledStoryboards };
}

async function visualEvidenceFromM5AssetPackage(artifact, allowedRoots) {
  const assets = Array.isArray(artifact?.data?.assets)
    ? artifact.data.assets.slice(0, 4)
    : [];
  if (!assets.length) throw new Error('AssetPackage 没有可读取的关键帧。');
  const controlled = [];
  for (const asset of assets) {
    const frameId = clean(asset?.frameId, 120);
    const timestamp = clean(asset?.timestamp, 40);
    const relativePath = String(asset?.relativePath || '').trim().replaceAll('\\', '/');
    if (
      !frameId
      || !timestamp
      || !relativePath
      || relativePath.startsWith('/')
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('AssetPackage 的关键帧引用、时间点或路径无效。');
    }
    let filePath = null;
    for (const root of allowedRoots) {
      const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
      const candidate = path.resolve(realRoot, relativePath);
      if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`)) continue;
      const realPath = await fs.realpath(candidate).catch(() => null);
      if (realPath && (realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`))) {
        filePath = realPath;
        break;
      }
    }
    if (!filePath) throw new Error('AssetPackage 的关键帧不在小拆允许读取的工作区。');
    const checksum = String(asset?.checksum || '').trim().toLowerCase();
    if (!validM5MediaChecksum(checksum)) {
      throw new Error('AssetPackage 的关键帧缺少有效 sha256。');
    }
    const bytes = await fs.readFile(filePath);
    const actualChecksum = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (actualChecksum !== checksum) {
      throw new Error('AssetPackage 的关键帧文件与声明 sha256 不一致。');
    }
    controlled.push({
      frameId,
      timestamp,
      reason:'M5 AssetPackage 已核验关键帧',
      relativePath,
      checksum,
      filePath,
    });
  }
  return {
    schemaVersion:'agent.army/visual-evidence/v1',
    frames:controlled.map(({ filePath:_filePath, ...frame }) => frame),
    storyboards:controlled.map((item) => ({
      frameId:item.frameId,
      localRef:path.basename(item.filePath),
      filePath:item.filePath,
    })),
    coverage:{
      firstFrameAt:controlled[0].timestamp,
      lastFrameAt:controlled.at(-1).timestamp,
    },
  };
}

function m5VisionActionId(task, frame) {
  const caseId = String(task?.input?.context?.pipelineCaseId || '').trim();
  const checksum = String(frame?.checksum || '').replace(/^sha256:/i, '');
  if (
    !/^[0-9a-f-]{8,80}$/i.test(caseId)
    || !/^[0-9a-f]{64}$/i.test(checksum)
  ) {
    throw m5VisualError(
      'm5_provider_vision_identity_invalid',
      'M5 视觉 action 缺少可信 Case 或关键帧哈希。',
    );
  }
  return `${caseId}:vision:${checksum.slice(0, 16)}`;
}

function confirmedM5VisionReceipt({
  value,
  expectedProjectId,
  expectedActionId,
  selectedFrame,
}) {
  const record = value?.callRecord;
  const commit = value?.costCommit;
  const projectId = String(expectedProjectId || '').trim();
  const heartbeatRunId = String(record?.costEvent?.heartbeatRunId || '').trim();
  if (
    value?.actionId !== expectedActionId
    || value?.operation !== 'vision'
    || value?.model !== 'step-1o-turbo-vision'
    || value?.sourcePath !== selectedFrame.relativePath
    || String(value?.sourceChecksum || '').toLowerCase() !== selectedFrame.checksum
    || !String(value?.observation || '').trim()
    || record?.actionId !== expectedActionId
    || record?.operation !== 'vision'
    || record?.model !== 'step-1o-turbo-vision'
    || !validM5MediaChecksum(String(record?.promptChecksum || ''))
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId)
    || record?.costEvent?.projectId !== projectId
    || record?.costEvent?.provider !== 'stepfun'
    || !/^[A-Za-z0-9:_-]{1,240}$/.test(heartbeatRunId)
    || commit?.status !== 'confirmed'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(commit?.costEventId || ''))
    || commit?.costEvent?.provider !== 'stepfun'
    || commit?.costEvent?.projectId !== projectId
    || commit?.costEvent?.heartbeatRunId !== heartbeatRunId
    || !Number.isInteger(Number(commit?.costEvent?.costCents))
    || Number(commit.costEvent.costCents) < 0
  ) {
    throw m5VisualError(
      'm5_provider_vision_receipt_invalid',
      'M5 StepFun 视觉回执未确认费用、Project 归属错误或关键帧哈希不匹配。',
    );
  }
  return {
    observation:String(value.observation).slice(0, 20_000),
    lineage:{
      actionId:expectedActionId,
      operation:'vision',
      model:'step-1o-turbo-vision',
      sourcePath:selectedFrame.relativePath,
      sourceChecksum:selectedFrame.checksum,
      callRecord:{
        actionId:expectedActionId,
        operation:'vision',
        model:'step-1o-turbo-vision',
        promptChecksum:String(record.promptChecksum).toLowerCase(),
        costEvent:{
          provider:'stepfun',
          projectId,
          heartbeatRunId,
        },
      },
      costCommit:{
        status:'confirmed',
        costEventId:String(commit.costEventId),
        costEvent:{
          provider:'stepfun',
          projectId,
          heartbeatRunId,
          costCents:Number(commit.costEvent.costCents),
        },
      },
      observationChecksum:`sha256:${crypto.createHash('sha256')
        .update(String(value.observation))
        .digest('hex')}`,
    },
  };
}

function m5VisualError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = true;
  return error;
}

function controlledArtifactPath(artifact, allowedRoots) {
  const location = String(artifact?.location || '');
  if (!location.startsWith('file://')) throw new Error('内容增长执行器只读取受控本机文件产物。');
  const filePath = path.resolve(fileURLToPath(location));
  const allowed = allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error('产物路径不在内容增长执行器允许范围内。');
  return filePath;
}

function evidenceSegments(transcript) {
  const body = String(transcript || '').replace(/^---[\s\S]*?---\s*/m, '').replace(/^#\s+[^\n]+\n+/m, '');
  const timed = [...body.matchAll(/\[((?:\d{2}:)?\d{2}:\d{2})\]\s*([^\n]+)/g)].map((match) => ({ timestamp:match[1], text:clean(match[2], 500) }));
  if (timed.length) return groupEvidenceSegments(timed);
  const untimed = body.split(/\n+/).map((line) => clean(line, 500)).filter((line) => line.length >= 8).map((text) => ({ timestamp:null, text }));
  return groupEvidenceSegments(untimed);
}

function groupEvidenceSegments(segments, maxBlocks = 30) {
  if (segments.length <= maxBlocks) return segments;
  const groupSize = Math.ceil(segments.length / maxBlocks);
  const grouped = [];
  for (let index = 0; index < segments.length; index += groupSize) {
    const group = segments.slice(index, index + groupSize);
    grouped.push({
      timestamp:group[0]?.timestamp || null,
      text:clean(group.map((item) => item.text).join(' '), 2_000)
    });
  }
  return grouped;
}

function buildAnalysis({ title, segments, depth, evidenceMode, confirmationMode = 'human', focus, sourceMetadata = {} }) {
  const usable = segments.length ? segments : [{ timestamp:null, text:'当前转录没有足够可引用片段。' }];
  const moduleNames = depth === 'full' ? FULL_ANALYSIS_MODULES : FAST_ANALYSIS_MODULES;
  const modules = moduleNames.map((name, index) => {
    const evidence = usable[index % usable.length];
    if (depth === 'full') return buildFullModule({ name, index, title, evidence, segments:usable, focus, sourceMetadata });
    return {
      name,
      finding:moduleFinding(name, evidence.text, focus),
      evidence:{ timestamp:evidence.timestamp, fragment:evidence.text },
      confidence:evidence.timestamp ? 'high' : 'medium'
    };
  });
  return {
    title:clean(title, 300) || '视频内容拆解',
    evidenceMode,
    confirmationMode:evidenceMode === 'formal' ? confirmationMode : null,
    evidenceLabel:evidenceMode === 'formal'
      ? confirmationMode === 'automatic' ? '系统质量确认稿' : '人工确认稿'
      : '未经确认的机器稿',
    depth,
    summary:`基于${evidenceMode === 'formal' ? confirmationMode === 'automatic' ? '系统质量确认稿' : '人工确认稿' : '机器稿'}完成 ${modules.length} 个模块的证据化拆解。`,
    modules,
    reusablePatterns:depth === 'full'
      ? modules.find((item) => item.name === '可模仿点 Top3')?.reusablePoints || []
      : modules.slice(0, 3).map((item) => `${item.name}：${item.finding}`),
    actionItems:modules.slice(-3).map((item) => item.optimization?.[0]?.action || `围绕“${item.name}”做一项可单独验证的改动。`)
  };
}

function moduleFinding(name, evidence, focus) {
  const emphasis = clean(focus, 120);
  return `该模块应以“${evidence}”为当前证据基点${emphasis ? `，重点核对${emphasis}` : ''}；后续优化不得超出该片段能够支持的范围。`;
}

function buildFullModule({ name, index, title, evidence, segments, focus, sourceMetadata = {} }) {
  const label = sentenceRole(evidence.text);
  const originalAnalysis = [{
    claim:fullOriginalClaim(name, title, evidence.text, label),
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text }
  }];
  const diagnosis = [{
    issue:fullDiagnosis(name, evidence.text, label),
    severity:index < 5 ? 'high' : 'medium',
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text }
  }];
  const optimization = [{
    action:fullOptimization(name, evidence.text, focus),
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text }
  }];
  const module = {
    name,
    finding:originalAnalysis[0].claim,
    originalAnalysis,
    diagnosis,
    optimization,
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text },
    confidence:evidence.timestamp ? 'high' : 'medium'
  };
  if (name === '基本信息') {
    module.metadata = {
      title:sourceMetadata.title || clean(title, 160) || '未提供',
      author:sourceMetadata.author || '未提供',
      platform:sourceMetadata.platform || '未提供',
      publishedAt:sourceMetadata.publishedAt || '未提供',
      duration:Number.isFinite(sourceMetadata.durationSeconds) ? `${sourceMetadata.durationSeconds} 秒` : '未提供',
      engagement:sourceMetadata.engagement ? JSON.stringify(sourceMetadata.engagement) : '未提供；不得推测'
    };
  }
  if (name === '标题诊断') module.titleFormula = titleFormulaFor(title);
  if (name === '全文逐句作用拆解') {
    module.sentenceBreakdown = segments.map((segment) => ({
      timestamp:segment.timestamp,
      original:segment.text,
      role:sentenceRole(segment.text),
      explanation:sentenceRoleExplanation(sentenceRole(segment.text)),
      evidence:{ timestamp:segment.timestamp, fragment:segment.text }
    }));
  }
  if (name === '可模仿点 Top3') {
    module.reusablePoints = segments.slice(0, 3).map((segment, position) => ({
      rank:position + 1,
      pattern:`${sentenceRole(segment.text)}：${segment.text}`,
      howToReuse:'复用这句话承担的结构作用，不复制原句、身份、案例或结果承诺。',
      caution:'改写后仍需回到自己的事实与素材核对。',
      evidence:{ timestamp:segment.timestamp, fragment:segment.text }
    }));
  }
  if (name === '爆款结构模板') {
    module.structureTemplate = {
      opening:`用“${segments[0]?.text || evidence.text}”承担开场问题或结果承诺，但不得夸大。`,
      body:`按 ${segments.length} 个可核验片段递进展开，每段只承担一个主要作用。`,
      ending:`用“${segments.at(-1)?.text || evidence.text}”对应的收束方式给出一个行动指令。`,
      disclaimer:'这是结构复用模板，不构成播放量或转化承诺。'
    };
  }
  return module;
}

function fullOriginalClaim(name, title, fragment, label) {
  if (name === '基本信息') return `当前可核验标题为“${clean(title, 160) || '未提供'}”；其余元数据未提供，不做推测。`;
  if (name === '标题诊断') return `标题当前匹配“${titleFormulaFor(title).category}”倾向；正文证据片段为“${fragment}”。`;
  if (name === '全文逐句作用拆解') return `确认稿共识别 ${label} 等逐句作用；完整逐句表见本模块 sentenceBreakdown。`;
  return `该模块当前最直接的原文证据是“${fragment}”，主要承担${label}作用。`;
}

function fullDiagnosis(name, fragment, label) {
  if (name === '认知落差检测') return `仅凭当前来源不能判断同行是否已讲清同一主题；可确认的是该片段以${label}传递“${fragment}”。`;
  if (name === '表达效率检测') return `需要核对“${fragment}”是否同时承担多个任务；若无法删减而不损失证据，才保留。`;
  if (name === '基本信息') return '作者、平台、发布时间和互动指标缺失；不得补写或据此推断内容表现。';
  return `该片段的${label}作用可识别，但仍需检查其承诺、上下文和后续兑现是否一致。`;
}

function fullOptimization(name, fragment, focus) {
  const emphasis = clean(focus, 120);
  if (name === '全文逐句作用拆解') return '逐句检查重复、填充词和生硬过渡；每次删改后保留原时间点和版本关系。';
  if (name === '标题诊断') return `先确保标题承诺能由“${fragment}”和正文兑现，再从同类标题公式中选择，不追加无证据数字。`;
  if (name === '爆款结构模板') return '只复用开头—主体—收束的任务分配，不复制原作者的独特表达、案例和结果数字。';
  return `围绕“${fragment}”只改一个变量并保留对照版本${emphasis ? `，优先核对${emphasis}` : ''}。`;
}

function sentenceRole(text) {
  const value = String(text || '');
  if (/关注|点赞|收藏|评论|留言|转发|私信/.test(value)) return 'CTA引导';
  if (/比如|例如|我曾|有一次|案例/.test(value)) return '案例故事';
  if (/\d/.test(value)) return '数据支撑';
  if (/但是|然而|不过|接下来|然后|所以/.test(value)) return '过渡衔接';
  if (/不要|别|避免|必须|不能/.test(value)) return '避坑提醒';
  if (/为什么|问题|痛点|困扰/.test(value)) return '痛点共鸣';
  if (/方法|步骤|框架|原则/.test(value)) return '框架命名';
  if (/最后|总结|总之/.test(value)) return '收尾总结';
  return '观点抛出';
}

function sentenceRoleExplanation(role) {
  return ({
    CTA引导:'推动观众执行一个明确动作。',
    案例故事:'用具体经历帮助理解抽象观点。',
    数据支撑:'用数字增强可核验性，但数字仍需来源。',
    过渡衔接:'连接上下段并提示结构推进。',
    避坑提醒:'指出不能做或容易出错的边界。',
    痛点共鸣:'建立用户问题和继续观看理由。',
    框架命名:'把方法压缩成可记忆结构。',
    收尾总结:'回收前文并结束叙事。',
    观点抛出:'给出当前段落的主要判断。'
  })[role];
}

function titleFormulaFor(title) {
  const value = clean(title, 200);
  if (!value) return { category:'未提供标题', formulaRange:null, note:'没有标题，无法匹配公式。' };
  if (/\d/.test(value)) return { category:'数字锚定或结果承诺', formulaRange:'26–40', note:'需核对数字与时间承诺是否有来源。' };
  if (/为什么/.test(value)) return { category:'认知冲突', formulaRange:'1–6', note:'正文必须真正解释原因。' };
  if (/如何|怎么/.test(value)) return { category:'结果承诺', formulaRange:'33–40', note:'正文必须给出可执行路径。' };
  if (/别|停止|戒掉/.test(value)) return { category:'行动号召', formulaRange:'61–66', note:'需避免空洞命令式表达。' };
  if (/\?|？|秘密|想不到/.test(value)) return { category:'好奇缺口', formulaRange:'7–12', note:'不能用悬念掩盖正文信息不足。' };
  return { category:'陈述型，未匹配强触发公式', formulaRange:null, note:'优先核对标题承诺与正文一致，而不是强套公式。' };
}

function buildDrafts({ title, contentGoal, platforms, analysis, evidence }) {
  const proof = evidence[0] || { timestamp:null, text:'确认稿缺少可展示片段' };
  const second = evidence[1] || proof;
  return platforms.map((platform) => ({
    platform,
    titleCandidates:[
      `${clean(title, 80) || '这条内容'}：先看最关键的一步`,
      `我从这段内容里拆出了一个可复用方法`,
      `别急着照抄，先把这件事想明白`
    ],
    opening:`${proof.text}——这是整条内容最值得先讲清楚的部分。`,
    body:[
      `目标：${clean(contentGoal, 240) || '让读者理解并能执行一个具体方法。'}`,
      `核心展开：${second.text}`,
      `收束：把方法拆成一个今天就能验证的小动作。`
    ],
    pacing:['前 3 秒直接给出问题或结果。', '中段用确认稿中的具体片段支撑。', '结尾只给一个行动指令。'],
    adaptation:platformAdaptation(platform),
    evidence:[proof, second],
    humanChecklist:['事实、数字和身份均能回到确认稿。', '没有复制他人的独特表达。', '标题承诺与正文一致。', '发布前由真人检查平台规范和最终措辞。'],
    analysisSummary:clean(analysis?.summary, 500)
  }));
}

function safeM5RelativePath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  if (
    !relative
    || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
    || !/\.mp4$/i.test(relative)
  ) return null;
  return relative;
}

async function writeArtifact({ artifactsDir, task, type, title, data, sourceRefs, validation, completedAt }) {
  const directory = path.join(artifactsDir, safeSegment(task.taskId));
  await fs.mkdir(directory, { recursive:true });
  const filePath = path.join(directory, `${type}.md`);
  const markdown = renderArtifactMarkdown({ type, title, data, sourceRefs, completedAt });
  await fs.writeFile(filePath, markdown, { encoding:'utf8', mode:0o600 });
  await fs.chmod(filePath, 0o600);
  const stat = await fs.stat(filePath);
  return {
    artifactId:`${type}:${task.taskId}`,
    taskId:task.taskId,
    type,
    title,
    sourceRefs,
    location:`file://${filePath}`,
    mimeType:'text/markdown',
    checksum:crypto.createHash('sha256').update(markdown).digest('hex'),
    accessScope:'local-owner',
    validation:{ ...validation, bytes:stat.size },
    createdAt:completedAt,
    data
  };
}

function renderArtifactMarkdown({ type, title, data, sourceRefs, completedAt }) {
  if (type === 'video_content_analysis_report') {
    return renderVideoAnalysisMarkdown({ title, data, sourceRefs, completedAt });
  }
  return [
    `# ${title}`,
    '',
    `生成时间：${completedAt}`,
    `来源产物：${sourceRefs.join('、')}`,
    '',
    '## 结构化结果',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    ''
  ].join('\n');
}

export function renderVideoAnalysisMarkdown({ title, data, sourceRefs = [], completedAt = '' } = {}) {
  const generation = data?.generationMode === 'hermes_advisor'
    ? 'Hermes 深度分析'
    : data?.generationMode === 'hermes_advisor_evidence_repaired'
      ? 'Hermes 深度分析（证据结构已按确认稿补齐）'
      : '本机证据化兜底（模型结果未通过正式结构校验）';
  const lines = [
    `# ${markdownText(title) || '视频内容拆解报告'}`,
    '',
    `> ${markdownText(data?.summary) || '暂无摘要。'}`,
    '',
    `- 分析方式：${generation}`,
    `- 证据来源：${markdownText(data?.evidenceLabel || data?.evidenceMode) || '未提供'}`,
    `- 分析深度：${data?.depth === 'full' ? '完整拆解' : '快速拆解'}`,
    `- 完整程度：${data?.completeness === 'complete' ? '图文分析完整' : '部分完成，画面分析未通过完整门禁'}`,
    `- 生成时间：${markdownText(completedAt || data?.generatedAt) || '未提供'}`,
    '',
    '## 来源信息',
    '',
    `- 原标题：${markdownText(data?.sourceMetadata?.title) || '未提供'}`,
    `- 作者：${markdownText(data?.sourceMetadata?.author) || '未提供'}`,
    `- 平台：${markdownText(data?.sourceMetadata?.platform) || '未提供'}`,
    `- 时长：${Number.isFinite(data?.sourceMetadata?.durationSeconds) ? `${data.sourceMetadata.durationSeconds} 秒` : '未提供'}`,
    `- 来源：${markdownText(data?.sourceMetadata?.canonicalUrl) || '未提供'}`,
    '',
    '## 画面观察',
    ''
  ];
  const visualFindings = Array.isArray(data?.visualFindings) ? data.visualFindings : [];
  if (visualFindings.length) {
    visualFindings.forEach((item) => {
      lines.push(`- [${markdownText(item?.evidence?.timestamp) || '时间点缺失'}｜${markdownText(item?.evidence?.frameRef) || '帧缺失'}] ${markdownText(item?.finding) || '无结论'}`);
    });
  } else {
    lines.push(data?.visualCoverage?.status === 'disabled' ? '- 本次按要求只分析文字。' : '- 没有通过证据门禁的画面结论；报告按部分完成交付。');
  }
  lines.push(
    '',
    '## 行动清单',
    ''
  );
  appendBullets(lines, data?.actionItems, '暂无明确行动项。');
  lines.push('', '## 可复用模式', '');
  appendBullets(lines, data?.reusablePatterns, '暂无可复用模式。');
  lines.push('', '## 逐项拆解', '');
  const modules = Array.isArray(data?.modules) ? data.modules : [];
  modules.forEach((module, index) => appendAnalysisModule(lines, module, index));
  lines.push(
    '',
    '## 证据说明',
    '',
    data?.evidenceMode === 'formal'
      ? data?.confirmationMode === 'automatic'
        ? '- 本报告基于系统质量门禁自动确认的转录；没有冒充人工听审，重要判断仍应回到所列原文片段复核。'
        : '- 本报告基于人工确认稿；所有判断均应回到所列原文片段复核。'
      : '- 本报告基于未经确认的机器稿，只能作为初步分析。',
    modules.some((module) => module?.evidence?.timestamp)
      ? '- 报告保留了确认稿中可识别的时间点。'
      : '- 确认稿没有可校验时间码，因此证据只能按原文片段定位，不能直接作为精确剪辑点。',
    `- 来源产物：${sourceRefs.map(markdownText).filter(Boolean).join('、') || '未提供'}`,
    ''
  );
  return lines.join('\n');
}

function appendAnalysisModule(lines, module, index) {
  lines.push(`### ${index + 1}. ${markdownText(module?.name) || '未命名模块'}`, '');
  if (module?.finding) lines.push(`**结论：** ${markdownText(module.finding)}`, '');
  if (module?.metadata && typeof module.metadata === 'object') {
    lines.push('#### 可核验信息', '');
    for (const [key, value] of Object.entries(module.metadata)) {
      lines.push(`- ${metadataLabel(key)}：${markdownText(value) || '未提供'}`);
    }
    lines.push('');
  }
  if (module?.titleFormula && typeof module.titleFormula === 'object') {
    lines.push(
      '#### 标题公式',
      '',
      `- 类型：${markdownText(module.titleFormula.category) || '未匹配'}`,
      `- 公式范围：${markdownText(module.titleFormula.formulaRange) || '无'}`,
      `- 提醒：${markdownText(module.titleFormula.note) || '无'}`,
      ''
    );
  }
  appendEvidenceSection(lines, '原文分析', module?.originalAnalysis, 'claim');
  appendEvidenceSection(lines, '问题诊断', module?.diagnosis, 'issue', (item) => severityLabel(item?.severity));
  appendEvidenceSection(lines, '优化建议', module?.optimization, 'action');
  if (Array.isArray(module?.sentenceBreakdown) && module.sentenceBreakdown.length) {
    lines.push(
      '<details>',
      `<summary>展开全文作用拆解（${module.sentenceBreakdown.length} 个连续证据段）</summary>`,
      ''
    );
    module.sentenceBreakdown.forEach((item, position) => {
      lines.push(
        `${position + 1}. **${markdownText(item?.role) || '作用未标注'}**`,
        `   - 原文（${timestampLabel(item?.evidence?.timestamp ?? item?.timestamp)}）：${markdownText(item?.original) || '原文缺失'}`,
        `   - 说明：${markdownText(item?.explanation) || '未提供'}`,
        ''
      );
    });
    lines.push('</details>', '');
  }
  if (Array.isArray(module?.reusablePoints) && module.reusablePoints.length) {
    lines.push('#### 可模仿点', '');
    module.reusablePoints.forEach((item, position) => {
      lines.push(
        `${position + 1}. **${markdownText(item?.pattern) || '模式未命名'}**`,
        `   - 怎么用：${markdownText(item?.howToReuse) || '未提供'}`,
        `   - 注意：${markdownText(item?.caution) || '未提供'}`,
        `   - 证据（${timestampLabel(item?.evidence?.timestamp)}）：${markdownText(item?.evidence?.fragment) || '原文缺失'}`,
        ''
      );
    });
  }
  if (module?.structureTemplate && typeof module.structureTemplate === 'object') {
    lines.push(
      '#### 可复用结构模板',
      '',
      `- 开头：${markdownText(module.structureTemplate.opening) || '未提供'}`,
      `- 主体：${markdownText(module.structureTemplate.body) || '未提供'}`,
      `- 结尾：${markdownText(module.structureTemplate.ending) || '未提供'}`,
      `- 边界：${markdownText(module.structureTemplate.disclaimer) || '未提供'}`,
      ''
    );
  }
}

function appendEvidenceSection(lines, title, items, textKey, prefix = () => '') {
  if (!Array.isArray(items) || !items.length) return;
  lines.push(`#### ${title}`, '');
  items.forEach((item) => {
    const label = prefix(item);
    lines.push(
      `- ${label ? `${label} ` : ''}${markdownText(item?.[textKey]) || '内容缺失'}`,
      `  - 证据（${timestampLabel(item?.evidence?.timestamp)}）：${markdownText(item?.evidence?.fragment) || '原文缺失'}`
    );
  });
  lines.push('');
}

function appendBullets(lines, items, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    lines.push(`- ${emptyText}`);
    return;
  }
  items.forEach((item) => lines.push(`- ${listItemText(item)}`));
}

function listItemText(value) {
  if (!value || typeof value !== 'object') return markdownText(value);
  return markdownText(value.pattern || value.action || value.title || value.finding || value.summary || '未命名条目');
}

function timestampLabel(value) {
  const timestamp = markdownText(value);
  return timestamp ? `时间点 ${timestamp}` : '时间点缺失';
}

function severityLabel(value) {
  return ({ high:'高优先级', medium:'中优先级', low:'低优先级' })[String(value || '').toLowerCase()] || '';
}

function metadataLabel(value) {
  return ({
    title:'标题',
    author:'作者',
    platform:'平台',
    publishedAt:'发布时间',
    duration:'时长',
    engagement:'互动数据'
  })[value] || markdownText(value);
}

function markdownText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function successResult(task, artifact, completedAt, mode, modelUsage = null) {
  return {
    status:'succeeded',
    currentStage:`${mode}_ready`,
    execution:{ executor:task.assigneeAgentId, mode, startedAt:task.execution?.startedAt || completedAt, finishedAt:completedAt, outcome:'artifact_ready' },
    usage:{
      tools:[{ id:`${mode}-write`, name:artifact.title, calls:1 }],
      ...(modelUsage?.model ? { model:modelUsage.model } : {})
    },
    artifactRefs:[artifact]
  };
}

function needsInput(now, code, userMessage) {
  const current = typeof now === 'function' ? now() : now;
  return { status:'needs_input', currentStage:code, error:{ code, userMessage, category:'needs_input', stage:'content_growth_input', occurredAt:current.toISOString() } };
}

function normalizePlatforms(value, text) {
  const explicit = Array.isArray(value) ? value : [];
  const inferred = [
    [/抖音|douyin/i, 'douyin'],
    [/小红书|xiaohongshu|xhs/i, 'xiaohongshu'],
    [/视频号|shipinhao/i, 'shipinhao'],
    [/b站|哔哩哔哩|bilibili/i, 'bilibili']
  ].filter(([pattern]) => pattern.test(text)).map(([, platform]) => platform);
  return [...new Set([...explicit, ...inferred].map((item) => clean(item, 40).toLowerCase()).filter(Boolean))];
}

function normalizeMetrics(value, description) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [clean(key, 80), metricValue(item)]).filter(([key, item]) => key && item !== ''));
  }
  const matches = [...String(description || '').matchAll(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})\s*[:：]\s*([0-9.]+%?|[0-9.]+[万亿]?)/g)];
  return Object.fromEntries(matches.slice(0, 20).map((match) => [match[1], match[2]]));
}

function metricValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isFinite(Number(value)) && value !== null && value !== '') return String(value).slice(0, 120);
  return clean(value, 120);
}

export function metricObservations(metrics) {
  return Object.entries(metrics).slice(0, 6).map(([key, value]) => `${key} 为 ${value}；仅记录观察，尚不能据此确认单一内容变量的因果影响。`);
}

function normalizeBoomSignalContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const grade = ['T1', 'T2', 'T3'].includes(String(value.grade || '').toUpperCase())
    ? String(value.grade).toUpperCase()
    : null;
  const sourceRef = clean(value.sourceRef, 2000);
  if (!grade || !sourceRef) return null;
  const snapshot = JSON.parse(JSON.stringify(value));
  return JSON.stringify(snapshot).length <= 12_000 ? snapshot : null;
}

async function templateLifecycleForReview({ store, script, metrics }) {
  const tasks = typeof store?.list === 'function' ? await store.list() : [];
  const previous = tasks
    .flatMap((item) => item.artifactRefs || [])
    .filter((artifact) => artifact.type === 'content_performance_report' && artifact.data?.lineage?.templateArtifactId === script.artifactId)
    .map((artifact) => artifact.data?.templateLifecycle?.metBaseline)
    .filter((value) => typeof value === 'boolean');
  const metBaseline = metricBoolean(metrics.metBaseline ?? metrics.relativeToBaseline);
  const outcomes = metBaseline === null ? previous : [...previous, metBaseline];
  const baselineSampleSize = Math.max(0, Number(metrics.baselineSampleSize) || 0);
  let state = 'trial';
  let reason = '继续试用；还没有足够的可比较真实表现。';
  if (outcomes.slice(-3).length === 3 && outcomes.slice(-3).every((value) => value === false)) {
    state = 'retired';
    reason = '连续三次低于账号基准，停止自动优先匹配。';
  } else if (baselineSampleSize >= 5 && outcomes.length >= 3 && outcomes.filter(Boolean).length >= 2) {
    state = 'validated';
    reason = '至少使用三次、至少两次达到账号基准，且基准样本不少于五条。';
  }
  return {
    state,
    reason,
    metBaseline,
    comparableUseCount:outcomes.length,
    metBaselineCount:outcomes.filter(Boolean).length,
    baselineSampleSize,
    templateArtifactId:script.artifactId
  };
}

function metricBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', '是', '达到', '高于', 'above', 'met'].includes(normalized)) return true;
  if (['false', 'no', '否', '未达到', '低于', 'below', 'missed'].includes(normalized)) return false;
  return null;
}

function platformAdaptation(platform) {
  return ({
    douyin:'短句、强开场、单一行动指令；成片仍需真人核对画面和音乐版权。',
    xiaohongshu:'标题体现具体收益与适用人群，正文保留可收藏的步骤。',
    shipinhao:'表达更完整，强化可信依据和关系传播语境。',
    bilibili:'允许更长铺垫，但章节承诺与证据仍需清楚。'
  })[platform] || '按目标平台长度和展示形式调整，但不改变已确认事实。';
}

function validAdvisedAnalysis(value, transcript, depth, visualEvidence = null) {
  if (!value || !Array.isArray(value.modules)) return false;
  const expected = depth === 'full' ? FULL_ANALYSIS_MODULES : FAST_ANALYSIS_MODULES;
  const byName = new Map(value.modules.map((module) => [clean(module?.name, 120), module]));
  if (!expected.every((name) => byName.has(name))) return false;
  const modulesValid = expected.every((name) => {
    const module = byName.get(name);
    if (!validAdvisedModuleCore(module, transcript, depth)) return false;
    if (name !== '全文逐句作用拆解') return true;
    return validSentenceBreakdown(module.sentenceBreakdown, transcript, { requireCoverage:true });
  });
  return modulesValid && validVisualFindings(value.visualFindings, visualEvidence, {
    minFindings:visualEvidence ? depth === 'full' ? 5 : 3 : 0,
    minCategories:visualEvidence ? depth === 'full' ? 3 : 2 : 0
  });
}

function repairAdvisedAnalysis(value, fallback, transcript, depth, visualEvidence = null) {
  value = normalizeAdvisedAnalysis(value, transcript, visualEvidence);
  if (!value || !Array.isArray(value.modules) || !fallback?.modules?.length) return null;
  const expected = depth === 'full' ? FULL_ANALYSIS_MODULES : FAST_ANALYSIS_MODULES;
  const advisedByName = new Map(value.modules.map((module) => [clean(module?.name, 120), module]));
  const fallbackByName = new Map(fallback.modules.map((module) => [clean(module?.name, 120), module]));
  let contributedModules = 0;
  const modules = expected.map((name) => {
    const advised = advisedByName.get(name);
    const safeFallback = fallbackByName.get(name);
    if (!advised || !validAdvisedModuleCore(advised, transcript, depth)) return safeFallback;
    contributedModules += 1;
    if (name !== '全文逐句作用拆解') return advised;
    if (!validSentenceBreakdown(advised.sentenceBreakdown, transcript, { requireCoverage:false })) return safeFallback;
    if (validSentenceBreakdown(advised.sentenceBreakdown, transcript, { requireCoverage:true })) return advised;
    return { ...advised, sentenceBreakdown:safeFallback?.sentenceBreakdown || [] };
  });
  const minimumContribution = depth === 'full' ? 7 : 3;
  if (contributedModules < minimumContribution) return null;
  return {
    ...fallback,
    summary:clean(value.summary, 1_000) || fallback.summary,
    modules,
    reusablePatterns:Array.isArray(value.reusablePatterns) && value.reusablePatterns.length
      ? value.reusablePatterns
      : fallback.reusablePatterns,
    actionItems:Array.isArray(value.actionItems) && value.actionItems.length
      ? value.actionItems
      : fallback.actionItems,
    visualFindings:validVisualFindings(value.visualFindings, visualEvidence, {
      minFindings:visualEvidence ? depth === 'full' ? 5 : 3 : 0,
      minCategories:visualEvidence ? depth === 'full' ? 3 : 2 : 0
    }) ? value.visualFindings : []
  };
}

function normalizeAdvisedAnalysis(value, transcript, visualEvidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const modules = Array.isArray(value.modules) ? value.modules.map((module) => {
    if (!module || typeof module !== 'object' || Array.isArray(module)) return module;
    if (evidenceMatches(transcript, module.evidence)) return module;
    const evidence = [
      ...(Array.isArray(module.originalAnalysis) ? module.originalAnalysis : []),
      ...(Array.isArray(module.diagnosis) ? module.diagnosis : []),
      ...(Array.isArray(module.optimization) ? module.optimization : [])
    ].map((item) => item?.evidence).find((item) => evidenceMatches(transcript, item));
    return evidence ? { ...module, evidence } : module;
  }) : value.modules;
  return {
    ...value,
    modules,
    visualFindings:normalizeVisualFindings(value.visualFindings, visualEvidence)
  };
}

function normalizeVisualFindings(value, visualEvidence) {
  const findings = Array.isArray(value) ? value : [];
  if (!visualEvidence) return findings;
  const frames = new Map((visualEvidence.frames || []).map((frame) => [String(frame.frameId || ''), frame]));
  return findings.map((item) => {
    const frameRef = clean(item?.evidence?.frameRef, 120);
    const frame = frames.get(frameRef);
    return frame ? {
      ...item,
      evidence:{ ...item.evidence, frameRef, timestamp:String(frame.timestamp || '') }
    } : item;
  });
}

function validVisualFindings(value, visualEvidence, { minFindings = 0, minCategories = Math.min(minFindings, 1) } = {}) {
  const findings = Array.isArray(value) ? value : [];
  if (!visualEvidence) return findings.length === 0;
  if (findings.length < minFindings) return false;
  if (new Set(findings.map((item) => item?.category)).size < minCategories) return false;
  const frames = new Map((visualEvidence.frames || []).map((frame) => [String(frame.frameId || ''), frame]));
  return findings.every((item) => {
    const finding = clean(item?.finding, 1000);
    const frameRef = clean(item?.evidence?.frameRef, 120);
    const timestamp = clean(item?.evidence?.timestamp, 40);
    const frame = frames.get(frameRef);
    return Boolean(
      finding
      && frame
      && timestamp
      && timestamp === String(frame.timestamp || '')
      && ['opening_visual_hook', 'shot_and_pacing', 'captions_and_graphics', 'people_objects_scenes', 'reusable_visual_pattern'].includes(item?.category)
      && ['high', 'medium', 'low'].includes(item?.confidence)
    );
  });
}

function normalizeSourceMetadata(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const duration = Number(metadata.durationSeconds);
  const engagement = metadata.engagement && typeof metadata.engagement === 'object' && !Array.isArray(metadata.engagement)
    ? metadata.engagement
    : null;
  return {
    title:clean(metadata.title, 500) || null,
    author:clean(metadata.author, 300) || null,
    platform:clean(metadata.platform, 80) || null,
    durationSeconds:Number.isFinite(duration) && duration >= 0 ? duration : null,
    canonicalUrl:clean(metadata.canonicalUrl, 2000) || null,
    publishedAt:clean(metadata.publishedAt, 120) || null,
    engagement:engagement && Object.keys(engagement).length ? engagement : null
  };
}

function validAdvisedModuleCore(module, transcript, depth) {
  if (!evidenceMatches(transcript, module?.evidence)) return false;
  if (depth !== 'full') return true;
  return evidenceLinkedItems(module.originalAnalysis, transcript)
    && evidenceLinkedItems(module.diagnosis, transcript)
    && evidenceLinkedItems(module.optimization, transcript);
}

function validSentenceBreakdown(value, transcript, { requireCoverage }) {
  const breakdown = Array.isArray(value) ? value : [];
  if (!breakdown.length || !breakdown.every((item) => evidenceMatches(transcript, breakdownEvidence(item)))) return false;
  if (!requireCoverage) return true;
  const covered = breakdown.map((item) => evidenceText(breakdownEvidence(item)?.fragment)).join('');
  return evidenceSegments(transcript).every((segment) => covered.includes(evidenceText(segment.text)));
}

function validAdvisedDrafts(value, platforms) {
  return Array.isArray(value) && value.length === platforms.length && value.every((draft) => Array.isArray(draft?.humanChecklist) && draft.humanChecklist.length > 0);
}

function evidenceLinkedItems(value, transcript) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => evidenceMatches(transcript, item?.evidence));
}

function evidenceMatches(transcript, evidence) {
  const fragment = clean(evidence?.fragment, 500);
  if (!fragment || evidenceText(fragment).length < 4) return false;
  const segments = evidenceSegments(transcript);
  const transcriptText = segments.map((segment) => segment.text).join(' ');
  if (!evidenceText(transcriptText).includes(evidenceText(fragment))) return false;
  const timeline = new Set(segments.map((segment) => segment.timestamp).filter(Boolean));
  if (!timeline.size) return true;
  const timestamp = clean(evidence?.timestamp, 40);
  return Boolean(timestamp && timeline.has(timestamp));
}

function breakdownEvidence(item) {
  if (item?.evidence?.fragment) return item.evidence;
  const fragment = item?.fragment || item?.original || item?.text;
  return fragment ? { timestamp:item?.timestamp ?? null, fragment } : null;
}

function evidenceText(value) {
  // “[时间点缺失]”是小D在无时间轴稿上附加的证据等级标记，
  // 不是作者原话。模型引用真实原句时可省略该标记，不能因此误判为
  // “来源片段不存在”。
  return normalize(value)
    .replace(/\[\s*时间点缺失\s*\]/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function clean(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function normalize(value) { return clean(value, 100_000).toLowerCase(); }
function safeSegment(value) { return String(value || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'task'; }
