import {
  consumeM5SystemControllerPlanRevision,
  isRecoverableM5SystemControllerFailure,
  markM5SystemControllerFailure,
  recoverM5SystemControllerFailure,
} from './m5-system-controller-recovery.js';

const METRIC_SYSTEM_ROLE = 'm5-metrics-controller';
const METRIC_ROUTINE_MARKER = '[agent-army:m5:routine:m5-metrics]';
const PUBLISH_RECEIPT_SCHEMA = 'agent.army/publish-receipt/v1';
const METRIC_SNAPSHOT_SCHEMA = 'agent.army/metric-snapshot/v1';
const PUBLISHER_PROVIDER = 'agent-army.publisher-gateway';
const HOUR_MS = 3_600_000;
const RECOVERY_DELAY_MS = 15 * 60_000;
const STALE_METRIC_INVOCATION_MS = 10 * 60_000;
const METRIC_RECONCILE_ACTION = 'publisher.reconcile_stale_attempt';
const MAX_METRIC_OBSERVATION_AGE_MS = 5 * 60_000;
const TRUSTED_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CONNECTOR_MODE = /^(?:fake|real:[a-z0-9][a-z0-9_-]{0,127})$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINTS = Object.freeze([
  Object.freeze({ label:'2h', offsetMs:2 * HOUR_MS }),
  Object.freeze({ label:'24h', offsetMs:24 * HOUR_MS }),
  Object.freeze({ label:'72h', offsetMs:72 * HOUR_MS }),
]);
const FORBIDDEN_CALLER_FIELDS = new Set([
  'receiptId',
  'collectionKey',
  'collectedAt',
  'publishedAt',
  'dueAt',
  'checkpoint',
  'campaignId',
  'accountRef',
  'connectorMode',
  'externalContentId',
  'metrics',
  'source',
  'trustedContext',
  'observation',
]);

export class PaperclipMetricMonitorHandler {
  constructor({
    governance,
    publisher,
    now = () => new Date(),
  } = {}) {
    this.governance = governance;
    this.publisher = publisher;
    this.now = now;
    this.inFlightIssues = new Map();
  }

  async handle(payload) {
    assertNoMetricSelectionParameters(payload);
    const runId = String(payload?.runId || '').trim();
    const agentId = String(payload?.agentId || '').trim();
    const issueId = String(payload?.context?.taskId || '').trim();
    if (!runId || !agentId || !issueId) {
      throw new PaperclipMetricMonitorError('M5 指标 HTTP heartbeat 缺少运行、控制器或任务标识。');
    }
    if (this.inFlightIssues.has(issueId)) return this.inFlightIssues.get(issueId);
    const execution = this.executeIssue({ issueId, runId, agentId });
    this.inFlightIssues.set(issueId, execution);
    try {
      return await execution;
    } catch (error) {
      if (!isRecoverableM5SystemControllerFailure(error)) throw error;
      try {
        return await recoverM5SystemControllerFailure({
          governance:this.governance,
          issueId,
          runId,
          agentId,
          routineKey:'m5-metrics',
          systemRole:METRIC_SYSTEM_ROLE,
          error,
        });
      } catch {
        throw error;
      }
    } finally {
      this.inFlightIssues.delete(issueId);
    }
  }

