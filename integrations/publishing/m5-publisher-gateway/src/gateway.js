import { coded, publishIdempotencyKey } from './policy.js';
import {
  PublisherCostRecorder,
  createFakePublisherCostReporter,
} from './cost-reporting.js';
import { MetricCollectionExecution } from './metric-collection-execution.js';
import { MetricInvocationRecovery } from './metric-invocation-recovery.js';
import { PublishExecution } from './publish-execution.js';

const PRODUCTION_GATEWAY_ACTIVATION = Symbol('production-gateway-activation');

export function createProductionPublisherGateway(options) {
  return new PublisherGateway({
    ...options,
    mode:'real',
    productionActivation:PRODUCTION_GATEWAY_ACTIVATION,
  });
}

export class PublisherGateway {
  constructor({
    repository,
    connectors,
    metricConnectors = null,
    artifactVerifier,
    paperclipControl,
    costReporter,
    costRecorder,
    approvalGuard = null,
    mode = 'fake',
    productionActivation = null,
    clock = () => new Date(),
  }) {
    if (mode === 'real' && productionActivation !== PRODUCTION_GATEWAY_ACTIVATION) {
      throw coded('real_gateway_disabled', '真实 Publisher Gateway 尚未获得单独批准；平台外部幂等与真实连接器核验尚未完成。');
    }
    if (!['fake', 'real'].includes(mode)) {
      throw coded('invalid_publisher_mode', 'Publisher Gateway 模式只允许 fake 或 real。');
    }
    if (!repository?.read || !repository?.update || !artifactVerifier?.verify) {
      throw coded('publisher_dependencies_missing', 'Publisher Gateway 必须使用事务账本和实际文件哈希验证器。');
    }
    if (!paperclipControl?.assertPublishAllowed || !paperclipControl?.pauseCampaignAndDisableCron) {
      throw coded(
        'paperclip_control_required',
        'Publisher Gateway 必须连接 Paperclip 控制适配器；活动授权真相和 Cron 控制不能保存在发布器内。',
      );
    }
    if (
      mode === 'real'
      && typeof approvalGuard?.assertCapabilityAllowed !== 'function'
    ) {
      throw coded(
        'publisher_approval_guard_required',
        '真实 Publisher Gateway 必须在每次外部调用前重新核验 connector capability 批准。',
      );
    }
    this.repository = repository;
    this.connectors = connectors;
    this.metricConnectors = metricConnectors || (mode === 'fake' ? connectors : {});
    this.artifactVerifier = artifactVerifier;
    this.paperclipControl = paperclipControl;
    this.approvalGuard = approvalGuard;
    this.mode = mode;
    validateConnectorModes(connectors, mode);
    validateConnectorModes(this.metricConnectors, mode);
    this.clock = clock;
    if (costRecorder) {
      if (
        typeof costRecorder.assertCampaignBudget !== 'function'
        || typeof costRecorder.recordLocalZeroAttempt !== 'function'
      ) {
        throw coded(
          'publisher_cost_reporter_required',
          'Publisher 费用记录器契约无效。',
        );
      }
      this.costRecorder = costRecorder;
    } else {
      this.costRecorder = new PublisherCostRecorder({
        repository,
        costReporter:costReporter || (
          mode === 'fake' ? createFakePublisherCostReporter() : null
        ),
        clock,
      });
    }
    this.processHardStop = null;
    this.publishExecution = new PublishExecution({
      repository,
      connectors,
      getArtifactVerifier:() => this.artifactVerifier,
      paperclipControl,
      costRecorder:this.costRecorder,
      mode,
      clock,
      assertOperational:() => this.assertOperational(),
      assertConnectorApproval:(...args) => this.assertConnectorApproval(...args),
      pauseInPaperclip:(input) => this.pauseInPaperclip(input),
    });
    this.metricCollectionExecution = new MetricCollectionExecution({
      repository,
      metricConnectors:this.metricConnectors,
      costRecorder:this.costRecorder,
      mode,
      clock,
      assertOperational:() => this.assertOperational(),
      assertConnectorApproval:(...args) => this.assertConnectorApproval(...args),
      pauseInPaperclip:(input) => this.pauseInPaperclip(input),
      activateGlobalHardStop:(input) => this.activateGlobalHardStop(input),
    });
    this.metricInvocationRecovery = new MetricInvocationRecovery({
      repository,
      paperclipControl,
      clock,
      pauseInPaperclip:(input) => this.pauseInPaperclip(input),
      activateGlobalHardStop:(input) => this.activateGlobalHardStop(input),
    });
  }

