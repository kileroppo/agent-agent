import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MissionChildPolicy, ProductMaturityAuthorization } from './mission-child-policy.ts';

const ROLE_SPECS = Object.freeze([
  role('ajun', 'A君', ['army.cross-agent-mission']),
  role('xiaod', '小D', ['media.transcribe-and-refine']),
  role('intel-researcher', '小R', ['research.intel-report']),
  role('office-assistant', '小办', ['office.briefing-package', 'office.presentation-package']),
  role('creator', '创建官', ['governance.agent-proposal']),
  role('reviewer', '审核官', ['governance.approval-review']),
  role('architect', '架构师', ['governance.architecture-review']),
  role('technical-expert', '技术专家', ['operations.technical-repair']),
  role('video-content-analyst', '小拆', ['content.video-benchmark-analysis']),
  role('content-creator', '小创', ['content.video-script-package', 'content.platform-draft']),
]);

export class CapabilityAcceptanceBundle {
  readonly #store: any;
  readonly #missions: any;
  readonly #policy: MissionChildPolicy;
  readonly #ledgerPath: string;
  readonly #projectRoot: string;
  readonly #now: () => Date;

  constructor({ store, missions, policy, ledgerPath, projectRoot, now = () => new Date() }: any) {
    this.#store = store;
    this.#missions = missions;
    this.#policy = policy;
    this.#ledgerPath = path.resolve(ledgerPath);
    this.#projectRoot = path.resolve(projectRoot);
    this.#now = now;
  }

