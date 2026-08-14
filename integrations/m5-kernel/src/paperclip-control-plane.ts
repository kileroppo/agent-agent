import {
  buildCampaignCaseBatch,
  buildParallelWorkCaseBatch,
  ingestCampaignDraftCase,
  ingestCampaignExecutionCases,
  ingestParallelWorkCaseBatch,
} from '@agent-army/m5-content-pipeline';
import { PaperclipM5Client } from '@agent-army/paperclip-client';
import { assertM5ControlPlane, M5ControlPlane } from './control-plane.ts';
import { inspectContentAutonomyPluginReadiness } from './paperclip-content-autonomy-preflight.ts';
import { buildContentAutonomyApprovalSnapshot } from './paperclip-content-autonomy-snapshot.ts';

const CONTENT_PLUGIN_KEY = 'agent-army.content-autonomy';
const DAILY_MARKER = '[agent-army:m5:routine:m5-daily-campaign]';
type DynamicRecord = Record<string, any>;
type PaperclipEndpoint = DynamicRecord & {
  request(method: string, pathname: string): Promise<any>;
};

export class PaperclipM5ControlPlane extends M5ControlPlane {
  readonly endpoint: PaperclipEndpoint;
  readonly definition: DynamicRecord | undefined;
  readonly companyId: string;
  readonly client: any;
  readonly pluginSources: Map<string, DynamicRecord>;

  constructor({
    endpoint,
    definition,
    companyId = endpoint?.companyId,
  }: Readonly<{
    endpoint?: PaperclipEndpoint;
    definition?: DynamicRecord;
    companyId?: unknown;
  }> = {}) {
    super();
    if (!endpoint || typeof endpoint.request !== 'function') {
      throw new TypeError('PaperclipM5ControlPlane 需要 Paperclip endpoint。');
    }
    this.endpoint = endpoint;
    this.definition = definition;
    this.companyId = String(companyId || '').trim();
    this.client = new PaperclipM5Client({ endpoint });
    this.pluginSources = new Map();
  }

  findPipelineByKey(key: unknown) {
    return Promise.resolve(this.endpoint.findByMarker('pipeline', key)).then(normalizePipeline);
  }

  getPipeline(id: unknown) {
    return this.client.getPipeline(id).then(normalizePipeline);
  }

  async listPipelineCases(id: unknown) {
    return list(await this.client.listPipelineCases(id)).map(normalizeCase).filter(Boolean);
  }

  async getCase(id: unknown) {
    return normalizeCase(await this.client.getCase(id));
  }

  async getCaseChildren(id: unknown) {
    return normalizeCaseTree(await this.client.getCaseChildrenTree(id));
  }

  async listCaseEvents(id: unknown, options?: DynamicRecord) {
    return list(await this.client.listCaseEvents(id, options)).map(normalizeEvent);
  }

  async getCaseOutputs(id: unknown) {
    const value = await this.client.listCaseOutputs(id);
    if (!Array.isArray(value)) {
      throw new Error('Paperclip Case outputs 必须是官方裸数组。');
    }
    return value.map(normalizeWorkProduct).filter(Boolean);
  }

  listCaseOutputs(id: unknown) { return this.getCaseOutputs(id); }

  async listIssueRuns(id: unknown) {
    return list(await this.client.listIssueRuns(id)).map(normalizeRun).filter(Boolean);
  }

  async updateCampaignGrant(caseId: unknown, expectedVersion: unknown, campaignGrant: unknown) {
    const current = rawCase(await this.client.getCase(caseId));
    const updated = await this.client.updateCase(caseId, {
      expectedVersion,
      fields:{ ...(current?.fields || {}), campaignGrant },
    });
    return normalizeCase(updated);
  }

  async transitionCase(caseId: unknown, payload: DynamicRecord) {
    if (typeof this.endpoint.transitionCase !== 'function') {
      throw new Error('Paperclip endpoint 缺少 Case transition。');
    }
    return normalizeCase(await this.endpoint.transitionCase(caseId, payload));
  }

