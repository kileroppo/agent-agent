import crypto from 'node:crypto';
import { m5WorkProductArtifactHash } from '@agent-army/m5-kernel/work-product-integrity';
import {
  M5_PLATFORMS,
  M5_SCHEMA_IDS,
  M5_STEPFUN_MODELS,
  normalizeM5Sha256,
} from '@agent-army/m5-contracts';
import {
  isPaperclipCompletionTaskStatus,
  isTaskExecutionClosedStatus,
} from './task-status-policy.js';
export { ValidationError } from './task-validation-error.js';
export {
  assertM5ExecutorRouteReceipt,
  assertM5PlanRevisionConsumed,
  m5BusinessExecutionInput,
  m5PipelineCaseChainIds,
  m5PlanRevisionExecutionContext,
  m5RelatedTaskContext,
  paperclipCaseContextFields,
  prepareM5ExecutorTask,
  trustedRoleToolScope,
} from './task-service-m5-execution-context-support.js';
import { ValidationError } from './task-validation-error.js';

export function isTerminalTask(task) {
  return isTaskExecutionClosedStatus(task?.status);
}

export function validatedM5StagePluginData(stageKey, expectedArtifactKind, result) {
  const declared = declaredM5StageArtifact(result, expectedArtifactKind);
  const data = structuredClone(declared?.data || result);
  delete data.toolId;
  delete data.pluginId;
  delete data.artifact;
  delete data.artifactRefs;
  const unsafe = findUnsafeM5PluginValue(data);
  if (unsafe) throw new ValidationError(`M5 内容插件回执包含不允许持久化的字段或路径：${unsafe}。`);
  if (stageKey === 'parallel_image_generation') {
    if (
      !safeRelativeArtifactPath(data.relativePath, '.png')
      || !sha256Value(data.checksum)
      || !Number.isInteger(Number(data.bytes))
      || Number(data.bytes) <= 0
      || data.model !== M5_STEPFUN_MODELS.image_generate
      || !Number.isInteger(Number(data.seed))
      || !validConfirmedM5ProviderReceipt(data.providerReceipt, 'image_generate')
    ) {
      throw new ValidationError('M5 并行生图回执缺少真实 PNG、模型、种子或 confirmed Provider action/cost 血缘。');
    }
  } else if (stageKey === 'voice') {
    if (
      !safeRelativeArtifactPath(data.relativePath, '.mp3')
      || !sha256Value(data.checksum)
      || !Number.isInteger(Number(data.bytes))
      || Number(data.bytes) <= 0
      || data.model !== M5_STEPFUN_MODELS.tts
      || !String(data.voice || '').trim()
      || !validConfirmedM5ProviderReceipt(data.providerReceipt || data, 'tts')
    ) {
      throw new ValidationError('M5 配音回执缺少真实 MP3、模型、官方音色或 confirmed Provider action/cost 血缘。');
    }
  } else if (stageKey === 'render') {
    if (declared && data.outputs) {
      const expected = {
        master:['M5Master', 'master.mp4'],
        douyin:['M5Douyin', 'douyin.mp4'],
        xiaohongshu:['M5Xiaohongshu', 'xiaohongshu.mp4'],
      };
      if (
        typeof data.outputs !== 'object'
        || Array.isArray(data.outputs)
        || Object.keys(expected).some((platform) =>
          !validM5RenderOutput(data.outputs[platform], ...expected[platform]),
        )
      ) {
        throw new ValidationError('M5 RenderPackage 必须包含 master、douyin、xiaohongshu 三份固定成片及真实回执。');
      }
      if (data.socialCardPackage != null && !validM5SocialCardPackage(data.socialCardPackage)) {
        throw new ValidationError('M5 RenderPackage 的静态卡包缺少可信 PNG、固定尺寸、哈希、模板或版权血缘。');
      }
      const master = data.outputs.master;
      Object.assign(data, {
        composition:master.composition,
        propsPath:master.propsPath,
        outputPath:master.outputPath,
        relativePath:master.outputPath,
        checksum:master.checksum,
        bytes:Number(master.bytes),
      });
    } else {
      if (
        !safeRelativeArtifactPath(data.outputPath, '.mp4')
        || !sha256Value(data.checksum)
        || !Number.isInteger(Number(data.bytes))
        || Number(data.bytes) <= 0
        || !['M5Master', 'M5Douyin', 'M5Xiaohongshu'].includes(data.composition)
      ) {
        throw new ValidationError('M5 渲染回执缺少真实 MP4 相对路径、文件哈希、字节数或固定 Composition。');
      }
      data.relativePath = data.outputPath;
    }
  } else if (stageKey === 'machine_review') {
    if (!declared) {
      throw new ValidationError('M5 机器审核必须返回显式专用 artifact，单一 media-validate 回执不能冒充完整审核。');
    }
    const review = data.reviewReport && typeof data.reviewReport === 'object'
      ? data.reviewReport
      : data;
    const checks = review.checks;
    const requiredChecks = ['facts', 'privacy', 'rights', 'media', 'claims', 'grantScope', 'duplicate'];
    if (
      !['passed', 'failed'].includes(review.status)
      || !checks
      || typeof checks !== 'object'
      || requiredChecks.some((key) => typeof checks[key] !== 'boolean')
    ) {
      throw new ValidationError('M5 机器审核专用产物缺少七项门禁的确定性结论。');
    }
    if (review.status === 'passed' && !validM5ArtifactPackage(review.evidence?.artifactPackage)) {
      throw new ValidationError('M5 机器审核通过回执缺少已校验的固定产物包、manifest 哈希或完整产物清单。');
    }
    return { reviewReport:structuredClone(review) };
  } else if (stageKey === 'publish_approval') {
    if (
      typeof data.passed !== 'boolean'
      || !Array.isArray(data.errors)
      || !String(data.idempotencyKey || '').trim()
    ) {
      throw new ValidationError('M5 发布审批回执缺少确定性门禁结论或幂等键。');
    }
    data.status = data.passed ? 'passed' : 'failed';
  } else if (stageKey === 'verify') {
    if (
      !declared
      || data.status !== 'passed'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(data.receiptId || ''))
      || !M5_PLATFORMS.includes(data.platform)
      || !String(data.externalContentId || '').trim()
      || !String(data.evidence || '').trim()
      || !sha256Value(data.contentChecksum)
    ) {
      throw new ValidationError('M5 发布核验专用产物缺少可信 PublishReceipt、平台内容ID、成功证据或内容哈希。');
    }
  } else {
    throw new ValidationError(`M5 阶段 ${stageKey} 没有插件回执校验器。`);
  }
  return data;
}

