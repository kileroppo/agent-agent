import crypto from 'node:crypto';

export class M5ContractError extends TypeError {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'M5ContractError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const M5_CONTRACT_ERROR_CODES = Object.freeze({
  PLATFORM_UNSUPPORTED:'m5_platform_unsupported',
  PUBLISH_ACTION_PROHIBITED:'m5_publish_action_prohibited',
  PUBLISH_ACTION_UNSUPPORTED:'m5_publish_action_unsupported',
  PROVIDER_OPERATION_UNSUPPORTED:'m5_provider_operation_unsupported',
  WORK_PRODUCT_KIND_UNSUPPORTED:'m5_work_product_kind_unsupported',
  WORK_PRODUCT_SCHEMA_MISMATCH:'m5_work_product_schema_mismatch',
  SCHEMA_ID_UNSUPPORTED:'m5_schema_id_unsupported',
  SHA256_INVALID:'m5_sha256_invalid',
  WORK_PRODUCT_IDENTITY_INVALID:'m5_work_product_identity_invalid',
});

export const M5_PLATFORM_IDS = Object.freeze({
  DOUYIN:'douyin',
  XIAOHONGSHU:'xiaohongshu',
});
export const M5_PLATFORMS = Object.freeze(Object.values(M5_PLATFORM_IDS));
export const M5_ALLOWED_PUBLISH_ACTIONS = Object.freeze([
  'upload',
  'fill_metadata',
  'schedule_or_publish',
  'read_own_metrics',
]);
export const M5_PROHIBITED_PUBLISH_ACTIONS = Object.freeze([
  'direct_message',
  'comment',
  'follow',
  'paid_promotion',
  'payment',
  'account_settings',
  'delete_history',
]);
export const M5_STEPFUN_MODELS = Object.freeze({
  vision:'step-1o-turbo-vision',
  image_generate:'step-image-edit-2',
  image_edit:'step-image-edit-2',
  tts:'stepaudio-2.5-tts',
});
export const M5_SCHEMA_IDS = Object.freeze({
  CAMPAIGN_GRANT:'agent.army/campaign-grant/v1',
  CAMPAIGN_PLAN:'agent.army/campaign-plan/v1',
  TOPIC_SELECTION:'agent.army/topic-selection/v1',
  CAMPAIGN_RESEARCH_REPORT:'agent.army/campaign-research/v2',
  EVIDENCE_PACKAGE:'agent.army/evidence-package/v2',
  SCRIPT_PACKAGE:'agent.army/video-script-package/v1',
  ASSET_PACKAGE:'agent.army/asset-package/v1',
  VISUAL_ANALYSIS_PACKAGE:'agent.army/visual-analysis-package/v1',
  GENERATED_IMAGE_PACKAGE:'agent.army/generated-image-package/v1',
  VOICE_PACKAGE:'agent.army/voice-package/v1',
  PARALLEL_WORK_BRANCH:'agent.army/parallel-work-branch/v1',
  PARALLEL_WORK_BATCH:'agent.army/parallel-work-batch/v1',
  PARALLEL_JOIN:'agent.army/parallel-work-join/v1',
  RENDER_PACKAGE:'agent.army/render-package/v1',
  MACHINE_REVIEW:'agent.army/machine-review/v1',
  CONTENT_VERSION:'agent.army/content-version/v1',
  PUBLISH_APPROVAL:'agent.army/publish-approval/v1',
  PUBLISH_RECEIPT:'agent.army/publish-receipt/v1',
  PUBLISH_VERIFICATION:'agent.army/publish-verification/v1',
  METRIC_SNAPSHOT:'agent.army/metric-snapshot/v1',
  RETROSPECTIVE:'agent.army/m5-retrospective/v1',
  LEARNING_PROPOSAL:'agent.army/learning-proposal/v1',
  OFFLINE_REPLAY:'agent.army/m5-offline-replay/v1',
  TEMPLATE_VERSION:'agent.army/template-version/v1',
  TEMPLATE_GRAY_RELEASE:'agent.army/template-gray-release/v1',
  TEMPLATE_DECISION:'agent.army/template-decision/v1',
  PRODUCTION_TEMPLATE_BINDING:'agent.army/production-template-binding/v1',
});
export const M5_WORK_PRODUCT_SCHEMAS = Object.freeze({
  TopicSelection:M5_SCHEMA_IDS.TOPIC_SELECTION,
  CampaignResearchReport:M5_SCHEMA_IDS.CAMPAIGN_RESEARCH_REPORT,
  EvidencePackage:M5_SCHEMA_IDS.EVIDENCE_PACKAGE,
  ScriptPackage:M5_SCHEMA_IDS.SCRIPT_PACKAGE,
  AssetPackage:M5_SCHEMA_IDS.ASSET_PACKAGE,
  VisualAnalysisPackage:M5_SCHEMA_IDS.VISUAL_ANALYSIS_PACKAGE,
  GeneratedImagePackage:M5_SCHEMA_IDS.GENERATED_IMAGE_PACKAGE,
  VoicePackage:M5_SCHEMA_IDS.VOICE_PACKAGE,
  ParallelJoin:M5_SCHEMA_IDS.PARALLEL_JOIN,
  RenderPackage:M5_SCHEMA_IDS.RENDER_PACKAGE,
  MachineReview:M5_SCHEMA_IDS.MACHINE_REVIEW,
  ContentVersion:M5_SCHEMA_IDS.CONTENT_VERSION,
  PublishApproval:M5_SCHEMA_IDS.PUBLISH_APPROVAL,
  PublishReceipt:M5_SCHEMA_IDS.PUBLISH_RECEIPT,
  PublishVerification:M5_SCHEMA_IDS.PUBLISH_VERIFICATION,
  MetricSnapshot:M5_SCHEMA_IDS.METRIC_SNAPSHOT,
  Retrospective:M5_SCHEMA_IDS.RETROSPECTIVE,
  LearningProposal:M5_SCHEMA_IDS.LEARNING_PROPOSAL,
  OfflineReplay:M5_SCHEMA_IDS.OFFLINE_REPLAY,
  TemplateVersion:M5_SCHEMA_IDS.TEMPLATE_VERSION,
  TemplateGrayRelease:M5_SCHEMA_IDS.TEMPLATE_GRAY_RELEASE,
  TemplateDecision:M5_SCHEMA_IDS.TEMPLATE_DECISION,
});
export const M5_WORK_PRODUCT_KINDS = Object.freeze(Object.keys(M5_WORK_PRODUCT_SCHEMAS));
export const M5_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

