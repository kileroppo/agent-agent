import { validateTaskCompletion } from './task-completion-contract.ts';
import { PaperclipAssignmentCompletion, pendingPaperclipCompletion, } from './paperclip-assignment-completion.ts';
import { PaperclipHermesReconciliationSource } from './paperclip-hermes-reconciliation-source.ts';
import { expectedAnalysisIntent, hasReadableArtifact, mergeArtifactRefs, taskFailure, validDate, validLocalEvidenceReport, } from './paperclip-hermes-task-support.ts';
const FAILURE_STATUSES: any = new Set(['blocked', 'failed']);
export class PaperclipHermesTaskReconciler {
    fallback: any;
    governance: any;
    intervalMs: any;
    now: any;
    running: any;
    store: any;
    timer: any;
    taskSource: any;
    constructor({ store, governance, fallback = null, now = (): any => Date.now(), intervalMs = 10000 }: any = {}) {
        this.store = store;
        this.governance = governance;
        this.fallback = fallback;
        this.now = now;
        this.intervalMs = intervalMs;
        this.timer = null;
        this.running = null;
        this.taskSource = new PaperclipHermesReconciliationSource(store);
    }
    start(): any {
        if (this.timer)
            return;
        void this.reconcile();
        this.timer = setInterval((): any => void this.reconcile(), this.intervalMs);
        this.timer.unref?.();
    }
    stop(): any {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    async reconcile(): Promise<any> {
        if (this.running)
            return this.running;
        this.running = this.reconcileOnce().finally((): any => { this.running = null; });
        return this.running;
    }
    async reconcileOnce(): Promise<any> {
        const tasks: any = await this.taskSource.list();
        const pending: any = tasks.filter((task: any): any => pendingPaperclipCompletion(task));
        const delegated: any = tasks.filter(isDelegatedHermesTask);
        await Promise.all(pending.map((task: any): any => this.reconcilePendingCompletion(task)));
        await Promise.all(delegated.map((task: any): any => this.reconcileTask(task)));
        return pending.length + delegated.length;
    }
    async reconcilePendingCompletion(task: any): Promise<any> {
        if (!pendingPaperclipCompletion(task))
            return;
        await this.assignmentCompletion().reconcilePending(task);
    }
    async reconcileTask(task: any): Promise<any> {
        let issue: any;
        try {
            issue = await this.governance.getPaperclipIssue(task.governance.paperclipIssueId);
        }
        catch {
            // Paperclip 短时不可用不应改写业务真相，也不刷新任务时间戳。
            return;
        }
        if (issue?.status === 'cancelled') {
            await this.settle(task, {
                status: 'cancelled',
                currentStage: 'paperclip_hermes_cancelled',
                outcome: 'cancelled_in_paperclip',
                error: null
            });
            return;
        }
        if (FAILURE_STATUSES.has(issue?.status)) {
            const hasArtifact: any = hasReadableArtifact(task);
            if (await this.tryLocalEvidenceFallback(task, issue))
                return;
            const latestRun: any = await this.latestRun(task);
            const processExitedWithoutCompletion: any = latestRun?.status === 'succeeded' && !hasArtifact;
            await this.settle(task, hasArtifact ? {
                status: 'waiting_test',
                currentStage: 'paperclip_hermes_waiting_test',
                outcome: 'artifact_requires_review',
                error: task.error || taskFailure('paperclip_hermes_requires_review', 'Paperclip 已结束本次运行，但本机保留了可读产物；需要人工核对后再决定是否采用。', this.now()),
                latestRun,
            } : {
                status: 'failed',
                currentStage: 'paperclip_hermes_failed',
                outcome: processExitedWithoutCompletion
                    ? 'paperclip_process_exited_without_completion'
                    : 'paperclip_hermes_failed',
                error: task.error || taskFailure(
                    processExitedWithoutCompletion
                        ? 'paperclip_process_exited_without_completion'
                        : 'paperclip_hermes_failed',
                    processExitedWithoutCompletion
                        ? 'Paperclip 进程显示已退出，但岗位没有完成指派，也没有回写可验证产物；本轮业务仍未完成，不能把运行成功当成交付成功。'
                        : 'Paperclip 执行器本轮没有生成可验证产物。请打开关联的 Paperclip 任务查看最后一次运行原因。',
                    this.now(),
                    { category:'configuration', retryable:true },
                ),
                latestRun,
            });
            return;
        }
        if (issue?.status === 'done') {
            const completion: any = validateTaskCompletion(task);
            const hasArtifact: any = completion.valid;
            const latestRun: any = await this.latestRun(task);
            await this.settle(task, hasArtifact ? {
                status: 'succeeded',
                currentStage: 'paperclip_hermes_completed',
                outcome: 'verified_artifact_ready',
                error: null,
                latestRun,
            } : {
                status: 'waiting_test',
                currentStage: 'paperclip_hermes_evidence_missing',
                outcome: 'paperclip_done_without_local_evidence',
                error: taskFailure('paperclip_hermes_evidence_missing', 'Paperclip 已标记完成，但 A君没有找到可验证的本地产物；已转为待测试，不冒充完整成功。', this.now()),
                latestRun,
            });
        }
    }
    async tryLocalEvidenceFallback(task: any, issue: any): Promise<any> {
        if (task.taskType !== 'content.video-benchmark-analysis')
            return false;
        const expectedIntent: any = expectedAnalysisIntent(task.input);
        let result: Record<string, any> = {
            artifactRefs: task.artifactRefs || [],
            usage: task.usage,
            execution: task.execution,
        };
        let artifact: any = result.artifactRefs.find((candidate: any): any => (validLocalEvidenceReport(candidate, expectedIntent, task.input?.evidenceMode)));
        if (!artifact && typeof this.fallback !== 'function')
            return false;
        try {
            if (!artifact)
                result = await this.fallback(task, { issue });
        }
        catch {
            return false;
        }
        artifact = artifact || (result?.artifactRefs || []).find((candidate: any): any => (validLocalEvidenceReport(candidate, expectedIntent, task.input?.evidenceMode)));
        if (!artifact)
            return false;
        const requiresReview: any = expectedIntent === 'deep';
        const currentStage: any = requiresReview
            ? 'local_evidence_fallback_waiting_test'
            : 'local_evidence_fallback_ready';
        const finishedAt: any = new Date(this.now()).toISOString();
        await this.store.updateTask(task.taskId, {
            status: requiresReview ? 'waiting_test' : 'succeeded',
            currentStage,
            execution: {
                ...(task.execution || {}),
                ...(result.execution || {}),
                owner: 'local-evidence-fallback',
                finishedAt,
                outcome: currentStage
            },
            usage: result.usage || task.usage,
            artifactRefs: mergeArtifactRefs(task.artifactRefs, result.artifactRefs),
            error: requiresReview ? taskFailure('local_evidence_fallback_requires_review', 'Hermes 未能完成深度分析；本机已生成证据化 13 模块报告，需人工核对后采用。', this.now()) : null
        });
        return true;
    }
    async latestRun(task: any): Promise<any> {
        if (typeof this.governance?.getPaperclipIssueRuns !== 'function')
            return null;
        try {
            const runs: any = await this.governance.getPaperclipIssueRuns(task.governance.paperclipIssueId);
            const run: any = Array.isArray(runs) ? runs[0] : null;
            const runId: any = String(run?.runId || run?.id || '').trim();
            if (!runId)
                return null;
            return {
                runId,
                status: String(run?.status || 'unknown').trim().slice(0, 80),
                startedAt: validDate(run?.startedAt),
                finishedAt: validDate(run?.finishedAt),
            };
        }
        catch {
            return null;
        }
    }
    async settle(task: any, { status, currentStage, outcome, error, latestRun = null }: any): Promise<any> {
        const finishedAt: any = new Date(this.now()).toISOString();
        await this.store.updateTask(task.taskId, {
            status,
            currentStage,
            execution: {
                ...(task.execution || {}),
                ...(latestRun ? { paperclipRunId:latestRun.runId, paperclipRun:latestRun } : {}),
                finishedAt,
                outcome,
            },
            error
        });
    }
    assignmentCompletion(): any {
        return new PaperclipAssignmentCompletion({
            store: this.store,
            governance: this.governance,
            now: (): any => new Date(this.now()).toISOString(),
        });
    }
}
function isDelegatedHermesTask(task: any): any {
    return task?.status === 'running'
        && task.taskType !== 'operations.technical-repair'
        && task.execution?.owner === 'paperclip-hermes'
        && Boolean(task.governance?.paperclipIssueId);
}
