import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MissionChildPolicy, ProductMaturityAuthorization } from './mission-child-policy.ts';
import { validateTaskCompletion } from '../task-completion-contract.ts';

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
  readonly #runtimeBoundarySnapshot: (() => Promise<any> | any) | null;
  #operationTail: Promise<void> = Promise.resolve();

  constructor({ store, missions, policy, ledgerPath, projectRoot, now = () => new Date(), runtimeBoundarySnapshot = null }: any) {
    this.#store = store;
    this.#missions = missions;
    this.#policy = policy;
    this.#ledgerPath = path.resolve(ledgerPath);
    this.#projectRoot = path.resolve(projectRoot);
    this.#now = now;
    this.#runtimeBoundarySnapshot = typeof runtimeBoundarySnapshot === 'function' ? runtimeBoundarySnapshot : null;
  }

  create() {
    return this.#serialize(() => this.#createOnce());
  }

  async #createOnce() {
    const records = await this.#readLedger();
    const existing = records.at(-1);
    if (existing && !existing.decision) {
      if (existing.missionTaskId) return this.#refresh(existing, records);
      if (existing.status === 'recovery_required' || reservationExpired(existing, this.#now())) {
        if (existing.status !== 'recovery_required') {
          existing.status = 'recovery_required';
          existing.updatedAt = this.#now().toISOString();
          existing.recovery = {
            reason:'reservation_authorization_expired',
            detectedAt:existing.updatedAt,
            automaticRetryAllowed:false,
          };
          await this.#writeLedger(records);
        }
        return existing;
      }
      return this.#createReservedMission(existing, records);
    }
    const tasks = await this.#store.list();
    const transcript = resolveTaskRef(tasks, '10E4F814', 'confirmed_transcript');
    const analysis = resolveTaskRef(tasks, 'B5403CD9', 'video_content_analysis_report');
    const batchId = `maturity-${crypto.randomUUID()}`;
    const items: readonly any[] = fixedItems(transcript.taskId, analysis.taskId, this.#projectRoot);
    const createdAt = this.#now().toISOString();
    const authorization = this.#policy.issue(batchId, items, new Date(createdAt));
    const record: any = {
      schemaVersion:'agent.army/product-maturity-validation-batch/v1',
      batchId,
      createdAt,
      updatedAt:createdAt,
      status:'creating',
      missionTaskId:null,
      childTaskIds:[],
      sourceTaskIds:[transcript.taskId, analysis.taskId],
      policy:{ maxModelCalls:4, maxCostUsd:0.08, externalActions:false, publishing:false },
      authorizationDigest:hash(authorization.token),
      decision:null,
    };
    records.push(record);
    await this.#writeLedger(records);
    return this.#createReservedMission(record, records, authorization);
  }

  async #createReservedMission(record: any, records: any[], issuedAuthorization?: ProductMaturityAuthorization) {
    const items: readonly any[] = fixedItems(record.sourceTaskIds[0], record.sourceTaskIds[1], this.#projectRoot);
    const authorization = issuedAuthorization || this.#policy.issue(record.batchId, items, new Date(record.createdAt));
    const authorizedItems = items.map((item) => ({
      ...item,
      context:{ ...(item.context || {}), productMaturityAuthorization:authorization },
    }));
    let result: any;
    try {
      result = await this.#missions.createBusinessMission({
        title:'完成 Agent 军团产品成熟度统一验证批次',
        items:authorizedItems,
        requester:{ kind:'local-owner', ref:'A君' },
        source:{ channel:'product-maturity-validation', eventRef:record.batchId },
        idempotencyKey:`product-maturity-validation:${record.batchId}`,
        productMaturityBatchId:record.batchId,
      });
      if (!result?.mission?.taskId || !Array.isArray(result?.children)) {
        throw new Error('产品成熟度验证任务返回无效，已保留创建预约等待重试。');
      }
    } catch (error) {
      record.status = 'creation_unknown';
      record.updatedAt = this.#now().toISOString();
      try { await this.#writeLedger(records); } catch { /* 初始 reservation 已安全落盘。 */ }
      throw error;
    }
    record.status = 'running';
    record.missionTaskId = result.mission.taskId;
    record.childTaskIds = result.children.map((item: any) => item.taskId).filter(Boolean);
    record.updatedAt = this.#now().toISOString();
    return this.#refresh(record, records);
  }

  decide(batchId: string, input: any) {
    return this.#serialize(() => this.#decideOnce(batchId, input));
  }

  async #decideOnce(batchId: string, input: any) {
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
    const sourceEvidence = fixedSourceEvidence(tasks, record);
    const batchEvidence = maturityBatchEvidence(tasks, record, this.#policy, sourceEvidence);
    const runtimeBoundary = await readRuntimeBoundary(this.#runtimeBoundarySnapshot);
    const evidenceArtifacts = evidenceArtifactViews(tasks, roles, batchEvidence.tasks, sourceEvidence.tasks);
    const evidenceHash = hash(stableJson({
      roles,
      batchEvidence:batchEvidence.view,
      sourceEvidence:sourceEvidence.view,
      runtimeBoundary,
      evidenceArtifacts,
    }));
    const batchTasks = batchEvidence.tasks;
    const allTerminal = batchTasks.length >= 4 && batchTasks.every((task: any) => terminal(task.status));
    const allVerified = roles.every((row) => row.verified);
    const acceptanceEligible = allTerminal && allVerified && batchEvidence.valid && sourceEvidence.valid && runtimeBoundary.safe;
    record.childTaskIds = batchEvidence.children.map((task: any) => task.taskId);
    record.roles = roles;
    record.batchEvidence = batchEvidence.view;
    record.sourceEvidence = sourceEvidence.view;
    record.runtimeBoundary = runtimeBoundary;
    record.evidenceArtifacts = evidenceArtifacts;
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
      assertValidLedger(parsed);
      return parsed.batches;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw new Error('产品成熟度验证账本不可读取。');
    }
  }

  async #writeLedger(records: any[]) {
    await fs.mkdir(path.dirname(this.#ledgerPath), { recursive:true });
    const temporary = `${this.#ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion:'agent.army/product-maturity-validation-ledger/v1', batches:records }, null, 2)}\n`, { mode:0o600, flag:'wx' });
      await fs.rename(temporary, this.#ledgerPath);
    } finally {
      await fs.rm(temporary, { force:true });
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function fixedItems(transcriptTaskId: string, analysisTaskId: string, projectRoot: string) {
  const acceptanceRoot = path.join(projectRoot, 'work', 'acceptance-runs');
  return [
    {
      key:'creator', agentId:'creator', taskType:'governance.agent-proposal', title:'验证创建官能生成受限岗位草案',
      description:'为公开网页只读差异核对员生成草案；只允许 GET，不登录、不外发、不激活岗位。',
      acceptance:'产出有职责、非职责、预算和最小验收任务的草案，保持 proposal-only。',
      proposalOnly:true, draftOnly:true,
      context:{ proposalOnly:true, draftOnly:true },
    },
    {
      key:'technical-expert', agentId:'technical-expert', taskType:'operations.technical-repair', title:'验证技术专家隔离修复夹具',
      description:'只修复受控 calculator 加法夹具并运行指定测试；不得修改真实业务文件。',
      acceptance:'只在隔离 worktree 修改一个夹具文件，测试与恢复检查均有证据。', dependsOn:['creator'],
      deterministicAcceptanceRepair:true,
      context:{
        deterministicAcceptanceRepair:true,
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
      researchMode:'off', approvedForUse:false,
      context:{
        researchMode:'off',
        approvedForUse:false,
        modelPolicy:{ maxCalls:0, maxCostUsd:0, costKnown:true },
        sourceTaskIds:[transcriptTaskId, analysisTaskId],
        requiredSourceTaskIds:[transcriptTaskId, analysisTaskId],
      },
    },
  ] as const;
}

function evidenceRow(spec: any, tasks: any[], record: any) {
  const matching = tasks.filter((task) => task.assigneeAgentId === spec.agentId && spec.taskTypes.includes(task.taskType));
  const success = latest(matching.filter((task) => task.status === 'succeeded' && verifiedArtifact(task)));
  const failure = latest(matching.filter((task) => ['failed', 'waiting_test'].includes(task.status)));
  const batchEvidence = spec.agentId === 'ajun'
    ? tasks.find((task) => task.taskId === record.missionTaskId)
    : tasks.find((task) => task.parentTaskId === record.missionTaskId && task.assigneeAgentId === spec.agentId);
  const selected = batchEvidence ? (batchEvidence.status === 'succeeded' && verifiedArtifact(batchEvidence) ? batchEvidence : null) : success;
  const freshness = selected && failure && Date.parse(taskTime(selected) || '') <= Date.parse(taskTime(failure) || '')
    ? 'predates_latest_failure'
    : selected ? 'later_than_latest_failure_or_no_failure' : 'none';
  const verified = Boolean(selected && freshness !== 'predates_latest_failure');
  const batchVerified = Boolean(batchEvidence && selected === batchEvidence && verified);
  const evidenceOrigin = batchEvidence ? 'current_batch' : selected ? 'historical' : 'none';
  return Object.freeze({
    agentId:spec.agentId,
    name:spec.name,
    verified,
    evidenceTaskId:selected?.taskId || batchEvidence?.taskId || null,
    verifiedAt:taskTime(selected),
    batchStatus:batchEvidence?.status || null,
    batchVerified,
    evidenceOrigin,
    latestFailureTaskId:failure?.taskId || null,
    latestFailureAt:taskTime(failure),
    freshness,
  });
}

function maturityBatchEvidence(tasks: any[], record: any, policy: MissionChildPolicy, sourceEvidence: any) {
  const missionMatches = tasks.filter((task: any) => task.taskId === record.missionTaskId);
  const mission = missionMatches[0] || null;
  const children = tasks.filter((task: any) => task.parentTaskId === record.missionTaskId);
  const expected = [
    ['creator', 'creator', 'governance.agent-proposal'],
    ['technical-expert', 'technical-expert', 'operations.technical-repair'],
    ['content-creator', 'content-creator', 'content.video-script-package'],
  ];
  const expectedChildren = expected.map(([, agentId, taskType]) => children.filter((task: any) =>
    task.assigneeAgentId === agentId && task.taskType === taskType));
  const expectedIds = new Set([record.missionTaskId, ...children.map((task: any) => task.taskId)]);
  const unexpectedBatchTasks = tasks.filter((task: any) => {
    const sameBatch = task?.source?.eventRef === record.batchId
      || task?.input?.context?.productMaturityBatchId === record.batchId;
    return sameBatch && !expectedIds.has(task.taskId);
  });
  const exactShape = missionMatches.length === 1
    && mission?.taskType === 'army.cross-agent-mission'
    && mission?.assigneeAgentId === 'ajun'
    && mission?.input?.context?.productMaturityBatchId === record.batchId
    && children.length === 3
    && expectedChildren.every((matches) => matches.length === 1)
    && unexpectedBatchTasks.length === 0;
  const authorizationResults = children.map((task: any) => {
    try {
      const verified = mission ? policy.verifyTaskAuthorization({ mission, task }) : null;
      const item = expected.find(([key, agentId, taskType]) => key === verified?.stepKey
        && agentId === task.assigneeAgentId && taskType === task.taskType);
      return Boolean(item && verified?.batchId === record.batchId);
    } catch { return false; }
  });
  let missionAuthorizationValid = false;
  try {
    missionAuthorizationValid = Boolean(mission && policy.verifyMissionAuthorization(mission));
  } catch { missionAuthorizationValid = false; }
  const missionTokens = Array.isArray(mission?.input?.context?.businessMissionItems)
    ? mission.input.context.businessMissionItems.map((item: any) => authorizationToken(item?.context))
    : [];
  const childTokens = children.map((task: any) => authorizationToken(task?.input?.context));
  const authorizationTokens = [...missionTokens, ...childTokens];
  const authorizationTokenDigest = authorizationTokens.length === 6
    && authorizationTokens.every(Boolean)
    && new Set(authorizationTokens).size === 1
    ? hash(authorizationTokens[0])
    : null;
  const authorizationDigestValid = Boolean(authorizationTokenDigest
    && authorizationTokenDigest === record.authorizationDigest);
  const authorizationValid = exactShape && missionAuthorizationValid && authorizationDigestValid
    && authorizationResults.length === 3 && authorizationResults.every(Boolean);
  const usageTasks = [...(mission ? [mission] : []), ...children];
  const usageKnown = exactShape && usageTasks.every(knownUsage);
  const modelCalls = usageKnown ? usageTasks.reduce((sum: number, task: any) => sum + task.usage.model.apiCalls, 0) : null;
  const costUsd = usageKnown ? usageTasks.reduce((sum: number, task: any) => sum + task.usage.cost.amount, 0) : null;
  const usageZero = usageKnown && modelCalls === 0 && costUsd === 0;
  const creator = expectedChildren[0]?.[0] || null;
  const technical = expectedChildren[1]?.[0] || null;
  const content = expectedChildren[2]?.[0] || null;
  const creatorArtifact = creator?.artifactRefs?.find((artifact: any) => artifact.type === 'agent_proposal');
  const technicalArtifact = technical?.artifactRefs?.find((artifact: any) => artifact.type === 'technical_repair_case');
  const creatorDraftOnly = creatorArtifact?.data?.status === 'draft'
    && creatorArtifact?.data?.reviewSubmission?.status === 'pending';
  const technicalVerification = technical?.execution?.verification;
  const technicalAcceptanceOnly = technical?.execution?.executor === 'technical-expert'
    && technical?.execution?.mode === 'isolated_technical_repair'
    && technical?.execution?.outcome === 'acceptance_verified_in_isolated_workspace'
    && technicalVerification?.verified === true
    && technicalVerification?.testsPassed === true
    && technicalVerification?.recoveryVerified === true
    && technicalVerification?.acceptanceOnly === true
    && technicalVerification?.sourceProjectRootChanged === false
    && technicalVerification?.runningReleaseUpdated === false;
  const contentArtifact = content?.artifactRefs?.find((artifact: any) => artifact.type === 'video_script_package');
  const expectedSourceBindings = sourceEvidence.bindings || [];
  const contentBindings = Array.isArray(contentArtifact?.data?.sourceTaskBindings)
    ? contentArtifact.data.sourceTaskBindings : [];
  const contentSourceBindingsValid = sourceEvidence.valid
    && expectedSourceBindings.length === 2
    && contentBindings.length === expectedSourceBindings.length
    && expectedSourceBindings.every((expectedBinding: any) => {
      const matches = contentBindings.filter((binding: any) => String(binding?.taskId || '') === expectedBinding.taskId);
      return matches.length === 1
        && sameStrings(matches[0].artifactIds, [expectedBinding.artifactId]);
    })
    && sameStringSet(contentArtifact?.sourceRefs, expectedSourceBindings.map((binding: any) => binding.artifactId));
  const outputDigestsValid = [creatorArtifact, technicalArtifact, contentArtifact].every((artifact) =>
    hasContentDigest(artifact) && verifiedArtifact({ artifactRefs:[artifact] }));
  const contentDraftOnly = contentArtifact?.validation?.fileCount === 5
    && contentArtifact?.validation?.externalSideEffects === 0
    && contentArtifact?.data?.publishingStatus === 'draft_only'
    && contentArtifact?.data?.generationMode === 'deterministic_fallback'
    && contentArtifact?.data?.templateLifecycle?.approvedForUse === false
    && sameStrings(contentArtifact?.data?.sourceTaskIds, record.sourceTaskIds)
    && sameStrings((contentArtifact?.data?.sourceTaskBindings || []).map((item: any) => item?.taskId), record.sourceTaskIds)
    && contentSourceBindingsValid;
  const valid = exactShape && authorizationValid && usageZero && outputDigestsValid
    && creatorDraftOnly && technicalAcceptanceOnly && contentDraftOnly;
  return {
    tasks:[...(mission ? [mission] : []), ...children],
    children,
    exactShape,
    valid,
    view:Object.freeze({
      exactShape,
      missionCount:missionMatches.length,
      childCount:children.length,
      unexpectedBatchTaskCount:unexpectedBatchTasks.length,
      missionAuthorizationValid,
      authorizationValid,
      authorizationDigestValid,
      authorizationTokenDigest,
      reservationAuthorizationDigest:typeof record.authorizationDigest === 'string' ? record.authorizationDigest : null,
      authorizationFailureCount:authorizationResults.filter((valid) => !valid).length,
      usageKnown,
      usageZero,
      modelCalls,
      costKnown:usageKnown,
      costUsd,
      creatorDraftOnly,
      technicalAcceptanceOnly,
      contentDraftOnly,
      contentSourceBindingsValid,
      outputDigestsValid,
    }),
  };
}

function knownUsage(task: any) {
  return task?.usage?.schemaVersion === 'agent.army/task-usage/v1'
    && task.usage.model?.status === 'reported'
    && Number.isFinite(task.usage.model?.apiCalls)
    && task.usage.model.apiCalls >= 0
    && task.usage.cost?.status === 'reported'
    && task.usage.cost?.currency === 'USD'
    && Number.isFinite(task.usage.cost?.amount)
    && task.usage.cost.amount >= 0;
}

function sameStrings(left: any, right: any) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => String(item) === String(right[index]));
}

function sameStringSet(left: any, right: any) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const a = [...new Set(left.map(String))].sort();
  const b = [...new Set(right.map(String))].sort();
  return a.length === left.length && b.length === right.length && sameStrings(a, b);
}

