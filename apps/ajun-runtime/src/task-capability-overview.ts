import { capabilityTruthState, type AgentCapabilityTruth } from './workflow/capability-truth.ts';

type ArtifactRecord = Readonly<{
  validation?: Readonly<{ exists?: boolean; readable?: boolean; nonEmpty?: boolean }>;
}>;

type TaskRecord = Readonly<{
  taskId?: string;
  taskType?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: Readonly<{ channel?: string }>;
  execution?: Readonly<{ mode?: string }>;
  approvalRefs?: readonly string[];
  artifactRefs?: readonly ArtifactRecord[];
}>;

type ApprovalRecord = Readonly<{
  approvalId?: string;
  status?: string;
  governanceMode?: string;
  createdAt?: string;
  updatedAt?: string;
  decidedAt?: string;
}>;

type CapabilityRow = Readonly<{
  id: string;
  name: string;
  status: string;
  detail: string;
  truth: AgentCapabilityTruth;
}>;

type LocalAiStatus = Readonly<{
  status?: string;
  safeMessage?: string;
  capabilities?: readonly Readonly<{
    capability?: string;
    configured?: boolean;
    e2eVerified?: boolean;
    verifiedAt?: string | null;
  }>[];
}> | null;

export function buildCapabilities({
  governance,
  feishuChannel,
  worker,
  localAi,
  skillReadiness,
  runtimeHealth,
  tasks,
  approvals,
}: {
  governance: Readonly<{ status?: string; version?: string | null }>;
  feishuChannel: Readonly<{ status?: string; detail?: string }>;
  worker: Readonly<{ status?: string; detail?: string }>;
  localAi: LocalAiStatus;
  skillReadiness: readonly any[];
  runtimeHealth: Readonly<Record<string, any>>;
  tasks: readonly TaskRecord[];
  approvals: readonly ApprovalRecord[];
}) {
  const taskEvidence = (matches: (task: TaskRecord) => boolean) => latest(tasks, (task) => task.status === 'succeeded' && verifiedArtifact(task) && matches(task));
  const taskFailure = (matches: (task: TaskRecord) => boolean) => latest(tasks, (task) => ['failed', 'waiting_test'].includes(String(task.status || '')) && matches(task));
  const truth = ({
    configured = true,
    live = true,
    evidenceTask = null,
    evidenceRef = null,
    verifiedAt = null,
    latestFailureTask = null,
  }: {
    configured?: boolean;
    live?: boolean;
    evidenceTask?: TaskRecord | null;
    evidenceRef?: string | null;
    verifiedAt?: string | null;
    latestFailureTask?: TaskRecord | null;
  } = {}) => capabilityTruthState({
    declared:true,
    configured,
    live,
    verified:Boolean(evidenceTask || (evidenceRef && verifiedAt)),
    humanAccepted:false,
    verifiedAt:recordTime(evidenceTask) || verifiedAt,
    evidenceTaskId:evidenceTask?.taskId || null,
    evidenceRef:evidenceTask?.taskId ? `task:${evidenceTask.taskId}` : evidenceRef,
    latestFailureAt:recordTime(latestFailureTask),
    latestFailureTaskId:latestFailureTask?.taskId || null,
  });

  const latestTaskRecord = latest(tasks, (task) => Boolean(task.taskId && recordTime(task)));
  const latestDecision = latest(approvals, (approval) => approval.status !== 'pending' && Boolean(recordTime(approval)));
  const decisionTask = latestDecision?.approvalId
    ? latest(tasks, (task) => task.approvalRefs?.includes(latestDecision.approvalId as string) === true)
    : null;
  const publicTask = (task: TaskRecord) => ['report.public-material', 'research.intel-report', 'research.open-investigation'].includes(String(task.taskType || ''));
  const feishuTask = (task: TaskRecord) => task.source?.channel === 'feishu';
  const macTask = (task: TaskRecord) => task.execution?.mode === 'mac_worker';

  const capabilities: CapabilityRow[] = [
    {
      id:'task-coordination', name:'统一任务协调', status:tasks.length ? 'ready' : 'partial',
      detail:tasks.length ? '任务创建和路由已有真实记录；具体业务完成仍以 Workflow 验证为准。' : '任务协调已配置，但尚无真实业务记录。',
      truth:truth({ evidenceTask:latestTaskRecord }),
    },
    {
      id:'agent-registry', name:'岗位注册表', status:'partial',
      detail:'岗位职责、任务类型和权限来自 Manifest；登记本身不代表岗位已通过业务验收。',
      truth:truth({ live:true }),
    },
    {
      id:'approval-gate', name:'审批闸门', status:approvals.length ? 'ready' : 'partial',
      detail:approvals.length ? '审批闸门已有真实决定记录；自动能力决策与人工审批分别留痕。' : '审批闸门已配置，尚无当前真实决定证据。',
      truth:truth({
        evidenceTask:decisionTask,
        evidenceRef:latestDecision?.approvalId ? `approval:${latestDecision.approvalId}` : null,
        verifiedAt:recordTime(latestDecision),
      }),
    },
    {
      id:'content-public-web-fetch', name:'公开资料读取', status:taskEvidence(publicTask) ? 'ready' : 'partial',
      detail:'公开网页、动态页面和 PDF 通过受控 Adapter 读取；真实可用性以研究 Workflow 产物为准。',
      truth:truth({ evidenceTask:taskEvidence(publicTask), latestFailureTask:taskFailure(publicTask) }),
    },
    {
      id:'authorized-content-read', name:'登录平台只读采集', status:'partial',
      detail:'通道已接入；每个平台、账号和数据范围仍需通过具体任务验证并完成真实只读验收。',
      truth:truth({ live:false }),
    },
  ];

  const governanceDecision = latest(approvals, (approval) => approval.governanceMode === 'paperclip' && approval.status !== 'pending' && Boolean(recordTime(approval)));
  const governanceTask = governanceDecision?.approvalId
    ? latest(tasks, (task) => task.approvalRefs?.includes(governanceDecision.approvalId as string) === true)
    : null;
  capabilities.push(
    {
      id:'governance', name:'Paperclip 治理投影', status:String(governance.status || 'partial'),
      detail:governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）；连接不替代具体预算和审批验收。` : 'Paperclip 未连接；组织级请求必须等待治理恢复。',
      truth:truth({
        live:governance.status === 'ready',
        evidenceTask:governanceTask,
        evidenceRef:governanceDecision?.approvalId ? `approval:${governanceDecision.approvalId}` : null,
        verifiedAt:recordTime(governanceDecision),
      }),
    },
    {
      id:'feishu-channel', name:'飞书收发与员工入口', status:String(feishuChannel.status || 'partial'), detail:String(feishuChannel.detail || ''),
      truth:truth({ live:feishuChannel.status === 'ready', evidenceTask:latest(tasks, feishuTask), latestFailureTask:taskFailure(feishuTask) }),
    },
    {
      id:'mac-worker', name:'Mac工作间安全接力', status:String(worker.status || 'partial'), detail:String(worker.detail || ''),
      truth:truth({ live:['ready', 'local'].includes(String(worker.status || '')), evidenceTask:taskEvidence(macTask), latestFailureTask:taskFailure(macTask) }),
    },
  );

  const localProof = latest(localAi?.capabilities || [], (item) => item.e2eVerified === true && Boolean(validTime(item.verifiedAt)));
  if (localAi) capabilities.push({
    id:'local-ai',
    name:'本机 AI 全能力网关',
    status:localAi.status === 'healthy' ? 'ready' : localAi.status === 'degraded' ? 'partial' : 'unavailable',
    detail:String(localAi.safeMessage || '本机 AI 网关状态未知。').slice(0, 300),
    truth:truth({
      configured:Boolean(localAi.capabilities?.some((item) => item.configured)),
      live:localAi.status === 'healthy' || localAi.status === 'degraded',
      evidenceRef:localProof?.capability ? `local-ai:${localProof.capability}` : null,
      verifiedAt:validTime(localProof?.verifiedAt),
    }),
  });

  capabilities.push({
    id:'external-execution', name:'外部发布与写入', status:'planned',
    detail:'外部发布和其他写入动作尚未接入且故意关闭；登录型只读采集不等于已经开放写入。',
    truth:capabilityTruthState({ declared:false, configured:false, live:false, verified:false, humanAccepted:false }),
  });

  const presentationSkill = skillReadiness.find((item: any) => item.slug === 'open-kimi-ppt');
  if (presentationSkill) {
    const composeStatus = presentationSkill.modes?.compose?.status || presentationSkill.status;
    const exportStatus = presentationSkill.modes?.export?.status || presentationSkill.status;
    const matchesPresentation = (task: TaskRecord) => task.taskType === 'office.presentation-package';
    capabilities.push({
      id:'office-presentation',
      name:'小办演示文稿',
      status:composeStatus === 'ready' && exportStatus === 'ready' ? 'ready' : composeStatus === 'ready' ? 'partial' : 'unavailable',
      detail:[
        `PPTD ${composeStatus === 'ready' ? '可用' : `不可用（${composeStatus}）`}`,
        `PPTX ${exportStatus === 'ready' ? '可用' : `暂不可用（${exportStatus}）`}`,
        presentationSkill.recovery,
      ].filter(Boolean).join('；').slice(0, 500),
      truth:truth({
        configured:composeStatus === 'ready',
        live:composeStatus === 'ready',
        evidenceTask:taskEvidence(matchesPresentation),
        latestFailureTask:taskFailure(matchesPresentation),
      }),
    });
  }

  const wechatHealth = runtimeHealth['wechat-chat-retriever'];
  if (wechatHealth) {
    const matchesWechat = (task: TaskRecord) => task.taskType === 'wechat.chat.retrieval';
    capabilities.push({
      id:'wechat-private-read',
      name:'微信本机只读',
      status:wechatHealth.status === 'healthy' ? 'ready' : wechatHealth.status === 'degraded' ? 'partial' : 'unavailable',
      detail:String(wechatHealth.safeMessage || ''),
      truth:truth({
        configured:true,
        live:['healthy', 'degraded'].includes(String(wechatHealth.status || '')),
        evidenceTask:taskEvidence(matchesWechat),
        latestFailureTask:taskFailure(matchesWechat),
      }),
    });
  }
  return Object.freeze(capabilities);
}

function verifiedArtifact(task: TaskRecord): boolean {
  return (task.artifactRefs || []).some((artifact) => artifact.validation?.exists === true
    && artifact.validation?.readable === true
    && artifact.validation?.nonEmpty !== false);
}

function latest<T>(items: readonly T[], predicate: (item: T) => boolean): T | null {
  return items.reduce<T | null>((best, item) => {
    if (!predicate(item)) return best;
    if (!best) return item;
    return timestamp(item) > timestamp(best) ? item : best;
  }, null);
}

function timestamp(value: any): number {
  return Date.parse(value?.decidedAt || value?.updatedAt || value?.createdAt || value?.verifiedAt || '') || 0;
}

function recordTime(value: any): string | null {
  const text = String(value?.decidedAt || value?.updatedAt || value?.createdAt || '').trim();
  return validTime(text);
}

function validTime(value: unknown): string | null {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : null;
}