  async ingestCampaignDraft(pipeline: DynamicRecord, draft: DynamicRecord) {
    const batch = buildCampaignCaseBatch({
      campaignId:draft.campaignId,
      startDate:draft.startDate,
      themes:draft.themes,
      assetRightsBasis:draft.assetRightsBasis,
    });
    (batch.parent as DynamicRecord).fields = {
      ...batch.parent.fields,
      campaignGrant:draft.grant,
      projectId:pipeline.projectId || null,
    };
    return normalizeCase(await ingestCampaignDraftCase(this.endpoint, pipeline.id, batch));
  }

  async ingestCampaignExecution(pipeline: DynamicRecord, campaign: DynamicRecord) {
    const plan = campaign.campaignPlan;
    if (!plan || !campaign.campaignId) throw new Error('Campaign 缺少执行计划。');
    const batch = buildCampaignCaseBatch({
      campaignId:campaign.campaignId,
      startDate:plan.startDate,
      themes:plan.themes,
      assetRightsBasis:plan.assetRightsBasis,
    });
    const rawCampaign = rawCase(await this.client.getCase(campaign.id));
    const result = await ingestCampaignExecutionCases(
      this.endpoint,
      pipeline.id,
      batch,
      rawCampaign,
    );
    return {
      days:(result.days || []).map(normalizeCase),
      platformCases:(result.platformCases || []).map(normalizeCase),
    };
  }

  async ensureParallelWorkCases(pipelineId: unknown, day: DynamicRecord) {
    const batch = buildParallelWorkCaseBatch({
      campaignId:day.campaignId,
      scheduledDate:day.scheduledDate,
      contentVersion:day.contentVersion || 'v1',
    });
    const result = await ingestParallelWorkCaseBatch(
      this.endpoint,
      pipelineId,
      batch,
      rawCase(await this.client.getCase(day.id)),
    );
    return {
      join:normalizeCase(result.join),
      branches:(result.branches || []).map(normalizeCase),
    };
  }

  async verifyProviderAction({
    operation,
    actionId,
    costEventId,
    runContext,
  }: DynamicRecord) {
    const response = await this.client.executePluginAction(
      CONTENT_PLUGIN_KEY,
      'provider-action-verify',
      { companyId:this.companyId, params:{ operation, actionId, costEventId, runContext } },
    );
    const value = response?.data?.data;
    return value && typeof value === 'object' ? { ...value } : null;
  }

  async findCostActivity({ costEventId }: DynamicRecord) {
    const value = await this.client.listCompanyActivity(this.companyId, {
      entityType:'cost_event', entityId:costEventId, limit:500,
    });
    if (!Array.isArray(value)) return null;
    const rows = value.filter((row) => row?.action === 'cost.reported');
    return rows.length === 1 ? normalizeCostActivity(rows[0]) : null;
  }

  async getBudgetOverview() {
    const raw = await this.client.getCompanyBudgetOverview(this.companyId);
    return { policies:list(raw?.policies).map(normalizeBudgetPolicy) };
  }

  async inspectExecutionReadiness({ pipeline, executionContracts }: DynamicRecord) {
    const [plugins, routines, agents, pipelineDetail] = await Promise.all([
      this.listPlugins(), this.listCompanyRoutines(), this.listCompanyAgents(), this.getPipeline(pipeline.id),
    ]);
    return { plugins, routines, agents, pipeline:pipelineDetail, executionContracts };
  }

  async listPlugins() {
    const rows = list(await this.client.listPlugins());
    for (const row of rows) if (row?.id) this.pluginSources.set(String(row.id), row);
    return rows.map(normalizePlugin);
  }

  async getPluginConfig(pluginId: unknown) {
    const record = await this.client.getPluginConfig(pluginId, this.companyId);
    return normalizePluginConfig(record);
  }

