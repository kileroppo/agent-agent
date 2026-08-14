import { M5LearningLifecycle, M5LearningLifecycleError, } from './m5-learning-lifecycle.ts';
const SYSTEM_ROLE: any = 'm5-learning-controller';
const ROUTINE_MARKER: any = '[agent-army:m5:routine:m5-learning]';
const TERMINAL_STATES: any = new Set(['validated', 'rolled_back', 'rejected']);
const AUTO_ADVANCE_CREATED_KINDS: any = new Set([
    'OfflineReplay',
    'TemplateVersion',
    'TemplateGrayRelease',
]);
const MAX_ADVANCES_PER_HEARTBEAT: any = 8;
const UUID: any = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
export class PaperclipLearningLifecycleHandler {
    governance: any;
    inFlightIssues: any;
    lifecycle: any;
    constructor({ governance, lifecycle = null, now = (): any => new Date() }: any = {}) {
        this.governance = governance;
        this.lifecycle = lifecycle || new M5LearningLifecycle({ governance, now });
        this.inFlightIssues = new Map();
    }
    async handle(payload: any = {}): Promise<any> {
        assertNoSelectionParameters(payload);
        const runId: any = String(payload.runId || '').trim();
        const agentId: any = String(payload.agentId || '').trim();
        const issueId: any = String(payload.context?.taskId || '').trim();
        if (!runId || !agentId || !issueId) {
            throw new PaperclipLearningLifecycleError('M5 学习 heartbeat 缺少运行、控制器或任务标识。');
        }
        if (this.inFlightIssues.has(issueId))
            return this.inFlightIssues.get(issueId);
        const execution: any = this.execute({ issueId, runId, agentId });
        this.inFlightIssues.set(issueId, execution);
        try {
            return await execution;
        }
        finally {
            this.inFlightIssues.delete(issueId);
        }
    }
    async execute({ issueId, runId, agentId }: any): Promise<any> {
        this.assertDependencies();
        const verified: any = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: agentId,
            systemRole: SYSTEM_ROLE,
        });
        const issue: any = verified.issue;
        if (issue.status === 'done') {
            return { accepted: true, skipped: true, issueId, reason: '学习任务已经完成。' };
        }
        if (!['in_progress', 'in_review'].includes(issue.status)) {
            throw new PaperclipLearningLifecycleError('学习任务必须处于 in_progress 或 in_review。');
        }
        if (!String(issue.description || '').includes(ROUTINE_MARKER)) {
            throw new PaperclipLearningLifecycleError('HTTP 控制器只接受 M5 学习 Routine 的固定任务。');
        }
        const { caseId, caseVersion } = learningCaseBinding(issue.description);
        await this.governance.assertCaseIssueLink(caseId, issueId);
        const result: any = await this.advanceToBoundary({ caseId, issueId, runId });
        const terminal: any = TERMINAL_STATES.has(result.state);
        if (terminal) {
            const currentCase: any = normalizeCase(await this.governance.getPipelineCase(caseId));
            if (currentCase.stageKey === 'learning' && currentCase.version === caseVersion) {
                await this.governance.transitionPipelineCase(caseId, {
                    expectedVersion: caseVersion,
                    toStageKey: 'done',
                }, { runId });
            }
            else if (currentCase.stageKey !== 'done' || currentCase.version !== caseVersion + 1) {
                throw new PaperclipLearningLifecycleError('模板决定与当前 Paperclip Case 学习阶段或版本不一致。');
            }
        }
        await this.governance.updateLearningIssue(issueId, {
            runId,
            status: terminal
                ? 'done'
                : result.state === 'waiting_reviewer_approval' ? 'in_review' : 'in_progress',
            comment: learningComment(result),
        });
        return {
            accepted: true,
            terminal,
            issueId,
            caseId,
            caseVersion,
            ...result,
        };
    }
    async advanceToBoundary(context: any): Promise<any> {
        for (let attempt: any = 1; attempt <= MAX_ADVANCES_PER_HEARTBEAT; attempt += 1) {
            const result: any = await this.lifecycle.advance(context);
            if (result?.replayed !== false
                || !AUTO_ADVANCE_CREATED_KINDS.has(result?.createdKind))
                return result;
        }
        throw new PaperclipLearningLifecycleError('M5 学习生命周期单次 heartbeat 超过安全推进上限。');
    }
    assertDependencies(): any {
        const required: any[] = [
            'verifySystemAssignment',
            'assertCaseIssueLink',
            'getPipelineCase',
            'transitionPipelineCase',
            'updateLearningIssue',
        ];
        if (required.some((method: any): any => typeof this.governance?.[method] !== 'function')
            || typeof this.lifecycle?.advance !== 'function') {
            throw new PaperclipLearningLifecycleError('M5 学习控制器缺少 Paperclip Case/Issue/Run/Work Product 适配。');
        }
    }
}
export class PaperclipLearningLifecycleError extends Error {
}
function learningCaseBinding(description: any): any {
    const text: any = String(description || '');
    const caseId: any = text.match(new RegExp(`(?:Case|case)(?:\\s*ID)?\\s*(?:为|:|=)\\s*(${UUID})`, 'i'))?.[1];
    const caseVersion: any = Number(text.match(/版本为\s*(\d+)/)?.[1]);
    if (!caseId || !Number.isInteger(caseVersion) || caseVersion <= 0) {
        throw new PaperclipLearningLifecycleError('M5 学习任务缺少固定 Case 与版本绑定。');
    }
    return { caseId, caseVersion };
}
function normalizeCase(value: any): any {
    const item: any = value?.case ?? value;
    return {
        ...item,
        stageKey: item?.stageKey ?? value?.stage?.key ?? item?.stage?.key ?? null,
    };
}
function learningComment(result: any): any {
    const product: any = result.workProductId ? `；Work Product ${result.workProductId}` : '';
    if (result.state === 'waiting_reviewer_approval') {
        return `离线回放已通过，等待审核官审批模板改进提案${product}。`;
    }
    if (result.state === 'waiting_single_gray_content') {
        return `模板版本已批准，只等待一条绑定该版本的灰度内容${product}。`;
    }
    if (result.state === 'waiting_gray_target_case') {
        return `模板提案已批准，但当前活动没有尚未执行的日期 Case；等待下一条可预约灰度内容${product}。`;
    }
    if (result.state === 'waiting_gray_quality_and_72h_metric') {
        return `单条灰度已登记，等待机器审核与72小时本人内容指标${product}。`;
    }
    if (result.state === 'rolled_back')
        return `灰度下降，已写回自动回退决定${product}。`;
    if (result.state === 'validated')
        return `单条灰度未下降，模板版本已通过${product}。`;
    if (result.state === 'rejected')
        return `审核官要求修改，模板提案已拒绝${product}。`;
    return `M5 学习生命周期推进到 ${result.state}${product}。`;
}
function assertNoSelectionParameters(payload: any): any {
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
            throw new PaperclipLearningLifecycleError(`M5 学习 heartbeat 不接受调用方指定 ${key}。`);
        }
    }
}
export { M5LearningLifecycleError };