const M5_WORK_PRODUCT_KIND_BY_TOKEN = new Map(
  M5_WORK_PRODUCT_KINDS.map((kind) => [normalizeCompactToken(kind), kind]),
);
const M5_SCHEMA_ID_SET = new Set(Object.values(M5_SCHEMA_IDS));

export function normalizeM5Platform(value) {
  const normalized = normalizeToken(value);
  return M5_PLATFORMS.includes(normalized) ? normalized : null;
}

export function assertM5Platform(value) {
  const normalized = normalizeM5Platform(value);
  if (normalized) return normalized;
  throw new M5ContractError(
    M5_CONTRACT_ERROR_CODES.PLATFORM_UNSUPPORTED,
    'M5 平台只允许 douyin 或 xiaohongshu。',
    { value },
  );
}

export function normalizeM5PublishAction(value) {
  const normalized = normalizeSnakeToken(value);
  return M5_ALLOWED_PUBLISH_ACTIONS.includes(normalized)
    || M5_PROHIBITED_PUBLISH_ACTIONS.includes(normalized)
    ? normalized
    : null;
}

export function assertM5PublishAction(value) {
  const action = normalizeSnakeToken(value);
  if (M5_PROHIBITED_PUBLISH_ACTIONS.includes(action)) {
    throw new M5ContractError(
      M5_CONTRACT_ERROR_CODES.PUBLISH_ACTION_PROHIBITED,
      `M5 禁止发布动作：${action}。`,
      { action },
    );
  }
  if (M5_ALLOWED_PUBLISH_ACTIONS.includes(action)) return action;
  throw new M5ContractError(
    M5_CONTRACT_ERROR_CODES.PUBLISH_ACTION_UNSUPPORTED,
    'M5 发布动作不在允许白名单内。',
    { value },
  );
}

export function normalizeM5ProviderOperation(value) {
  const normalized = normalizeSnakeToken(value);
  return Object.hasOwn(M5_STEPFUN_MODELS, normalized) ? normalized : null;
}

export function assertM5ProviderOperation(value) {
  const operation = normalizeM5ProviderOperation(value);
  if (operation) return operation;
  throw new M5ContractError(
    M5_CONTRACT_ERROR_CODES.PROVIDER_OPERATION_UNSUPPORTED,
    'M5 StepFun 操作没有固定模型映射。',
    { value },
  );
}

export function getM5StepFunModel(operation) {
  return M5_STEPFUN_MODELS[assertM5ProviderOperation(operation)];
}

export function normalizeM5WorkProductKind(value) {
  return M5_WORK_PRODUCT_KIND_BY_TOKEN.get(normalizeCompactToken(value)) || null;
}