  async executeIssue({ issueId, runId, agentId }) {
    this.assertDependencies();
    const verified = await this.governance.verifySystemAssignment({
      issueId,
      runId,
      paperclipAgentId:agentId,
      systemRole:METRIC_SYSTEM_ROLE,
    });
    const issue = verified.issue;
    if (issue.status === 'done') {
      return { accepted:true, skipped:true, issueId, reason:'三个指标检查点已完成。' };
    }
    if (!['in_progress', 'in_review'].includes(issue.status)) {
      throw new PaperclipMetricMonitorError('指标 Monitor 任务必须处于 in_progress 或 in_review。');
    }
    if (!String(issue.description || '').includes(METRIC_ROUTINE_MARKER)) {
      throw new PaperclipMetricMonitorError('HTTP 控制器只接受 M5 指标回流 Routine 的固定任务。');
    }
    const existingMonitor = issue.executionPolicy?.monitor;
    if (
      existingMonitor?.recoveryPolicy === 'human_review'
      && existingMonitor?.recoveryAction?.action === METRIC_RECONCILE_ACTION
    ) {
      return {
        accepted:true,
        issueId,
        waitingForHumanReview:true,
        recoveryAction:structuredClone(existingMonitor.recoveryAction),
      };
    }
    const caseId = metricCaseId(issue);
    await this.governance.assertCaseIssueLink(caseId, issueId);
    await consumeM5SystemControllerPlanRevision({
      governance:this.governance,
      pipelineCaseId:caseId,
      runId,
      routineKey:'m5-metrics',
      systemRole:METRIC_SYSTEM_ROLE,
    });

    let receipt;
    let collectionAttempted = false;
    let activeCheckpoint = null;
    try {
      const outputs = await this.governance.getPipelineCaseOutputs(caseId);
      receipt = trustedPublishReceipt(outputs);
      const completed = completedCheckpointLabels(outputs, receipt);
      const next = CHECKPOINTS.find((item) => !completed.has(item.label));
      if (!next) {
        await this.governance.completeMetricMonitorIssue(issueId, {
          runId,
          executionPolicy:withoutMonitor(issue.executionPolicy),
          comment:'2h、24h、72h 三个本人内容指标快照均已写回当前 Case。',
        });
        return { accepted:true, issueId, completed:true, checkpointCount:3 };
      }

      const dueAt = new Date(Date.parse(receipt.publishedAt) + next.offsetMs);
      const current = validDate(this.now());
      if (current.getTime() < dueAt.getTime()) {
        await this.schedule(issue, {
          issueId,
          runId,
          receipt,
          checkpoint:next,
          nextCheckAt:dueAt,
        });
        return {
          accepted:true,
          issueId,
          waiting:true,
          checkpoint:next.label,
          nextCheckAt:dueAt.toISOString(),
        };
      }

      const collectionKey = `${receipt.receiptId}:${next.label}`;
      activeCheckpoint = next;
      collectionAttempted = true;
      const result = await this.publisher.collectMetricSnapshot({
        receiptId:receipt.receiptId,
        collectionKey,
        collectedAt:current.toISOString(),
      }, {
        action:'publisher.read_own_metrics',
        runId,
        issueId,
        campaignId:receipt.campaignId,
        agentId,
        authorizationId:`paperclip:${runId}:${issueId}:publisher.read_own_metrics:${next.label}`,
      });
      await this.persistSnapshot({
        issueId,
        caseId,
        runId,
        checkpoint:next,
        dueAt,
        receipt,
        snapshot:result.snapshot,
      });

      if (next.label === CHECKPOINTS.at(-1).label) {
        await this.governance.completeMetricMonitorIssue(issueId, {
          runId,
          executionPolicy:withoutMonitor(issue.executionPolicy),
          comment:'2h、24h、72h 三个本人内容指标快照均已写回当前 Case。',
        });
        return {
          accepted:true,
          issueId,
          completed:true,
          checkpoint:next.label,
          replayed:result.replayed,
        };
      }

      const following = CHECKPOINTS[CHECKPOINTS.indexOf(next) + 1];
      await this.schedule(issue, {
        issueId,
        runId,
        receipt,
        checkpoint:following,
        nextCheckAt:new Date(Date.parse(receipt.publishedAt) + following.offsetMs),
      });
      return {
        accepted:true,
        issueId,
        completed:false,
        checkpoint:next.label,
        replayed:result.replayed,
      };
    } catch (error) {
      if (!collectionAttempted) {
        await this.scheduleReceiptRecovery(issue, { issueId, runId, caseId, error }).catch(() => undefined);
        throw error;
      }
      if (error?.code === 'metric_collection_active' && activeCheckpoint) {
        const humanReview = await this.scheduleStaleInvocationReview(issue, {
          issueId,
          runId,
          receipt,
          checkpoint:activeCheckpoint,
        }).catch(() => null);
        if (humanReview) return humanReview;
      }
      await this.scheduleRecovery(issue, { issueId, runId, receipt, error }).catch(() => undefined);
      throw markM5SystemControllerFailure(sanitizedMetricFailure(error));
    }
  }

