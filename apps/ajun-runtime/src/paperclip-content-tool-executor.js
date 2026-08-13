import { assertM5BudgetCoverage } from './m5-budget-cost-contract.js';
import {
  PaperclipContentExecutionContextResolver,
  PaperclipContentToolExecutorError,
} from './paperclip-content-execution-context.js';
import {
  externalCapabilityEvidence,
  runExternalCapabilityWithEvents,
} from './adapters/external-capability-run-event-bridge.ts';

const CONTENT_PLUGIN_ID = 'agent-army.content-autonomy';
const CONTENT_TOOL_PREFIX = `${CONTENT_PLUGIN_ID}:`;
const COST_CLAIM_ACTION = 'cost-event-claim';
const COST_CONFIRM_ACTION = 'cost-event-confirm';
const INTERNAL_COST_TOOLS = new Set([
  `${CONTENT_TOOL_PREFIX}${COST_CLAIM_ACTION}`,
  `${CONTENT_TOOL_PREFIX}${COST_CONFIRM_ACTION}`,
]);
const PAID_CONTENT_TOOLS = new Set([
  `${CONTENT_TOOL_PREFIX}stepfun-vision`,
  `${CONTENT_TOOL_PREFIX}stepfun-image-generate`,
  `${CONTENT_TOOL_PREFIX}stepfun-image-edit`,
  `${CONTENT_TOOL_PREFIX}stepfun-tts`,
]);
const VISION_MAX_INPUT_TOKENS = 128_000;
const VISION_MAX_OUTPUT_TOKENS = 4_096;
const adapterBudgetGates = new WeakMap();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export { PaperclipContentToolExecutorError };

export class PaperclipContentToolExecutor {
  constructor({ adapter, budgetTicketAuthority = null, onRunEvent = null, now = () => new Date() } = {}) {
    if (!adapter?.companyId || typeof adapter.request !== 'function') {
      throw new PaperclipContentToolExecutorError('内容插件执行器缺少 Paperclip 适配器。');
    }
    this.adapter = adapter;
    this.budgetTicketAuthority = budgetTicketAuthority;
    this.onRunEvent = typeof onRunEvent === 'function' ? onRunEvent : null;
    this.now = now;
    this.contextResolver = new PaperclipContentExecutionContextResolver({ adapter });
  }

  async execute(input = {}, authentication = {}) {
    const context = await this.resolveContext(input, authentication);
    const toolId = contentToolId(input.toolId);
    const parameters = canonicalContentParameters(
      toolId,
      input.parameters,
      context,
    );
    const executeTool = async () => {
      const routed = await this.dispatch(toolId, parameters, context.runContext);
      return this.resolveExecutionResult({
        toolId,
        routed,
        runContext:context.runContext,
      });
    };
    if (!PAID_CONTENT_TOOLS.has(toolId)) return executeTool();
    return runExternalCapabilityWithEvents({
      onRunEvent:this.onRunEvent,
      now:this.now,
      context:{
        taskId:context.targetCaseId,
        workflowId:context.campaignCaseId,
        stepId:String(context.targetCase?.stageKey || toolId.slice(CONTENT_TOOL_PREFIX.length)),
        agentId:context.runContext.agentId,
        capabilityId:paidCapabilityId(toolId),
        routeId:'paperclip-content-plugin-stepfun',
        provider:'stepfun',
      },
      execute:() => this.withBudgetGate(context.runContext, async () => {
        const maximumCostCents = await this.maximumPaidCallCost(toolId, parameters);
        const scopes = await this.assertPaperclipBudget(context.runContext, maximumCostCents);
        if (!this.budgetTicketAuthority?.sign) {
          throw new PaperclipContentToolExecutorError(
            'A君预算票据签发器不可用，Provider 未调用。',
            'paperclip_budget_ticket_unavailable',
          );
        }
        const budgetTicket = this.budgetTicketAuthority.sign({
          run:context.runContext,
          actionId:parameters.actionId,
          operation:paidOperation(toolId),
          maximumCostCents,
          parameters,
          scopes,
        });
        const routed = await this.dispatch(
          toolId,
          { ...parameters, budgetTicket },
          context.runContext,
        );
        return this.resolveExecutionResult({
          toolId,
          routed,
          runContext:context.runContext,
        });
      }),
      evidence:externalCapabilityEvidence,
      hasRegisteredFallback:false,
    });
  }