  async getOfficialTtsVoice() {
    const plugins = await this.listPlugins();
    const plugin = plugins.find((item) => item.key === CONTENT_PLUGIN_KEY);
    if (!plugin?.id) return null;
    const config = await this.getPluginConfig(plugin.id);
    return String(config?.officialTtsVoices?.[0] || '').trim() || null;
  }

  async listCompanyRoutines() {
    return list(await this.client.listCompanyRoutines(this.companyId)).map(normalizeRoutine);
  }

  async listCompanyAgents() {
    return list(await this.client.listCompanyAgents(this.companyId)).map(normalizeAgent);
  }

  async getDailySchedule(pipeline: DynamicRecord) {
    const routines = await this.listCompanyRoutines();
    const matches = routines.filter((item) => item.projectId === pipeline.projectId
      && item.description.includes(DAILY_MARKER));
    if (matches.length !== 1) throw new Error(`M5 每日入口必须唯一，当前为 ${matches.length} 个。`);
    const detail = matches[0].schedules ? matches[0] : normalizeRoutine(await this.client.getRoutine(matches[0].id));
    if (detail.schedules.length !== 1) throw new Error(`M5 每日入口必须恰好一个日程，当前为 ${detail.schedules.length} 个。`);
    return detail.schedules[0];
  }

  async setDailyScheduleEnabled(scheduleId: unknown, enabled: unknown) {
    const value = await this.client.updateRoutineTrigger(scheduleId, { enabled });
    return normalizeSchedule(value?.trigger ?? value);
  }

  async inspectContentAutonomyReadiness({ plugin, agents }: DynamicRecord) {
    return inspectContentAutonomyPluginReadiness({
      adapter:this.endpoint,
      companyId:this.companyId,
      plugin:this.pluginSources.get(String(plugin?.id || '')) || plugin,
      agents,
    });
  }

  async readContentAutonomyApprovalSnapshot(plugin: DynamicRecord | null = null) {
    const installed = plugin || (await this.listPlugins()).find((item) => item.key === CONTENT_PLUGIN_KEY);
    if (!installed?.id || installed.status !== 'ready') throw new Error('内容插件未处于 ready。');
    const rawPlugin = this.pluginSources.get(String(installed.id));
    const config = await this.getPluginConfig(installed.id);
    return buildContentAutonomyApprovalSnapshot({
      plugin:rawPlugin,
      configRecord:{ configJson:config },
    });
  }

  // Parallel-work canonical interface. These methods keep raw Paperclip shapes
  // inside this Adapter and present only normalized records to the kernel.
  async listCaseIssueLinks(caseId: unknown) {
    return list(await this.endpoint.listCaseIssueLinks(caseId)).map(normalizeIssueLink);
  }
  countActiveParallelIssues(pipelineId: unknown) { return this.endpoint.countActiveParallelIssues(pipelineId); }
  runParallelRoutine(input: DynamicRecord) { return this.endpoint.runParallelRoutine({ ...input, branch:paperclipCase(input.branch) }); }
  linkCaseIssue(...args: any[]) { return this.endpoint.linkCaseIssue(...args); }
  completeParallelGateIssues(...args: any[]) { return this.endpoint.completeParallelGateIssues?.(...args); }
  async replaceCaseBlockers(...args: any[]) { return this.endpoint.replaceCaseBlockers(...args); }
  async ingestCase(pipelineId: unknown, value: unknown) { return normalizeCase(await this.endpoint.ingestCase(pipelineId, value)); }

  assertInterface() { return assertM5ControlPlane(this); }
}

export function normalizePaperclipCase(value: unknown) { return normalizeCase(value); }
export function normalizePaperclipWorkProduct(value: unknown) { return normalizeWorkProduct(value); }

function normalizePipeline(value: any) {
  const raw = value?.pipeline ?? value;
  if (!raw?.id) return null;
  return {
    id:String(raw.id), key:String(raw.key || ''), projectId:String(raw.projectId || ''),
    stages:list(raw.stages).map((stage: DynamicRecord) => ({
      id:stage.id || null, key:String(stage.key || ''), kind:String(stage.kind || ''),
      routineId:stage.config?.onEnter?.routineId || null,
    })),
  };
}