  assertDependencies() {
    const requiredGovernance = [
      'verifySystemAssignment',
      'assertCaseIssueLink',
      'getPipelineCaseOutputs',
      'updateIssueExecutionPolicy',
      'createIssueWorkProduct',
      'completeMetricMonitorIssue',
    ];
    if (requiredGovernance.some((method) => typeof this.governance?.[method] !== 'function')) {
      throw new PaperclipMetricMonitorError('M5 指标控制器缺少 Paperclip 原生 Monitor/Work Product 适配。');
    }
    if (typeof this.publisher?.collectMetricSnapshot !== 'function') {
      throw new PaperclipMetricMonitorError('M5 指标连接器未启用；真实平台调用保持关闭。');
    }
  }

  async schedule(issue, {
    issueId,
    runId,
    receipt,
    checkpoint,
    nextCheckAt,
  }) {
    const timeoutAt = new Date(Date.parse(receipt.publishedAt) + 7 * 24 * HOUR_MS);
    await this.governance.updateIssueExecutionPolicy(issueId, {
      runId,
      executionPolicy:withMonitor(issue.executionPolicy, {
        nextCheckAt:validDate(nextCheckAt).toISOString(),
        notes:`M5 本人内容指标 ${checkpoint.label} 检查点`,
        scheduledBy:'assignee',
        kind:'external_service',
        serviceName:'m5-publisher-metrics',
        externalRef:`${receipt.receiptId}:${checkpoint.label}`,
        timeoutAt:timeoutAt.toISOString(),
        maxAttempts:8,
        recoveryPolicy:'wake_owner',
      }),
    });
  }

  async scheduleRecovery(issue, { issueId, runId, receipt, error }) {
    const current = validDate(this.now());
      const completed = completedCheckpointLabels(
        await this.governance.getPipelineCaseOutputs(metricCaseId(issue)),
        receipt,
      );
    const checkpoint = CHECKPOINTS.find((item) => !completed.has(item.label));
    if (!checkpoint) return;
    const dueAt = Date.parse(receipt.publishedAt) + checkpoint.offsetMs;
    const retryAt = new Date(Math.max(current.getTime() + RECOVERY_DELAY_MS, dueAt));
    await this.governance.updateIssueExecutionPolicy(issueId, {
      runId,
      executionPolicy:withMonitor(issue.executionPolicy, {
        nextCheckAt:retryAt.toISOString(),
        notes:`M5 ${checkpoint.label} 采集失败，等待原生 Monitor 恢复：${safeError(error)}`,
        scheduledBy:'assignee',
        kind:'external_service',
        serviceName:'m5-publisher-metrics',
        externalRef:`${receipt.receiptId}:${checkpoint.label}`,
        timeoutAt:new Date(Date.parse(receipt.publishedAt) + 7 * 24 * HOUR_MS).toISOString(),
        maxAttempts:8,
        recoveryPolicy:'wake_owner',
      }),
    });
  }

  async scheduleStaleInvocationReview(issue, {
    issueId,
    runId,
    receipt,
    checkpoint,
  }) {
    if (typeof this.publisher?.getAttempt !== 'function') return null;
    const collectionKey = `${receipt.receiptId}:${checkpoint.label}`;
    const attemptKey = `metric:${collectionKey}`;
    const attempt = await this.publisher.getAttempt(attemptKey);
    const current = validDate(this.now());
    const invokingAt = Date.parse(attempt?.invokingAt);
    const ageMs = current.getTime() - invokingAt;
    if (
      attempt?.kind !== 'metric_snapshot'
      || attempt?.state !== 'invoking'
      || attempt?.idempotencyKey !== attemptKey
      || attempt?.collectionKey !== collectionKey
      || attempt?.receiptId !== receipt.receiptId
      || attempt?.campaignId !== receipt.campaignId
      || !TRUSTED_REFERENCE.test(String(attempt?.attemptId || ''))
      || !Number.isFinite(invokingAt)
      || ageMs < STALE_METRIC_INVOCATION_MS
    ) {
      return null;
    }
    const recoveryAction = Object.freeze({
      action:METRIC_RECONCILE_ACTION,
      attemptId:attempt.attemptId,
      collectionKey,
      allowedConclusions:Object.freeze([
        'no_external_effect',
        'external_effect_verified',
      ]),
      instruction:'负责人必须先核对旧指标外部调用是否已终止及是否产生外部效果，再通过独立 Paperclip 授权执行恢复；禁止自动重试 connector。',
    });
    await this.governance.updateIssueExecutionPolicy(issueId, {
      runId,
      executionPolicy:withMonitor(issue.executionPolicy, {
        nextCheckAt:new Date(current.getTime() + 24 * HOUR_MS).toISOString(),
        notes:`M5 ${checkpoint.label} 指标调用超过 10 分钟仍为 invoking，等待负责人核对；禁止自动重试 connector。`,
        scheduledBy:'assignee',
        kind:'external_service',
        serviceName:'m5-publisher-metrics',
        externalRef:collectionKey,
        timeoutAt:new Date(Date.parse(receipt.publishedAt) + 7 * 24 * HOUR_MS).toISOString(),
        maxAttempts:8,
        recoveryPolicy:'human_review',
        automaticRetry:false,
        recoveryAction,
      }),
    });
    return {
      accepted:true,
      issueId,
      checkpoint:checkpoint.label,
      waitingForHumanReview:true,
      recoveryAction,
    };
  }

