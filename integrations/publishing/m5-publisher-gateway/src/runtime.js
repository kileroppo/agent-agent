import path from 'node:path';
import {
  M5_PLATFORM_IDS,
  M5_PLATFORMS,
} from '@agent-army/m5-contracts';
import { WorkspaceArtifactVerifier } from './artifact-verifier.js';
import { FakePlatformConnector } from './connectors.js';
import { CuaPlatformConnector } from './cua-connector.js';
import { DouyinOfficialApiConnector } from './douyin-official-api-connector.js';
import { PublisherGateway, createProductionPublisherGateway } from './gateway.js';
import { coded } from './policy.js';
import { FilePublisherRepository } from './repository.js';
import {
  PublisherCostRecorder,
  createFakePublisherCostReporter,
} from './cost-reporting.js';
import { validateAccountIdentityVerifier } from './account-identity.js';
import { XhsOwnMetricsCuaConnector } from './xhs-own-metrics-cua-connector.js';

export function createPublisherRuntime({
  mode,
  productionEnabled = false,
  workspaceRoot,
  ledgerPath,
  paperclipControl,
  costReporter,
  accountIdentityVerifier,
  approvedConnectorMap,
  approvedMetricConnectorMap,
  clock = () => new Date(),
} = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (!normalizedMode || normalizedMode === 'disabled' || normalizedMode === 'off') return null;
  if (!['fake', 'real'].includes(normalizedMode)) {
    throw coded('invalid_publisher_mode', 'Publisher Runtime 模式只允许 disabled、fake 或 real。');
  }
  if (normalizedMode === 'real' && productionEnabled !== true) {
    throw coded('real_gateway_disabled', '真实 Publisher Runtime 默认关闭；必须显式设置 productionEnabled: true。');
  }
  if (!path.isAbsolute(String(workspaceRoot || ''))) {
    throw coded('invalid_workspace_root', 'Publisher Runtime 必须配置绝对发布工作区。');
  }
  if (!path.isAbsolute(String(ledgerPath || ''))) {
    throw coded('invalid_publisher_ledger', 'Publisher Runtime 必须配置绝对账本路径。');
  }
  if (!paperclipControl?.assertPublishAllowed || !paperclipControl?.pauseCampaignAndDisableCron) {
    throw coded(
      'paperclip_control_required',
      'Publisher Runtime 必须显式注入 Paperclip 控制适配器。',
    );
  }
  const repository = new FilePublisherRepository(ledgerPath);
  const costRecorder = new PublisherCostRecorder({
    repository,
    costReporter:costReporter || (
      normalizedMode === 'fake' ? createFakePublisherCostReporter() : null
    ),
    clock,
  });
  if (normalizedMode === 'real') {
    assertPublisherCapabilityIsolation(
      approvedConnectorMap,
      approvedMetricConnectorMap,
    );
    const connectors = buildApprovedConnectors(
      approvedConnectorMap,
      clock(),
      costRecorder,
      accountIdentityVerifier,
    );
    const metricConnectors = buildApprovedMetricConnectors(
      approvedMetricConnectorMap,
      clock,
      costRecorder,
      accountIdentityVerifier,
    );
    const approvalGuard = createRuntimeApprovalGuard({
      connectors,
      metricConnectors,
    });
    const gateway = createProductionPublisherGateway({
      repository,
      connectors,
      metricConnectors,
      approvalGuard,
      artifactVerifier:new WorkspaceArtifactVerifier(workspaceRoot),
      paperclipControl,
      costRecorder,
      clock,
    });
    return new ProductionPublisherRuntime({
      gateway,
      repository,
      connectors,
      metricConnectors,
    });
  }
  if (
    (approvedConnectorMap && Object.keys(approvedConnectorMap).length > 0)
    || (approvedMetricConnectorMap && Object.keys(approvedMetricConnectorMap).length > 0)
  ) {
    throw coded(
      'publisher_connector_mode_mismatch',
      'fake Runtime 不接受真实 approvedConnectorMap，fake 与 real 不得混用。',
    );
  }
  const connectors = {
    [M5_PLATFORM_IDS.DOUYIN]:new FakePlatformConnector(M5_PLATFORM_IDS.DOUYIN),
    [M5_PLATFORM_IDS.XIAOHONGSHU]:new FakePlatformConnector(M5_PLATFORM_IDS.XIAOHONGSHU),
  };
  const gateway = new PublisherGateway({
    repository,
    connectors,
    artifactVerifier:new WorkspaceArtifactVerifier(workspaceRoot),
    paperclipControl,
    costRecorder,
    mode:'fake',
    clock,
  });
  return new FakePublisherRuntime({
    gateway,
    repository,
    connectors,
    metricConnectors:connectors,
  });
}