function normalizeCase(value: any) {
  const raw = rawCase(value);
  if (!raw?.id) return null;
  if (
    !raw.fields
    && ['campaignGrant', 'campaignId', 'scheduledDate', 'workBranch', 'parallelJoin']
      .some((key) => Object.hasOwn(raw, key))
  ) return structuredClone(raw);
  const fields = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
  return {
    id:String(raw.id), version:Number(raw.version) || 0,
    pipelineId:String(raw.pipelineId || raw.pipeline?.id || ''),
    projectId:String(fields.projectId || raw.pipeline?.projectId || raw.projectId || ''),
    parentCaseId:raw.parentCaseId || null, caseKey:String(raw.caseKey || ''),
    stageKey:String(raw.stageKey || value?.stage?.key || raw.stage?.key || ''),
    stageKind:String(value?.stage?.kind || raw.stage?.kind || ''),
    campaignGrant:fields.campaignGrant || null, campaignPlan:fields.campaignPlan || null,
    campaignId:String(fields.campaignId || ''), scheduledDate:String(fields.scheduledDate || ''),
    theme:String(fields.theme || ''), assetRightsBasis:String(fields.assetRightsBasis || ''),
    platform:String(fields.platform || ''), contentVersion:String(fields.contentVersion || ''),
    workBranch:fields.workBranch || null, parallelJoin:fields.parallelJoin || null,
    contentRecovery:fields.m5ContentRecovery || null,
    stageRecovery:fields.m5StageRecovery || null,
    activeWork:raw.activeWork || value?.activeWork || null,
    blocked:raw.blocked === true, terminal:raw.terminal === true,
    terminalKind:String(raw.terminalKind || ''),
  };
}

function paperclipCase(value: DynamicRecord) {
  return {
    id:value.id, version:value.version, pipelineId:value.pipelineId,
    parentCaseId:value.parentCaseId, caseKey:value.caseKey, stageKey:value.stageKey,
    fields:{ campaignId:value.campaignId, scheduledDate:value.scheduledDate,
      contentVersion:value.contentVersion, platform:value.platform || undefined,
      workBranch:value.workBranch || undefined, parallelJoin:value.parallelJoin || undefined },
  };
}

function normalizeCaseTree(value: any) {
  if (Array.isArray(value)) return value.map(normalizeCase).filter(Boolean);
  const root = value?.case;
  if (!root) return [];
  const result: DynamicRecord[] = [];
  const queue = list(root.childGroups).flatMap((group: DynamicRecord) => list(group.cases));
  while (queue.length) {
    const current = queue.shift();
    const normalized = normalizeCase(current);
    if (normalized) result.push(normalized);
    queue.push(...list(current?.childGroups).flatMap((group: DynamicRecord) => list(group.cases)));
  }
  return result;
}

function normalizeWorkProduct(value: any) {
  const raw = value?.workProduct ?? value;
  if (!raw || typeof raw !== 'object') return null;
  if (Object.hasOwn(raw, 'artifact') && Object.hasOwn(raw, 'artifactHash')) {
    return structuredClone(raw);
  }
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  const artifact = metadata.artifact?.data
    || metadata.artifact
    || metadata.contentVersion
    || metadata.reviewReport
    || metadata.receipt
    || null;
  return {
    id:raw.id || null, externalId:raw.externalId || null,
    recordKind:raw.kind || null, type:raw.type || null,
    provider:raw.provider || null, sourceTrust:raw.sourceTrust ?? null,
    status:raw.status || null, healthStatus:raw.healthStatus || null,
    createdByRunId:raw.createdByRunId || null,
    kind:metadata.kind || metadata.artifactKind || metadata.artifact?.type || null,
    artifactKind:metadata.artifactKind || metadata.artifact?.type || null,
    schemaVersion:metadata.schemaVersion || metadata.artifact?.schemaVersion || null,
    artifact,
    artifactHash:metadata.artifactHash || null,
    sourceRunId:metadata.sourceRunId || null, sourceTaskId:metadata.sourceTaskId || null,
    sourceArtifactId:metadata.sourceArtifactId || null, stageKey:metadata.stageKey || null,
    sourceIssueId:metadata.sourceIssueId || null, pipelineCaseId:metadata.pipelineCaseId || null,
    projectId:metadata.projectId || null, receipt:metadata.receipt || null,
    contentVersion:metadata.contentVersion || metadata.artifact?.contentVersion
      || (metadata.kind === 'ContentVersion' ? artifact : null),
    reviewReport:metadata.reviewReport || metadata.artifact?.reviewReport
      || (metadata.kind === 'MachineReview' ? artifact : null),
  };
}

