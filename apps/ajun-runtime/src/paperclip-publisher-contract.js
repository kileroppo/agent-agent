const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PUBLISHER_APPROVAL_KIND = 'publisher_connector_approval_v1';
const PUBLISHER_APPROVAL_SCHEMA = 'agent.army/publisher-connector-approvals/v1';
const PUBLISHER_AUTHORIZATION_SCHEMA = 'agent.army/publisher-authorization/v1';
const PUBLISHER_COST_RECORD_SCHEMA = 'agent.army/publisher-cost-record/v1';
const PUBLISHER_ACTION_ROLES = Object.freeze({
  'publisher.publish':'m5-publisher-controller',
  'publisher.read_own_metrics':'m5-metrics-controller',
  'publisher.reconcile_stale_attempt':'m5-metrics-controller',
});
const PUBLISHER_ACTION_STAGES = Object.freeze({
  'publisher.publish':'publish',
  'publisher.read_own_metrics':'metrics',
  'publisher.reconcile_stale_attempt':'metrics',
});
const PUBLISHER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const PUBLISHER_SECRET_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const PUBLISHER_CONNECTOR_MODE = /^real:[a-z0-9][a-z0-9_-]{0,127}$/;
const PUBLISHER_BUDGET_OPERATIONS = new Set(['publish', 'read_own_metrics']);
const PUBLISHER_COST_OPERATIONS = Object.freeze({
  publish:new Set(['upload_video', 'create_video', 'query_video_basic_info', 'publish']),
  read_own_metrics:new Set(['read_video_metrics', 'read_own_metrics']),
});

function m5CaseProjectId(detail, item) {
  return String(
    item?.projectId
    || item?.fields?.projectId
    || item?.pipeline?.projectId
    || detail?.pipeline?.projectId
    || '',
  );
}

function normalizeM5Case(value) {
  const item = value?.case ?? value;
  if (!item || typeof item !== 'object' || Array.isArray(item) || !item.id) {
    throw new Error('Paperclip Publisher Case 结构无效。');
  }
  return {
    ...item,
    fields:item.fields && typeof item.fields === 'object' ? item.fields : {},
    stageKey:item.stageKey || value?.stage?.key || item.stage?.key || null,
    pipelineId:item.pipelineId || value?.pipeline?.id || item.pipeline?.id || null,
    projectId:item.projectId || value?.pipeline?.projectId || item.pipeline?.projectId || null,
  };
}

function publisherIssueCaseId(issue) {
  const value = String(issue?.description || '').match(
    /当前 Case 为 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i,
  )?.[1];
  if (!value) throw new Error('Publisher 系统任务缺少固定 Case 绑定。');
  return value;
}

function assertPublisherAuthorizationId(input, credential) {
  const value = publisherReference(
    input.authorizationId,
    'Publisher authorizationId 无效。',
  );
  if (input.action === 'publisher.publish') {
    if (value !== `paperclip:${credential.runId}:${credential.issueId}:publisher.publish`) {
      throw new Error('Publisher 发布授权标识与当前 Run 不一致。');
    }
    return;
  }
  if (input.action === 'publisher.read_own_metrics') {
    const prefix = `paperclip:${credential.runId}:${credential.issueId}:publisher.read_own_metrics:`;
    if (!value.startsWith(prefix) || !['2h', '24h', '72h'].includes(value.slice(prefix.length))) {
      throw new Error('Publisher 指标授权标识与当前 Run 或检查点不一致。');
    }
    return;
  }
  if (
    input.action !== 'publisher.reconcile_stale_attempt'
    || !credential.approvalId
    || value !== `paperclip:approval:${credential.approvalId}:metric-recovery`
  ) {
    throw new Error('Publisher 恢复授权标识与当前 Paperclip Approval 不一致。');
  }
}

function normalizePublisherConnectorApproval(value) {
  const payload = value?.payload;
  if (
    !UUID.test(String(value?.id || ''))
    || !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.governanceKind !== PUBLISHER_APPROVAL_KIND
  ) return null;
  try {
    const platform = publisherPlatform(payload.platform);
    const capability = publisherCapability(payload.capability || 'publish');
    const connectorKind = String(payload.connectorKind || '');
    if (
      !['douyin_official_api', 'cua', 'xhs_own_metrics_cua'].includes(connectorKind)
      || (capability === 'publish' && connectorKind === 'xhs_own_metrics_cua')
      || (
        capability === 'read_own_metrics'
        && !['douyin_official_api', 'xhs_own_metrics_cua'].includes(connectorKind)
      )
    ) return null;
    const expiresAt = validClock(payload.expiresAt).toISOString();
    const approval = {
      id:value.id,
      campaignId:publisherReference(payload.campaignId, 'Campaign 无效。'),
      platform,
      capability,
      connectorKind,
      accountRef:publisherReference(payload.accountRef, 'accountRef 无效。'),
      expiresAt,
    };
    if (payload.secretKey != null) approval.secretKey = String(payload.secretKey);
    if (payload.providerIdentity != null) {
      approval.providerIdentity = publisherIdentity(payload.providerIdentity);
    }
    return approval;
  } catch {
    return null;
  }
}

