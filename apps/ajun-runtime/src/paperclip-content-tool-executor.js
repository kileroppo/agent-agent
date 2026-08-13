import { assertContentAutonomyApprovalSnapshot } from './content-autonomy-plugin-snapshot.js';
import { assertM5BudgetCoverage } from './m5-budget-cost-contract.js';
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
const PAPERCLIP_RUN_JWT_MAX_TTL_SECONDS = 2 * 60 * 60;
const PAPERCLIP_RUN_JWT_CLOCK_SKEW_SECONDS = 60;
const PAPERCLIP_RUN_JWT_MAX_LENGTH = 12_288;
const adapterBudgetGates = new WeakMap();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FORBIDDEN_CALLER_IDENTITY = Object.freeze([
  'agentId',
  'runId',
  'companyId',
  'projectId',
  'runContext',
]);
const FORBIDDEN_CALLER_AUTHORIZATION = new Set([
  'accountref',
  'accountrefs',
  'allowedactions',
  'budget',
  'budgetcents',
  'campaign',
  'campaigncase',
  'campaigncaseid',
  'campaigngrant',
  'campaignid',
  'canonicalgrant',
  'caseid',
  'companyid',
  'dailypublishlimitperplatform',
  'grant',
  'heartbeatrunid',
  'platform',
  'platforms',
  'projectid',
  'prohibitedactions',
  'runcontext',
  'runid',
  'scheduleddate',
  'totalpublishlimit',
]);
const FORBIDDEN_TOP_LEVEL_AUTHORIZATION = new Set([
  'accountRef',
  'accountRefs',
  'allowedActions',
  'budget',
  'budgetCents',
  'campaignCase',
  'campaignGrant',
  'campaignId',
  'canonicalGrant',
  'companyId',
  'dailyPublishLimitPerPlatform',
  'grant',
  'heartbeatRunId',
  'platforms',
  'projectId',
  'prohibitedActions',
  'runContext',
  'runId',
  'totalPublishLimit',
]);

export class PaperclipContentToolExecutor {
  constructor({ adapter, budgetTicketAuthority = null, onRunEvent = null, now = () => new Date() } = {}) {
    if (!adapter?.companyId || typeof adapter.request !== 'function') {
      throw new PaperclipContentToolExecutorError('内容插件执行器缺少 Paperclip 适配器。');
    }
    this.adapter = adapter;
    this.budgetTicketAuthority = budgetTicketAuthority;
    this.onRunEvent = typeof onRunEvent === 'function' ? onRunEvent : null;
    this.now = now;
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
    rejectCallerAuthorization(input);
    const campaignCaseId = uuid(input.campaignCaseId, '活动父 Case 标识无效。');
    const targetCaseId = uuid(input.caseId, '内容执行必须指定活动内的子 Case。');
    if (campaignCaseId === targetCaseId) {
      throw new PaperclipContentToolExecutorError('内容工具只能在活动子 Case 的真实岗位运行中执行。');
    }
    const campaignCase = normalizeCaseDetail(await this.adapter.request(
      'GET',
      `/api/cases/${encodeURIComponent(campaignCaseId)}`,
    ));
    if (!campaignCase || campaignCase.id !== campaignCaseId || campaignCase.parentCaseId) {
      throw new PaperclipContentToolExecutorError('活动父 Case 与当前授权上下文不一致。');
    }
    const targetCase = normalizeCaseDetail(await this.adapter.request(
      'GET',
      `/api/cases/${encodeURIComponent(targetCaseId)}`,
    ));
    await this.assertDescendant(targetCase, campaignCaseId);
    assertSamePipelineProject(campaignCase, targetCase);

    const runContext = await this.resolveRunContext(targetCase);
    if (authentication.requireRunAuthentication === true) {
      await this.authenticateRunContext(runContext, authentication.paperclipApiKey);
    }
    const campaignGrant = canonicalCampaignGrant(campaignCase);
    try {
      await assertContentAutonomyApprovalSnapshot({
        adapter:this.adapter,
        companyId:runContext.companyId,
        approved:campaignGrant.pluginApproval,
      });
    } catch (error) {
      throw new PaperclipContentToolExecutorError(
        String(error?.message || '内容插件批准快照核验失败。'),
        'content_plugin_approval_drift',
      );
    }
    return {
      campaignCase,
      campaignCaseId,
      campaignGrant,
      targetCase,
      targetCaseId,
      runContext,
    };
  }

