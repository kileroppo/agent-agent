import {
  classifyTaskBacklog,
  type BacklogEvidenceContext,
  type BacklogClassification,
} from './backlog-classification.ts';

type ValidationAuthority = 'none' | 'budget_policy' | 'public_source_and_budget_policy' | 'isolated_local_write';
type ValidationState = 'ready_for_automation' | 'policy_gated_automation' | 'requires_explicit_authority';
type EvidenceFreshness = 'later_than_latest_failure' | 'predates_latest_failure' | 'none';

type ValidationSpec = Readonly<{
  id: string;
  name: string;
  matches: (task: any) => boolean;
  authority: ValidationAuthority;
  automatedMethod: string;
  acceptanceStandard: string;
  humanCheck: string | null;
  failureAction: string;
}>;

const REVIEW_CLASSES = new Set<BacklogClassification>([
  'needs_reverification',
  'unresolved_failure',
  'unresolved',
]);

const SPECS: readonly ValidationSpec[] = Object.freeze([
  spec({
    id:'research-intelligence',
    name:'小R公开研究',
    taskTypes:['research.intel-report'],
    authority:'public_source_and_budget_policy',
    automatedMethod:'用非敏感公开主题执行一次完整研究 Workflow，检查多路检索、来源绑定、反证搜索和可读产物。',
    acceptanceStandard:'新任务成功；产物非空可读；至少满足研究 Workflow 的来源数量、搜索多样性、反证与主张证据绑定门禁。',
    humanCheck:'人工抽查结论是否准确、来源是否支持结论。',
    failureAction:'保留失败证据并按失败层定位；公开读取失败交给运维官，Provider 不可用时只提示用户授权或恢复，不自动扩大权限。',
  }),
  spec({
    id:'video-analysis',
    name:'小拆视频分析',
    taskTypes:['content.video-benchmark-analysis'],
    extraMatch:(task) => task?.taskType === 'army.cross-agent-mission'
      && /视频|拆解|精华|转录/.test(String(task?.input?.title || '')),
    authority:'public_source_and_budget_policy',
    automatedMethod:'复用已确认转录优先执行纯文本分析；有视觉主张时再走受控视觉 Provider，并记录转录、分析和视觉证据三层结果。',
    acceptanceStandard:'新任务成功；报告版本、正式来源确认、模式结构和视觉主张证据绑定门禁全部通过；没有视觉证据时不得生成视觉事实。',
    humanCheck:'人工抽查精华提炼和内容判断是否忠于原视频。',
    failureAction:'先自动检查本机能力并只恢复一次；文本路径可用时降级为纯文本交付，只有所需模型或受控 Provider 仍不可用才通知用户。',
  }),
  spec({
    id:'content-draft',
    name:'小创内容草稿',
    taskTypes:['content.platform-draft'],
    authority:'budget_policy',
    automatedMethod:'用非发布型测试输入生成结构化草稿，只验证内容产物，不调用发布接口。',
    acceptanceStandard:'新任务成功；草稿非空可读；格式、平台结构和来源约束通过；externalPublished 必须保持 false。',
    humanCheck:'人工验收内容质量、口吻和业务可用性。',
    failureAction:'停止在内容产物层，不发布、不重试付费调用；记录 Provider 与 Prompt/契约层错误，等待明确授权后再复验。',
  }),
  spec({
    id:'failure-recovery',
    name:'运维官失败恢复',
    taskTypes:['operations.failure-recovery'],
    authority:'none',
    automatedMethod:'运行恢复策略回归和本机只读健康探针，验证只恢复一次、只重试一次且不会递归创建恢复任务。',
    acceptanceStandard:'策略测试通过；健康探针可读；恢复决定有凭证；超过单次重试后安全停止。',
    humanCheck:null,
    failureAction:'禁止继续自动重试，升级技术专家并保留原始任务、恢复任务和错误层级。',
  }),
  spec({
    id:'technical-repair',
    name:'技术专家隔离修复',
    taskTypes:['operations.technical-repair'],
    authority:'isolated_local_write',
    automatedMethod:'只在验收夹具或临时工作树执行修复回归，验证补丁范围、测试结果和回滚证据，不触碰真实业务文件。',
    acceptanceStandard:'隔离修复测试通过；修改范围受控；原任务与修复证据可关联；真实业务代码仍需独立审查后才能落地。',
    humanCheck:null,
    failureAction:'标记待测试并停止修改；不得用扩大写权限、重启外部服务或无限重试掩盖失败。',
  }),
]);

