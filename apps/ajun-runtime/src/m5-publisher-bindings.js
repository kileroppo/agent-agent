import crypto from 'node:crypto';
import path from 'node:path';
import {
  PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
  PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA,
  PUBLISHER_COST_REPORTER_SCHEMA,
  createProductionPublisherComposition,
  createPublisherRuntime,
} from '../../../integrations/publishing/m5-publisher-gateway/src/index.js';

const FAKE_PUBLISH_TOOL = 'publisher.fake_publish';

export function createM5PublisherBindings({
  env = process.env,
  dataDir,
  clock,
  getCampaignService,
  production = null,
} = {}) {
  if (!path.isAbsolute(String(dataDir || ''))) {
    throw new M5PublisherBindingError('A君必须为 M5 Publisher 配置绝对数据目录。');
  }
  const mode = String(env.AJUN_M5_PUBLISHER_MODE || '').trim().toLowerCase();
  if (production?.enabled === true) {
    if (mode) {
      throw new M5PublisherBindingError(
        'A君真实 Publisher 不能由 AJUN_M5_PUBLISHER_MODE 或其他环境变量启用。',
        'real_gateway_env_enable_denied',
      );
    }
    const publisher = new LazyProductionPublisher({
      paperclipAccess:production.paperclipAccess,
      connectorDependencies:production.connectorDependencies,
      workspaceRoot:configuredProductionPath(
        production.workspaceRoot,
        path.join(dataDir, 'content-growth-artifacts'),
        'production.workspaceRoot',
      ),
      ledgerPath:configuredProductionPath(
        production.ledgerPath,
        path.join(dataDir, 'm5-publisher', 'ledger.json'),
        'production.ledgerPath',
      ),
      paperclipControl:new PaperclipPublisherControl({
        getCampaignService,
        paperclipAccess:production.paperclipAccess,
        clock,
      }),
      clock,
    });
    return {
      get runtime() {
        return publisher.runtime;
      },
      publisher,
      toolExecutor:null,
    };
  }
  const runtime = createPublisherRuntime({
    mode,
    workspaceRoot:configuredAbsolutePath(
      env.AJUN_M5_PUBLISHER_WORKSPACE_ROOT,
      path.join(dataDir, 'content-growth-artifacts'),
      'AJUN_M5_PUBLISHER_WORKSPACE_ROOT',
    ),
    ledgerPath:configuredAbsolutePath(
      env.AJUN_M5_PUBLISHER_LEDGER_PATH,
      path.join(dataDir, 'm5-publisher', 'ledger.json'),
      'AJUN_M5_PUBLISHER_LEDGER_PATH',
    ),
    paperclipControl:mode === 'fake'
      ? new PaperclipPublisherControl({ getCampaignService, clock })
      : null,
    clock,
  });
  if (!runtime) return { runtime:null, publisher:null, toolExecutor:null };
  if (runtime.mode !== 'fake') {
    throw new M5PublisherBindingError('A君只允许注入 fake Publisher Runtime。');
  }
  return {
    runtime,
    publisher:runtime,
    toolExecutor:new FakePublisherToolExecutor(runtime),
  };
}

export class LazyProductionPublisher {
  constructor({
    paperclipAccess,
    connectorDependencies,
    workspaceRoot,
    ledgerPath,
    paperclipControl,
    clock = () => new Date(),
  } = {}) {
    const required = [
      'authorizePublisherRequest',
      'getPublisherConnectorApprovalSnapshot',
      'resolvePublisherCredentialReference',
      'verifyPublisherAccountIdentity',
      'assertPublisherCampaignBudget',
      'recordPublisherConnectorAttempt',
      'assertPublisherMetricRecoveryAllowed',
    ];
    if (required.some((method) => typeof paperclipAccess?.[method] !== 'function')) {
      throw new M5PublisherBindingError(
        'A君真实 Publisher 必须注入 Paperclip 授权、connector 批准快照、Secret 引用解析、账号身份核验和费用适配器。',
        'paperclip_publisher_access_required',
      );
    }
    if (
      !connectorDependencies
      || typeof connectorDependencies !== 'object'
      || Array.isArray(connectorDependencies)
    ) {
      throw new M5PublisherBindingError(
        'A君真实 Publisher 必须显式注入已审核 transport 或 CUA runner。',
        'publisher_connector_dependencies_required',
      );
    }
    this.mode = 'real';
    this.paperclipAccess = paperclipAccess;
    this.connectorDependencies = connectorDependencies;
    this.workspaceRoot = workspaceRoot;
    this.ledgerPath = ledgerPath;
    this.paperclipControl = paperclipControl;
    this.clock = clock;
    this.runtime = null;
    this.runtimePromise = null;
    this.approvalSnapshotId = null;
    this.approvalSnapshotFingerprint = null;
    this.approvalSnapshotValidUntil = null;
  }

