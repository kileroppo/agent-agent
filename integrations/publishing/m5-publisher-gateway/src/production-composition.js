import {
  M5_PLATFORM_IDS,
  M5_PLATFORMS,
} from '@agent-army/m5-contracts';
import { coded } from './policy.js';
import {
  assertPublisherCapabilityIsolation,
  createPublisherRuntime,
} from './runtime.js';

export const PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA =
  'agent.army/publisher-connector-approvals/v1';
const PRODUCTION_COMPOSITION = Symbol('publisher-production-composition');

export function createProductionPublisherComposition(options = {}) {
  if (options.enabled !== true) return null;

  const {
    approvalSnapshot,
    connectorDependencies,
    workspaceRoot,
    ledgerPath,
    paperclipControl,
    costReporter,
    accountIdentityVerifier,
    clock = () => new Date(),
  } = options;
  const snapshot = validateApprovalSnapshot(approvalSnapshot, clock());
  const approvedConnectorMap = buildApprovedConnectorMap(
    snapshot.approvals,
    connectorDependencies,
  );
  const approvedMetricConnectorMap = buildApprovedMetricConnectorMap(
    snapshot.approvals,
    connectorDependencies,
  );
  assertPublisherCapabilityIsolation(
    approvedConnectorMap,
    approvedMetricConnectorMap,
  );

  return Object.freeze({
    [PRODUCTION_COMPOSITION]:true,
    mode:'real',
    approvalSnapshotId:snapshot.snapshotId,
    createRuntime() {
      return createPublisherRuntime({
        mode:'real',
        productionEnabled:true,
        workspaceRoot,
        ledgerPath,
        paperclipControl,
        costReporter,
        accountIdentityVerifier,
        approvedConnectorMap,
        approvedMetricConnectorMap,
        clock,
      });
    },
  });
}

export function isProductionPublisherComposition(value) {
  return value?.[PRODUCTION_COMPOSITION] === true
    && value?.mode === 'real'
    && typeof value?.createRuntime === 'function';
}

function validateApprovalSnapshot(value, now) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA
    || value.source !== 'paperclip'
    || typeof value.snapshotId !== 'string'
    || !value.snapshotId.startsWith('paperclip:')
    || !Number.isFinite(Date.parse(value.capturedAt))
    || Date.parse(value.capturedAt) > now.getTime()
    || !Array.isArray(value.approvals)
    || value.approvals.length === 0
  ) {
    throw coded(
      'publisher_approval_snapshot_invalid',
      '真实 Publisher 必须由调用方注入结构完整的 Paperclip 批准快照。',
    );
  }
  const approvalIdentities = value.approvals.map(
    (item) => `${String(item?.platform || '')}:${String(item?.capability || 'publish')}`,
  );
  if (
    value.approvals.some(
      (item) => !M5_PLATFORMS.includes(item?.platform),
    )
    || new Set(approvalIdentities).size !== approvalIdentities.length
  ) {
    throw coded(
      'publisher_approval_snapshot_invalid',
      'Paperclip 批准快照包含重复的平台能力或不支持的平台。',
    );
  }
  for (const approval of value.approvals) {
    const expiresAt = Date.parse(approval?.expiresAt);
    if (
      approval?.status !== 'approved'
      || typeof approval?.approvalRef !== 'string'
      || !approval.approvalRef.startsWith('paperclip:')
      || !['publish', 'read_own_metrics'].includes(approval?.capability || 'publish')
      || !['douyin_official_api', 'cua', 'xhs_own_metrics_cua']
        .includes(approval?.connectorKind)
      || (
        (approval?.capability || 'publish') === 'publish'
        && approval?.connectorKind === 'xhs_own_metrics_cua'
      )
      || (
        approval?.capability === 'read_own_metrics'
        && !['douyin_official_api', 'xhs_own_metrics_cua']
          .includes(approval?.connectorKind)
      )
      || !Number.isFinite(expiresAt)
      || expiresAt <= now.getTime()
    ) {
      throw coded(
        'real_connector_approval_invalid',
        `${String(approval?.platform || 'unknown')} connector 的 Paperclip 批准无效或已经过期。`,
      );
    }
  }
  return {
    snapshotId:value.snapshotId,
    approvals:value.approvals.map((item) => structuredClone(item)),
  };
}

