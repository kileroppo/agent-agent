import {
  M5LearningLifecycle,
  M5LearningLifecycleError,
} from './m5-learning-lifecycle.js';

const SYSTEM_ROLE = 'm5-retrospective-controller';
const ROUTINE_MARKER = '[agent-army:m5:routine:m5-learning]';
const TERMINAL_STATES = new Set(['validated', 'rolled_back', 'rejected']);
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

export class PaperclipLearningLifecycleHandler {
  constructor({ governance, lifecycle = null, now = () => new Date() } = {}) {
    this.governance = governance;
    this.lifecycle = lifecycle || new M5LearningLifecycle({ governance, now });
    this.inFlightIssues = new Map();
  }

  async handle(payload = {}) {
    assertNoSelectionParameters(payload);
    const runId = String(payload.runId || '').trim();
    const agentId = String(payload.agentId || '').trim();
    const issueId = String(payload.context?.taskId || '').trim();
    if (!runId || !agentId || !issueId) {
      throw new PaperclipLearningLifecycleError(
        'M5 学习 heartbeat 缺少运行、控制器或任务标识。',
      );
    }
    if (this.inFlightIssues.has(issueId)) return this.inFlightIssues.get(issueId);
    const execution = this.execute({ issueId, runId, agentId });
    this.inFlightIssues.set(issueId, execution);
    try {
      return await execution;
    } finally {
      this.inFlightIssues.delete(issueId);
    }
  }

  async execute({ issueId, runId, agentId }) {
    this.assertDependencies();
    const verified = await this.governance.verifySystemAssignment({
      issueId,
      runId,
      paperclipAgentId:agentId,
      systemRole:SYSTEM_ROLE,
    });
    const issue = verified.issue;
    if (issue.status === 'done') {
      return { accepted:true, skipped:true, issueId, reason:'学习任务已经完成。' };
    }
    if (!['in_progress', 'in_review'].includes(issue.status)) {
      throw new PaperclipLearningLifecycleError(
        '学习任务必须处于 in_progress 或 in_review。',
      );
    }
    if (!String(issue.description || '').includes(ROUTINE_MARKER)) {
      throw new PaperclipLearningLifecycleError(
        'HTTP 控制器只接受 M5 学习 Routine 的固定任务。',
      );
    }
    const caseId = learningCaseBinding(issue.description);
    await this.governance.assertCaseIssueLink(caseId, issueId);
    const result = await this.lifecycle.advance({ caseId, issueId, runId });
    const terminal = TERMINAL_STATES.has(result.state);
    await this.governance.updateLearningIssue(issueId, {
      runId,
      status:terminal
        ? 'done'
        : result.state === 'waiting_reviewer_approval' ? 'in_review' : 'in_progress',
      comment:learningComment(result),
    });
    return {
      accepted:true,
      terminal,
      issueId,
      caseId,
      ...result,
    };
  }

  assertDependencies() {
    const required = [
      'verifySystemAssignment',
      'assertCaseIssueLink',
      'updateLearningIssue',
    ];
    if (
      required.some((method) => typeof this.governance?.[method] !== 'function')
      || typeof this.lifecycle?.advance !== 'function'
    ) {
      throw new PaperclipLearningLifecycleError(
        'M5 学习控制器缺少 Paperclip Case/Issue/Run/Work Product 适配。',
      );
    }
  }
}

export class PaperclipLearningLifecycleError extends Error {}

function learningCaseBinding(description) {
  const match = String(description || '').match(
    new RegExp(`(?:Case|case)(?:\\s*ID)?\\s*(?:为|:|=)\\s*(${UUID})`, 'i'),
  );
  if (!match) {
    throw new PaperclipLearningLifecycleError(
      'M5 学习任务缺少固定 Case 绑定。',
    );
  }
  return match[1];
}

function learningComment(result) {
  const product = result.workProductId ? `；Work Product ${result.workProductId}` : '';
  if (result.state === 'waiting_reviewer_approval') {
    return `离线回放已通过，等待审核官审批模板改进提案${product}。`;
  }
  if (result.state === 'waiting_single_gray_content') {
    return `模板版本已批准，只等待一条绑定该版本的灰度内容${product}。`;
  }
  if (result.state === 'waiting_gray_quality_and_72h_metric') {
    return `单条灰度已登记，等待机器审核与72小时本人内容指标${product}。`;
  }
  if (result.state === 'rolled_back') return `灰度下降，已写回自动回退决定${product}。`;
  if (result.state === 'validated') return `单条灰度未下降，模板版本已通过${product}。`;
  if (result.state === 'rejected') return `审核官要求修改，模板提案已拒绝${product}。`;
  return `M5 学习生命周期推进到 ${result.state}${product}。`;
}

function assertNoSelectionParameters(payload) {
  for (const key of [
    'caseId',
    'issueId',
    'templateVersionId',
    'contentVersionId',
    'metricSnapshotId',
    'reviewState',
    'decision',
  ]) {
    if (Object.hasOwn(payload || {}, key)) {
      throw new PaperclipLearningLifecycleError(
        `M5 学习 heartbeat 不接受调用方指定 ${key}。`,
      );
    }
  }
}

export { M5LearningLifecycleError };