function authorizationToken(context: any) {
  return context?.productMaturityAuthorization?.kind === 'product-maturity-validation'
    && typeof context.productMaturityAuthorization.token === 'string'
    && context.productMaturityAuthorization.token
    ? context.productMaturityAuthorization.token
    : null;
}

function contentDigest(value: any) {
  const candidate = [value?.checksum, value?.digest, value?.contentHash, value?.data?.contentHash]
    .find((item) => typeof item === 'string' && item.trim());
  if (!candidate) return null;
  const normalized = candidate.trim().toLowerCase();
  return /^(?:sha256:)?[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function hasContentDigest(artifact: any) {
  return Boolean(artifact?.artifactId && contentDigest(artifact));
}

function fixedSourceEvidence(tasks: any[], record: any) {
  const expected = [
    { taskId:record.sourceTaskIds[0], taskType:'media.transcribe-and-refine', agentId:'xiaod', artifactType:'confirmed_transcript' },
    { taskId:record.sourceTaskIds[1], taskType:'content.video-benchmark-analysis', agentId:'video-content-analyst', artifactType:'video_content_analysis_report' },
  ];
  const rows = expected.map((spec) => {
    const matches = tasks.filter((task: any) => task.taskId === spec.taskId);
    const task = matches[0] || null;
    const artifacts = (task?.artifactRefs || []).filter((artifact: any) => artifact.type === spec.artifactType);
    const artifact = artifacts[0] || null;
    const artifactId = typeof artifact?.artifactId === 'string' && artifact.artifactId ? artifact.artifactId : null;
    const digest = contentDigest(artifact);
    const valid = matches.length === 1
      && task?.taskType === spec.taskType
      && task?.assigneeAgentId === spec.agentId
      && task?.status === 'succeeded'
      && artifacts.length === 1
      && verifiedArtifact({ artifactRefs:[artifact] })
      && Boolean(artifactId && digest);
    return Object.freeze({
      taskId:spec.taskId,
      taskType:spec.taskType,
      agentId:spec.agentId,
      artifactType:spec.artifactType,
      artifactId,
      contentDigest:digest,
      valid,
      artifact:artifactEvidenceView(artifact),
    });
  });
  return {
    tasks:expected.map((spec) => tasks.find((task: any) => task.taskId === spec.taskId)).filter(Boolean),
    bindings:rows.map((row) => ({ taskId:row.taskId, artifactId:row.artifactId, contentDigest:row.contentDigest })),
    valid:rows.every((row) => row.valid),
    view:Object.freeze({ valid:rows.every((row) => row.valid), sources:rows }),
  };
}

function evidenceArtifactViews(tasks: any[], roles: readonly any[], batchTasks: any[], sourceTasks: any[]) {
  const taskIds = new Set([
    ...roles.map((row) => row.evidenceTaskId).filter(Boolean),
    ...batchTasks.map((task) => task.taskId),
    ...sourceTasks.map((task) => task.taskId),
  ]);
  return tasks
    .filter((task: any) => taskIds.has(task.taskId))
    .map((task: any) => Object.freeze({
      taskId:task.taskId,
      taskType:task.taskType,
      assigneeAgentId:task.assigneeAgentId,
      status:task.status,
      updatedAt:task.updatedAt || task.createdAt || null,
      artifacts:(task.artifactRefs || []).map(artifactEvidenceView),
    }))
    .sort((left: any, right: any) => String(left.taskId).localeCompare(String(right.taskId)));
}

function artifactEvidenceView(artifact: any) {
  if (!artifact || typeof artifact !== 'object') return null;
  const sourceTaskBindings = Array.isArray(artifact.data?.sourceTaskBindings)
    ? artifact.data.sourceTaskBindings.map((binding: any) => ({
      taskId:binding?.taskId || null,
      artifactIds:Array.isArray(binding?.artifactIds) ? binding.artifactIds.map(String) : [],
      checksum:binding?.checksum || null,
      artifactChecksums:Array.isArray(binding?.artifactChecksums) ? binding.artifactChecksums.map(String) : [],
    }))
    : [];
  const identity = {
    artifactId:artifact.artifactId || null,
    type:artifact.type || null,
    location:artifact.location || null,
    mimeType:artifact.mimeType || null,
  };
  const digests = {
    checksum:artifact.checksum || null,
    digest:artifact.digest || null,
    contentHash:artifact.contentHash || artifact.data?.contentHash || null,
    sourceTranscriptChecksum:artifact.data?.sourceTranscriptChecksum || null,
    sourceAnalysisChecksum:artifact.data?.sourceAnalysisChecksum || null,
  };
  const view = {
    ...identity,
    ...digests,
    validation:artifact.validation && typeof artifact.validation === 'object' ? artifact.validation : null,
    sourceRefs:Array.isArray(artifact.sourceRefs) ? artifact.sourceRefs.map(String) : [],
    sourceTaskIds:Array.isArray(artifact.data?.sourceTaskIds) ? artifact.data.sourceTaskIds.map(String) : [],
    sourceTaskBindings,
  };
  return Object.freeze({ ...view, evidenceDigest:hash(stableJson(view)) });
}

async function readRuntimeBoundary(provider: (() => Promise<any> | any) | null) {
  if (!provider) return unknownRuntimeBoundary('provider_missing');
  try {
    const snapshot = await provider();
    const schemaValid = snapshot?.schemaVersion === 'agent.army/product-maturity-runtime-boundary/v1';
    const publisherDisabled = schemaValid && snapshot?.publisher?.disabled === true;
    const campaignActiveCount = schemaValid && Number.isInteger(snapshot?.campaigns?.activeCount)
      && snapshot.campaigns.activeCount >= 0 ? snapshot.campaigns.activeCount : null;
    const cronDisabled = schemaValid && snapshot?.cron?.disabled === true;
    const observedAt = typeof snapshot?.observedAt === 'string' && Number.isFinite(Date.parse(snapshot.observedAt))
      ? snapshot.observedAt : null;
    const evidenceRef = typeof snapshot?.evidenceRef === 'string' && snapshot.evidenceRef.trim()
      ? snapshot.evidenceRef.trim().slice(0, 500) : null;
    const revisionCandidate = typeof snapshot?.revision === 'string' ? snapshot.revision.trim().toLowerCase() : '';
    const revision = /^(?:sha256:)?[0-9a-f]{64}$/.test(revisionCandidate) ? revisionCandidate : null;
    const observationIdentityValid = Boolean((observedAt && evidenceRef) || revision);
    return Object.freeze({
      schemaVersion:'agent.army/product-maturity-runtime-boundary-evidence/v1',
      known:Boolean(schemaValid && campaignActiveCount !== null && observationIdentityValid),
      safe:Boolean(publisherDisabled && campaignActiveCount === 0 && cronDisabled && observationIdentityValid),
      publisherDisabled:Boolean(publisherDisabled),
      campaignActiveCount,
      cronDisabled:Boolean(cronDisabled),
      observationIdentityValid,
      observedAt,
      evidenceRef,
      revision,
      error:null,
    });
  } catch {
    return unknownRuntimeBoundary('provider_failed');
  }
}

function unknownRuntimeBoundary(error: string) {
  return Object.freeze({
    schemaVersion:'agent.army/product-maturity-runtime-boundary-evidence/v1',
    known:false,
    safe:false,
    publisherDisabled:false,
    campaignActiveCount:null,
    cronDisabled:false,
    observationIdentityValid:false,
    observedAt:null,
    evidenceRef:null,
    revision:null,
    error,
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
function verifiedArtifact(task: any) {
  const readable = task?.artifactRefs?.some((artifact: any) => artifact.validation?.exists === true && artifact.validation?.readable === true && artifact.validation?.nonEmpty !== false);
  if (!readable) return false;
  if (
    task?.assigneeAgentId === 'intel-researcher'
    && task?.taskType === 'research.intel-report'
    && task?.input?.context?.validationPurpose === 'product_maturity_role_freshness'
  ) return validateTaskCompletion(task).valid;
  return true;
}
function taskTime(task: any) { return task?.updatedAt || task?.createdAt || null; }
function latest(tasks: any[]) { return tasks.reduce((best, task) => !best || Date.parse(taskTime(task) || '') > Date.parse(taskTime(best) || '') ? task : best, null); }
function reservationExpired(record: any, now: Date) {
  return ['creating', 'creation_unknown'].includes(record?.status)
    && Number.isFinite(Date.parse(record?.createdAt))
    && now.getTime() >= Date.parse(record.createdAt) + 24 * 60 * 60 * 1000;
}
function assertValidLedger(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 'agent.army/product-maturity-validation-ledger/v1'
    || !Array.isArray(value.batches)) throw new Error('invalid maturity ledger');
  const batchIds = new Set<string>();
  const allowedStatuses = new Set([
    'creating', 'creation_unknown', 'recovery_required', 'running', 'ready_for_decision',
    'stale_evidence', 'accepted', 'revision_required',
  ]);
  for (const record of value.batches) {
    const decision = record?.decision;
    const validDecision = decision === null || (decision && typeof decision === 'object'
      && ['accepted', 'revision_required'].includes(decision.status));
    const validMission = typeof record?.missionTaskId === 'string' && record.missionTaskId.length > 0;
    const validReservation = record?.missionTaskId === null
      && ['creating', 'creation_unknown', 'recovery_required'].includes(record?.status)
      && decision === null;
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schemaVersion !== 'agent.army/product-maturity-validation-batch/v1'
      || !/^maturity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(record.batchId || ''))
      || batchIds.has(record.batchId)
      || !allowedStatuses.has(record.status)
      || !Number.isFinite(Date.parse(record.createdAt))
      || !Number.isFinite(Date.parse(record.updatedAt))
      || !Array.isArray(record.childTaskIds)
      || record.childTaskIds.some((taskId: any) => typeof taskId !== 'string' || !taskId)
      || !Array.isArray(record.sourceTaskIds) || record.sourceTaskIds.length !== 2
      || record.sourceTaskIds.some((taskId: any) => typeof taskId !== 'string' || !taskId)
      || !validDecision || (!validMission && !validReservation)) throw new Error('invalid maturity batch');
    batchIds.add(record.batchId);
  }
}
function hash(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableJson(value: any) { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
function validationError(message: string, code: string, httpStatus = 400) { const error: any = new Error(message); error.code = code; error.httpStatus = httpStatus; return error; }