export function declaredM5StageArtifact(result, expectedArtifactKind) {
  const candidates = [
    result?.artifact,
    ...(Array.isArray(result?.artifactRefs) ? result.artifactRefs : []),
  ].filter(Boolean);
  if (!candidates.length) return null;
  const matches = candidates.filter((item) => item?.type === expectedArtifactKind);
  if (matches.length !== 1) {
    throw new ValidationError(`M5 阶段必须且只能返回一个 ${expectedArtifactKind} 专用产物。`);
  }
  const artifact = matches[0];
  if (
    !artifact.data
    || typeof artifact.data !== 'object'
    || Array.isArray(artifact.data)
    || artifact.validation?.exists !== true
    || artifact.validation?.readable !== true
    || artifact.validation?.nonEmpty !== true
  ) {
    throw new ValidationError(`M5 ${expectedArtifactKind} 专用产物没有通过 exists/readable/nonEmpty 门禁。`);
  }
  return artifact;
}

export function validM5RenderOutput(value, composition, fileName) {
  return value
    && value.composition === composition
    && safeRelativeArtifactPath(value.propsPath, '.props.json')
    && safeRelativeArtifactPath(value.outputPath, '.mp4')
    && String(value.outputPath).replaceAll('\\', '/').endsWith(`/${fileName}`)
    && sha256Value(value.checksum)
    && Number.isInteger(Number(value.bytes))
    && Number(value.bytes) > 0;
}