function buildApprovedConnectorMap(approvals, dependencies = {}) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw coded(
      'publisher_connector_dependency_missing',
      '真实 Publisher connector 依赖必须由可信调用方显式注入。',
    );
  }
  const output = {};
  for (const approval of approvals.filter(
    (item) => (item.capability || 'publish') === 'publish',
  )) {
    if (
      approval.connectorKind === 'douyin_official_api'
      && approval.platform === M5_PLATFORM_IDS.DOUYIN
    ) {
      const dependency = dependencies.douyinOfficialApi;
      if (
        typeof dependency?.httpRequest !== 'function'
        || typeof dependency?.credentialResolver !== 'function'
      ) {
        throw coded(
          'publisher_connector_dependency_missing',
          '抖音官方 connector 缺少显式 HTTP transport 或 credential resolver。',
        );
      }
      output.douyin = {
        kind:'douyin_official_api',
        approval,
        options:{
          httpRequest:dependency.httpRequest,
          credentialResolver:dependency.credentialResolver,
          ...(dependency.maxUploadBytes === undefined
            ? {}
            : { maxUploadBytes:dependency.maxUploadBytes }),
        },
      };
      continue;
    }
    if (approval.connectorKind === 'cua') {
      const runner = dependencies.cuaRunners?.[approval.platform];
      if (!runner) {
        throw coded(
          'publisher_connector_dependency_missing',
          `${approval.platform} CUA connector 缺少显式受控 runner。`,
        );
      }
      output[approval.platform] = {
        kind:'cua',
        approval,
        options:{ runner },
      };
      continue;
    }
    throw coded(
      'publisher_approval_snapshot_invalid',
      `${approval.platform} 的 connector 批准类型无效。`,
    );
  }
  return output;
}

function buildApprovedMetricConnectorMap(approvals, dependencies = {}) {
  const output = {};
  for (const approval of approvals.filter(
    (item) => item.capability === 'read_own_metrics',
  )) {
    if (
      approval.platform === M5_PLATFORM_IDS.XIAOHONGSHU
      && approval.connectorKind === 'xhs_own_metrics_cua'
    ) {
      const dependency = dependencies.xhsOwnMetricsCua;
      if (
        typeof dependency?.runner?.beginSession !== 'function'
        || !dependency?.selectorBundle
        || !dependency?.profileLease
      ) {
        throw coded(
          'publisher_metric_connector_dependency_missing',
          '小红书本人指标 connector 缺少独立只读 runner、selector bundle 或 Profile lease。',
        );
      }
      output.xiaohongshu = {
        kind:'xhs_own_metrics_cua',
        approval,
        options:{
          runner:dependency.runner,
          selectorBundle:dependency.selectorBundle,
          profileLease:dependency.profileLease,
        },
      };
      continue;
    }
    if (
      approval.platform === M5_PLATFORM_IDS.DOUYIN
      && approval.connectorKind === 'douyin_official_api'
    ) {
      const dependency = dependencies.douyinOfficialApi;
      if (
        typeof dependency?.httpRequest !== 'function'
        || typeof dependency?.credentialResolver !== 'function'
      ) {
        throw coded(
          'publisher_metric_connector_dependency_missing',
          '抖音本人指标 connector 缺少独立批准的 HTTP transport 或 credential resolver。',
        );
      }
      output.douyin = {
        kind:'douyin_official_api',
        approval,
        options:{
          httpRequest:dependency.httpRequest,
          credentialResolver:dependency.credentialResolver,
        },
      };
      continue;
    }
    throw coded(
      'publisher_approval_snapshot_invalid',
      `${approval.platform} 的指标 connector 批准类型无效。`,
    );
  }
  return output;
}