  async scheduleReceiptRecovery(issue, { issueId, runId, caseId, error }) {
    const current = validDate(this.now());
    await this.governance.updateIssueExecutionPolicy(issueId, {
      runId,
      executionPolicy:withMonitor(issue.executionPolicy, {
        nextCheckAt:new Date(current.getTime() + RECOVERY_DELAY_MS).toISOString(),
        notes:`M5 等待可信 PublishReceipt：${safeError(error)}`,
        scheduledBy:'assignee',
        kind:'external_service',
        serviceName:'m5-publisher-metrics',
        externalRef:`case:${caseId}:publish-receipt`,
        timeoutAt:new Date(current.getTime() + 24 * HOUR_MS).toISOString(),
        maxAttempts:8,
        recoveryPolicy:'wake_owner',
      }),
    });
  }

  async persistSnapshot({
    issueId,
    caseId,
    runId,
    checkpoint,
    dueAt,
    receipt,
    snapshot,
  }) {
    const expectedCollectionKey = `${receipt.receiptId}:${checkpoint.label}`;
    const verifiedSnapshot = assertMetricSnapshotMatches({
      snapshot,
      receipt,
      expectedCollectionKey,
      dueAt,
    });
    const latestOutputs = await this.governance.getPipelineCaseOutputs(caseId);
    if (completedCheckpointLabels(latestOutputs, receipt).has(checkpoint.label)) return;
    await this.governance.createIssueWorkProduct(issueId, {
      type:'artifact',
      provider:PUBLISHER_PROVIDER,
      externalId:verifiedSnapshot.snapshotId,
      title:`M5 指标快照 / ${checkpoint.label}`,
      status:'active',
      reviewState:'none',
      isPrimary:false,
      healthStatus:'healthy',
      summary:`${receipt.platform} ${checkpoint.label} 本人内容指标已采集。`,
      metadata:{
        schemaVersion:METRIC_SNAPSHOT_SCHEMA,
        kind:'MetricSnapshot',
        checkpoint:checkpoint.label,
        dueAt:dueAt.toISOString(),
        receiptId:receipt.receiptId,
        collectionKey:verifiedSnapshot.collectionKey,
        snapshot:verifiedSnapshot,
      },
      createdByRunId:runId,
    }, { runId });
  }
}

export class PaperclipMetricMonitorError extends Error {
  constructor(message, code = 'metric_monitor_invalid') {
    super(message);
    this.name = 'PaperclipMetricMonitorError';
    this.code = code;
  }
}

