import crypto from 'node:crypto';
import { validM5MediaChecksum } from '@agent-army/m5-kernel/content-version';
import {
  findArtifact,
  needsInput,
  referencedArtifacts,
  successResult,
  visualEvidenceFromM5AssetPackage,
  writeArtifact,
} from './local-content-artifacts.js';

const m5VisualAnalysisMethods = {
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

};

export function executeM5VisualAnalysis(host, task, options = {}) {
  return m5VisualAnalysisMethods.m5VisualAnalysis.call(host, task, options);
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

export function normalizeAdvisedAnalysis(value, transcript, visualEvidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...value,
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

export function validVisualFindings(value, visualEvidence, { minFindings = 0, minCategories = Math.min(minFindings, 1) } = {}) {
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

function clean(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
