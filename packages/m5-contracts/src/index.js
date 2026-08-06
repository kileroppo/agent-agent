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
export const CONTENT_CHANNEL_IDS = Object.freeze({
  DOUYIN:'douyin',
  XIAOHONGSHU:'xiaohongshu',
  WECHAT_OFFICIAL_ACCOUNT:'wechat_official_account',
  WECHAT_CHANNELS:'wechat_channels',
});
export const CONTENT_CHANNELS = Object.freeze(Object.values(CONTENT_CHANNEL_IDS));
export const CONTENT_QUALITY_GATE_IDS = Object.freeze([
  'evidence',
  'account_voice',
  'platform_native',
  'visual_consistency',
  'compliance',
  'delivery_completeness',
]);
export const CONTENT_REVIEW_DECISIONS = Object.freeze([
  'scale',
  'repackage',
  'adapt_platform',
  'stop',
  'collect_more_samples',
]);
export const CONTENT_PLATFORM_PLAYBOOKS = deepFreeze({
  [CONTENT_CHANNEL_IDS.DOUYIN]:{
    title:'用具体结果或冲突建立点击理由，不能超出正文证据。',
    opening:'前三秒交代问题、结果或可观察变化。',
    structure:'短句推进，画面负责证明，结尾只保留一个行动。',
    visual:'竖屏强节奏；字幕不能只是重复画面。',
  },
  [CONTENT_CHANNEL_IDS.XIAOHONGSHU]:{
    title:'对应用户会搜索的具体问题或身份处境。',
    opening:'第一屏尽快交代身份、场景、结果与证据。',
    structure:'每页只承担一个信息任务，保留真实过程、失败和取舍。',
    visual:'封面手机可读；正文、页面任务与素材来源逐页对应。',
  },
  [CONTENT_CHANNEL_IDS.WECHAT_OFFICIAL_ACCOUNT]:{
    title:'标题承诺必须由正文完整兑现。',
    opening:'从真实场景、冲突或判断进入，不用行业套话铺垫。',
    structure:'论证完整，段落适合手机阅读，正文独立交付价值。',
    visual:'封面、摘要、正文图片和外链在草稿预览中逐项核对。',
  },
  [CONTENT_CHANNEL_IDS.WECHAT_CHANNELS]:{
    title:'标题自然可信，适合微信关系链理解和转发。',
    opening:'前三秒给出真实问题或结论。',
    structure:'口播说得出口，事实完整，结尾只保留一个行动。',
    visual:'竖屏画面与字幕分工明确，避免无证据效果演示。',
  },
});
export const CONTENT_METRIC_KEYS = Object.freeze([
  'impressions',
  'views',
  'completions',
  'likes',
  'comments',
  'saves',
  'shares',
  'newFollowers',
  'conversions',
  'attributedRevenue',
  'productionMinutes',
  'successfulOutputs',
]);
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
  CONTENT_BRIEF:'agent.army/content-brief/v1',
  CONTENT_OPPORTUNITY:'agent.army/content-opportunity/v1',
  SEMANTIC_QUALITY_REVIEW:'agent.army/content-semantic-quality-review/v1',
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
  WECHAT_DRAFT_REQUEST:'agent.army/wechat-draft-request/v1',
  WECHAT_DRAFT_RECEIPT:'agent.army/wechat-draft-receipt/v1',
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
  ContentBrief:M5_SCHEMA_IDS.CONTENT_BRIEF,
  ContentOpportunity:M5_SCHEMA_IDS.CONTENT_OPPORTUNITY,
  SemanticQualityReview:M5_SCHEMA_IDS.SEMANTIC_QUALITY_REVIEW,
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
  WechatDraftReceipt:M5_SCHEMA_IDS.WECHAT_DRAFT_RECEIPT,
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

export function normalizeContentChannel(value) {
  const token = normalizeSnakeToken(value);
  const aliases = {
    xhs:CONTENT_CHANNEL_IDS.XIAOHONGSHU,
    wechat:CONTENT_CHANNEL_IDS.WECHAT_OFFICIAL_ACCOUNT,
    wechat_mp:CONTENT_CHANNEL_IDS.WECHAT_OFFICIAL_ACCOUNT,
    mp:CONTENT_CHANNEL_IDS.WECHAT_OFFICIAL_ACCOUNT,
    gongzhonghao:CONTENT_CHANNEL_IDS.WECHAT_OFFICIAL_ACCOUNT,
    shipinhao:CONTENT_CHANNEL_IDS.WECHAT_CHANNELS,
  };
  return CONTENT_CHANNELS.includes(token) ? token : aliases[token] || null;
}

export function contentQualityChecklist(platform) {
  const channel = normalizeContentChannel(platform);
  if (!channel) {
    throw new M5ContractError(
      M5_CONTRACT_ERROR_CODES.PLATFORM_UNSUPPORTED,
      '内容渠道不在受支持范围内。',
      { value:platform },
    );
  }
  const playbook = CONTENT_PLATFORM_PLAYBOOKS[channel];
  return CONTENT_QUALITY_GATE_IDS.map((gate) => Object.freeze({
    gate,
    required:true,
    instruction:qualityInstruction(gate, playbook),
  }));
}

