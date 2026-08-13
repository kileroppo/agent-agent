export const DELIVERY_BRIEF_SCHEMA_VERSION = 'agent.army/delivery-brief/v1' as const;

export type DeliveryBrief = Readonly<{
  schemaVersion: typeof DELIVERY_BRIEF_SCHEMA_VERSION;
  purpose: string;
  audience: string;
  usageScenario: string;
  deliverables: readonly string[];
  acceptanceCriteria: readonly string[];
  constraints: readonly string[];
  inferredAssumptions: readonly string[];
  clarification: string | null;
  readiness: 'ready' | 'needs_clarification';
}>;

type BriefDefaults = Readonly<{
  audience: string;
  usageScenario: string;
  deliverables: readonly string[];
  acceptanceCriteria: readonly string[];
}>;

type DeliveryBriefSource = Readonly<Record<string, any>>;

const SOURCE_REQUIRED = [
  'media.',
  'vision.',
  'image.edit',
  'document.',
] as const;

/**
 * Builds a usable brief from current task input while preserving explicit fields.
 * This is intentionally deterministic: an LLM may enrich the source before this
 * boundary, but the persisted contract never depends on an untracked model call.
 */
export function resolveDeliveryBrief(source: DeliveryBriefSource = {}): DeliveryBrief {
  const explicit = record(source.deliveryBrief);
  const input = record(source.input);
  const goal = record(explicit.goalSpec || source.goalSpec || input.goalSpec);
  const taskType = clean(explicit.taskType || source.taskType || input.taskType, 160);
  const defaults = defaultsFor(taskType);
  const title = clean(explicit.title || source.title || input.title, 500);
  const description = clean(explicit.description || source.description || input.description, 2_000);
  const purpose = clean(explicit.purpose || goal.objective || source.purpose || input.purpose || title || description, 2_000);
  const audience = clean(explicit.audience || source.audience || input.audience, 500) || defaults.audience;
  const usageScenario = clean(explicit.usageScenario || source.usageScenario || input.usageScenario, 500)
    || defaults.usageScenario;
  const deliverables = firstList(
    explicit.deliverables,
    goal.deliverables,
    source.deliverables,
    input.deliverables,
    defaults.deliverables,
  );
  const acceptanceCriteria = firstList(
    explicit.acceptanceCriteria,
    goal.acceptanceCriteria,
    source.acceptanceCriteria,
    input.acceptanceCriteria,
    defaults.acceptanceCriteria,
  );
  const constraints = mergeLists(
    goal.constraints,
    source.constraints,
    input.constraints,
    explicit.constraints,
  );
  const inferredAssumptions = mergeLists(
    explicit.inferredAssumptions,
    audienceWasInferred(explicit, source, input) ? [`默认受众：${audience}`] : [],
    usageWasInferred(explicit, source, input) ? [`默认使用场景：${usageScenario}`] : [],
  );
  const clarification = oneClarification({
    explicit,
    source,
    input,
    taskType,
    purpose,
  });

  return Object.freeze({
    schemaVersion:DELIVERY_BRIEF_SCHEMA_VERSION,
    purpose,
    audience,
    usageScenario,
    deliverables:Object.freeze(deliverables),
    acceptanceCriteria:Object.freeze(acceptanceCriteria),
    constraints:Object.freeze(constraints),
    inferredAssumptions:Object.freeze(inferredAssumptions),
    clarification,
    readiness:clarification ? 'needs_clarification' : 'ready',
  });
}

function oneClarification({ explicit, source, input, taskType, purpose }: {
  explicit: DeliveryBriefSource;
  source: DeliveryBriefSource;
  input: DeliveryBriefSource;
  taskType: string;
  purpose: string;
}): string | null {
  const supplied = clean(explicit.clarification, 240);
  if (supplied) return supplied;
  if (!purpose) return '这项工作最终要解决什么问题？';
  if (requiresSource(taskType) && !hasSource(source, input, explicit)) {
    return '请提供需要处理的素材、文件或来源链接。';
  }
  return null;
}

function defaultsFor(taskType: string): BriefDefaults {
  if (taskType.startsWith('research.')) return Object.freeze({
    audience:'需要据此做判断的负责人',
    usageScenario:'用于业务判断、方案选择或后续行动',
    deliverables:['研究结论', '来源清单', '建议与未决问题'],
    acceptanceCriteria:['直接回答研究问题', '关键结论可追溯到已读取来源', '区分事实、推断与不确定项'],
  });
  if (taskType.startsWith('media.')) return Object.freeze({
    audience:'需要阅读或复用素材的负责人和协作成员',
    usageScenario:'用于快速理解素材并继续编辑或分发',
    deliverables:['可读转录稿', '核心摘要', '原始素材引用'],
    acceptanceCriteria:['覆盖完整素材', '关键术语、数字和结论可核对', '摘要忠于原始内容'],
  });
  if (taskType === 'office.presentation-package') return Object.freeze({
    audience:'实际参加汇报或评审的成员',
    usageScenario:'用于正式汇报、评审或继续编辑',
    deliverables:['可编辑演示文稿', '汇报结论与行动项'],
    acceptanceCriteria:['结构支持快速理解结论', '内容完整且数据一致', '文件可打开、可编辑并通过视觉检查'],
  });
  if (taskType.startsWith('office.')) return Object.freeze({
    audience:'直接使用产物的负责人和协作成员',
    usageScenario:'用于协作、评审或继续编辑',
    deliverables:['可编辑办公产物', '结论与下一步'],
    acceptanceCriteria:['覆盖任务要求', '结构清晰且信息一致', '文件可打开并可继续编辑'],
  });
  if (taskType.startsWith('content.')) return Object.freeze({
    audience:'目标内容的实际读者或观看者',
    usageScenario:'用于内容评审、制作或后续发布决策',
    deliverables:['可评审内容产物', '依据与限制'],
    acceptanceCriteria:['满足任务目标和平台约束', '事实与素材依据一致', '未获授权时不执行外部发布'],
  });
  return Object.freeze({
    audience:'提出任务并使用结果的负责人',
    usageScenario:'用于完成当前任务并决定下一步',
    deliverables:['可直接使用的主要产物'],
    acceptanceCriteria:['完成明确目标', '产物存在、可读且非空'],
  });
}

function requiresSource(taskType: string): boolean {
  return SOURCE_REQUIRED.some((prefix) => taskType.startsWith(prefix));
}

function hasSource(...values: DeliveryBriefSource[]): boolean {
  return values.some((value) => Boolean(
    clean(value.sourceUrl, 2_000)
    || textList(value.sourceUrls).length
    || textList(value.sourceTaskIds).length
    || textList(record(value.context).sourceTaskIds).length
    || textList(value.imagePaths).length
    || textList(value.filePaths).length
    || clean(value.sourceText || value.material || value.content, 2_000),
  ));
}

function audienceWasInferred(...values: DeliveryBriefSource[]): boolean {
  return !values.some((value) => clean(value.audience, 500));
}

function usageWasInferred(...values: DeliveryBriefSource[]): boolean {
  return !values.some((value) => clean(value.usageScenario, 500));
}

function firstList(...values: unknown[]): string[] {
  for (const value of values) {
    const list = textList(value);
    if (list.length) return list;
  }
  return [];
}

function mergeLists(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => textList(value)))];
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, 1_000)).filter(Boolean))].slice(0, 30);
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function record(value: unknown): DeliveryBriefSource {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as DeliveryBriefSource
    : {};
}
