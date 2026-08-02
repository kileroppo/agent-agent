import {
  M5_PLATFORMS,
  M5_SCHEMA_IDS,
} from '@agent-army/m5-contracts';
import {
  consumeM5SystemControllerPlanRevision,
  isRecoverableM5SystemControllerFailure,
  markM5SystemControllerFailure,
  recoverM5SystemControllerFailure,
} from './m5-system-controller-recovery.js';
import {
  IMMEDIATE_PUBLISH_RECOVERY_ACTION,
  calendarDateInShanghai,
} from '@agent-army/m5-publisher-gateway/policy';

const SYSTEM_ROLE = 'm5-publisher-controller';
const ROUTINE_MARKER = '[agent-army:m5:routine:m5-publish]';
const CONTENT_PROVIDER = 'agent-army.content-autonomy';
const PUBLISHER_PROVIDER = 'agent-army.publisher-gateway';
const CONTENT_VERSION_SCHEMA = M5_SCHEMA_IDS.CONTENT_VERSION;
const MACHINE_REVIEW_SCHEMA = M5_SCHEMA_IDS.MACHINE_REVIEW;
const PUBLISH_RECEIPT_SCHEMA = M5_SCHEMA_IDS.PUBLISH_RECEIPT;
const PLATFORMS = new Set(M5_PLATFORMS);
const REQUIRED_REVIEW_CHECKS = Object.freeze([
  'facts',
  'privacy',
  'rights',
  'media',
  'claims',
  'grantScope',
  'duplicate',
]);
const FORBIDDEN_CALLER_FIELDS = new Set([
  'campaignId',
  'campaignCaseId',
  'campaignGrant',
  'caseId',
  'platform',
  'scheduledDate',
  'contentVersion',
  'contentVersionId',
  'contentChecksum',
  'checksum',
  'mediaPath',
  'title',
  'body',
  'tags',
  'reviewReport',
  'idempotencyKey',
  'receiptId',
  'accountRef',
]);

