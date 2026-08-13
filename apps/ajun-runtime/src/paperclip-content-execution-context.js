import { assertContentAutonomyApprovalSnapshot } from './content-autonomy-plugin-snapshot.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PAPERCLIP_RUN_JWT_MAX_TTL_SECONDS = 2 * 60 * 60;
const PAPERCLIP_RUN_JWT_CLOCK_SKEW_SECONDS = 60;
const PAPERCLIP_RUN_JWT_MAX_LENGTH = 12_288;
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

export class PaperclipContentExecutionContextResolver {
  constructor({ adapter } = {}) {
    this.adapter = adapter;
  }

  async resolve(input = {}, authentication = {}) {
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

function canonicalCampaignGrant(campaignCase) {
  const grant = campaignCase?.fields?.campaignGrant;
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new PaperclipContentToolExecutorError('活动父 Case 缺少可信 CampaignGrant。');
  }
  return structuredClone(grant);
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

function uuid(value, message) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw new PaperclipContentToolExecutorError(message);
  return id;
}

function asList(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