  async create() {
    const records = await this.#readLedger();
    const existing = records.at(-1);
    if (existing) return existing.decision ? existing : this.#refresh(existing, records);
    const tasks = await this.#store.list();
    const transcript = resolveTaskRef(tasks, '10E4F814', 'confirmed_transcript');
    const analysis = resolveTaskRef(tasks, 'B5403CD9', 'video_content_analysis_report');
    const batchId = `maturity-${crypto.randomUUID()}`;
    const items: readonly any[] = fixedItems(transcript.taskId, analysis.taskId, this.#projectRoot);
    const authorization = this.#policy.issue(batchId, items);
    const authorizedItems = items.map((item) => ({
      ...item,
      context:{ ...(item.context || {}), productMaturityAuthorization:authorization },
    }));
    const createdAt = this.#now().toISOString();
    const result = await this.#missions.createBusinessMission({
      title:'完成 Agent 军团产品成熟度统一验证批次',
      items:authorizedItems,
      requester:{ kind:'local-owner', ref:'A君' },
      source:{ channel:'product-maturity-validation', eventRef:batchId },
      idempotencyKey:`product-maturity-validation:${batchId}`,
      productMaturityBatchId:batchId,
    });
    const record: any = {
      schemaVersion:'agent.army/product-maturity-validation-batch/v1',
      batchId,
      createdAt,
      updatedAt:createdAt,
      status:'running',
      missionTaskId:result.mission.taskId,
      childTaskIds:result.children.map((item: any) => item.taskId),
      sourceTaskIds:[transcript.taskId, analysis.taskId],
      policy:{ maxModelCalls:4, maxCostUsd:0.08, externalActions:false, publishing:false },
      authorizationDigest:hash(authorization.token),
      decision:null,
    };
    records.push(record);
    await this.#writeLedger(records);
    return this.#refresh(record, records);
  }

  async decide(batchId: string, input: any) {
    const decision = input?.decision === 'accepted' || input?.decision === 'revision_required' ? input.decision : null;
    if (!decision) throw validationError('决定必须是 accepted 或 revision_required。', 'maturity_decision_invalid');
    const records = await this.#readLedger();
    const record = records.find((item: any) => item.batchId === batchId);
    if (!record) throw validationError('找不到这个产品成熟度验证批次。', 'maturity_batch_not_found', 404);
    if (record.decision) return record;
    const refreshed = await this.#refresh(record, records, { persist:false });
    if (refreshed.status !== 'ready_for_decision') {
      throw validationError('批次证据尚未全部形成，不能登记统一验收决定。', 'maturity_batch_not_ready', 409);
    }
    if (!input?.evidenceHash || input.evidenceHash !== refreshed.evidenceHash) {
      record.status = 'stale_evidence';
      record.updatedAt = this.#now().toISOString();
      record.evidenceHash = refreshed.evidenceHash;
      record.roles = refreshed.roles;
      await this.#writeLedger(records);
      throw validationError('验收证据已变化，请基于最新 evidenceHash 重新提交统一决定。', 'maturity_evidence_stale', 409);
    }
    if (decision === 'accepted' && refreshed.acceptanceEligible !== true) {
      throw validationError('当前批次没有全部通过验证，不能登记 accepted；可以登记 revision_required。', 'maturity_batch_not_acceptance_eligible', 409);
    }
    const decidedAt = this.#now().toISOString();
    record.status = decision;
    record.updatedAt = decidedAt;
    record.evidenceHash = refreshed.evidenceHash;
    record.roles = refreshed.roles;
    record.decision = {
      status:decision,
      note:String(input?.note || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      decidedAt,
      decidedBy:'A君',
      scope:'capability-acceptance-bundle',
      historicalTaskStatusesChanged:false,
    };
    await this.#writeLedger(records);
    return record;
  }

  async #refresh(record: any, records: any[], { persist = true } = {}) {
    const tasks = await this.#store.list();
    const roles = ROLE_SPECS.map((spec) => evidenceRow(spec, tasks, record));
    const evidenceHash = hash(stableJson(roles));
    const batchTasks = tasks.filter((task: any) => task.taskId === record.missionTaskId || task.parentTaskId === record.missionTaskId);
    const allTerminal = batchTasks.length >= 4 && batchTasks.every((task: any) => terminal(task.status));
    const allVerified = roles.every((row) => row.verified);
    const acceptanceEligible = allTerminal && allVerified;
    record.childTaskIds = batchTasks.filter((task: any) => task.parentTaskId === record.missionTaskId).map((task: any) => task.taskId);
    record.roles = roles;
    record.evidenceHash = evidenceHash;
    record.acceptanceEligible = acceptanceEligible;
    record.status = record.decision?.status || (allTerminal ? 'ready_for_decision' : 'running');
    record.updatedAt = this.#now().toISOString();
    if (persist) await this.#writeLedger(records);
    return record;
  }

  async #readLedger(): Promise<any[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#ledgerPath, 'utf8'));
      return Array.isArray(parsed?.batches) ? parsed.batches : [];
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw new Error('产品成熟度验证账本不可读取。');
    }
  }

  async #writeLedger(records: any[]) {
    await fs.mkdir(path.dirname(this.#ledgerPath), { recursive:true });
    const temporary = `${this.#ledgerPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion:'agent.army/product-maturity-validation-ledger/v1', batches:records }, null, 2)}\n`, { mode:0o600 });
    await fs.rename(temporary, this.#ledgerPath);
  }
}

function fixedItems(transcriptTaskId: string, analysisTaskId: string, projectRoot: string) {
  const acceptanceRoot = path.join(projectRoot, 'work', 'acceptance-runs');
  return [
    {
      key:'creator', agentId:'creator', taskType:'governance.agent-proposal', title:'验证创建官能生成受限岗位草案',
      description:'为公开网页只读差异核对员生成草案；只允许 GET，不登录、不外发、不激活岗位。',
      acceptance:'产出有职责、非职责、预算和最小验收任务的草案，保持 proposal-only。',
    },
    {
      key:'technical-expert', agentId:'technical-expert', taskType:'operations.technical-repair', title:'验证技术专家隔离修复夹具',
      description:'只修复受控 calculator 加法夹具并运行指定测试；不得修改真实业务文件。',
      acceptance:'只在隔离 worktree 修改一个夹具文件，测试与恢复检查均有证据。', dependsOn:['creator'],
      context:{
        acceptanceWorkspaceRoot:acceptanceRoot,
        failure:{ code:'acceptance_fixture_failure', category:'code_defect', stage:'test', retryable:false },
        repairScope:{
          files:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.js'],
          testSupportFiles:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js', 'docs/acceptance-fixtures/technical-repair-sandbox/package.json'],
          testCommand:'node --test docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js',
          recoveryCheck:'确认 add(2, 3) 返回 5，且只修改 calculator.js。',
        },
      },
    },
    {
      key:'content-creator', agentId:'content-creator', taskType:'content.video-script-package', title:'生成 45 秒竖屏本地待审解释型脚本',
      description:'基于现有确认稿和正式视频分析生成本地待审脚本包；不得补抓、登录、发送或发布。',
      acceptance:'生成唯一五文件脚本包，draft_only、externalSideEffects=0，并引用两个来源任务。', dependsOn:['technical-expert'],
      platforms:['douyin'], contentGoal:'用 45 秒解释宿命论访谈中的核心观点，只表达现有证据支持的内容。',
      context:{
        sourceTaskIds:[transcriptTaskId, analysisTaskId],
        requiredSourceTaskIds:[transcriptTaskId, analysisTaskId],
      },
    },
  ] as const;
}