export function validM5SocialCardPackage(value) {
  const outputDir = safeRelativeDirectory(value?.outputDir);
  const cards = Array.isArray(value?.cards) ? value.cards : [];
  const checks = value?.checks;
  return value?.schemaVersion === M5_SCHEMA_IDS.SOCIAL_CARD_PACKAGE
    && value?.platform === 'xiaohongshu'
    && outputDir
    && safeRelativeArtifactPath(value?.propsPath, '.json')
    && String(value.propsPath).replaceAll('\\', '/').endsWith('/social-card.props.json')
    && sha256Value(value?.propsChecksum)
    && safeRelativeArtifactPath(value?.manifestPath, '.json')
    && String(value.manifestPath).replaceAll('\\', '/').endsWith('/social-card-render-manifest.json')
    && sha256Value(value?.manifestChecksum)
    && sha256Value(value?.templateBindingHash)
    && String(value?.rightsBasis || '').trim().length > 0
    && value?.rightsBasisHash === sha256Text(value.rightsBasis)
    && cards.length >= 3
    && cards.length <= 9
    && cards.every((card) =>
      /^[a-z0-9][a-z0-9-]{1,48}$/i.test(String(card?.id || ''))
      && safeRelativeArtifactPath(card?.relativePath, '.png')
      && String(card.relativePath).replaceAll('\\', '/').startsWith(`${outputDir}/`)
      && Number(card?.width) === 1080
      && Number(card?.height) === 1440
      && Number.isInteger(Number(card?.bytes))
      && Number(card.bytes) > 0
      && sha256Value(card?.checksum)
    )
    && checks?.dimensions === true
    && checks?.fileHashes === true
    && checks?.assetLineage === true
    && checks?.rightsBasis === true
    && checks?.externalNetworkUsed === false;
}

export function safeRelativeDirectory(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return relative
    && !relative.startsWith('/')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
    ? relative
    : null;
}

export function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

export function findUnsafeM5PluginValue(value, path = 'result', seen = new Set()) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (/^(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/])/.test(value.trim())) return path;
    return null;
  }
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return `${path}.__cycle__`;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:secret|token|cookie|authorization|credential|api[_-]?key)/i.test(key)) {
      return `${path}.${key}`;
    }
    const unsafe = findUnsafeM5PluginValue(nested, `${path}.${key}`, seen);
    if (unsafe) return unsafe;
  }
  return null;
}

export function safeRelativeArtifactPath(value, extension) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(
    relative
    && relative.toLowerCase().endsWith(extension)
    && !relative.startsWith('/')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
  );
}