export function buildValidationCampaign(
  tasks: readonly any[],
  context: BacklogEvidenceContext = {},
) {
  const reviewTasks = (tasks || []).filter((task) => REVIEW_CLASSES.has(classifyTaskBacklog(task, tasks, context)));
  const groups = new Map<string, { spec: ValidationSpec; tasks: any[] }>();
  for (const task of reviewTasks) {
    const matched = SPECS.find((candidate) => candidate.matches(task)) || fallbackSpec(task);
    const group = groups.get(matched.id) || { spec:matched, tasks:[] };
    group.tasks.push(task);
    groups.set(matched.id, group);
  }
  const items = [...groups.values()].map(({ spec:matched, tasks:matchedTasks }) => Object.freeze({
    id:matched.id,
    name:matched.name,
    state:validationState(matched.authority),
    authority:matched.authority,
    taskCount:matchedTasks.length,
    taskIds:Object.freeze(matchedTasks.map((task) => String(task?.taskId || '')).filter(Boolean)),
    taskTypes:Object.freeze([...new Set(matchedTasks.map((task) => String(task?.taskType || '')).filter(Boolean))]),
    automatedMethod:matched.automatedMethod,
    acceptanceStandard:matched.acceptanceStandard,
    humanCheck:matched.humanCheck,
    failureAction:matched.failureAction,
    evidence:validationEvidence(matched, matchedTasks, tasks),
  }));
  return Object.freeze({
    schemaVersion:'agent.army/validation-campaign/v1',
    source:'historical-task-evidence',
    taskCount:reviewTasks.length,
    groupCount:items.length,
    readyForAutomation:items.filter((item) => item.state === 'ready_for_automation')
      .reduce((count, item) => count + item.taskCount, 0),
    policyGatedAutomation:items.filter((item) => item.state === 'policy_gated_automation')
      .reduce((count, item) => count + item.taskCount, 0),
    requiresExplicitAuthority:items.filter((item) => item.state === 'requires_explicit_authority')
      .reduce((count, item) => count + item.taskCount, 0),
    groups:Object.freeze(items),
  });
}

function validationEvidence(
  matched: ValidationSpec,
  reviewTasks: readonly any[],
  allTasks: readonly any[],
) {
  const verifiedTasks = (allTasks || []).filter((task) => matched.matches(task) && isVerifiedSuccess(task));
  const latestVerified = latestTimedTask(verifiedTasks);
  const latestFailure = latestTimedTask(reviewTasks);
  let freshness: EvidenceFreshness = 'none';
  if (latestVerified && latestFailure) {
    if (latestVerified.timestamp > latestFailure.timestamp) freshness = 'later_than_latest_failure';
    if (latestVerified.timestamp < latestFailure.timestamp) freshness = 'predates_latest_failure';
  }
  return Object.freeze({
    verifiedSuccessCount:verifiedTasks.length,
    latestVerifiedTaskId:latestVerified?.task?.taskId ? String(latestVerified.task.taskId) : null,
    latestVerifiedAt:latestVerified?.at || null,
    latestFailureTaskId:latestFailure?.task?.taskId ? String(latestFailure.task.taskId) : null,
    latestFailureAt:latestFailure?.at || null,
    freshness,
  });
}

function isVerifiedSuccess(task: any): boolean {
  return task?.status === 'succeeded'
    && !isAutomatedValidationRecord(task)
    && (task?.artifactRefs || []).some((artifact: any) => (
      artifact?.validation?.exists === true
      && artifact?.validation?.readable === true
      && artifact?.validation?.nonEmpty === true
    ));
}

function isAutomatedValidationRecord(task: any): boolean {
  const channel = String(task?.source?.channel || '').toLowerCase();
  const idempotencyKey = String(task?.idempotencyKey || '').toLowerCase();
  return ['acceptance', 'test', 'fixture'].some((marker) => (
    channel.includes(marker) || idempotencyKey.includes(marker)
  ));
}

function latestTimedTask(tasks: readonly any[]) {
  let latest: { task: any; at: string; timestamp: number } | null = null;
  for (const task of tasks) {
    const at = validTaskTime(task);
    if (!at) continue;
    const timestamp = Date.parse(at);
    if (!latest || timestamp > latest.timestamp) latest = { task, at, timestamp };
  }
  return latest;
}

function validTaskTime(task: any): string | null {
  for (const value of [task?.updatedAt, task?.createdAt]) {
    if (typeof value === 'string' && value && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

function validationState(authority: ValidationAuthority): ValidationState {
  if (['none', 'isolated_local_write'].includes(authority)) return 'ready_for_automation';
  if (['budget_policy', 'public_source_and_budget_policy'].includes(authority)) return 'policy_gated_automation';
  return 'requires_explicit_authority';
}

function spec(input: {
  id: string;
  name: string;
  taskTypes: readonly string[];
  extraMatch?: (task: any) => boolean;
  authority: ValidationAuthority;
  automatedMethod: string;
  acceptanceStandard: string;
  humanCheck: string | null;
  failureAction: string;
}): ValidationSpec {
  const taskTypes = new Set(input.taskTypes);
  return Object.freeze({
    ...input,
    matches:(task: any) => taskTypes.has(String(task?.taskType || '')) || input.extraMatch?.(task) === true,
  });
}

function fallbackSpec(task: any): ValidationSpec {
  const taskType = String(task?.taskType || 'unknown');
  return Object.freeze({
    id:`other:${taskType}`,
    name:`其他待验证能力：${taskType}`,
    matches:(candidate: any) => String(candidate?.taskType || 'unknown') === taskType,
    authority:'budget_policy',
    automatedMethod:'先识别该任务依赖的 Runtime、Skill、Policy 与 Tool Gateway，再选择不产生外部副作用的最小验证。',
    acceptanceStandard:'必须产生新的成功任务和可验证产物；只有代码或配置存在不能视为通过。',
    humanCheck:'由人工确认业务结果是否可用。',
    failureAction:'保留失败并补充能力映射，不在未知权限与成本边界下自动重试。',
  });
}