export class PaperclipPublisherController {
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
    assertNoPublishSelectionParameters(payload);
    const runId = String(payload?.runId || '').trim();
    const agentId = String(payload?.agentId || '').trim();
    const issueId = String(payload?.context?.taskId || '').trim();
    if (!runId || !agentId || !issueId) {
      throw new PaperclipPublisherControllerError('M5 发布 HTTP heartbeat 缺少运行、控制器或任务标识。');
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
          routineKey:'m5-publish',
          systemRole:SYSTEM_ROLE,
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
    const { issue } = await this.governance.verifySystemAssignment({
      issueId,
      runId,
      paperclipAgentId:agentId,
      systemRole:SYSTEM_ROLE,
    });
    if (!['in_progress', 'in_review', 'done'].includes(issue.status)) {
      throw new PaperclipPublisherControllerError('发布任务必须处于 in_progress、in_review 或已完成的幂等重放状态。');
    }
    if (!String(issue.description || '').includes(ROUTINE_MARKER)) {
      throw new PaperclipPublisherControllerError('HTTP 控制器只接受 M5 发布 Routine 的固定任务。');
    }

    const caseId = issueCaseId(issue);
    await this.governance.assertCaseIssueLink(caseId, issueId);
    await consumeM5SystemControllerPlanRevision({
      governance:this.governance,
      pipelineCaseId:caseId,
      runId,
      routineKey:'m5-publish',
      systemRole:SYSTEM_ROLE,
    });
    const targetCase = normalizeCase(await this.governance.getPipelineCase(caseId));
    if (targetCase.id !== caseId || targetCase.stageKey !== 'publish') {
      throw new PaperclipPublisherControllerError('当前 Case 不在 publish 阶段，拒绝执行发布。');
    }
    const ancestry = await this.resolveCampaign(targetCase);
    const executionTime = this.now();
    const grant = activeCampaignGrant(ancestry.campaignCase, executionTime);
    const outputs = await this.governance.getPipelineCaseOutputs(caseId);
    const derived = trustedPublishInputs({
      outputs,
      targetCase,
      campaignCase:ancestry.campaignCase,
      grant,
      executionTime,
    });

    const existing = trustedPublishReceipts(outputs);
    if (existing.length > 1) {
      throw new PaperclipPublisherControllerError('当前 Case 存在多个可信 PublishReceipt，必须人工核对。');
    }
    if (existing.length === 1) {
      assertReceiptMatches(existing[0], derived);
      if (issue.status !== 'done') {
        await this.governance.completePublisherIssue(issueId, {
          runId,
          comment:'已核验当前 Case 的唯一 PublishReceipt；幂等重放未再次发布或写入 Work Product。',
        });
      }
      return {
        accepted:true,
        issueId,
        replayed:true,
        receipt:existing[0],
      };
    }

    try {
      const result = await this.publisher.publish(derived.request, {
        action:'publisher.publish',
        runId,
        issueId,
        campaignId:ancestry.campaignCase.id,
        agentId,
        authorizationId:`paperclip:${runId}:${issueId}:publisher.publish`,
      });
      const receipt = validPublisherReceipt(result?.receipt, derived);
      await this.governance.createIssueWorkProduct(issueId, {
      type:'artifact',
      provider:PUBLISHER_PROVIDER,
      externalId:receipt.receiptId,
      title:`M5 发布凭证 / ${receipt.platform}`,
      status:'active',
      reviewState:'none',
      isPrimary:true,
      healthStatus:'healthy',
      summary:`${receipt.platform} 已返回可核验内容引用。`,
      metadata:{
        schemaVersion:PUBLISH_RECEIPT_SCHEMA,
        kind:'PublishReceipt',
        receipt,
      },
      createdByRunId:runId,
      }, { runId });

      const afterWrite = await this.governance.getPipelineCaseOutputs(caseId);
      const persisted = trustedPublishReceipts(afterWrite);
      if (persisted.length !== 1) {
        throw new PaperclipPublisherControllerError(
          `PublishReceipt 写回后必须唯一且可回读，实际为 ${persisted.length} 个。`,
        );
      }
      assertReceiptMatches(persisted[0], derived);
      await this.governance.completePublisherIssue(issueId, {
        runId,
        comment:'Publisher Gateway 已返回可核验内容引用，唯一 PublishReceipt 已写回并回读确认。',
      });
      return {
        accepted:true,
        issueId,
        replayed:result.replayed === true,
        receipt:persisted[0],
      };
    } catch (error) {
      throw markM5SystemControllerFailure(error);
    }
  }

  assertDependencies() {
    const required = [
      'verifySystemAssignment',
      'assertCaseIssueLink',
      'getPipelineCase',
      'getPipelineCaseOutputs',
      'createIssueWorkProduct',
      'completePublisherIssue',
    ];
    if (required.some((method) => typeof this.governance?.[method] !== 'function')) {
      throw new PaperclipPublisherControllerError('M5 发布控制器缺少 Paperclip Case/Work Product 适配。');
    }
    if (typeof this.publisher?.publish !== 'function') {
      throw new PaperclipPublisherControllerError('M5 Publisher 未启用；真实发布保持关闭。');
    }
  }

  async resolveCampaign(targetCase) {
    if (!validUuid(targetCase.parentCaseId)) {
      throw new PaperclipPublisherControllerError('发布 Case 缺少有效的日期父 Case。');
    }
    const dayCase = normalizeCase(await this.governance.getPipelineCase(targetCase.parentCaseId));
    if (!validUuid(dayCase.parentCaseId)) {
      throw new PaperclipPublisherControllerError('日期 Case 缺少有效的活动父 Case。');
    }
    const campaignCase = normalizeCase(await this.governance.getPipelineCase(dayCase.parentCaseId));
    if (
      !targetCase.parentCaseId
      || !dayCase.id
      || dayCase.id !== targetCase.parentCaseId
      || !campaignCase.id
      || campaignCase.id !== dayCase.parentCaseId
      || campaignCase.parentCaseId
      || campaignCase.stageKey !== 'campaign_active'
      || campaignCase.pipelineId !== targetCase.pipelineId
      || dayCase.pipelineId !== targetCase.pipelineId
    ) {
      throw new PaperclipPublisherControllerError('发布 Case 不属于有效的活动父 Case 层级。');
    }
    return { dayCase, campaignCase };
  }
}

