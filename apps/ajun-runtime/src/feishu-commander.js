const CREATE_AGENT_RE = /(?:创建|新建|招募|招)\s*(?:一个\s*)?(?:agent|智能体|岗位)/i;
const HEALTH_RE = /健康|状态|服务|运行|paperclip|检查系统/i;
const MEDIA_RE = /视频|音频|转录|字幕|整理素材|youtube|bilibili|抖音|快手|transcri/i;

export class FeishuCommander {
  constructor({ tasks, proposals, store } = {}) { this.tasks = tasks; this.proposals = proposals; this.store = store; }

  async handle(input) {
    const text = String(input?.text || '').trim();
    const sourceEventRef = String(input?.sourceEventRef || '').trim();
    if (!text) throw new FeishuCommanderValidationError('飞书消息不能为空。');
    if (!sourceEventRef) throw new FeishuCommanderValidationError('飞书消息缺少稳定事件引用，未创建任务。');
    const source = { channel: 'feishu', eventRef: sourceEventRef, chatRef: safeRef(input?.chatRef) };
    const requester = { kind: 'feishu-user', ref: safeRef(input?.requesterRef) || 'feishu-requester' };
    if (CREATE_AGENT_RE.test(text)) return this.createProposal({ text, sourceEventRef });
    const taskType = HEALTH_RE.test(text) ? 'operations.health-review' : MEDIA_RE.test(text) || publicUrl(text) ? 'media.transcribe-and-refine' : 'army.intake';
    const task = await this.tasks.create({
      title: text, description: '', taskType, requester, source,
      idempotencyKey: `feishu:${sourceEventRef}`
    });
    const result = replyFor(task, taskType);
    const approval = task.status === 'waiting_approval' ? await this.approvalFor(task) : null;
    return approval ? { ...result, approval } : result;
  }

  async createProposal({ text, sourceEventRef }) {
    const proposal = await this.proposals.create({ requestedOutcome: text, sourceEventRef }, { source: 'feishu' });
    const submitted = proposal.status === 'draft' ? await this.proposals.submit(proposal.proposalId) : proposal;
    return {
      kind: 'agent_proposal', proposal,
      reply: submitted.status === 'pending_approval'
        ? `已生成 Agent 草案「${submitted.proposalId}」并提交组织级审核；通过受限测试前不会上线。`
        : `已找到 Agent 草案「${submitted.proposalId}」，当前状态：${submitted.status}。`
    };
  }

  async approvalFor(task) {
    const approvalId = task.approvalRefs?.[0];
    if (!approvalId || !this.store) return null;
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId && item.status === 'pending');
    if (!approval) return null;
    return {
      approvalId: approval.approvalId, governanceMode: approval.governanceMode,
      action: approval.action, riskLevel: approval.riskLevel, reason: approval.reason,
      requestedScope: approval.requestedScope, validUntil: approval.validUntil
    };
  }
}

export class FeishuCommanderValidationError extends Error {}

function replyFor(task, taskType) {
  if (taskType === 'operations.health-review') {
    const report = task.artifactRefs?.find((item) => item.type === 'health_report')?.data;
    return { kind: 'health_review', task, reply: report ? `系统检查完成：${report.overall === 'healthy' ? '本机核心组件正常' : '发现需要处理的组件'}。任务号：${task.taskId}。` : `已登记系统检查，任务号：${task.taskId}。` };
  }
  if (taskType === 'media.transcribe-and-refine') {
    if (!task.input?.sourceUrl) return { kind: 'media_task', task, reply: `已收到素材整理请求。请再发送一条可公开访问的视频或音频链接；未开始处理。任务号：${task.taskId}。` };
    return { kind: 'media_task', task, reply: `已交给小D处理公开素材，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  const intake = task.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
  return { kind: 'intake', task, reply: intake?.nextAction || `已收到任务，任务号：${task.taskId}。请补充具体交付物或发送“检查系统状态”“整理视频 + 链接”“创建一个 Agent”。` };
}

function publicUrl(text) { return String(text).match(/https?:\/\/[^\s<>"]+/i)?.[0]?.replace(/[),.;，。；]+$/, '') || null; }
function safeRef(value) { return String(value || '').trim().slice(0, 240) || null; }