  async withBudgetGate(runContext, operation) {
    const gates = budgetGatesFor(this.adapter);
    const key = `${runContext.companyId}:${runContext.projectId}`;
    const previous = gates.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    gates.set(key, previous.catch(() => {}).then(() => current));
    await previous.catch(() => {});
    const blocked = this.budgetGateBlocks?.get(key);
    if (blocked) {
      release();
      throw markAmbiguousPaidCall(new PaperclipContentToolExecutorError(
        `Paperclip 预算门闩因上一笔付费调用状态不确定而关闭（${blocked}）；核对费用账本后再恢复。`,
        'paperclip_budget_gate_blocked',
      ));
    }
    try {
      return await operation();
    } catch (error) {
      if (ambiguousPaidCall(error)) {
        if (!this.budgetGateBlocks) this.budgetGateBlocks = new Map();
        this.budgetGateBlocks.set(key, String(error.code || 'paid_call_ambiguous'));
        markAmbiguousPaidCall(error);
      }
      throw error;
    } finally {
      release();
    }
  }

  async maximumPaidCallCost(toolId, parameters) {
    const plugins = asList(await this.adapter.request('GET', '/api/plugins').catch(() => []));
    const installed = plugins.find((item) =>
      item?.pluginKey === CONTENT_PLUGIN_ID || item?.id === CONTENT_PLUGIN_ID,
    );
    const pluginId = installed?.id || CONTENT_PLUGIN_ID;
    const record = await this.adapter.request(
      'GET',
      `/api/plugins/${encodeURIComponent(pluginId)}/config?companyId=${encodeURIComponent(this.adapter.companyId)}`,
    ).catch(() => null);
    const rates = record?.configJson?.costRatesCents;
    if (!validRates(rates)) {
      throw new PaperclipContentToolExecutorError(
        '无法从 Paperclip 插件配置读取有效 StepFun 费率，付费调用未执行。',
        'paperclip_cost_rate_unavailable',
      );
    }
    if (
      toolId.endsWith(':stepfun-image-generate')
      || toolId.endsWith(':stepfun-image-edit')
    ) return positiveCeiling(rates.imagePerGeneration);
    if (toolId.endsWith(':stepfun-tts')) {
      return positiveCeiling(
        String(parameters.text || '').length * Number(rates.ttsPerThousandCharacters) / 1000,
      );
    }
    return positiveCeiling(
      VISION_MAX_INPUT_TOKENS * Number(rates.visionInputPerMillionTokens) / 1_000_000
      + VISION_MAX_OUTPUT_TOKENS * Number(rates.visionOutputPerMillionTokens) / 1_000_000,
    );
  }

  async assertPaperclipBudget(runContext, maximumCostCents) {
    const overview = await this.adapter.request(
      'GET',
      `/api/companies/${encodeURIComponent(runContext.companyId)}/budgets/overview`,
    ).catch(() => null);
    try {
      return assertM5BudgetCoverage({
        overview,
        companyId:runContext.companyId,
        agentId:runContext.agentId,
        projectId:runContext.projectId,
        maximumCostCents,
      });
    } catch (error) {
      throw new PaperclipContentToolExecutorError(
        `${String(error?.message || 'Paperclip 公司、岗位或项目预算不可用')} Provider 未调用。`,
        'paperclip_budget_insufficient',
      );
    }
  }

  async resolveContext(input = {}, authentication = {}) {
    return this.contextResolver.resolve(input, authentication);
  }

  async authenticateRunContext(runContext, apiKey) {
    return this.contextResolver.authenticateRunContext(runContext, apiKey);
  }

  async assertDescendant(targetCase, campaignCaseId) {
    return this.contextResolver.assertDescendant(targetCase, campaignCaseId);
  }

  async resolveRunContext(targetCase) {
    return this.contextResolver.resolveRunContext(targetCase);
  }

  async dispatch(tool, parameters, runContext) {
    let routed;
    try {
      routed = await this.adapter.request('POST', '/api/plugins/tools/execute', {
        tool,
        parameters,
        runContext,
      });
    } catch (error) {
      throw new PaperclipContentToolExecutorError(
        `Paperclip 内容插件执行不可用：${safeText(error?.message, 300)}`,
        'content_plugin_unavailable',
      );
    }
    if (
      routed?.pluginId !== CONTENT_PLUGIN_ID
      || routed?.toolName !== tool.slice(CONTENT_TOOL_PREFIX.length)
      || !routed.result
    ) {
      throw new PaperclipContentToolExecutorError('Paperclip 返回了不匹配的内容插件工具回执。');
    }
    return routed;
  }