export class PaperclipPublisherControllerError extends Error {}

export function trustedPublishInputs({
  outputs,
  targetCase,
  campaignCase,
  grant,
  executionTime,
}) {
  const contentItems = trustedArtifacts(outputs, CONTENT_PROVIDER, CONTENT_VERSION_SCHEMA, 'ContentVersion');
  const reviewItems = trustedArtifacts(outputs, CONTENT_PROVIDER, MACHINE_REVIEW_SCHEMA, 'MachineReview');
  if (contentItems.length !== 1 || reviewItems.length !== 1) {
    throw new PaperclipPublisherControllerError(
      `当前 Case 必须各有一个可信 ContentVersion 和 MachineReview，实际为 ${contentItems.length}/${reviewItems.length}。`,
    );
  }
  const contentVersion = contentItems[0].metadata.contentVersion;
  const reviewReport = reviewItems[0].metadata.reviewReport;
  const platform = String(targetCase.fields?.platform || '').trim();
  const scheduledDate = String(targetCase.fields?.scheduledDate || '').trim();
  if (
    !PLATFORMS.has(platform)
    || !validCalendarDate(scheduledDate)
  ) {
    throw new PaperclipPublisherControllerError('发布 Case 缺少可信平台或发布日期。');
  }
  const executionDate = calendarDateInShanghai(executionTime);
  if (scheduledDate !== executionDate) {
    throw immediatePublishDateMismatch(scheduledDate, executionDate);
  }
  if (
    !contentVersion
    || contentVersion.platform !== platform
    || !validOpaqueId(contentVersion.contentVersionId)
    || !/^sha256:[0-9a-f]{64}$/i.test(String(contentVersion.checksum || ''))
    || !validRelativePath(contentVersion.mediaPath)
    || !String(contentVersion.title || '').trim()
    || !String(contentVersion.body || '').trim()
    || !Array.isArray(contentVersion.tags)
  ) {
    throw new PaperclipPublisherControllerError('ContentVersion 与当前平台 Case 不一致或缺少发布产物。');
  }
  if (
    reviewReport?.status !== 'passed'
    || REQUIRED_REVIEW_CHECKS.some((check) => reviewReport?.checks?.[check] !== true)
    || reviewReport.contentVersionId !== contentVersion.contentVersionId
  ) {
    throw new PaperclipPublisherControllerError('机器审核未完整通过或审核版本不匹配。');
  }
  if (
    !grant.platforms?.includes(platform)
    || !String(grant.accountRefs?.[platform] || '').trim()
  ) {
    throw new PaperclipPublisherControllerError('活动授权没有覆盖当前平台账号。');
  }
  const request = {
    campaignId:campaignCase.id,
    grant:structuredClone(grant),
    platform,
    contentVersionId:contentVersion.contentVersionId,
    contentChecksum:contentVersion.checksum,
    scheduledDate,
    mediaPath:contentVersion.mediaPath,
    title:String(contentVersion.title).trim(),
    body:String(contentVersion.body).trim(),
    tags:structuredClone(contentVersion.tags),
    reviewReport:structuredClone(reviewReport),
    idempotencyKey:[
      campaignCase.id,
      platform,
      contentVersion.contentVersionId,
      scheduledDate,
    ].join(':'),
  };
  return { request, contentVersion, reviewReport };
}

export function trustedPublishReceipts(outputs) {
  return outputItems(outputs)
    .filter((item) =>
      item.kind === 'work_product'
      && item.type === 'artifact'
      && item.provider === PUBLISHER_PROVIDER
      && item.sourceTrust == null
      && ['active', 'approved'].includes(item.status)
      && item.healthStatus === 'healthy'
      && item.metadata?.schemaVersion === PUBLISH_RECEIPT_SCHEMA
      && item.metadata?.kind === 'PublishReceipt',
    )
    .map((item) => validReceiptStructure(item.metadata.receipt));
}

function trustedArtifacts(outputs, provider, schemaVersion, kind) {
  return outputItems(outputs).filter((item) =>
    item.kind === 'work_product'
    && item.type === 'artifact'
    && item.provider === provider
    && item.sourceTrust == null
    && ['active', 'approved'].includes(item.status)
    && item.healthStatus === 'healthy'
    && item.metadata?.schemaVersion === schemaVersion
    && item.metadata?.kind === kind,
  );
}