function uniquePublisherApproval(approvals, expected) {
  const rows = approvals.filter((approval) => (
    approval.platform === expected.platform
    && approval.capability === expected.capability
    && approval.accountRef === expected.accountRef
  ));
  if (rows.length !== 1) {
    throw new Error('Paperclip Publisher connector 批准缺失或不唯一。');
  }
  return rows[0];
}

function parsePublisherCredential(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 64_000) {
    throw new Error('Paperclip Publisher Secret 不是受支持的结构化凭据。');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Paperclip Publisher Secret 不是受支持的结构化凭据。');
  }
  assertExactKeys(parsed, ['accessToken', 'openId'], 'Publisher Secret');
  const accessToken = String(parsed.accessToken || '').trim();
  const openId = String(parsed.openId || '').trim();
  if (!accessToken || accessToken.length > 16_384 || !openId || openId.length > 1_024) {
    throw new Error('Paperclip Publisher Secret 缺少受支持的账号凭据字段。');
  }
  return Object.freeze({ accessToken, openId });
}

function publisherIdentity(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some((key) => !['kind', 'value'].includes(key))
    || value.kind !== 'open_id_sha256'
    || !/^sha256:[0-9a-f]{64}$/.test(String(value.value || ''))
  ) {
    throw new Error('Publisher 平台账号身份哈希无效。');
  }
  return Object.freeze({ kind:value.kind, value:value.value });
}

function samePublisherIdentity(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

function publisherPlatform(value) {
  const platform = String(value || '');
  if (!['douyin', 'xiaohongshu'].includes(platform)) {
    throw new Error('Publisher 平台无效。');
  }
  return platform;
}

function publisherCapability(value) {
  const capability = String(value || '');
  if (!['publish', 'read_own_metrics'].includes(capability)) {
    throw new Error('Publisher connector 能力无效。');
  }
  return capability;
}

function publisherReference(value, message) {
  const normalized = String(value || '').trim();
  if (!PUBLISHER_REFERENCE.test(normalized)) throw new Error(message);
  return normalized;
}

function publisherAuthorizationRecord(value) {
  return value?.schemaVersion === PUBLISHER_AUTHORIZATION_SCHEMA ? value : null;
}

function samePublisherAuthorization(left, right) {
  return [
    'schemaVersion',
    'action',
    'authorizationId',
    'runId',
    'issueId',
    'agentId',
    'campaignId',
  ].every((field) => left?.[field] === right?.[field]);
}

function publisherCostRecord(value) {
  return value?.schemaVersion === PUBLISHER_COST_RECORD_SCHEMA ? value : null;
}

function samePublisherCost(left, right) {
  return [
    'schemaVersion',
    'costRecordId',
    'campaignId',
    'connectorMode',
    'operation',
    'sourceRef',
    'amountUsd',
    'occurredAt',
  ].every((field) => left?.[field] === right?.[field]);
}

function boundedRecordMap(existing, key, value) {
  const entries = Object.entries(
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing
      : {},
  ).filter(([entryKey]) => entryKey !== key).slice(-63);
  return Object.fromEntries([...entries, [key, value]]);
}

function integerVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('Paperclip Publisher Case 缺少可用于原子写入的版本号。');
  }
  return version;
}

function validClock(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Publisher 时间无效。');
  return date;
}

function assertExactKeys(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是结构化对象。`);
  }
  const extra = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (extra) throw new Error(`${label}包含未授权字段 ${extra}。`);
}


function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export {
  UUID,
  PUBLISHER_APPROVAL_SCHEMA,
  PUBLISHER_AUTHORIZATION_SCHEMA,
  PUBLISHER_COST_RECORD_SCHEMA,
  PUBLISHER_ACTION_ROLES,
  PUBLISHER_ACTION_STAGES,
  PUBLISHER_SECRET_KEY,
  PUBLISHER_CONNECTOR_MODE,
  PUBLISHER_BUDGET_OPERATIONS,
  PUBLISHER_COST_OPERATIONS,
  m5CaseProjectId,
  normalizeM5Case,
  publisherIssueCaseId,
  assertPublisherAuthorizationId,
  normalizePublisherConnectorApproval,
  uniquePublisherApproval,
  parsePublisherCredential,
  publisherIdentity,
  samePublisherIdentity,
  publisherPlatform,
  publisherCapability,
  publisherReference,
  publisherAuthorizationRecord,
  samePublisherAuthorization,
  publisherCostRecord,
  samePublisherCost,
  boundedRecordMap,
  integerVersion,
  validClock,
  assertExactKeys,
  stableJson,
};