  async authenticateRunContext(runContext, apiKey) {
    if (!String(apiKey || '').trim() || typeof this.adapter.authenticateRun !== 'function') {
      throw new PaperclipContentToolExecutorError(
        '工具执行缺少当前 Paperclip Run 的短期身份凭证。',
        'paperclip_run_auth_required',
      );
    }
    const token = String(apiKey).trim();
    assertPaperclipRunJwtClaims(token, runContext);
    let actor;
    try {
      actor = await this.adapter.authenticateRun({
        apiKey:token,
        runId:runContext.runId,
      });
    } catch {
      throw new PaperclipContentToolExecutorError(
        'Paperclip Run 身份凭证无效、已过期或与当前 Run 不匹配。',
        'paperclip_run_auth_invalid',
      );
    }
    if (actor?.id !== runContext.agentId || actor?.companyId !== runContext.companyId) {
      throw new PaperclipContentToolExecutorError(
        'Paperclip Run 身份与当前 Case 执行岗位不一致。',
        'paperclip_run_auth_mismatch',
      );
    }
  }

  async assertDescendant(targetCase, campaignCaseId) {
    let current = targetCase;
    const visited = new Set();
    for (let depth = 0; depth < 32; depth += 1) {
      if (!current?.id || visited.has(current.id)) break;
      visited.add(current.id);
      if (current.parentCaseId === campaignCaseId) return;
      if (!current.parentCaseId) break;
      current = normalizeCaseDetail(await this.adapter.request(
        'GET',
        `/api/cases/${encodeURIComponent(uuid(current.parentCaseId, '活动子 Case 的父级标识无效。'))}`,
      ));
    }
    throw new PaperclipContentToolExecutorError('目标 Case 不属于当前活动，禁止借活动授权调用其他任务的工具。');
  }