  async publish(request, authorizationContext) {
    const authorized = await this.authorize(
      'publisher.publish',
      request?.campaignId,
      authorizationContext,
    );
    const runtime = await this.getRuntime(authorized);
    return runtime.publish(request);
  }

  async collectMetricSnapshot(input, authorizationContext) {
    const authorized = await this.authorize(
      'publisher.read_own_metrics',
      authorizationContext?.campaignId,
      authorizationContext,
    );
    const runtime = await this.getRuntime(authorized);
    return runtime.collectMetricSnapshot({
      ...input,
      campaignId:authorized.campaignId,
    });
  }

  async getAttempt(idempotencyKey) {
    if (!this.runtime) return null;
    return this.runtime.gateway.getAttempt(idempotencyKey);
  }

  async reconcileMetricInvocation(input, authorizationContext) {
    const authorized = await this.authorize(
      'publisher.reconcile_stale_attempt',
      input?.campaignId,
      authorizationContext,
      { allowExactReplay:true },
    );
    const runtime = await this.getRuntime(authorized);
    const trustedInput = {
      ...structuredClone(input),
      campaignId:authorized.campaignId,
      authorizationId:authorized.authorizationId,
    };
    if (authorized.replayed === true) {
      const attempt = await runtime.gateway?.getAttempt?.(
        `metric:${String(trustedInput.collectionKey || '')}`,
      );
      const recovery = exactMetricRecoveryReplay(attempt, trustedInput);
      if (!recovery) {
        throw new M5PublisherBindingError(
          'Paperclip 恢复授权已经消费，且没有找到范围完全一致的既有恢复结果。',
          'publisher_authorization_replayed',
        );
      }
      return {
        replayed:true,
        recovery,
      };
    }
    return runtime.reconcileMetricInvocation(trustedInput);
  }

  async getReceipt(identifier) {
    if (!this.runtime) return null;
    return this.runtime.getReceipt(identifier);
  }

  async getSafetyStatus() {
    if (!this.runtime) return { active:false, reason:null, activatedAt:null };
    return this.runtime.getSafetyStatus();
  }

  async authorize(action, campaignId, context, {
    allowExactReplay = false,
  } = {}) {
    const presented = {
      action:String(context?.action || ''),
      runId:String(context?.runId || ''),
      issueId:String(context?.issueId || ''),
      campaignId:String(context?.campaignId || ''),
      agentId:String(context?.agentId || ''),
      authorizationId:String(context?.authorizationId || ''),
    };
    if (
      presented.action !== action
      || presented.campaignId !== String(campaignId || '')
      || Object.entries(presented)
        .filter(([field]) => field !== 'action')
        .some(([, value]) => !validAuthorizationReference(value))
    ) {
      throw new M5PublisherBindingError(
        'A君 Publisher 缺少与 action、Run、Issue、Campaign 和控制器一致的可信授权上下文。',
        'publisher_authorization_scope_mismatch',
      );
    }
    let result;
    try {
      result = await this.paperclipAccess.authorizePublisherRequest(
        structuredClone(presented),
      );
    } catch {
      throw new M5PublisherBindingError(
        'Paperclip Publisher Run 授权核验失败。',
        'publisher_request_unauthorized',
      );
    }
    if (
      result?.authorized !== true
      || Object.entries(presented).some(([field, value]) => result[field] !== value)
    ) {
      throw new M5PublisherBindingError(
        'Paperclip Publisher 授权范围与 action、Run、Issue 或 Campaign 不一致。',
        'publisher_authorization_scope_mismatch',
      );
    }
    if (result?.replayed === true) {
      if (allowExactReplay === true) return { ...presented, replayed:true };
      throw new M5PublisherBindingError(
        'Paperclip Publisher 一次性授权已经使用，拒绝重放。',
        'publisher_authorization_replayed',
      );
    }
    return presented;
  }

