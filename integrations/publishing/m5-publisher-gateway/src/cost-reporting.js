import crypto from 'node:crypto';
import { coded } from './policy.js';

export const PUBLISHER_COST_REPORTER_SCHEMA =
  'agent.army/publisher-cost-reporter/v1';

const OFFICIAL_CONNECTOR_MODE = 'real:douyin_official_api';
const LOCAL_ZERO_MODE =
  /^(?:fake|real:(?:(?:douyin|xiaohongshu|xiaohongshu_own_metrics)_cua|wechat_wenyan_cli))$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const OPERATION = /^[a-z][a-z0-9_]{1,63}$/;

export class PublisherCostRecorder {
  constructor({
    repository,
    costReporter,
    clock = () => new Date(),
  } = {}) {
    if (!repository?.read || !repository?.update) {
      throw coded(
        'publisher_cost_repository_required',
        'Publisher 费用记录必须复用发布事务账本。',
      );
    }
    validateReporter(costReporter);
    this.repository = repository;
    this.costReporter = costReporter;
    this.clock = clock;
  }

  async assertCampaignBudget({
    campaignId,
    connectorMode,
    operation,
    checkedAt = this.clock(),
  } = {}) {
    const input = normalizeBudgetInput({
      campaignId,
      connectorMode,
      operation,
      checkedAt,
    });
    let result;
    try {
      result = await this.costReporter.assertCampaignBudget(input);
    } catch {
      throw coded(
        'publisher_budget_unavailable',
        '无法从 Paperclip 核验活动剩余预算；平台连接器未调用。',
      );
    }
    if (
      result?.campaignId !== input.campaignId
      || result?.hardStopEnabled !== true
      || typeof result?.allowed !== 'boolean'
      || !Number.isFinite(Number(result?.remainingAmountUsd))
      || Number(result.remainingAmountUsd) < 0
    ) {
      throw coded(
        'publisher_budget_unavailable',
        'Paperclip 返回的活动预算状态无法验证；平台连接器未调用。',
      );
    }
    return Object.freeze({
      campaignId:input.campaignId,
      allowed:result.allowed,
      hardStopEnabled:true,
      remainingAmountUsd:normalizeUsd(result.remainingAmountUsd),
    });
  }

  async recordLocalZeroAttempt(input = {}) {
    const connectorMode = String(input.connectorMode || '');
    if (!LOCAL_ZERO_MODE.test(connectorMode)) {
      throw coded(
        'publisher_cost_source_invalid',
        '只有 Fake、本机 CUA 或本机 Wenyan connector 可以固定记录零费用。',
      );
    }
    return this.record({
      ...input,
      connectorMode,
      providerRequestId:null,
      receiptRef:input.receiptRef,
      amountUsd:0,
      source:'local_zero',
    });
  }

  async recordOfficialTransportAttempt(input = {}) {
    if (input.connectorMode !== OFFICIAL_CONNECTOR_MODE) {
      throw coded(
        'publisher_cost_source_invalid',
        '官方 API 实际费用只能绑定受支持的官方 connector。',
      );
    }
    return this.record({
      ...input,
      source:'transport_actual',
    });
  }