export function assertPublisherCapabilityIsolation(
  approvedConnectorMap = {},
  approvedMetricConnectorMap = {},
) {
  const publisher = approvedConnectorMap?.xiaohongshu;
  const metrics = approvedMetricConnectorMap?.xiaohongshu;
  if (!publisher || !metrics) return true;
  const publishRunner = publisher.options?.runner;
  const metricRunner = metrics.options?.runner;
  const publishProfile = String(
    publishRunner?.contract?.profileName || '',
  );
  const metricProfile = String(
    metrics.options?.profileLease?.profileName || '',
  );
  if (
    publishRunner === metricRunner
    || (publishProfile && metricProfile && publishProfile === metricProfile)
  ) {
    throw coded(
      'publisher_cua_capability_isolation_required',
      '小红书发布与本人指标必须使用不同 runner 和不同命名 Profile。',
    );
  }
  return true;
}

function buildApprovedConnectors(
  approvedConnectorMap,
  now,
  costRecorder,
  accountIdentityVerifier,
) {
  if (
    !approvedConnectorMap
    || typeof approvedConnectorMap !== 'object'
    || Array.isArray(approvedConnectorMap)
    || Object.keys(approvedConnectorMap).length === 0
  ) {
    throw coded('real_connector_map_required', '真实 Publisher Runtime 必须注入非空的受批准 connector map。');
  }
  const connectors = {};
  for (const [platform, descriptor] of Object.entries(approvedConnectorMap)) {
    if (!M5_PLATFORMS.includes(platform)) {
      throw coded('unsupported_real_connector', `不支持真实发布平台 ${platform}。`);
    }
    validateConnectorApproval(platform, descriptor, now);
    if (descriptor.kind === 'douyin_official_api' && platform === M5_PLATFORM_IDS.DOUYIN) {
      const { httpRequest, credentialResolver, maxUploadBytes } = descriptor.options || {};
      if (typeof httpRequest !== 'function' || typeof credentialResolver !== 'function') {
        throw coded(
          'real_connector_dependencies_missing',
          '抖音官方 connector 必须注入 HTTP 传输和临时凭据解析器。',
        );
      }
      validateAccountIdentityVerifier(accountIdentityVerifier);
      connectors[platform] = new DouyinOfficialApiConnector({
        enabled:true,
        httpRequest,
        credentialResolver,
        accountIdentityVerifier,
        maxUploadBytes,
        costRecorder,
      });
      bindApprovalPolicy(connectors[platform], descriptor.approval, 'publish');
      continue;
    }
    if (descriptor.kind === 'cua') {
      connectors[platform] = new CuaPlatformConnector({
        platform,
        runner:descriptor.options?.runner,
        enabled:true,
      });
      bindApprovalPolicy(connectors[platform], descriptor.approval, 'publish');
      continue;
    }
    throw coded(
      'unsupported_real_connector',
      `${platform} 不支持 connector 类型 ${String(descriptor?.kind || '')}。`,
    );
  }
  return connectors;
}

function buildApprovedMetricConnectors(
  approvedMetricConnectorMap,
  clock,
  costRecorder,
  accountIdentityVerifier,
) {
  if (!approvedMetricConnectorMap) return {};
  if (
    typeof approvedMetricConnectorMap !== 'object'
    || Array.isArray(approvedMetricConnectorMap)
  ) {
    throw coded(
      'real_metric_connector_map_invalid',
      '真实指标 connector map 必须由可信调用方显式注入。',
    );
  }
  const connectors = {};
  for (const [platform, descriptor] of Object.entries(approvedMetricConnectorMap)) {
    validateMetricConnectorApproval(platform, descriptor, clock());
    if (platform === M5_PLATFORM_IDS.XIAOHONGSHU && descriptor.kind === 'xhs_own_metrics_cua') {
      connectors[platform] = new XhsOwnMetricsCuaConnector({
        enabled:true,
        runner:descriptor.options?.runner,
        selectorBundle:descriptor.options?.selectorBundle,
        profileLease:descriptor.options?.profileLease,
        clock,
      });
      bindApprovalPolicy(
        connectors[platform],
        descriptor.approval,
        'read_own_metrics',
      );
      continue;
    }
    if (platform === M5_PLATFORM_IDS.DOUYIN && descriptor.kind === 'douyin_official_api') {
      const { httpRequest, credentialResolver } = descriptor.options || {};
      if (typeof httpRequest !== 'function' || typeof credentialResolver !== 'function') {
        throw coded(
          'real_metric_connector_dependencies_missing',
          '抖音本人指标 connector 缺少独立批准的 HTTP 与凭据解析依赖。',
        );
      }
      validateAccountIdentityVerifier(accountIdentityVerifier);
      connectors[platform] = new DouyinOfficialApiConnector({
        enabled:true,
        httpRequest,
        credentialResolver,
        accountIdentityVerifier,
        costRecorder,
      });
      bindApprovalPolicy(
        connectors[platform],
        descriptor.approval,
        'read_own_metrics',
      );
      continue;
    }
    throw coded(
      'unsupported_real_metric_connector',
      `${platform} 不支持指标 connector 类型 ${String(descriptor?.kind || '')}。`,
    );
  }
  return connectors;
}