export function safeRelativeImageArtifactPath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(
    relative
    && /\.(?:jpe?g|png|webp)$/i.test(relative)
    && !relative.startsWith('/')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

export function safeM5VisionRelativePath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(
    relative
    && /\.png$/i.test(relative)
    && !relative.startsWith('/')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

export function sha256Value(value) {
  return Boolean(normalizeM5Sha256(value));
}

export function paperclipUuid(value) {
  const id = String(value || '').trim();
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

export function validConfirmedM5ProviderReceipt(value, operation) {
  const actionId = String(value?.actionId || '').trim();
  const record = value?.callRecord;
  const commit = value?.costCommit;
  return /^[A-Za-z0-9:_-]{8,160}$/.test(actionId)
    && value?.operation === operation
    && record?.actionId === actionId
    && record?.operation === operation
    && record?.model === value?.model
    && sha256Value(record?.promptChecksum)
    && commit?.status === 'confirmed'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(commit?.costEventId || ''))
    && commit?.costEvent?.provider === 'stepfun'
    && Number.isInteger(Number(commit?.costEvent?.costCents))
    && Number(commit.costEvent.costCents) >= 0;
}

export function taskExecutionView(task) {
  return {
    taskId:task.taskId,
    taskType:task.taskType,
    status:task.status,
    currentStage:task.currentStage,
  };
}

export function m5WorkProductMetadata({ contract, task, artifact, assignment }) {
  const expected = contract.expectedWorkProduct;
  const safeData = sanitizeM5ArtifactData(artifact.data);
  const metadata = {
    schemaVersion:expected.schemaVersion,
    kind:expected.type,
    stageKey:contract.stageKey,
    routineKey:contract.routineKey,
    sourceTaskId:task.taskId,
    sourceArtifactId:String(artifact.artifactId || `${artifact.type}:${task.taskId}`).slice(0, 240),
    sourceIssueId:String(assignment?.issueId || task.governance?.paperclipIssueId || '').trim(),
    pipelineCaseId:String(assignment?.pipelineCaseId || task.input?.context?.pipelineCaseId || '').trim(),
    projectId:String(assignment?.projectId || task.input?.context?.paperclipProjectId || '').trim(),
    sourceRunId:String(assignment?.runId || task.execution?.paperclipRunId || '').trim(),
    artifactKind:artifact.type,
    artifact:safeData,
  };
  metadata.artifactHash = m5WorkProductArtifactHash(metadata);
  if (expected.type === 'ContentVersion') {
    const contentVersion = safeData?.contentVersion;
    if (!validM5ContentVersion(contentVersion)) {
      throw new ValidationError(
        '平台适配产物缺少可发布 ContentVersion（平台、版本、sha256、相对媒体路径、标题、正文和标签）。',
      );
    }
    metadata.contentVersion = contentVersion;
  }
  if (expected.type === 'MachineReview') {
    const reviewReport = safeData?.reviewReport;
    if (!validM5MachineReview(reviewReport)) {
      throw new ValidationError('机器审核产物没有完整通过七项发布门禁，不能写成可信 MachineReview。');
    }
    metadata.reviewReport = reviewReport;
  }
  return metadata;
}

export function m5WorkProductProvider(kind) {
  return ['ContentVersion', 'MachineReview'].includes(kind)
    ? 'agent-army.content-autonomy'
    : 'agent-army.ajun-runtime';
}

export function sanitizeM5ArtifactData(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = value.slice(0, 20_000);
    if (/^file:\/\//i.test(text) || /^(?:\/|[A-Za-z]:[\\/])/.test(text)) {
      return '[redacted-local-path]';
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeM5ArtifactData(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, 2_000);
  const denied = /(?:^|_)(?:authorization|cookie|credentials?|password|secrets?|session|token|api[_-]?key|file[_-]?path|local[_-]?path)(?:$|_)/i;
  return Object.fromEntries(Object.entries(value).slice(0, 300).flatMap(([key, child]) =>
    denied.test(key) ? [] : [[key, sanitizeM5ArtifactData(child, depth + 1)]],
  ));
}

export function validM5ContentVersion(value) {
  return value
    && M5_PLATFORMS.includes(value.platform)
    && /^[a-z0-9][a-z0-9_.:-]{2,127}$/i.test(String(value.contentVersionId || ''))
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.checksum || ''))
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.audioHash || ''))
    && /^[-_a-z0-9:.]{8,}$/i.test(String(value.voiceProviderActionId || ''))
    && validM5RelativePath(value.mediaPath)
    && Boolean(String(value.title || '').trim())
    && Boolean(String(value.body || '').trim())
    && Array.isArray(value.tags);
}

export function validM5MachineReview(value) {
  const checks = [
    'facts',
    'privacy',
    'rights',
    'media',
    'claims',
    'grantScope',
    'duplicate',
  ];
  return value?.status === 'passed'
    && checks.every((key) => value?.checks?.[key] === true)
    && validM5ArtifactPackage(value?.evidence?.artifactPackage);
}