  async getRuntime(authorizationContext) {
    const snapshot = await this.paperclipAccess.getPublisherConnectorApprovalSnapshot(
      structuredClone(authorizationContext),
    );
    let approvalPolicy;
    try {
      approvalPolicy = normalizePublisherApprovalSnapshot(snapshot, this.clock());
    } catch (error) {
      if (this.runtimePromise) this.runtimePromise.invalidated = true;
      throw error;
    }
    if (this.runtime) {
      assertSameApprovalPolicy(
        {
          snapshotId:this.approvalSnapshotId,
          fingerprint:this.approvalSnapshotFingerprint,
          validUntil:this.approvalSnapshotValidUntil,
        },
        approvalPolicy,
        this.clock(),
      );
      return this.runtime;
    }
    if (this.runtimePromise) {
      try {
        assertSameApprovalPolicy(
          this.runtimePromise.approvalPolicy,
          approvalPolicy,
          this.clock(),
        );
      } catch (error) {
        this.runtimePromise.invalidated = true;
        throw error;
      }
      return this.runtimePromise.promise;
    }
    const pending = {
      approvalPolicy,
      invalidated:false,
      promise:null,
    };
    pending.promise = Promise.resolve().then(() => {
      if (pending.invalidated) throw approvalSnapshotChanged();
      const composition = createProductionPublisherComposition({
        enabled:true,
        approvalSnapshot:snapshot,
        connectorDependencies:this.productionConnectorDependencies(),
        workspaceRoot:this.workspaceRoot,
        ledgerPath:this.ledgerPath,
        paperclipControl:this.paperclipControl,
        costReporter:this.paperclipCostReporter(),
        accountIdentityVerifier:this.paperclipAccountIdentityVerifier(),
        clock:this.clock,
      });
      const runtime = composition.createRuntime();
      assertSameApprovalPolicy(
        approvalPolicy,
        approvalPolicy,
        this.clock(),
      );
      if (pending.invalidated) {
        throw approvalSnapshotChanged();
      }
      if (composition.approvalSnapshotId !== approvalPolicy.snapshotId) {
        throw approvalSnapshotChanged();
      }
      this.runtime = runtime;
      this.approvalSnapshotId = approvalPolicy.snapshotId;
      this.approvalSnapshotFingerprint = approvalPolicy.fingerprint;
      this.approvalSnapshotValidUntil = approvalPolicy.validUntil;
      return runtime;
    }).finally(() => {
      if (this.runtimePromise === pending) this.runtimePromise = null;
    });
    this.runtimePromise = pending;
    return pending.promise;
  }

  productionConnectorDependencies() {
    const douyin = this.connectorDependencies.douyinOfficialApi;
    return {
      ...(douyin
        ? {
          douyinOfficialApi:{
            httpRequest:douyin.httpRequest,
            credentialResolver:(input) => (
              this.paperclipAccess.resolvePublisherCredentialReference(input)
            ),
            ...(douyin.maxUploadBytes === undefined
              ? {}
              : { maxUploadBytes:douyin.maxUploadBytes }),
          },
        }
        : {}),
      ...(this.connectorDependencies.cuaRunners
        ? { cuaRunners:this.connectorDependencies.cuaRunners }
        : {}),
      ...(this.connectorDependencies.xhsOwnMetricsCua
        ? { xhsOwnMetricsCua:this.connectorDependencies.xhsOwnMetricsCua }
        : {}),
    };
  }

  paperclipCostReporter() {
    return Object.freeze({
      contract:Object.freeze({
        schemaVersion:PUBLISHER_COST_REPORTER_SCHEMA,
        deterministic:true,
        source:'paperclip',
      }),
      assertCampaignBudget:(input) => (
        this.paperclipAccess.assertPublisherCampaignBudget(input)
      ),
      recordConnectorAttempt:(input) => (
        this.paperclipAccess.recordPublisherConnectorAttempt(input)
      ),
    });
  }