function validateConnectorApproval(platform, descriptor, now) {
  const approval = descriptor?.approval;
  const expiresAt = Date.parse(approval?.expiresAt);
  if (
    approval?.status !== 'approved'
    || typeof approval?.approvalRef !== 'string'
    || !approval.approvalRef.startsWith('paperclip:')
    || approval?.platform !== platform
    || approval?.connectorKind !== descriptor?.kind
    || !Number.isFinite(expiresAt)
    || expiresAt <= now.getTime()
  ) {
    throw coded(
      'real_connector_approval_invalid',
      `${platform} connector 缺少有效的 Paperclip 批准引用或批准已经过期。`,
    );
  }
}

function validateMetricConnectorApproval(platform, descriptor, now) {
  const approval = descriptor?.approval;
  const expiresAt = Date.parse(approval?.expiresAt);
  if (
    !M5_PLATFORMS.includes(platform)
    || approval?.status !== 'approved'
    || typeof approval?.approvalRef !== 'string'
    || !approval.approvalRef.startsWith('paperclip:')
    || approval?.platform !== platform
    || approval?.capability !== 'read_own_metrics'
    || approval?.connectorKind !== descriptor?.kind
    || !Number.isFinite(expiresAt)
    || expiresAt <= now.getTime()
  ) {
    throw coded(
      'real_metric_connector_approval_invalid',
      `${platform} 指标 connector 缺少独立、有效且未过期的 Paperclip 批准。`,
    );
  }
}

function bindApprovalPolicy(connector, approval, capability) {
  Object.defineProperty(connector, 'approvalPolicy', {
    configurable:false,
    enumerable:false,
    writable:false,
    value:Object.freeze({
      status:approval.status,
      approvalRef:approval.approvalRef,
      platform:approval.platform,
      capability,
      connectorKind:approval.connectorKind,
      expiresAt:new Date(approval.expiresAt).toISOString(),
    }),
  });
}

function createRuntimeApprovalGuard({ connectors, metricConnectors }) {
  return Object.freeze({
    assertCapabilityAllowed({ platform, capability, checkedAt }) {
      const connector = capability === 'read_own_metrics'
        ? metricConnectors[platform]
        : connectors[platform];
      const approval = connector?.approvalPolicy;
      const current = Date.parse(checkedAt);
      const expiresAt = Date.parse(approval?.expiresAt);
      const valid = approval?.status === 'approved'
        && approval?.platform === platform
        && approval?.capability === capability
        && typeof approval?.approvalRef === 'string'
        && approval.approvalRef.startsWith('paperclip:')
        && Number.isFinite(current)
        && Number.isFinite(expiresAt)
        && expiresAt > current;
      if (!valid) {
        throw coded(
          capability === 'read_own_metrics'
            ? 'real_metric_connector_approval_invalid'
            : 'real_connector_approval_invalid',
          `${platform} ${capability} connector 批准已失效、过期或与当前 capability 不一致。`,
        );
      }
      return true;
    },
  });
}

export class FakePublisherRuntime {
  constructor({
    gateway,
    repository,
    connectors,
    metricConnectors = connectors,
  }) {
    this.mode = 'fake';
    this.gateway = gateway;
    this.repository = repository;
    this.connectors = connectors;
    this.metricConnectors = metricConnectors;
  }

  publish(request) {
    return this.gateway.publish(request);
  }

  collectMetricSnapshot(input) {
    return this.gateway.collectMetricSnapshot(input);
  }

  reconcileMetricInvocation(input) {
    return this.gateway.reconcileMetricInvocation(input);
  }

  async getReceipt(identifier) {
    const receipt = await this.gateway.getReceipt(identifier);
    if (!receipt) return null;
    const state = await this.repository.read();
    return {
      ...receipt,
      metricSnapshots:state.metricSnapshots.filter((item) => item.receiptId === receipt.receiptId),
    };
  }

  getSafetyStatus() {
    return this.gateway.getSafetyStatus();
  }
}

export class ProductionPublisherRuntime extends FakePublisherRuntime {
  constructor(options) {
    super(options);
    this.mode = 'real';
  }
}