  async resolveRunContext(targetCase) {
    const activeWork = targetCase?.activeWork;
    const issueId = uuid(activeWork?.issueId, '目标 Case 当前没有可信的 Paperclip 工作 Issue。');
    const agentId = uuid(activeWork?.agentId, '目标 Case 当前没有可信的 Paperclip 执行岗位。');
    const projectId = uuid(targetCase?.pipeline?.projectId, '目标 Case 缺少 Paperclip 项目范围。');
    const liveRunsPayload = await this.adapter.request(
      'GET',
      `/api/issues/${encodeURIComponent(issueId)}/live-runs`,
    );
    const liveRuns = asList(liveRunsPayload).filter((item) =>
      item?.status === 'running' && item.agentId === agentId && UUID.test(String(item.id || '')),
    );
    if (liveRuns.length !== 1) {
      throw new PaperclipContentToolExecutorError('目标 Case 必须恰好存在一个匹配岗位的运行中 Paperclip Run。');
    }
    const runId = liveRuns[0].id;
    const run = await this.adapter.request(
      'GET',
      `/api/heartbeat-runs/${encodeURIComponent(runId)}`,
    );
    if (
      run?.id !== runId
      || run?.agentId !== agentId
      || run?.companyId !== this.adapter.companyId
      || run?.status !== 'running'
    ) {
      throw new PaperclipContentToolExecutorError('Paperclip Run 与活动子 Case 的当前执行身份不一致。');
    }
    return {
      companyId:uuid(this.adapter.companyId, 'Paperclip 公司标识无效。'),
      projectId,
      agentId,
      runId,
    };
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

export class PaperclipContentToolExecutorError extends Error {
  constructor(message, code = 'paperclip_content_tool_denied') {
    super(message);
    this.code = code;
    this.isM5ToolExecutionError = true;
  }
}

function rejectCallerAuthorization(input) {
  if (FORBIDDEN_CALLER_IDENTITY.some((key) => Object.hasOwn(input, key))) {
    throw new PaperclipContentToolExecutorError(
      '执行身份只能从 Paperclip 当前活动子 Case 派生，禁止提交 agentId、runId、companyId、projectId 或 runContext。',
    );
  }
  const forbiddenTopLevel = [...FORBIDDEN_TOP_LEVEL_AUTHORIZATION]
    .find((key) => Object.hasOwn(input, key));
  if (forbiddenTopLevel) {
    throw new PaperclipContentToolExecutorError(
      `调用方不得提交权限字段 ${forbiddenTopLevel}；活动授权、账号、预算和限额只能从 Paperclip 派生。`,
    );
  }
  for (const key of ['parameters', 'reviewReport', 'tags', 'title', 'body']) {
    const nested = findForbiddenAuthorization(input[key], key);
    if (nested) {
      throw new PaperclipContentToolExecutorError(
        `工具业务参数不得携带权限字段 ${nested}；该字段必须由 Paperclip Case/Run 覆盖。`,
      );
    }
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

function canonicalCampaignGrant(campaignCase) {
  const grant = campaignCase?.fields?.campaignGrant;
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new PaperclipContentToolExecutorError('活动父 Case 缺少可信 CampaignGrant。');
  }
  return structuredClone(grant);
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

function findForbiddenAuthorization(value, path = 'parameters', seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return `${path}.__cycle__`;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
    const nextPath = `${path}.${key}`;
    if (FORBIDDEN_CALLER_AUTHORIZATION.has(normalized)) return nextPath;
    const found = findForbiddenAuthorization(nested, nextPath, seen);
    if (found) return found;
  }
  return null;
}

function normalizeCaseDetail(value) {
  const raw = value?.case ?? value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    ...raw,
    pipeline:value?.pipeline ?? raw.pipeline ?? null,
    stage:value?.stage ?? raw.stage ?? null,
    stageKey:raw.stageKey ?? value?.stage?.key ?? raw.stage?.key ?? null,
    activeWork:value?.activeWork ?? raw.activeWork ?? null,
  };
}

function assertSamePipelineProject(campaignCase, targetCase) {
  if (
    !campaignCase?.pipelineId
    || targetCase?.pipelineId !== campaignCase.pipelineId
    || targetCase?.pipeline?.id !== campaignCase?.pipeline?.id
    || targetCase?.pipeline?.projectId !== campaignCase?.pipeline?.projectId
  ) {
    throw new PaperclipContentToolExecutorError('目标 Case 与活动父 Case 不属于同一 Paperclip Pipeline/Project。');
  }
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

function assertPaperclipRunJwtClaims(token, runContext) {
  let header;
  let claims;
  try {
    if (!token || token.length > PAPERCLIP_RUN_JWT_MAX_LENGTH) throw new Error('size');
    const segments = token.split('.');
    if (
      segments.length !== 3
      || segments.some((segment) => !segment || !/^[A-Za-z0-9_-]+$/.test(segment))
      || segments[0].length > 4_096
      || segments[1].length > 8_192
    ) throw new Error('shape');
    header = decodeJwtObject(segments[0]);
    claims = decodeJwtObject(segments[1]);
  } catch {
    throw invalidPaperclipRunJwt();
  }

  const now = Math.floor(Date.now() / 1000);
  const issuedAt = claims?.iat;
  const expiresAt = claims?.exp;
  const valid = header?.alg === 'HS256'
    && header?.typ === 'JWT'
    && claims?.iss === 'paperclip'
    && claims?.aud === 'paperclip-api'
    && typeof claims?.adapter_type === 'string'
    && claims.adapter_type.trim().length > 0
    && claims?.sub === runContext.agentId
    && claims?.company_id === runContext.companyId
    && claims?.run_id === runContext.runId
    && Number.isInteger(issuedAt)
    && Number.isInteger(expiresAt)
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= PAPERCLIP_RUN_JWT_MAX_TTL_SECONDS
    && issuedAt <= now + PAPERCLIP_RUN_JWT_CLOCK_SKEW_SECONDS
    && expiresAt > now;
  if (!valid) throw invalidPaperclipRunJwt();
}

function decodeJwtObject(segment) {
  const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
  return value;
}

function invalidPaperclipRunJwt() {
  return new PaperclipContentToolExecutorError(
    'Paperclip Run 身份凭证必须是当前 Run 的短期 JWT；长期 API Key、过期或跨 Run 凭证均被拒绝。',
    'paperclip_run_auth_invalid',
  );
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