export function trustedPublishReceipt(outputs) {
  const items = outputItems(outputs).filter((item) =>
    item.kind === 'work_product'
    && item.type === 'artifact'
    && item.provider === PUBLISHER_PROVIDER
    && item.sourceTrust == null
    && ['active', 'approved'].includes(item.status)
    && item.healthStatus === 'healthy'
    && item.metadata?.schemaVersion === PUBLISH_RECEIPT_SCHEMA
    && item.metadata?.kind === 'PublishReceipt',
  );
  if (items.length !== 1) {
    throw new PaperclipMetricMonitorError(
      `当前 Case 必须且只能有一个标准信任的 PublishReceipt，实际为 ${items.length} 个。`,
      'metric_publish_receipt_ambiguous',
    );
  }
  const receipt = items[0].metadata.receipt;
  if (
    !receipt
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(receipt.receiptId || ''))
    || !TRUSTED_REFERENCE.test(String(receipt.campaignId || ''))
    || !['douyin', 'xiaohongshu'].includes(receipt.platform)
    || !TRUSTED_REFERENCE.test(String(receipt.accountRef || ''))
    || !CONNECTOR_MODE.test(String(receipt.connectorMode || ''))
    || !String(receipt.contentVersionId || '').trim()
    || !String(receipt.externalContentId || '').trim()
    || !String(receipt.evidence || '').trim()
    || !Number.isFinite(Date.parse(receipt.publishedAt))
  ) {
    throw new PaperclipMetricMonitorError(
      'PublishReceipt 结构无效，拒绝派生指标检查点。',
      'metric_publish_receipt_identity_invalid',
    );
  }
  return structuredClone(receipt);
}

export function completedCheckpointLabels(outputs, receipt) {
  const completed = new Set();
  for (const item of outputItems(outputs)) {
    const checkpoint = CHECKPOINTS.find(
      (candidate) => candidate.label === item?.metadata?.checkpoint,
    );
    if (
      !checkpoint
      || item.kind !== 'work_product'
      || item.type !== 'artifact'
      || item.provider !== PUBLISHER_PROVIDER
      || item.sourceTrust != null
      || item.status !== 'active'
      || item.healthStatus !== 'healthy'
      || item.metadata?.schemaVersion !== METRIC_SNAPSHOT_SCHEMA
      || item.metadata?.kind !== 'MetricSnapshot'
      || item.metadata?.receiptId !== receipt.receiptId
    ) {
      continue;
    }
    const dueAt = new Date(Date.parse(receipt.publishedAt) + checkpoint.offsetMs);
    const expectedCollectionKey = `${receipt.receiptId}:${checkpoint.label}`;
    if (
      item.metadata.dueAt !== dueAt.toISOString()
      || item.metadata.collectionKey !== expectedCollectionKey
    ) {
      continue;
    }
    try {
      const snapshot = assertMetricSnapshotMatches({
        snapshot:item.metadata.snapshot,
        receipt,
        expectedCollectionKey,
        dueAt,
      });
      if (item.externalId !== snapshot.snapshotId) continue;
      completed.add(checkpoint.label);
    } catch {
      // 历史或伪造的标签不能替代完整 MetricSnapshot 身份核验。
    }
  }
  return completed;
}

function metricCaseId(issue) {
  const value = String(issue?.description || '').match(
    /当前 Case 为 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i,
  )?.[1];
  if (!value) throw new PaperclipMetricMonitorError('M5 指标任务缺少固定 Case 绑定。');
  return value;
}

function outputItems(outputs) {
  return Array.isArray(outputs) ? outputs : Array.isArray(outputs?.items) ? outputs.items : [];
}

function withMonitor(executionPolicy, monitor) {
  return {
    ...(executionPolicy && typeof executionPolicy === 'object' ? executionPolicy : {}),
    monitor,
  };
}

function withoutMonitor(executionPolicy) {
  return {
    ...(executionPolicy && typeof executionPolicy === 'object' ? executionPolicy : {}),
    monitor:null,
  };
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PaperclipMetricMonitorError('指标控制器时钟无效。');
  return date;
}

function assertMetricSnapshotMatches({
  snapshot,
  receipt,
  expectedCollectionKey,
  dueAt,
}) {
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || !String(snapshot.snapshotId || '').trim()
    || snapshot.receiptId !== receipt.receiptId
    || snapshot.collectionKey !== expectedCollectionKey
    || snapshot.platform !== receipt.platform
    || snapshot.contentVersionId !== receipt.contentVersionId
    || !optionalIdentityMatches(snapshot, receipt)
    || !Number.isFinite(Date.parse(snapshot.collectedAt))
    || Date.parse(snapshot.collectedAt) < dueAt.getTime()
    || !validMetricValues(snapshot.metrics)
    || (receipt.platform === 'xiaohongshu' && !validXhsMetricEvidence(snapshot, receipt))
  ) {
    throw new PaperclipMetricMonitorError(
      'Publisher 返回的 MetricSnapshot 与当前回执、检查点或采集时间不一致。',
      'metric_snapshot_identity_invalid',
    );
  }
  return structuredClone(snapshot);
}