  async resolveExecutionResult({ toolId, routed, runContext }) {
    const result = routed.result;
    const costStatus = result?.data?.costCommit?.status;
    if (result.error && costStatus === 'pending_core_cost_event') {
      return this.commitPendingCost({ toolId, actionId:result.data.actionId, runContext });
    }
    if (result.error && costStatus === 'submitting_core_cost_event') {
      throw new PaperclipContentToolExecutorError(
        '费用事件已经领取提交租约但尚未确认；为避免重复计费，禁止自动重试，请核对 Paperclip 费用账本。',
        'cost_event_submission_ambiguous',
      );
    }
    if (result.error) {
      throw new PaperclipContentToolExecutorError(
        `内容插件执行失败：${safeText(result.error, 500)}`,
        'content_plugin_failed',
      );
    }
    return executionView(toolId, routed.pluginId, result);
  }

  async commitPendingCost({ toolId, actionId, runContext }) {
    const safeActionId = actionIdentifier(actionId);
    const claimed = await this.performCostAction(COST_CLAIM_ACTION, {
      actionId:safeActionId,
      runContext,
    });
    const costCommit = claimed?.data?.costCommit;
    if (costCommit?.status !== 'submitting_core_cost_event') {
      throw new PaperclipContentToolExecutorError('内容插件没有返回有效的费用提交租约。');
    }
    const submissionId = uuid(costCommit.submissionId, '内容插件返回的费用提交租约无效。');
    const costEvent = validatedCostEvent(costCommit.costEvent, runContext);

    let created;
    try {
      created = await this.adapter.request(
        'POST',
        `/api/companies/${encodeURIComponent(runContext.companyId)}/cost-events`,
        costEvent,
      );
    } catch (error) {
      throw new PaperclipContentToolExecutorError(
        `Paperclip 费用提交结果未确认；提交租约保持占用且不会自动重试：${safeText(error?.message, 300)}`,
        'cost_event_submission_ambiguous',
      );
    }
    const costEventId = uuid(created?.id, 'Paperclip 没有返回有效的费用事件 ID。');
    assertCreatedCostEvent(created, costEvent, runContext);

    const confirmed = await this.performCostAction(COST_CONFIRM_ACTION, {
      actionId:safeActionId,
      submissionId,
      costEventId,
      runContext,
    });
    if (confirmed?.data?.costCommit?.status !== 'confirmed') {
      throw new PaperclipContentToolExecutorError(
        'Paperclip 已登记费用，但插件确认状态未完成：确认回执无效。',
        'cost_event_confirmation_ambiguous',
      );
    }
    const view = executionView(toolId, CONTENT_PLUGIN_ID, confirmed);
    return {
      ...view,
      costCommit:{
        ...view.costCommit,
        costEvent:{ provider:costEvent.provider, costCents:costEvent.costCents },
      },
    };
  }

  async performCostAction(action, params) {
    let response;
    try {
      response = await this.adapter.request(
        'POST',
        `/api/plugins/${encodeURIComponent(CONTENT_PLUGIN_ID)}/actions/${encodeURIComponent(action)}`,
        {
          companyId:this.adapter.companyId,
          params,
        },
      );
    } catch (error) {
      throw new PaperclipContentToolExecutorError(
        `Paperclip 内容插件费用动作 ${action} 不可用：${safeText(error?.message, 300)}`,
        'cost_control_action_unavailable',
      );
    }
    if (!response?.data || typeof response.data !== 'object') {
      throw new PaperclipContentToolExecutorError(`Paperclip 内容插件费用动作 ${action} 回执无效。`);
    }
    return response.data;
  }
}

export class M5ToolExecutorRouter {
  constructor({ publisherExecutor = null, contentExecutor = null } = {}) {
    this.publisherExecutor = publisherExecutor;
    this.contentExecutor = contentExecutor;
  }