  paperclipAccountIdentityVerifier() {
    return Object.freeze({
      contract:Object.freeze({
        schemaVersion:PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
        deterministic:true,
        source:'paperclip',
      }),
      verify:(input) => (
        this.paperclipAccess.verifyPublisherAccountIdentity(input)
      ),
    });
  }
}

export class PaperclipPublisherControl {
  constructor({
    getCampaignService,
    paperclipAccess = null,
    clock = () => new Date(),
  } = {}) {
    if (typeof getCampaignService !== 'function') {
      throw new M5PublisherBindingError('启用 Publisher 时必须注入 getCampaignService，活动状态只能从 Paperclip 读取。');
    }
    this.getCampaignService = getCampaignService;
    this.paperclipAccess = paperclipAccess;
    this.clock = clock;
  }

  async assertPublishAllowed({ campaignId, checkedAt }) {
    const service = await this.requireService();
    const [campaignCase, trigger] = await Promise.all([
      service.getRawCase(campaignId),
      service.getDailyRoutineTrigger(),
    ]);
    const canonicalGrant = campaignCase?.fields?.campaignGrant;
    const currentStage = campaignCase?.stageKey || campaignCase?.stage?.key || null;
    const now = validTimestamp(checkedAt) || this.clock();
    const startsAt = Date.parse(canonicalGrant?.startsAt);
    const expiresAt = Date.parse(canonicalGrant?.expiresAt);
    if (
      campaignCase?.id !== campaignId
      || canonicalGrant?.status !== 'active'
      || currentStage !== 'campaign_active'
      || !Number.isFinite(startsAt)
      || !Number.isFinite(expiresAt)
      || startsAt > now.getTime()
      || expiresAt <= now.getTime()
      || trigger?.enabled !== true
    ) {
      throw new M5PublisherBindingError(
        'Paperclip CampaignGrant 未激活、已过期、父 Case 不在 campaign_active 或活动 Cron 未启用，拒绝发布。',
      );
    }
    return {
      campaignId,
      grantStatus:'active',
      cronStatus:'enabled',
      currentStage,
      canonicalGrant:structuredClone(canonicalGrant),
      checkedAt:now.toISOString(),
    };
  }

  async pauseCampaignAndDisableCron({
    campaignId,
    reason,
    idempotencyKey,
  }) {
    const service = await this.requireService();
    await service.control(campaignId, 'pause', { reason });
    const [campaignCase, trigger] = await Promise.all([
      service.getRawCase(campaignId),
      service.getDailyRoutineTrigger(),
    ]);
    if (
      campaignCase?.id !== campaignId
      || campaignCase?.fields?.campaignGrant?.status !== 'paused'
      || trigger?.enabled !== false
    ) {
      throw new M5PublisherBindingError('Paperclip 没有同时确认 CampaignGrant 已暂停且活动 Cron 已关闭。');
    }
    return {
      campaignId,
      grantStatus:'paused',
      cronStatus:'disabled',
      controlEventId:String(idempotencyKey || `publisher-pause:${campaignId}`),
    };
  }

  async assertMetricRecoveryAllowed(input) {
    if (typeof this.paperclipAccess?.assertPublisherMetricRecoveryAllowed !== 'function') {
      throw new M5PublisherBindingError(
        '指标未决调用恢复缺少 Paperclip Board Approval 与证据核验适配器。',
        'paperclip_metric_recovery_access_required',
      );
    }
    return this.paperclipAccess.assertPublisherMetricRecoveryAllowed(
      structuredClone(input),
    );
  }

  async requireService() {
    const service = await this.getCampaignService();
    if (
      typeof service?.getRawCase !== 'function'
      || typeof service?.control !== 'function'
      || typeof service?.getDailyRoutineTrigger !== 'function'
    ) {
      throw new M5PublisherBindingError('Paperclip 内容活动服务不可用，Publisher 失败关闭。');
    }
    return service;
  }
}