function evidenceRow(spec: any, tasks: any[], record: any) {
  const matching = tasks.filter((task) => spec.taskTypes.includes(task.taskType));
  const success = latest(matching.filter((task) => task.status === 'succeeded' && verifiedArtifact(task)));
  const failure = latest(matching.filter((task) => ['failed', 'waiting_test'].includes(task.status)));
  const batchEvidence = spec.agentId === 'ajun'
    ? tasks.find((task) => task.taskId === record.missionTaskId)
    : tasks.find((task) => task.parentTaskId === record.missionTaskId && task.assigneeAgentId === spec.agentId);
  const batchVerified = Boolean(batchEvidence?.status === 'succeeded' && verifiedArtifact(batchEvidence));
  const selected = batchEvidence ? (batchVerified ? batchEvidence : null) : success;
  const evidenceOrigin = batchEvidence ? 'current_batch' : selected ? 'historical' : 'none';
  return Object.freeze({
    agentId:spec.agentId,
    name:spec.name,
    verified:Boolean(selected),
    evidenceTaskId:selected?.taskId || batchEvidence?.taskId || null,
    verifiedAt:taskTime(selected),
    batchStatus:batchEvidence?.status || null,
    batchVerified,
    evidenceOrigin,
    latestFailureTaskId:failure?.taskId || null,
    latestFailureAt:taskTime(failure),
    freshness:selected && failure && Date.parse(taskTime(selected) || '') <= Date.parse(taskTime(failure) || '') ? 'predates_latest_failure' : selected ? 'later_than_latest_failure_or_no_failure' : 'none',
  });
}

function resolveTaskRef(tasks: any[], shortRef: string, artifactType: string) {
  const task = tasks.find((item) => compact(item.taskId).startsWith(shortRef.toUpperCase())
    && item.status === 'succeeded' && item.artifactRefs?.some((artifact: any) => artifact.type === artifactType && artifact.validation?.exists === true && artifact.validation?.readable === true));
  if (!task) throw validationError(`找不到 ${shortRef} 的有效 ${artifactType} 证据，批次未创建。`, 'maturity_source_evidence_missing', 409);
  return task;
}

function role(agentId: string, name: string, taskTypes: readonly string[]) { return Object.freeze({ agentId, name, taskTypes }); }
function compact(value: unknown) { return String(value || '').replace(/[^0-9a-z]/gi, '').toUpperCase(); }
function terminal(status: string) { return ['succeeded', 'failed', 'needs_input', 'waiting_test', 'cancelled'].includes(status); }
function verifiedArtifact(task: any) { return task?.artifactRefs?.some((artifact: any) => artifact.validation?.exists === true && artifact.validation?.readable === true && artifact.validation?.nonEmpty !== false); }
function taskTime(task: any) { return task?.updatedAt || task?.createdAt || null; }
function latest(tasks: any[]) { return tasks.reduce((best, task) => !best || Date.parse(taskTime(task) || '') > Date.parse(taskTime(best) || '') ? task : best, null); }
function hash(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableJson(value: any) { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
function validationError(message: string, code: string, httpStatus = 400) { const error: any = new Error(message); error.code = code; error.httpStatus = httpStatus; return error; }