  async execute(input = {}, authentication = {}) {
    const toolId = String(input.toolId || '').trim();
    if (toolId.startsWith('publisher.')) {
      if (!this.publisherExecutor?.execute) {
        throw new PaperclipContentToolExecutorError('Publisher 工具当前没有启用。');
      }
      if (!this.contentExecutor?.resolveContext) {
        throw new PaperclipContentToolExecutorError('Publisher 缺少 Paperclip Case/Run 身份解析器。');
      }
      const context = await this.contentExecutor.resolveContext(input, authentication);
      const platform = trustedPlatform(context.targetCase);
      const scheduledDate = trustedScheduledDate(context.targetCase);
      const stageKey = context.targetCase?.stageKey || context.targetCase?.stage?.key || null;
      if (stageKey !== 'publish') {
        throw new PaperclipContentToolExecutorError('Publisher 只能由处于 publish 阶段的活动平台 Case 执行。');
      }
      if (input.platform != null && String(input.platform) !== platform) {
        throw new PaperclipContentToolExecutorError('调用方平台与 Paperclip 当前平台 Case 不一致，拒绝发布。');
      }
      if (input.scheduledDate != null && String(input.scheduledDate) !== scheduledDate) {
        throw new PaperclipContentToolExecutorError('调用方发布日期与 Paperclip 当前平台 Case 不一致，拒绝发布。');
      }
      return this.publisherExecutor.execute({
        ...input,
        platform,
        scheduledDate,
      }, context);
    }
    if (toolId.startsWith(CONTENT_TOOL_PREFIX)) {
      if (!this.contentExecutor?.execute) {
        throw new PaperclipContentToolExecutorError('Paperclip 内容插件执行器当前没有启用。');
      }
      return this.contentExecutor.execute(input, authentication);
    }
    throw new PaperclipContentToolExecutorError('该工具不在 M5 受控工具范围。');
  }
}

function contentToolId(value) {
  const id = String(value || '').trim();
  if (!id.startsWith(CONTENT_TOOL_PREFIX) || INTERNAL_COST_TOOLS.has(id)) {
    throw new PaperclipContentToolExecutorError('只能调用已安装的 Agent军团内容插件业务工具。');
  }
  const name = id.slice(CONTENT_TOOL_PREFIX.length);
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(name)) {
    throw new PaperclipContentToolExecutorError('内容插件工具名无效。');
  }
  return id;
}

function paidOperation(toolId) {
  if (toolId.endsWith(':stepfun-vision')) return 'vision';
  if (toolId.endsWith(':stepfun-image-generate')) return 'image_generate';
  if (toolId.endsWith(':stepfun-image-edit')) return 'image_edit';
  if (toolId.endsWith(':stepfun-tts')) return 'tts';
  throw new PaperclipContentToolExecutorError('该工具不是受支持的StepFun付费工具。');
}

function paidCapabilityId(toolId) {
  if (toolId.endsWith(':stepfun-vision')) return 'vision.analyze';
  if (toolId.endsWith(':stepfun-image-generate')) return 'image.generate';
  if (toolId.endsWith(':stepfun-image-edit')) return 'image.edit';
  if (toolId.endsWith(':stepfun-tts')) return 'tts.synthesize';
  throw new PaperclipContentToolExecutorError('该工具不是受支持的StepFun付费工具。');
}

function objectParameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaperclipContentToolExecutorError('内容插件工具参数必须是对象。');
  }
  return structuredClone(value);
}

function canonicalContentParameters(toolId, value, context) {
  const parameters = objectParameters(value);
  const toolName = toolId.slice(CONTENT_TOOL_PREFIX.length);
  if (toolName === 'campaign-preflight') {
    return { campaign:structuredClone(context.campaignGrant) };
  }
  if (toolName === 'publish-preflight') {
    const platform = trustedPlatform(context.targetCase);
    const scheduledDate = trustedScheduledDate(context.targetCase);
    const contentVersion = parameters.contentVersion;
    if (!contentVersion || typeof contentVersion !== 'object' || Array.isArray(contentVersion)) {
      throw new PaperclipContentToolExecutorError('发布预检缺少内容版本业务数据。');
    }
    return {
      campaignId:context.campaignCaseId,
      campaign:structuredClone(context.campaignGrant),
      contentVersion:{ ...structuredClone(contentVersion), platform },
      reviewReport:structuredClone(parameters.reviewReport),
      platform,
      scheduledDate,
    };
  }
  return parameters;
}