export class FakePublisherToolExecutor {
  constructor(runtime) {
    if (runtime?.mode !== 'fake' || typeof runtime.publish !== 'function') {
      throw new M5PublisherBindingError('fake Publisher 工具只能绑定到 fake Runtime。');
    }
    this.runtime = runtime;
  }

  async execute(input = {}, trustedContext = null) {
    if (input.toolId !== FAKE_PUBLISH_TOOL) {
      throw new M5PublisherBindingError('当前只允许 publisher.fake_publish 本地验收动作。');
    }
    if (
      trustedContext?.campaignCaseId !== input.campaignCaseId
      || trustedContext?.campaignGrant?.status !== 'active'
      || trustedContext?.runContext?.runId == null
      || trustedContext?.targetCase?.id !== input.caseId
    ) {
      throw new M5PublisherBindingError('fake Publisher 缺少由 Paperclip 活动子 Case 和运行中 Run 派生的可信执行上下文。');
    }
    const result = await this.runtime.publish({
      campaignId:trustedContext.campaignCaseId,
      grant:trustedContext.campaignGrant,
      platform:input.platform,
      contentVersionId:input.contentVersionId,
      contentChecksum:input.contentChecksum,
      scheduledDate:input.scheduledDate,
      mediaPath:input.mediaPath,
      title:input.title,
      body:input.body,
      tags:Array.isArray(input.tags) ? input.tags : [],
      reviewReport:input.reviewReport,
      idempotencyKey:input.idempotencyKey,
    });
    return {
      toolId:FAKE_PUBLISH_TOOL,
      mode:'fake',
      replayed:result.replayed,
      receipt:result.receipt,
    };
  }
}

export class M5PublisherBindingError extends Error {
  constructor(message, code = 'm5_publisher_binding_failed') {
    super(message);
    this.code = code;
  }
}

function exactMetricRecoveryReplay(attempt, input) {
  const recovery = attempt?.metricRecovery;
  const expectedState = input?.conclusion === 'no_external_effect'
    ? 'failed'
    : input?.conclusion === 'external_effect_verified'
      ? 'blocked'
      : null;
  const exact = Boolean(
    expectedState
    && attempt?.kind === 'metric_snapshot'
    && attempt.state === expectedState
    && attempt.idempotencyKey === `metric:${input.collectionKey}`
    && attempt.campaignId === input.campaignId
    && String(attempt.receiptId || '').toLowerCase()
      === String(input.receiptId || '').toLowerCase()
    && attempt.collectionKey === input.collectionKey
    && recovery?.action === 'publisher.reconcile_stale_attempt'
    && recovery.authorizationId === input.authorizationId
    && recovery.conclusion === input.conclusion
    && recovery.evidenceRef === input.evidenceRef
    && validAuthorizationReference(recovery.recoveryId)
    && typeof recovery.approvalRef === 'string'
    && recovery.approvalRef.startsWith('paperclip:')
    && Number.isFinite(Date.parse(recovery.resolvedAt))
  );
  if (!exact) return null;
  return Object.freeze({
    recoveryId:recovery.recoveryId,
    action:recovery.action,
    conclusion:recovery.conclusion,
    evidenceRef:recovery.evidenceRef,
    resolvedAt:new Date(recovery.resolvedAt).toISOString(),
    state:expectedState,
    retryAllowed:recovery.conclusion === 'no_external_effect',
    nextAction:recovery.conclusion === 'no_external_effect'
      ? 'request_new_read_own_metrics_authorization'
      : 'keep_metric_attempt_blocked',
  });
}