export function normalizeContentBrief(value = {}) {
  const channels = [...new Set(
    (Array.isArray(value.channels) ? value.channels : [value.primaryChannel])
      .map(normalizeContentChannel)
      .filter(Boolean),
  )].slice(0, 3);
  const audience = boundedText(value.audience, 300);
  const goal = boundedText(value.goal, 500);
  const coreJudgment = boundedText(value.coreJudgment, 800);
  if (!channels.length || !audience || !goal || !coreJudgment) return null;
  return Object.freeze({
    schemaVersion:'agent.army/content-brief/v1',
    accountPositioning:boundedText(value.accountPositioning, 500) || null,
    audience,
    goal,
    coreJudgment,
    evidenceRefs:Object.freeze(uniqueTextList(value.evidenceRefs, 20, 240)),
    constraints:Object.freeze(uniqueTextList(value.constraints, 20, 500)),
    channels:Object.freeze(channels),
    primaryAction:boundedText(value.primaryAction, 300) || null,
    experiment:normalizeContentExperiment(value.experiment),
    assumptions:Object.freeze(uniqueTextList(value.assumptions, 10, 500)),
    confirmationStatus:['confirmed', 'assumed_defaults', 'needs_confirmation']
      .includes(value.confirmationStatus)
      ? value.confirmationStatus
      : 'needs_confirmation',
  });
}

export function deriveContentMetrics(value = {}) {
  const metrics = Object.fromEntries(CONTENT_METRIC_KEYS.map((key) => [
    key,
    nonNegativeNumber(value[key]),
  ]));
  return Object.freeze({
    ...metrics,
    followersPerThousandViews:safeRate(metrics.newFollowers, metrics.views, 1000),
    deepEngagementRate:safeRate(
      sumNullable(metrics.comments, metrics.saves, metrics.shares),
      metrics.views,
      1,
    ),
    clickThroughRate:safeRate(metrics.views, metrics.impressions, 1),
    conversionRate:safeRate(metrics.conversions, metrics.views, 1),
    minutesPerSuccessfulOutput:safeRate(
      metrics.productionMinutes,
      metrics.successfulOutputs,
      1,
    ),
  });
}

export function summarizeComparableContentMetrics(samples = []) {
  const normalized = (Array.isArray(samples) ? samples : [])
    .map((sample) => deriveContentMetrics(sample));
  const metricKeys = [
    ...CONTENT_METRIC_KEYS,
    'followersPerThousandViews',
    'deepEngagementRate',
    'clickThroughRate',
    'conversionRate',
    'minutesPerSuccessfulOutput',
  ];
  return Object.freeze(Object.fromEntries(metricKeys.map((key) => {
    const values = normalized.map((item) => item[key]).filter(Number.isFinite).sort((a, b) => a - b);
    return [key, Object.freeze({
      sampleCount:values.length,
      median:quantile(values, 0.5),
      p75:quantile(values, 0.75),
    })];
  })));
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

function qualityInstruction(gate, playbook) {
  return ({
    evidence:'关键数字、身份、经历、比较和因果都能回到可信来源；标题不超出正文证据。',
    account_voice:'保留具体时间、动作、对象和取舍；删除百科腔、套话、整齐模板和空泛升华。',
    platform_native:`${playbook.title} ${playbook.opening} ${playbook.structure}`,
    visual_consistency:`${playbook.visual} 同组素材使用同一视觉锚，且不虚构产品界面。`,
    compliance:'披露商业关系，不编造收益、销量、评价、案例或未经证明的最高级。',
    delivery_completeness:'标题、正文、摘要、封面、素材顺序、标签、字幕、声明和发布设置按渠道逐项交付。',
  })[gate];
}

function normalizeContentExperiment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const variable = boundedText(value.variable, 200);
  const hypothesis = boundedText(value.hypothesis, 500);
  const successCriterion = boundedText(value.successCriterion, 500);
  const observationWindow = boundedText(value.observationWindow, 120);
  if (!variable || !hypothesis || !successCriterion || !observationWindow) return null;
  return Object.freeze({ variable, hypothesis, successCriterion, observationWindow });
}

function uniqueTextList(value, maximumItems, maximumLength) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => boundedText(item, maximumLength)).filter(Boolean))]
    .slice(0, maximumItems);
}

function boundedText(value, maximumLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

function nonNegativeNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sumNullable(...values) {
  const present = values.filter(Number.isFinite);
  return present.length ? present.reduce((total, item) => total + item, 0) : null;
}

function safeRate(numerator, denominator, multiplier) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? (numerator / denominator) * multiplier
    : null;
}

function quantile(values, percentile) {
  if (!values.length) return null;
  if (values.length === 1) return values[0];
  const index = (values.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  const weight = index - lower;
  return values[lower] + (values[upper] - values[lower]) * weight;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