function trustedPlatform(targetCase) {
  const platform = String(targetCase?.fields?.platform || '').trim();
  if (!['douyin', 'xiaohongshu'].includes(platform)) {
    throw new PaperclipContentToolExecutorError('目标 Case 缺少可信的平台范围。');
  }
  return platform;
}

function trustedScheduledDate(targetCase) {
  const value = String(targetCase?.fields?.scheduledDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new PaperclipContentToolExecutorError('目标 Case 缺少可信的发布日期。');
  }
  return value;
}

function validatedCostEvent(value, runContext) {
  if (
    !value
    || typeof value !== 'object'
    || value.agentId !== runContext.agentId
    || value.projectId !== runContext.projectId
    || value.heartbeatRunId !== runContext.runId
    || value.provider !== 'stepfun'
    || value.biller !== 'stepfun'
    || value.billingType !== 'metered_api'
    || !String(value.billingCode || '').startsWith('m5:')
    || !String(value.model || '').trim()
    || !Number.isInteger(value.costCents)
    || value.costCents <= 0
    || Number.isNaN(Date.parse(value.occurredAt))
  ) {
    throw new PaperclipContentToolExecutorError('费用事件与当前 Paperclip 运行不一致，禁止记账。');
  }
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens']) {
    if (!Number.isInteger(value[field]) || value[field] < 0) {
      throw new PaperclipContentToolExecutorError('费用事件 Token 用量无效，禁止记账。');
    }
  }
  return {
    agentId:value.agentId,
    projectId:value.projectId,
    heartbeatRunId:value.heartbeatRunId,
    provider:value.provider,
    biller:value.biller,
    billingType:value.billingType,
    billingCode:value.billingCode,
    model:value.model,
    inputTokens:value.inputTokens,
    cachedInputTokens:value.cachedInputTokens,
    outputTokens:value.outputTokens,
    costCents:value.costCents,
    occurredAt:value.occurredAt,
  };
}

function assertCreatedCostEvent(created, expected, runContext) {
  if (
    created?.agentId !== runContext.agentId
    || created?.projectId !== runContext.projectId
    || created?.heartbeatRunId !== runContext.runId
    || created?.provider !== expected.provider
    || created?.model !== expected.model
    || created?.billingCode !== expected.billingCode
    || created?.costCents !== expected.costCents
  ) {
    throw new PaperclipContentToolExecutorError(
      'Paperclip 费用回执与提交内容不一致；插件保持未确认，禁止继续。',
      'cost_event_receipt_mismatch',
    );
  }
}

function executionView(toolId, pluginId, result) {
  const data = result?.data && typeof result.data === 'object' ? result.data : {};
  return {
    toolId,
    pluginId,
    content:safeText(result?.content, 1000) || null,
    ...data,
  };
}

function actionIdentifier(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(id)) {
    throw new PaperclipContentToolExecutorError('内容插件费用 actionId 无效。');
  }
  return id;
}

function uuid(value, message) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw new PaperclipContentToolExecutorError(message);
  return id;
}

function asList(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function budgetGatesFor(adapter) {
  let gates = adapterBudgetGates.get(adapter);
  if (!gates) {
    gates = new Map();
    adapterBudgetGates.set(adapter, gates);
  }
  return gates;
}

function validRates(value) {
  return value && typeof value === 'object' && [
    'visionInputPerMillionTokens',
    'visionOutputPerMillionTokens',
    'imagePerGeneration',
    'ttsPerThousandCharacters',
  ].every((key) => Number.isFinite(Number(value[key])) && Number(value[key]) > 0);
}

function positiveCeiling(value) {
  return Math.max(1, Math.ceil(Number(value)));
}

function ambiguousPaidCall(error) {
  return new Set([
    'content_plugin_unavailable',
    'content_plugin_failed',
    'cost_control_action_unavailable',
    'cost_event_submission_ambiguous',
    'cost_event_confirmation_ambiguous',
    'cost_event_receipt_mismatch',
  ]).has(error?.code);
}

function markAmbiguousPaidCall(error) {
  if (error && typeof error === 'object') {
    error.outcome = 'ambiguous';
    error.ambiguous = true;
    error.failureKind = 'ambiguous_result';
  }
  return error;
}

function safeText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