function normalizeRun(raw: any) {
  if (!raw?.id && !raw?.runId) return null;
  return { id:String(raw.id || raw.runId), status:String(raw.status || raw.state || '').toLowerCase(),
    agentId:raw.agentId || null, companyId:raw.companyId || null };
}
function normalizeEvent(raw: any) { return { id:raw?.id || null, type:raw?.type || raw?.action || null,
  createdAt:raw?.createdAt || null, summary:raw?.summary || raw?.message || null }; }
function normalizeCostActivity(raw: any) { return { id:raw.id, companyId:raw.companyId,
  actorType:raw.actorType, actorId:raw.actorId, entityType:raw.entityType,
  entityId:raw.entityId, model:raw.details?.model, costCents:Number(raw.details?.costCents),
  createdAt:raw.createdAt }; }
function normalizeBudgetPolicy(raw: any) { return { scopeType:raw.scopeType, scopeId:raw.scopeId,
  metric:raw.metric, active:raw.isActive !== false, hardStop:raw.hardStopEnabled === true,
  amount:Number(raw.amount), status:raw.status, paused:raw.paused === true,
  remainingAmount:Number(raw.remainingAmount) }; }
function normalizePlugin(raw: any) { return { id:raw?.id || null,
  key:String(raw?.pluginKey || raw?.key || raw?.manifestJson?.id || ''),
  status:String(raw?.status || ''), version:String(raw?.version || raw?.manifestJson?.version || '') };
}
function normalizePluginConfig(raw: any) { return raw?.configJson && typeof raw.configJson === 'object'
  ? structuredClone(raw.configJson) : null; }
function normalizeRoutine(raw: any) { return { id:raw?.id || null, projectId:raw?.projectId || null,
  description:String(raw?.description || ''), status:String(raw?.status || ''),
  assigneeAgentId:raw?.assigneeAgentId || null,
  schedules:list(raw?.triggers).filter((item: DynamicRecord) => item?.kind === 'schedule').map(normalizeSchedule) };
}
function normalizeSchedule(raw: any) { return { id:raw?.id || null, enabled:raw?.enabled === true,
  kind:String(raw?.kind || '') }; }
function normalizeAgent(raw: any) { return { id:raw?.id || null, status:String(raw?.status || ''),
  roleId:raw?.metadata?.agentArmyId || null, systemRole:raw?.metadata?.agentArmySystemRole || null,
  adapterType:raw?.adapterType || null, adapterConfig:raw?.adapterConfig || null,
  capabilities:list(raw?.capabilities) };
}
function normalizeIssueLink(raw: any) { return { issueId:raw?.issue?.id || raw?.issueId || null,
  status:raw?.issue?.status || raw?.status || null, title:raw?.issue?.title || '',
  description:raw?.issue?.description || '' };
}
function rawCase(value: any) { return value?.case ?? value; }
function list(value: any): DynamicRecord[] { return Array.isArray(value) ? value : Array.isArray(value?.items)
  ? value.items : Array.isArray(value?.cases) ? value.cases : Array.isArray(value?.runs) ? value.runs : []; }
