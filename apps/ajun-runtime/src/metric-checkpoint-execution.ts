import { M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
import { markM5SystemControllerFailure } from './m5-system-controller-recovery.ts';
import { assertMetricSnapshotLineage, assertPublishReceiptIdentity, trustedMetricSnapshotProducts, trustedPublishReceiptProducts, } from './trusted-publish-lineage.ts';
const METRIC_SNAPSHOT_SCHEMA: any = M5_SCHEMA_IDS.METRIC_SNAPSHOT;
const PUBLISHER_PROVIDER: any = 'agent-army.publisher-gateway';
const HOUR_MS: any = 3600000;
const RECOVERY_DELAY_MS: any = 15 * 60000;
const STALE_METRIC_INVOCATION_MS: any = 10 * 60000;
const METRIC_RECONCILE_ACTION: any = 'publisher.reconcile_stale_attempt';
const TRUSTED_REFERENCE: any = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CHECKPOINTS: any = Object.freeze([
    Object.freeze({ label: '2h', offsetMs: 2 * HOUR_MS }),
    Object.freeze({ label: '24h', offsetMs: 24 * HOUR_MS }),
    Object.freeze({ label: '72h', offsetMs: 72 * HOUR_MS }),
]);
export class MetricCheckpointExecution {
    governance: any;
    now: any;
    publisher: any;
    constructor({ governance, publisher, now = (): any => new Date(), }: any = {}) {
        this.governance = governance;
        this.publisher = publisher;
        this.now = now;
    }
    assertDependencies(): any {
        const requiredGovernance: any[] = [
            'getPipelineCaseOutputs',
            'updateIssueExecutionPolicy',
            'createIssueWorkProduct',
            'completeMetricMonitorIssue',
        ];
        if (requiredGovernance.some((method: any): any => typeof this.governance?.[method] !== 'function')) {
            throw new PaperclipMetricMonitorError('M5 指标控制器缺少 Paperclip 原生 Monitor/Work Product 适配。');
        }
        if (typeof this.publisher?.collectMetricSnapshot !== 'function') {
            throw new PaperclipMetricMonitorError('M5 指标连接器未启用；真实平台调用保持关闭。');
        }
    }
    async advance({ issue, caseId, runId, agentId }: any): Promise<any> {
        this.assertDependencies();
        const issueId: any = String(issue?.id || '').trim();
        const existingMonitor: any = issue.executionPolicy?.monitor;
        if (existingMonitor?.recoveryPolicy === 'human_review'
            && existingMonitor?.recoveryAction?.action === METRIC_RECONCILE_ACTION) {
            return {
                accepted: true,
                issueId,
                waitingForHumanReview: true,
                recoveryAction: structuredClone(existingMonitor.recoveryAction),
            };
        }
        let receipt: any;
        let collectionAttempted: any = false;
        let activeCheckpoint: any = null;
        try {
            const outputs: any = await this.governance.getPipelineCaseOutputs(caseId);
            receipt = trustedPublishReceipt(outputs);
            const completed: any = completedCheckpointLabels(outputs, receipt);
            const next: any = CHECKPOINTS.find((item: any): any => !completed.has(item.label));
            if (!next) {
                await this.complete(issue, { issueId, runId });
                return { accepted: true, issueId, completed: true, checkpointCount: 3 };
            }
            const dueAt: any = new Date(Date.parse(receipt.publishedAt) + next.offsetMs);
            const current: any = validDate(this.now());
            if (current.getTime() < dueAt.getTime()) {
                await this.schedule(issue, {
                    issueId,
                    runId,
                    receipt,
                    checkpoint: next,
                    nextCheckAt: dueAt,
                });
                return {
                    accepted: true,
                    issueId,
                    waiting: true,
                    checkpoint: next.label,
                    nextCheckAt: dueAt.toISOString(),
                };
            }
            const collectionKey: any = `${receipt.receiptId}:${next.label}`;
            activeCheckpoint = next;
            collectionAttempted = true;
            const result: any = await this.publisher.collectMetricSnapshot({
                receiptId: receipt.receiptId,
                collectionKey,
                collectedAt: current.toISOString(),
            }, {
                action: 'publisher.read_own_metrics',
                runId,
                issueId,
                campaignId: receipt.campaignId,
                agentId,
                authorizationId: `paperclip:${runId}:${issueId}:publisher.read_own_metrics:${next.label}`,
            });
            await this.persistSnapshot({
                issueId,
                caseId,
                runId,
                checkpoint: next,
                dueAt,
                receipt,
                snapshot: result.snapshot,
            });
            if (next.label === CHECKPOINTS.at(-1).label) {
                await this.complete(issue, { issueId, runId });
                return {
                    accepted: true,
                    issueId,
                    completed: true,
                    checkpoint: next.label,
                    replayed: result.replayed,
                };
            }
            const following: any = CHECKPOINTS[CHECKPOINTS.indexOf(next) + 1];
            await this.schedule(issue, {
                issueId,
                runId,
                receipt,
                checkpoint: following,
                nextCheckAt: new Date(Date.parse(receipt.publishedAt) + following.offsetMs),
            });
            return {
                accepted: true,
                issueId,
                completed: false,
                checkpoint: next.label,
                replayed: result.replayed,
            };
        }
        catch (error: any) {
            if (!collectionAttempted) {
                await this.scheduleReceiptRecovery(issue, {
                    issueId,
                    runId,
                    caseId,
                    error,
                }).catch((): any => undefined);
                throw error;
            }
            if (error?.code === 'metric_collection_active' && activeCheckpoint) {
                const humanReview: any = await this.scheduleStaleInvocationReview(issue, {
                    issueId,
                    runId,
                    receipt,
                    checkpoint: activeCheckpoint,
                }).catch((): any => null);
                if (humanReview)
                    return humanReview;
            }
            await this.scheduleRecovery(issue, {
                issueId,
                runId,
                caseId,
                receipt,
                error,
            }).catch((): any => undefined);
            throw markM5SystemControllerFailure(sanitizedMetricFailure(error));
        }
    }
    async complete(issue: any, { issueId, runId }: any): Promise<any> {
        await this.governance.completeMetricMonitorIssue(issueId, {
            runId,
            executionPolicy: withoutMonitor(issue.executionPolicy),
            comment: '2h、24h、72h 三个本人内容指标快照均已写回当前 Case。',
        });
    }
    async schedule(issue: any, { issueId, runId, receipt, checkpoint, nextCheckAt, }: any): Promise<any> {
        const timeoutAt: any = new Date(Date.parse(receipt.publishedAt) + 7 * 24 * HOUR_MS);
        await this.governance.updateIssueExecutionPolicy(issueId, {
            runId,
            executionPolicy: withMonitor(issue.executionPolicy, {
                nextCheckAt: validDate(nextCheckAt).toISOString(),
                notes: `M5 本人内容指标 ${checkpoint.label} 检查点`,
                scheduledBy: 'assignee',
                kind: 'external_service',
                serviceName: 'm5-publisher-metrics',
                externalRef: `${receipt.receiptId}:${checkpoint.label}`,
                timeoutAt: timeoutAt.toISOString(),
                maxAttempts: 8,
                recoveryPolicy: 'wake_owner',
            }),
        });
    }
    async scheduleRecovery(issue: any, { issueId, runId, caseId, receipt, error, }: any): Promise<any> {
        const current: any = validDate(this.now());
        const completed: any = completedCheckpointLabels(await this.governance.getPipelineCaseOutputs(caseId), receipt);
        const checkpoint: any = CHECKPOINTS.find((item: any): any => !completed.has(item.label));
        if (!checkpoint)
            return;
        const dueAt: any = Date.parse(receipt.publishedAt) + checkpoint.offsetMs;
        const retryAt: any = new Date(Math.max(current.getTime() + RECOVERY_DELAY_MS, dueAt));
        await this.governance.updateIssueExecutionPolicy(issueId, {
            runId,
            executionPolicy: withMonitor(issue.executionPolicy, {
                nextCheckAt: retryAt.toISOString(),
                notes: `M5 ${checkpoint.label} 采集失败，等待原生 Monitor 恢复：${safeError(error)}`,
                scheduledBy: 'assignee',
                kind: 'external_service',
                serviceName: 'm5-publisher-metrics',
                externalRef: `${receipt.receiptId}:${checkpoint.label}`,
                timeoutAt: new Date(Date.parse(receipt.publishedAt) + 7 * 24 * HOUR_MS).toISOString(),
                maxAttempts: 8,
                recoveryPolicy: 'wake_owner',
            }),
        });
    }
    async scheduleStaleInvocationReview(issue: any, { issueId, runId, receipt, checkpoint, }: any): Promise<any> {
        if (typeof this.publisher?.getAttempt !== 'function')
            return null;
        const collectionKey: any = `${receipt.receiptId}:${checkpoint.label}`;
        const attemptKey: any = `metric:${collectionKey}`;
        const attempt: any = await this.publisher.getAttempt(attemptKey);
        const current: any = validDate(this.now());
        const invokingAt: any = Date.parse(attempt?.invokingAt);
        const ageMs: any = current.getTime() - invokingAt;
        if (attempt?.kind !== 'metric_snapshot'
            || attempt?.state !== 'invoking'
            || attempt?.idempotencyKey !== attemptKey
            || attempt?.collectionKey !== collectionKey
            || attempt?.receiptId !== receipt.receiptId
            || attempt?.campaignId !== receipt.campaignId
            || !TRUSTED_REFERENCE.test(String(attempt?.attemptId || ''))
            || !Number.isFinite(invokingAt)
            || ageMs < STALE_METRIC_INVOCATION_MS) {
            return null;
        }
        const recoveryAction: any = Object.freeze({
            action: METRIC_RECONCILE_ACTION,
            attemptId: attempt.attemptId,
            collectionKey,
            allowedConclusions: Object.freeze([
                'no_external_effect',
                'external_effect_verified',
            ]),
            instruction: '负责人必须先核对旧指标外部调用是否已终止及是否产生外部效果，再通过独立 Paperclip 授权执行恢复；禁止自动重试 connector。',
        });
        await this.governance.updateIssueExecutionPolicy(issueId, {
            runId,
            executionPolicy: withMonitor(issue.executionPolicy, {
                nextCheckAt: new Date(current.getTime() + 24 * HOUR_MS).toISOString(),
                notes: `M5 ${checkpoint.label} 指标调用超过 10 分钟仍为 invoking，等待负责人核对；禁止自动重试 connector。`,
                scheduledBy: 'assignee',
                kind: 'external_service',
                serviceName: 'm5-publisher-metrics',
                externalRef: collectionKey,
                timeoutAt: new Date(Date.parse(receipt.publishedAt) + 7 * 24 * HOUR_MS).toISOString(),
                maxAttempts: 8,
                recoveryPolicy: 'human_review',
                automaticRetry: false,
                recoveryAction,
            }),
        });
        return {
            accepted: true,
            issueId,
            checkpoint: checkpoint.label,
            waitingForHumanReview: true,
            recoveryAction,
        };
    }
    async scheduleReceiptRecovery(issue: any, { issueId, runId, caseId, error }: any): Promise<any> {
        const current: any = validDate(this.now());
        await this.governance.updateIssueExecutionPolicy(issueId, {
            runId,
            executionPolicy: withMonitor(issue.executionPolicy, {
                nextCheckAt: new Date(current.getTime() + RECOVERY_DELAY_MS).toISOString(),
                notes: `M5 等待可信 PublishReceipt：${safeError(error)}`,
                scheduledBy: 'assignee',
                kind: 'external_service',
                serviceName: 'm5-publisher-metrics',
                externalRef: `case:${caseId}:publish-receipt`,
                timeoutAt: new Date(current.getTime() + 24 * HOUR_MS).toISOString(),
                maxAttempts: 8,
                recoveryPolicy: 'wake_owner',
            }),
        });
    }
    async persistSnapshot({ issueId, caseId, runId, checkpoint, dueAt, receipt, snapshot, }: any): Promise<any> {
        const expectedCollectionKey: any = `${receipt.receiptId}:${checkpoint.label}`;
        const verifiedSnapshot: any = assertMetricSnapshotMatches({
            snapshot,
            receipt,
            expectedCollectionKey,
            dueAt,
        });
        const latestOutputs: any = await this.governance.getPipelineCaseOutputs(caseId);
        if (completedCheckpointLabels(latestOutputs, receipt).has(checkpoint.label))
            return;
        await this.governance.createIssueWorkProduct(issueId, {
            type: 'artifact',
            provider: PUBLISHER_PROVIDER,
            externalId: verifiedSnapshot.snapshotId,
            title: `M5 指标快照 / ${checkpoint.label}`,
            status: 'active',
            reviewState: 'none',
            isPrimary: false,
            healthStatus: 'healthy',
            summary: `${receipt.platform} ${checkpoint.label} 本人内容指标已采集。`,
            metadata: {
                schemaVersion: METRIC_SNAPSHOT_SCHEMA,
                kind: 'MetricSnapshot',
                checkpoint: checkpoint.label,
                dueAt: dueAt.toISOString(),
                receiptId: receipt.receiptId,
                collectionKey: verifiedSnapshot.collectionKey,
                snapshot: verifiedSnapshot,
            },
            createdByRunId: runId,
        }, { runId });
    }
}
export class PaperclipMetricMonitorError extends Error {
    code: any;
    name: any;
    constructor(message: any, code: any = 'metric_monitor_invalid') {
        super(message);
        this.name = 'PaperclipMetricMonitorError';
        this.code = code;
    }
}
export function trustedPublishReceipt(outputs: any): any {
    const items: any = trustedPublishReceiptProducts(outputs);
    if (items.length !== 1) {
        throw new PaperclipMetricMonitorError(`当前 Case 必须且只能有一个标准信任的 PublishReceipt，实际为 ${items.length} 个。`, 'metric_publish_receipt_ambiguous');
    }
    return assertPublishReceiptIdentity(items[0].metadata.receipt, {
        requireMetricIdentity: true,
        invalid: (): any => new PaperclipMetricMonitorError('PublishReceipt 结构无效，拒绝派生指标检查点。', 'metric_publish_receipt_identity_invalid'),
    });
}
export function completedCheckpointLabels(outputs: any, receipt: any): any {
    const completed: any = new Set();
    for (const item of trustedMetricSnapshotProducts(outputs)) {
        const checkpoint: any = CHECKPOINTS.find((candidate: any): any => candidate.label === item?.metadata?.checkpoint);
        if (!checkpoint
            || item.metadata?.receiptId !== receipt.receiptId) {
            continue;
        }
        const dueAt: any = new Date(Date.parse(receipt.publishedAt) + checkpoint.offsetMs);
        const expectedCollectionKey: any = `${receipt.receiptId}:${checkpoint.label}`;
        if (item.metadata.dueAt !== dueAt.toISOString()
            || item.metadata.collectionKey !== expectedCollectionKey) {
            continue;
        }
        try {
            const snapshot: any = assertMetricSnapshotMatches({
                snapshot: item.metadata.snapshot,
                receipt,
                expectedCollectionKey,
                dueAt,
            });
            if (item.externalId !== snapshot.snapshotId)
                continue;
            completed.add(checkpoint.label);
        }
        catch {
            // 历史或伪造的标签不能替代完整 MetricSnapshot 身份核验。
        }
    }
    return completed;
}
function withMonitor(executionPolicy: any, monitor: any): any {
    return {
        ...(executionPolicy && typeof executionPolicy === 'object' ? executionPolicy : {}),
        monitor,
    };
}
function withoutMonitor(executionPolicy: any): any {
    return {
        ...(executionPolicy && typeof executionPolicy === 'object' ? executionPolicy : {}),
        monitor: null,
    };
}
function validDate(value: any): any {
    const date: any = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime()))
        throw new PaperclipMetricMonitorError('指标控制器时钟无效。');
    return date;
}
function assertMetricSnapshotMatches({ snapshot, receipt, expectedCollectionKey, dueAt, }: any): any {
    return assertMetricSnapshotLineage({
        snapshot,
        receipt,
        expectedCollectionKey,
        dueAt,
        invalid: (): any => new PaperclipMetricMonitorError('Publisher 返回的 MetricSnapshot 与当前回执、检查点或采集时间不一致。', 'metric_snapshot_identity_invalid'),
    });
}
function sanitizedMetricFailure(error: any): any {
    const candidate: any = String(error?.code || '');
    const code: any = /^[a-z][a-z0-9_.-]{1,119}$/i.test(candidate)
        ? candidate
        : 'metric_collection_failed';
    return new PaperclipMetricMonitorError(`指标采集失败，等待安全恢复：${safeError(error)}`, code);
}
function safeError(error: any): any {
    return String(error?.code || error?.message || 'metric_collection_failed')
        .replace(/(?:\/Users|\/home|\/private|\/var\/folders)\/[^\s"'`]+/g, '[local-path]')
        .replace(/\b[A-Za-z]:\\[^\s"'`]+/g, '[local-path]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [credential]')
        .replace(/\b(token|cookie|authorization|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[credential]')
        .replace(/\b(?:sk|key|token|secret)[-_][a-z0-9._-]{8,}\b/gi, '[credential]')
        .replace(/https?:\/\/[^\s"'`]+/gi, '[external-url]')
        .replace(/\s+/g, ' ')
        .slice(0, 180);
}