function normalizePublisherApprovalSnapshot(snapshot, nowValue) {
  const now = validClock(nowValue);
  const capturedAt = Date.parse(snapshot?.capturedAt);
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || snapshot.schemaVersion !== PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA
    || snapshot.source !== 'paperclip'
    || typeof snapshot.snapshotId !== 'string'
    || !snapshot.snapshotId.startsWith('paperclip:')
    || !Number.isFinite(capturedAt)
    || capturedAt > now.getTime()
    || !Array.isArray(snapshot.approvals)
    || snapshot.approvals.length === 0
  ) {
    throw approvalSnapshotInvalid();
  }
  const approvals = [];
  const identities = new Set();
  for (const raw of snapshot.approvals) {
    const capability = raw?.capability || 'publish';
    const expiresAt = Date.parse(raw?.expiresAt);
    const identity = `${String(raw?.platform || '')}:${String(capability || '')}`;
    if (
      !['douyin', 'xiaohongshu'].includes(raw?.platform)
      || !['publish', 'read_own_metrics'].includes(capability)
      || !['douyin_official_api', 'cua', 'xhs_own_metrics_cua']
        .includes(raw?.connectorKind)
      || (capability === 'publish' && raw?.connectorKind === 'xhs_own_metrics_cua')
      || (
        capability === 'read_own_metrics'
        && !['douyin_official_api', 'xhs_own_metrics_cua'].includes(raw?.connectorKind)
      )
      || raw?.status !== 'approved'
      || typeof raw?.approvalRef !== 'string'
      || !raw.approvalRef.startsWith('paperclip:')
      || !Number.isFinite(expiresAt)
      || identities.has(identity)
    ) {
      throw approvalSnapshotInvalid();
    }
    if (expiresAt <= now.getTime()) throw approvalSnapshotExpired();
    identities.add(identity);
    approvals.push({
      platform:raw.platform,
      capability,
      connectorKind:raw.connectorKind,
      status:raw.status,
      approvalRef:raw.approvalRef,
      expiresAt:new Date(expiresAt).toISOString(),
    });
  }
  approvals.sort((left, right) => (
    `${left.platform}:${left.capability}`.localeCompare(
      `${right.platform}:${right.capability}`,
    )
  ));
  const validUntil = Math.min(
    ...approvals.map((approval) => Date.parse(approval.expiresAt)),
  );
  const fingerprint = `sha256:${crypto.createHash('sha256')
    .update(stableJson({
      schemaVersion:snapshot.schemaVersion,
      source:snapshot.source,
      snapshotId:snapshot.snapshotId,
      approvals,
    }))
    .digest('hex')}`;
  return Object.freeze({
    snapshotId:snapshot.snapshotId,
    fingerprint,
    validUntil,
  });
}

function assertSameApprovalPolicy(expected, current, nowValue) {
  const now = validClock(nowValue);
  if (
    !Number.isFinite(expected?.validUntil)
    || expected.validUntil <= now.getTime()
    || !Number.isFinite(current?.validUntil)
    || current.validUntil <= now.getTime()
  ) {
    throw approvalSnapshotExpired();
  }
  if (
    expected?.snapshotId !== current?.snapshotId
    || expected?.fingerprint !== current?.fingerprint
    || expected?.validUntil !== current?.validUntil
  ) {
    throw approvalSnapshotChanged();
  }
}

function approvalSnapshotInvalid() {
  return new M5PublisherBindingError(
    'Paperclip connector 批准快照结构、状态或能力范围无效，拒绝复用真实 Runtime。',
    'publisher_approval_snapshot_invalid',
  );
}

function approvalSnapshotExpired() {
  return new M5PublisherBindingError(
    'Paperclip connector 批准快照已经到期；旧 Runtime 保持停止，必须重新批准并显式重建。',
    'publisher_approval_snapshot_expired',
  );
}

function approvalSnapshotChanged() {
  return new M5PublisherBindingError(
    'Paperclip connector 批准快照已经变化；旧 Runtime 保持停止，必须显式重建。',
    'publisher_approval_snapshot_changed',
  );
}

function validClock(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new M5PublisherBindingError(
      'A君 Publisher 时钟无效，拒绝核验 connector 批准。',
      'publisher_clock_invalid',
    );
  }
  return new Date(timestamp);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function validTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function configuredAbsolutePath(value, fallback, name) {
  const configured = String(value || '').trim();
  if (!configured) return fallback;
  if (!path.isAbsolute(configured)) {
    throw new M5PublisherBindingError(`${name} 必须是绝对路径。`);
  }
  return configured;
}

function configuredProductionPath(value, fallback, name) {
  const configured = value == null ? fallback : String(value).trim();
  if (!path.isAbsolute(configured)) {
    throw new M5PublisherBindingError(`${name} 必须是绝对路径。`);
  }
  return configured;
}

function validAuthorizationReference(value) {
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$/.test(String(value || ''));
}