  async publish(request) {
    return this.publishExecution.publish(request);
  }

  async collectMetricSnapshot(input = {}) {
    return this.metricCollectionExecution.collect(input);
  }

  async getReceipt(identifier) {
    const receipts = Object.values((await this.repository.read()).receipts);
    return receipts.find((receipt) => (
      receipt.receiptId === identifier || receipt.idempotencyKey === identifier
    )) || null;
  }

  async getAttempt(idempotencyKey) {
    return (await this.repository.read()).attempts[idempotencyKey] || null;
  }

  async reconcileMetricInvocation(input = {}) {
    return this.metricInvocationRecovery.reconcile(input);
  }

  async getSafetyStatus() {
    const state = await this.repository.read();
    return structuredClone(state.safetyLatch);
  }

  async assertOperational() {
    if (this.processHardStop?.active) {
      throw coded('publisher_global_hard_stop', 'Publisher Gateway 已全局硬停；必须先恢复 Paperclip 控制面并人工解除运行实例。');
    }
    const state = await this.repository.read();
    if (state.safetyLatch?.active) {
      this.processHardStop = structuredClone(state.safetyLatch);
      throw coded('publisher_global_hard_stop', 'Publisher Gateway 已全局硬停；必须先恢复 Paperclip 控制面并人工解除运行实例。');
    }
  }

  async assertConnectorApproval(platform, capability, checkedAt) {
    if (this.mode !== 'real') return;
    await this.approvalGuard.assertCapabilityAllowed({
      platform,
      capability,
      checkedAt:checkedAt.toISOString(),
    });
  }

  async pauseInPaperclip({ idempotencyKey, campaignId, reason, now }) {
    const pauseKey = `publisher-pause:${campaignId}:${reason}`;
    try {
      const result = await this.paperclipControl.pauseCampaignAndDisableCron({
        campaignId,
        reason,
        idempotencyKey:pauseKey,
        requestedAt:now.toISOString(),
      });
      if (!validPauseControlResult(result, campaignId)) {
        throw coded('invalid_paperclip_pause_receipt', 'Paperclip 暂停回执没有同时证明 Grant 已暂停且 Cron 已关闭。');
      }
      await this.repository.update((state) => {
        const attempt = state.attempts[idempotencyKey];
        if (attempt) {
          attempt.pauseControl = {
            campaignId,
            grantStatus:'paused',
            cronStatus:'disabled',
            controlEventId:String(result.controlEventId),
            confirmedAt:now.toISOString(),
          };
          attempt.updatedAt = now.toISOString();
        }
      });
      return result;
    } catch (error) {
      await this.activateGlobalHardStop({
        campaignId,
        reason:'paperclip_pause_writeback_failed',
        controlError:String(error?.code || 'paperclip_control_failure'),
        activatedAt:now.toISOString(),
      });
      throw coded(
        'paperclip_pause_failed_hard_stop',
        'Paperclip 未确认 CampaignGrant 暂停和 Cron 关闭；Publisher Gateway 已全局硬停，禁止继续发布。',
      );
    }
  }

  async activateGlobalHardStop(latch) {
    this.processHardStop = { active:true, ...structuredClone(latch) };
    try {
      await this.repository.update((state) => {
        state.safetyLatch = structuredClone(this.processHardStop);
      });
    } catch {
      // 进程内门闩已先激活；即使持久化介质故障，本实例也绝不继续发布。
    }
  }
}

function validPauseControlResult(value, campaignId) {
  return value?.campaignId === campaignId
    && value?.grantStatus === 'paused'
    && value?.cronStatus === 'disabled'
    && typeof value?.controlEventId === 'string'
    && value.controlEventId.length > 0;
}

function validateConnectorModes(connectors, mode) {
  const connectorModes = Object.values(connectors || {})
    .map((connector) => String(connector?.connectorMode || ''));
  if (
    (mode === 'real' && connectorModes.some((value) => !value.startsWith('real:')))
    || (mode === 'fake' && connectorModes.some((value) => value.startsWith('real:')))
  ) {
    throw coded(
      'publisher_connector_mode_mismatch',
      'fake 与 real connector 不得在同一个 Publisher Gateway 中混用。',
    );
  }
}

export { publishIdempotencyKey };
