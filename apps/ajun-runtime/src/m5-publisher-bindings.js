import path from 'node:path';
import {
  createPublisherRuntime,
} from '@agent-army/m5-publisher-gateway';
import {
  M5PublisherBindingError,
  PublisherRuntimeLease,
} from './m5-publisher-runtime-lease.js';

export { M5PublisherBindingError, PublisherRuntimeLease };

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
    this.runtimeLease = new PublisherRuntimeLease({
      getDependencies:() => ({
        paperclipAccess:this.paperclipAccess,
        connectorDependencies:this.connectorDependencies,
        workspaceRoot:this.workspaceRoot,
        ledgerPath:this.ledgerPath,
        paperclipControl:this.paperclipControl,
        clock:this.clock,
      }),
      authorizeRequest:(input) => this.authorize(
        input.action,
        input.campaignId,
        input.context,
        { allowExactReplay:input.allowExactReplay },
      ),
      runtimeProvider:(authorization) => this.getRuntime(authorization),
      synchronizeState:(state) => Object.assign(this, state),
    });
  }

  async publish(request, authorizationContext) {
    const acquired = await this.runtimeLease.acquire({
      action:'publisher.publish',
      campaignId:request?.campaignId,
      context:authorizationContext,
    });
    return acquired.runtime.publish(request);
  }

  async collectMetricSnapshot(input, authorizationContext) {
    const acquired = await this.runtimeLease.acquire({
      action:'publisher.read_own_metrics',
      campaignId:authorizationContext?.campaignId,
      context:authorizationContext,
    });
    return acquired.runtime.collectMetricSnapshot({
      ...input,
      campaignId:acquired.authorization.campaignId,
    });
  }

  async getAttempt(idempotencyKey) {
    if (!this.runtime) return null;
    return this.runtime.gateway.getAttempt(idempotencyKey);
  }

  async reconcileMetricInvocation(input, authorizationContext) {
    const acquired = await this.runtimeLease.acquire({
      action:'publisher.reconcile_stale_attempt',
      campaignId:input?.campaignId,
      context:authorizationContext,
      allowExactReplay:true,
    });
    const trustedInput = {
      ...structuredClone(input),
      campaignId:acquired.authorization.campaignId,
      authorizationId:acquired.authorization.authorizationId,
    };
    if (acquired.authorization.replayed === true) {
      const attempt = await acquired.runtime.gateway?.getAttempt?.(
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
    return acquired.runtime.reconcileMetricInvocation(trustedInput);
  }

  async getReceipt(identifier) {
    if (!this.runtime) return null;
    return this.runtime.getReceipt(identifier);
  }

  async getSafetyStatus() {
    if (!this.runtime) return { active:false, reason:null, activatedAt:null };
    return this.runtime.getSafetyStatus();
  }

  async authorize(action, campaignId, context, options = {}) {
    return this.runtimeLease.authorize(action, campaignId, context, options);
  }

  async getRuntime(authorizationContext) {
    return this.runtimeLease.getRuntime(authorizationContext);
  }

  productionConnectorDependencies() {
    return this.runtimeLease.productionConnectorDependencies();
  }

  paperclipCostReporter() {
    return this.runtimeLease.paperclipCostReporter();
  }

  paperclipAccountIdentityVerifier() {
    return this.runtimeLease.paperclipAccountIdentityVerifier();
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
    const canonicalGrant = campaignCase?.campaignGrant || campaignCase?.fields?.campaignGrant;
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
      || (campaignCase?.campaignGrant || campaignCase?.fields?.campaignGrant)?.status !== 'paused'
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