export function assertM5WorkProductKind(value) {
  const kind = normalizeM5WorkProductKind(value);
  if (kind) return kind;
  throw new M5ContractError(
    M5_CONTRACT_ERROR_CODES.WORK_PRODUCT_KIND_UNSUPPORTED,
    '未知的 M5 Work Product kind。',
    { value },
  );
}

export function getM5WorkProductSchema(kind) {
  return M5_WORK_PRODUCT_SCHEMAS[assertM5WorkProductKind(kind)];
}

export function normalizeM5WorkProductContract(value) {
  const kind = normalizeM5WorkProductKind(value?.kind);
  const schemaVersion = normalizeM5SchemaId(value?.schemaVersion);
  if (!kind || !schemaVersion || M5_WORK_PRODUCT_SCHEMAS[kind] !== schemaVersion) return null;
  return Object.freeze({ kind, schemaVersion });
}

export function assertM5WorkProductContract(value) {
  const kind = assertM5WorkProductKind(value?.kind);
  const schemaVersion = assertM5SchemaId(value?.schemaVersion);
  if (M5_WORK_PRODUCT_SCHEMAS[kind] === schemaVersion) {
    return Object.freeze({ kind, schemaVersion });
  }
  throw new M5ContractError(
    M5_CONTRACT_ERROR_CODES.WORK_PRODUCT_SCHEMA_MISMATCH,
    `M5 Work Product ${kind} 与 schemaVersion 不匹配。`,
    { kind, schemaVersion, expectedSchemaVersion:M5_WORK_PRODUCT_SCHEMAS[kind] },
  );
}

export function normalizeM5SchemaId(value) {
  const normalized = normalizeToken(value);
  return M5_SCHEMA_ID_SET.has(normalized) ? normalized : null;
}

export function assertM5SchemaId(value) {
  const schemaId = normalizeM5SchemaId(value);
  if (schemaId) return schemaId;
  throw new M5ContractError(
    M5_CONTRACT_ERROR_CODES.SCHEMA_ID_UNSUPPORTED,
    '未知或未受支持的 M5 schema 标识。',
    { value },
  );
}

export function normalizeM5Sha256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (M5_SHA256_PATTERN.test(normalized)) return normalized;
  if (/^[0-9a-f]{64}$/.test(normalized)) return `sha256:${normalized}`;
  return null;
}

export function assertM5Sha256(value) {
  const checksum = normalizeM5Sha256(value);
  if (checksum) return checksum;
  throw new M5ContractError(
    M5_CONTRACT_ERROR_CODES.SHA256_INVALID,
    'M5 哈希必须是 sha256: 加 64 位十六进制。',
  );
}

export function canonicalizeM5Value(value) {
  if (Array.isArray(value)) return value.map(canonicalizeM5Value);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeM5Value(value[key])]),
  );
}

export function m5Sha256(value) {
  const input = Buffer.isBuffer(value) || ArrayBuffer.isView(value)
    ? value
    : typeof value === 'string'
      ? value
      : JSON.stringify(canonicalizeM5Value(value));
  return `sha256:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

export function deriveM5WorkProductArtifactHash({
  sourceTaskId,
  sourceArtifactId,
  sourceIssueId,
  pipelineCaseId,
  projectId,
  sourceRunId,
  artifactKind,
  artifact,
} = {}) {
  const identity = {
    sourceTaskId:normalizeIdentityPart(sourceTaskId),
    sourceArtifactId:normalizeIdentityPart(sourceArtifactId),
    sourceIssueId:normalizeIdentityPart(sourceIssueId),
    pipelineCaseId:normalizeIdentityPart(pipelineCaseId),
    projectId:normalizeIdentityPart(projectId),
    sourceRunId:normalizeIdentityPart(sourceRunId),
    artifactKind:normalizeIdentityPart(artifactKind),
    artifact:artifact ?? null,
  };
  if (!identity.artifactKind) {
    throw new M5ContractError(
      M5_CONTRACT_ERROR_CODES.WORK_PRODUCT_IDENTITY_INVALID,
      'M5 Work Product 身份缺少 artifactKind。',
    );
  }
  return m5Sha256(identity);
}

export function validM5WorkProductArtifactHash(metadata) {
  const expected = normalizeM5Sha256(metadata?.artifactHash);
  if (!expected) return false;
  try {
    return expected === deriveM5WorkProductArtifactHash(metadata);
  } catch {
    return false;
  }
}

function normalizeToken(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeSnakeToken(value) {
  return normalizeToken(value).replace(/[\s-]+/g, '_');
}

function normalizeCompactToken(value) {
  return normalizeToken(value).replace(/[\s_-]+/g, '');
}

function normalizeIdentityPart(value) {
  return String(value || '').trim();
}