  async record(input) {
    const record = normalizeCostRecord(input);
    const costRecordId = deterministicCostRecordId(record);
    const claimed = await this.repository.update((state) => {
      const existing = state.costRecords[costRecordId];
      if (existing) {
        if (!sameCharge(existing, record)) {
          return { kind:'conflict' };
        }
        return existing.state === 'reported'
          ? { kind:'replay', record:existing }
          : { kind:'ambiguous', record:existing };
      }
      state.costRecords[costRecordId] = {
        ...record,
        costRecordId,
        state:'submitting',
        createdAt:this.clock().toISOString(),
      };
      return { kind:'claimed' };
    });
    if (claimed.kind === 'conflict') {
      throw coded(
        'publisher_cost_record_conflict',
        '同一费用幂等标识对应了不同金额或来源，拒绝覆盖。',
      );
    }
    if (claimed.kind === 'ambiguous') {
      throw coded(
        'publisher_cost_reporting_ambiguous',
        '费用上报结果未决，禁止重复计费；需要先核对 Paperclip 费用事件。',
      );
    }
    if (claimed.kind === 'replay') {
      return { replayed:true, record:structuredClone(claimed.record) };
    }

    let receipt;
    try {
      receipt = await this.costReporter.recordConnectorAttempt(
        Object.freeze({
          costRecordId,
          campaignId:record.campaignId,
          connectorMode:record.connectorMode,
          operation:record.operation,
          providerRequestId:record.providerRequestId,
          receiptRef:record.receiptRef,
          amountUsd:record.amountUsd,
          occurredAt:record.occurredAt,
        }),
      );
    } catch {
      throw coded(
        'publisher_cost_reporting_ambiguous',
        '费用上报未得到确定回执，禁止重复计费；需要先核对 Paperclip 费用事件。',
      );
    }
    const reportRef = String(receipt?.reportRef || '');
    if (!REFERENCE.test(reportRef)) {
      throw coded(
        'publisher_cost_reporting_ambiguous',
        '费用上报没有返回可核验回执，禁止重复计费。',
      );
    }
    const committed = await this.repository.update((state) => {
      const current = state.costRecords[costRecordId];
      if (!current || current.state !== 'submitting' || !sameCharge(current, record)) {
        throw coded(
          'publisher_cost_record_conflict',
          '费用记录在提交期间发生变化，已停止后续动作。',
        );
      }
      current.state = 'reported';
      current.reportRef = reportRef;
      current.reportedAt = this.clock().toISOString();
      return current;
    });
    return { replayed:false, record:committed };
  }
}

export function createFakePublisherCostReporter() {
  return Object.freeze({
    contract:Object.freeze({
      schemaVersion:PUBLISHER_COST_REPORTER_SCHEMA,
      deterministic:true,
      source:'fake',
    }),
    async assertCampaignBudget({ campaignId }) {
      return {
        campaignId,
        allowed:true,
        hardStopEnabled:true,
        remainingAmountUsd:Number.MAX_SAFE_INTEGER,
      };
    },
    async recordConnectorAttempt({ costRecordId, amountUsd }) {
      if (amountUsd !== 0) {
        throw coded('publisher_fake_cost_invalid', 'Fake Publisher 费用必须固定为零。');
      }
      return { reportRef:`fake:${costRecordId}` };
    },
  });
}