function optionalIdentityMatches(snapshot, receipt) {
  return ['campaignId', 'accountRef', 'connectorMode', 'externalContentId']
    .every((field) => (
      !Object.hasOwn(snapshot, field)
      || snapshot[field] === receipt[field]
    ));
}

function validMetricValues(metrics) {
  return Boolean(metrics)
    && typeof metrics === 'object'
    && !Array.isArray(metrics)
    && Object.keys(metrics).length > 0
    && Object.values(metrics).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
}

function validXhsMetricEvidence(snapshot, receipt) {
  const source = snapshot.source;
  const expectedSourceKeys = [
    'approvalRef',
    'capturedAt',
    'kind',
    'origin',
    'pageKind',
    'rawMetrics',
    'selectorBundleVersion',
    'selectorChecksum',
  ].sort();
  const expectedMetricKeys = ['comments', 'likes', 'saves', 'views'];
  const capturedAt = Date.parse(source?.capturedAt);
  const observationAgeMs = Date.parse(snapshot.collectedAt) - capturedAt;
  return snapshot.accountRef === receipt.accountRef
    && snapshot.externalContentId === receipt.externalContentId
    && Object.keys(snapshot.metrics).sort().join('\n')
      === expectedMetricKeys.join('\n')
    && source
    && typeof source === 'object'
    && !Array.isArray(source)
    && Object.keys(source).sort().join('\n') === expectedSourceKeys.join('\n')
    && source.kind === 'official_creator_ui'
    && ['https://creator.xiaohongshu.com', 'https://pro.xiaohongshu.com']
      .includes(source.origin)
    && source.pageKind === 'own_note_detail'
    && /^[1-9]\d*\.\d+\.\d+$/.test(String(source.selectorBundleVersion || ''))
    && SHA256.test(String(source.selectorChecksum || ''))
    && String(source.approvalRef || '').startsWith('paperclip:')
    && Number.isFinite(capturedAt)
    && observationAgeMs >= 0
    && observationAgeMs <= MAX_METRIC_OBSERVATION_AGE_MS
    && source.rawMetrics
    && typeof source.rawMetrics === 'object'
    && !Array.isArray(source.rawMetrics)
    && Object.keys(source.rawMetrics).sort().join('\n')
      === expectedMetricKeys.join('\n')
    && expectedMetricKeys.every((key) => exactRawMetricValue(source.rawMetrics[key]));
}

function exactRawMetricValue(value) {
  if (Number.isSafeInteger(value) && value >= 0) return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (
    !/^(?:0|[1-9]\d*)$/.test(text)
    && !/^(?:[1-9]\d{0,2})(?:,\d{3})+$/.test(text)
  ) {
    return false;
  }
  const parsed = Number(text.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

function sanitizedMetricFailure(error) {
  const candidate = String(error?.code || '');
  const code = /^[a-z][a-z0-9_.-]{1,119}$/i.test(candidate)
    ? candidate
    : 'metric_collection_failed';
  return new PaperclipMetricMonitorError(
    `指标采集失败，等待安全恢复：${safeError(error)}`,
    code,
  );
}

function safeError(error) {
  return String(error?.code || error?.message || 'metric_collection_failed')
    .replace(/(?:\/Users|\/home|\/private|\/var\/folders)\/[^\s"'`]+/g, '[local-path]')
    .replace(/\b[A-Za-z]:\\[^\s"'`]+/g, '[local-path]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [credential]')
    .replace(
      /\b(token|cookie|authorization|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[credential]',
    )
    .replace(/\b(?:sk|key|token|secret)[-_][a-z0-9._-]{8,}\b/gi, '[credential]')
    .replace(/https?:\/\/[^\s"'`]+/gi, '[external-url]')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function assertNoMetricSelectionParameters(payload) {
  const queue = [payload];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_CALLER_FIELDS.has(key)) {
        throw new PaperclipMetricMonitorError(
          `M5 指标 HTTP heartbeat 不接受调用方指定 ${key}。`,
          'metric_selection_parameter_forbidden',
        );
      }
      if (child && typeof child === 'object') queue.push(child);
    }
  }
}