function activeCampaignGrant(campaignCase, nowValue) {
  const grant = campaignCase.fields?.campaignGrant;
  const now = validDate(nowValue);
  const startsAt = Date.parse(grant?.startsAt);
  const expiresAt = Date.parse(grant?.expiresAt);
  if (
    !grant
    || grant.status !== 'active'
    || !Number.isFinite(startsAt)
    || !Number.isFinite(expiresAt)
    || startsAt > now.getTime()
    || expiresAt <= now.getTime()
  ) {
    throw new PaperclipPublisherControllerError('活动父 Case 缺少当前有效的 active CampaignGrant。');
  }
  return structuredClone(grant);
}

function validPublisherReceipt(receipt, derived) {
  const valid = validReceiptStructure(receipt);
  assertReceiptMatches(valid, derived);
  return valid;
}

function validReceiptStructure(receipt) {
  if (
    !receipt
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(receipt.receiptId || ''))
    || !String(receipt.externalContentId || '').trim()
    || !String(receipt.evidence || '').trim()
    || !Number.isFinite(Date.parse(receipt.publishedAt))
  ) {
    throw new PaperclipPublisherControllerError('Publisher Gateway 没有返回结构完整的 PublishReceipt。');
  }
  return structuredClone(receipt);
}

function assertReceiptMatches(receipt, derived) {
  const request = derived.request;
  if (
    receipt.campaignId !== request.campaignId
    || receipt.platform !== request.platform
    || receipt.contentVersionId !== request.contentVersionId
    || receipt.contentChecksum !== request.contentChecksum
    || receipt.scheduledDate !== request.scheduledDate
    || receipt.idempotencyKey !== request.idempotencyKey
  ) {
    throw new PaperclipPublisherControllerError('PublishReceipt 与当前 Case 派生的发布上下文不一致。');
  }
}

function normalizeCase(value) {
  const item = value?.case ?? value;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new PaperclipPublisherControllerError('Paperclip Case 结构无效。');
  }
  return {
    ...item,
    stageKey:item.stageKey || value?.stage?.key || null,
    pipelineId:item.pipelineId || value?.pipeline?.id || null,
  };
}

function issueCaseId(issue) {
  const value = String(issue?.description || '').match(
    /当前 Case 为 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i,
  )?.[1];
  if (!value) throw new PaperclipPublisherControllerError('M5 发布任务缺少固定 Case 绑定。');
  return value;
}

function outputItems(outputs) {
  return Array.isArray(outputs) ? outputs : Array.isArray(outputs?.items) ? outputs.items : [];
}

function validRelativePath(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(text)
    && !text.startsWith('/')
    && text.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validCalendarDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function immediatePublishDateMismatch(scheduledDate, executionDate) {
  const error = new PaperclipPublisherControllerError(
    `当前连接器只允许即时发布；平台 Case 日期 ${scheduledDate} 与上海执行日 ${executionDate} 不一致。`,
  );
  error.code = 'publisher_scheduled_date_mismatch';
  error.recoveryAction = Object.freeze({
    action:IMMEDIATE_PUBLISH_RECOVERY_ACTION,
    instruction:'将平台 Case 重排到当前上海日期后重新执行；禁止直接补发历史 Case 或提前发布未来 Case。',
    scheduledDate,
    executionDate,
    timeZone:'Asia/Shanghai',
  });
  return error;
}

function validOpaqueId(value) {
  return /^[a-z0-9][a-z0-9_.:-]{2,127}$/i.test(String(value || ''));
}

function validUuid(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PaperclipPublisherControllerError('M5 发布控制器时钟无效。');
  }
  return date;
}

function assertNoPublishSelectionParameters(payload) {
  const queue = [payload];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_CALLER_FIELDS.has(key)) {
        throw new PaperclipPublisherControllerError(`M5 发布 HTTP heartbeat 不接受调用方指定 ${key}。`);
      }
      if (child && typeof child === 'object') queue.push(child);
    }
  }
}