export function parseOfficialTransportCost(value, {
  operation,
  connectorMode = OFFICIAL_CONNECTOR_MODE,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw coded(
      'publisher_transport_cost_unverified',
      `${operation} 缺少传输层结构化实际费用，拒绝猜测金额。`,
    );
  }
  const allowed = new Set([
    'amountUsd',
    'providerRequestId',
    'receiptRef',
    'occurredAt',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw coded(
      'publisher_transport_cost_unverified',
      `${operation} 的传输费用包含未授权字段。`,
    );
  }
  return normalizeCostRecord({
    campaignId:'transport-validation',
    idempotencyKey:'transport-validation',
    connectorMode,
    operation,
    providerRequestId:value.providerRequestId,
    receiptRef:value.receiptRef,
    amountUsd:value.amountUsd,
    occurredAt:value.occurredAt,
    source:'transport_actual',
  });
}

function validateReporter(reporter) {
  if (
    reporter?.contract?.schemaVersion !== PUBLISHER_COST_REPORTER_SCHEMA
    || reporter?.contract?.deterministic !== true
    || typeof reporter?.assertCampaignBudget !== 'function'
    || typeof reporter?.recordConnectorAttempt !== 'function'
  ) {
    throw coded(
      'publisher_cost_reporter_required',
      '真实 Publisher 必须注入确定性的 Paperclip 费用 reporter。',
    );
  }
}

function normalizeBudgetInput(value) {
  const campaignId = reference(value.campaignId, 'campaignId');
  const connectorMode = connectorModeValue(value.connectorMode);
  const operation = operationValue(value.operation);
  const checkedAt = timestamp(value.checkedAt, 'checkedAt');
  return Object.freeze({ campaignId, connectorMode, operation, checkedAt });
}

function normalizeCostRecord(value) {
  const source = String(value.source || '');
  const connectorMode = connectorModeValue(value.connectorMode);
  if (
    (source === 'local_zero' && !LOCAL_ZERO_MODE.test(connectorMode))
    || (source === 'transport_actual' && connectorMode !== OFFICIAL_CONNECTOR_MODE)
  ) {
    throw coded('publisher_cost_source_invalid', 'Publisher 费用来源与 connector 模式不匹配。');
  }
  if (!['local_zero', 'transport_actual'].includes(source)) {
    throw coded('publisher_cost_source_invalid', 'Publisher 费用来源无效。');
  }
  const amountUsd = normalizeUsd(value.amountUsd);
  if (source === 'local_zero' && amountUsd !== 0) {
    throw coded('publisher_local_cost_invalid', 'Fake 与本机 CUA 费用必须固定为零。');
  }
  const providerRequestId = optionalReference(value.providerRequestId);
  const receiptRef = optionalReference(value.receiptRef);
  if ((providerRequestId ? 1 : 0) + (receiptRef ? 1 : 0) !== 1) {
    throw coded(
      'publisher_cost_reference_invalid',
      '费用记录必须且只能提供 providerRequestId 或 receiptRef。',
    );
  }
  return Object.freeze({
    campaignId:reference(value.campaignId, 'campaignId'),
    idempotencyKey:reference(value.idempotencyKey, 'idempotencyKey'),
    connectorMode,
    operation:operationValue(value.operation),
    providerRequestId,
    receiptRef,
    amountUsd,
    occurredAt:timestamp(value.occurredAt, 'occurredAt'),
    source,
  });
}

function deterministicCostRecordId(record) {
  const identity = [
    record.campaignId,
    record.idempotencyKey,
    record.connectorMode,
    record.operation,
    record.providerRequestId || record.receiptRef,
  ].join('\n');
  return `publisher-cost:${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

function sameCharge(left, right) {
  return left.campaignId === right.campaignId
    && left.idempotencyKey === right.idempotencyKey
    && left.connectorMode === right.connectorMode
    && left.operation === right.operation
    && left.providerRequestId === right.providerRequestId
    && left.receiptRef === right.receiptRef
    && left.amountUsd === right.amountUsd
    && left.occurredAt === right.occurredAt
    && left.source === right.source;
}

function normalizeUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw coded('publisher_cost_amount_invalid', 'Publisher 实际费用必须是非负美元金额。');
  }
  return Number(amount.toFixed(6));
}

function connectorModeValue(value) {
  const mode = String(value || '');
  if (!/^(?:fake|real:[a-z0-9_]+)$/.test(mode)) {
    throw coded('publisher_cost_connector_invalid', 'Publisher connectorMode 无效。');
  }
  return mode;
}

function operationValue(value) {
  const operation = String(value || '');
  if (!OPERATION.test(operation)) {
    throw coded('publisher_cost_operation_invalid', 'Publisher 费用 operation 无效。');
  }
  return operation;
}

function reference(value, field) {
  const normalized = String(value || '');
  if (!REFERENCE.test(normalized)) {
    throw coded('publisher_cost_reference_invalid', `Publisher 费用 ${field} 无效。`);
  }
  return normalized;
}

function optionalReference(value) {
  if (value == null || value === '') return null;
  return reference(value, 'reference');
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) {
    throw coded('publisher_cost_timestamp_invalid', `Publisher 费用 ${field} 无效。`);
  }
  return new Date(parsed).toISOString();
}