const M5_REQUIRED_ARTIFACTS = Object.freeze([
  'master.mp4',
  'douyin.mp4',
  'xiaohongshu.mp4',
  'douyin.copy.json',
  'xiaohongshu.copy.json',
  'cover.png',
  'sources.json',
  'review.json',
  'lineage.json',
]);

export function validM5ArtifactPackage(value) {
  const artifacts = Array.isArray(value?.requiredArtifacts)
    ? value.requiredArtifacts.map((item) => String(item || '').trim())
    : [];
  return validM5RelativePath(value?.manifestPath)
    && String(value.manifestPath).endsWith('/artifact-manifest.json')
    && sha256Value(value?.manifestChecksum)
    && artifacts.length === M5_REQUIRED_ARTIFACTS.length
    && new Set(artifacts).size === M5_REQUIRED_ARTIFACTS.length
    && M5_REQUIRED_ARTIFACTS.every((name) => artifacts.includes(name));
}

export function validM5RelativePath(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(text)
    && !text.startsWith('/')
    && text.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function outputItems(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

export function canonicalOpenResearchExecutionPolicy(issue) {
  const value = issue?.executionPolicy?.openResearch;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({
    remainingUnits:value.remainingUnits,
    estimatedNextStepUnits:value.estimatedNextStepUnits,
  });
}

export function verifiedAssignmentArtifact(item) {
  return item?.validation?.exists === true
    && item?.validation?.readable === true
    && item?.validation?.nonEmpty === true;
}
export function storedPaperclipEmployeeResult(task) {
  const execution = task?.execution?.paperclipEmployee;
  if (execution?.state === 'running' && task.status === 'running') {
    return {
      status:'running',
      currentStage:task.currentStage,
      verified:false,
      recommendedCompletionStatus:'running',
      continuePolling:true,
      pollAfterSeconds:30,
      message:'当前岗位的本机工作仍在执行；服务端会先等待结果，超时后再查询即可。',
      artifacts:[],
    };
  }
  if (execution?.state === 'settled') {
    return {
      status:String(execution.status || execution.recommendedCompletionStatus || 'waiting_test'),
      currentStage:task.currentStage,
      verified:execution.verified === true,
      recommendedCompletionStatus:isPaperclipCompletionTaskStatus(execution.recommendedCompletionStatus)
        ? execution.recommendedCompletionStatus
        : 'waiting_test',
      error:task.error || null,
      artifacts:(task.artifactRefs || []).filter(verifiedAssignmentArtifact).map(artifactExecutionView),
    };
  }
  if (isTerminalTask(task)) {
    const verified = task.status === 'succeeded' && (task.artifactRefs || []).some(verifiedAssignmentArtifact);
    return {
      status:task.status,
      currentStage:task.currentStage,
      verified,
      recommendedCompletionStatus:verified
        ? 'succeeded'
        : task.status === 'failed'
          ? 'failed'
          : 'waiting_test',
      error:task.error || null,
      artifacts:(task.artifactRefs || []).filter(verifiedAssignmentArtifact).map(artifactExecutionView),
    };
  }
  return null;
}
export function artifactExecutionView(item) {
  return {
    type:item.type,
    title:item.title,
    checksum:item.checksum || null,
    validation:item.validation,
    data:item.data
  };
}
import { isVerifiedVideoAnalysisArtifact } from './task-completion-contract.js';

export function contentGrowthArtifactVerified(task, artifact, { expectedProjectId = null } = {}) {
  const readable = artifact?.validation?.exists === true
    && artifact?.validation?.readable === true
    && artifact?.validation?.nonEmpty === true;
  if (!readable) return false;
  if (task?.taskType === 'content.campaign-visual-analysis') {
    const insights = artifact?.data?.insights;
    const receipt = artifact?.data?.providerReceipt;
    return Array.isArray(insights)
      && insights.length > 0
      && insights.every((item) =>
        String(item?.finding || '').trim()
        && String(item?.frameRef || '').trim()
        && String(item?.timestamp || '').trim()
        && String(item?.evidenceKind || '').trim(),
      )
      && validConfirmedM5ProviderReceipt(receipt, 'vision')
      && safeRelativeImageArtifactPath(receipt?.sourcePath)
      && sha256Value(receipt?.sourceChecksum)
      && sha256Value(receipt?.observationChecksum)
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(
        receipt?.costCommit?.costEvent?.projectId || '',
      ))
      && (
        expectedProjectId == null
        || receipt?.costCommit?.costEvent?.projectId === expectedProjectId
      );
  }
  if (task?.taskType === 'content.video-benchmark-analysis') {
    return isVerifiedVideoAnalysisArtifact(task, artifact);
  }
  return true;
}
export function storedContentGrowthResult(task) {
  const execution = task?.execution?.contentGrowth;
  if (execution?.state !== 'settled') return null;
  const recommendedCompletionStatus = isPaperclipCompletionTaskStatus(execution.recommendedCompletionStatus)
    ? execution.recommendedCompletionStatus
    : 'waiting_test';
  return {
    status:String(execution.status || recommendedCompletionStatus),
    currentStage:task.currentStage,
    verified:execution.verified === true,
    recommendedCompletionStatus,
    error:task.error || null,
    artifacts:[]
  };
}
export async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled:false }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ settled:true, value })),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeArchitectureLayers(input = {}) {
  const explicitFacts = (Array.isArray(input.factClaims) ? input.factClaims : []).slice(0, 20).map((item) => ({
    claim:architectureText(item?.claim, 1000),
    evidenceRefs:architectureStrings(item?.evidenceRefs || item?.evidence_refs, 10, 500)
  })).filter((item) => item.claim && item.evidenceRefs.length);
  const legacyFacts = (Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []).slice(0, 30).map((item) => ({
    claim:architectureText(item?.claim, 1000),
    evidenceRefs:architectureStrings([item?.ref], 1, 500)
  })).filter((item) => item.claim && item.evidenceRefs.length);
  const architectureJudgments = (Array.isArray(input.architectureJudgments) ? input.architectureJudgments : []).slice(0, 20).map((item) => ({
    judgment:architectureText(item?.judgment, 1200),
    basisRefs:architectureStrings(item?.basisRefs || item?.basis_refs, 10, 500),
    assumptions:architectureStrings(item?.assumptions, 10, 600),
    confidence:['low', 'medium', 'high'].includes(item?.confidence) ? item.confidence : 'low'
  })).filter((item) => item.judgment && (item.basisRefs.length || item.assumptions.length));
  const candidateProposals = (Array.isArray(input.candidateProposals) ? input.candidateProposals : []).slice(0, 10).map((item) => ({
    proposal:architectureText(item?.proposal, 1200),
    problem:architectureText(item?.problem, 1000),
    validationPlan:architectureText(item?.validationPlan || item?.validation_plan, 1500),
    risks:architectureStrings(item?.risks, 10, 600),
    nonGoals:architectureStrings(item?.nonGoals || item?.non_goals, 10, 600)
  })).filter((item) => item.proposal && item.problem && item.validationPlan);
  return {
    factClaims:explicitFacts.length ? explicitFacts : legacyFacts,
    architectureJudgments,
    candidateProposals,
    currentStateUnknowns:architectureStrings([
      ...(Array.isArray(input.currentStateUnknowns) ? input.currentStateUnknowns : []),
      ...(Array.isArray(input.unverifiedClaims) ? input.unverifiedClaims : [])
    ], 20, 1000)
  };
}

export function architectureText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function architectureStrings(values, maxItems, maxLength) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => architectureText(item, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}
