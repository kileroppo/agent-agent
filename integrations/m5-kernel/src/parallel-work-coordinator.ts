const ACTIVE_ISSUE_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'blocked']);
const TERMINAL_ISSUE_STATUSES = new Set(['done', 'cancelled']);
const TERMINAL_CASE_STAGES = new Set(['done', 'cancelled']);
const INITIAL_BRANCH_ORDER = Object.freeze([
  'research',
  'assets',
  'image_generation',
  'visual_analysis',
  'voice',
]);
type DynamicRecord = Record<string, any>;
type M5ParallelControlPlane = DynamicRecord & {
  getCase(caseId: unknown): Promise<DynamicRecord | null>;
  getCaseOutputs(caseId: unknown): Promise<DynamicRecord[]>;
  listCaseIssueLinks(caseId: unknown): Promise<DynamicRecord[]>;
  countActiveParallelIssues(pipelineId: string): Promise<number>;
  ensureParallelWorkCases(pipelineId: string, day: DynamicRecord): Promise<{
    join: DynamicRecord;
    branches: DynamicRecord[];
  }>;
  runParallelRoutine(input: DynamicRecord): Promise<DynamicRecord>;
  linkCaseIssue(caseId: unknown, issueId: unknown, relation: string): Promise<unknown>;
  transitionCase(caseId: unknown, input: DynamicRecord): Promise<DynamicRecord>;
  completeParallelGateIssues?(caseId: unknown, reason: string): Promise<unknown>;
};

export class M5ParallelWorkCoordinator {
  readonly controlPlane: M5ParallelControlPlane;
  readonly pipelineId: string;
  readonly maxConcurrency: number;

  constructor({
    controlPlane,
    pipelineId,
    maxConcurrency = 4,
  }: Readonly<{
    controlPlane?: M5ParallelControlPlane;
    pipelineId?: string;
    maxConcurrency?: number;
  }> = {}) {
    if (!controlPlane || !pipelineId) {
      throw new M5ParallelWorkCoordinatorError('并行工作协调器缺少控制面或 Pipeline。');
    }
    if (maxConcurrency !== 4) {
      throw new M5ParallelWorkCoordinatorError('M5 并行工作全局并发固定为4。');
    }
    this.controlPlane = controlPlane;
    this.pipelineId = pipelineId;
    this.maxConcurrency = maxConcurrency;
  }

  async reconcile(dayCaseId: unknown) {
    this.assertControlPlane();
    const day = await this.controlPlane.getCase(dayCaseId);
    if (!day?.id || day.pipelineId !== this.pipelineId || !day.caseKey) {
      throw new M5ParallelWorkCoordinatorError('目标日期 Case 不属于 M5 Pipeline。');
    }
    const campaignId = String(day.campaignId || '').trim();
    const scheduledDate = String(day.scheduledDate || '').trim();
    const contentVersion = String(day.contentVersion || 'v1').trim();
    if (`${campaignId}:${scheduledDate}` !== day.caseKey) {
      throw new M5ParallelWorkCoordinatorError('目标日期 Case 的活动、日期或 caseKey 不一致。');
    }

    const dayOutputs = await this.controlPlane.getCaseOutputs(day.id);
    if (!hasHealthyWorkProduct(dayOutputs, 'TopicSelection')) {
      return {
        created:null,
        dispatched:[],
        completed:[],
        waiting:[{ kind:'parallel_batch', reason:'topic_not_verified' }],
        joined:false,
      };
    }

    const ingested = await this.controlPlane.ensureParallelWorkCases(this.pipelineId, {
      ...day,
      campaignId,
      scheduledDate,
      contentVersion,
    });
    const dispatched: DynamicRecord[] = [];
    const completed: DynamicRecord[] = [];
    const waiting: DynamicRecord[] = [];

    for (const kind of INITIAL_BRANCH_ORDER) {
      const branch = ingested.branches.find((item) => item.workBranch?.kind === kind);
      const work = branch?.workBranch;
      if (!branch || !work) {
        throw new M5ParallelWorkCoordinatorError(`并行工作分支缺失：${kind}。`);
      }
      const outputs = await this.controlPlane.getCaseOutputs(branch.id);
      const links = issueLinks(await this.controlPlane.listCaseIssueLinks(branch.id));
      const outputVerified = hasHealthyWorkProduct(outputs, work.requiredWorkProduct);
      const issuesTerminal = links.length > 0
        && links.every((item) => TERMINAL_ISSUE_STATUSES.has(issueStatus(item)));

      if (outputVerified && issuesTerminal) {
        if (!TERMINAL_CASE_STAGES.has(branch.stageKey)) {
          await this.completeCase(branch, `已核验 ${work.requiredWorkProduct} 且分支任务终态。`);
          completed.push({ kind, caseId:branch.id });
        }
        continue;
      }
      if (links.some((item) => ACTIVE_ISSUE_STATUSES.has(issueStatus(item)))) {
        waiting.push({ kind, reason:'routine_active' });
        continue;
      }
      if (links.length > 0) {
        waiting.push({ kind, reason:outputVerified ? 'issue_not_terminal' : 'work_product_missing' });
        continue;
      }
      if (kind === 'voice' && !hasHealthyWorkProduct(dayOutputs, 'ScriptPackage')) {
        waiting.push({ kind, reason:'script_not_verified' });
        continue;
      }
      if (kind === 'visual_analysis') {
        const assets = ingested.branches.find(
          (item) => item.workBranch?.kind === 'assets',
        );
        const assetsReady = assets
          && hasHealthyWorkProduct(
            await this.controlPlane.getCaseOutputs(assets.id),
            'AssetPackage',
          );
        if (!assetsReady) {
          waiting.push({ kind, reason:'asset_package_not_verified' });
          continue;
        }
      }
      const active = await this.controlPlane.countActiveParallelIssues(this.pipelineId);
      if (active >= this.maxConcurrency) {
        waiting.push({ kind, reason:'global_concurrency_limit' });
        continue;
      }
      const routineKey = String(work.activationRoutineKey || '').trim();
      if (!routineKey) {
        waiting.push({ kind, reason:'activation_routine_missing' });
        continue;
      }
      const run = await this.controlPlane.runParallelRoutine({
        branch,
        routineKey,
        idempotencyKey:`${branch.caseKey}:routine:v${positiveVersion(branch.version)}`,
      });
      if (!run?.linkedIssueId) {
        throw new M5ParallelWorkCoordinatorError(`${kind} Routine 没有返回 Paperclip Issue。`);
      }
      await this.controlPlane.linkCaseIssue(branch.id, run.linkedIssueId, 'automation');
      await this.controlPlane.linkCaseIssue(day.id, run.linkedIssueId, 'work');
      dispatched.push({
        kind,
        caseId:branch.id,
        routineKey,
        issueId:run.linkedIssueId,
      });
    }

    const refreshedBranches = await Promise.all(
      ingested.branches.map(async (item) => requireParallelCase(
        await this.controlPlane.getCase(item.id),
        `并行工作分支不存在：${item.id}`,
      )),
    );
    const allComplete = refreshedBranches.every((branch) =>
      branch
      && TERMINAL_CASE_STAGES.has(branch.stageKey)
      && hasHealthyWorkProductSync(
        branch,
        ingested.branches,
      ),
    );
    // Work Product 不保存在 Case 字段中，必须从 Paperclip outputs 再读一次；
    // 上面的同步判断只防止身份漂移，真实汇聚判断在这里完成。
    const verifiedBranches = allComplete
      ? await Promise.all(refreshedBranches.map(async (branch) => {
        const expected = branch.workBranch?.requiredWorkProduct;
        return Boolean(expected)
          && hasHealthyWorkProduct(await this.controlPlane.getCaseOutputs(branch.id), expected);
      }))
      : [];
    let joined = false;
    let join = requireParallelCase(
      await this.controlPlane.getCase(ingested.join.id),
      '并行汇聚 Case 不存在。',
    );
    if (allComplete && verifiedBranches.every(Boolean)) {
      if (!TERMINAL_CASE_STAGES.has(join.stageKey)) {
        join = await this.completeCase(
          join,
          '五个并行分支均终态且对应 Work Product 已从 Paperclip outputs 核验。',
        );
      }
      joined = join.stageKey === 'done';
    }

    const research = refreshedBranches.find(
      (item) => item.workBranch?.kind === 'research',
    );
    const researchVerified = research
      && hasHealthyWorkProduct(
        await this.controlPlane.getCaseOutputs(research.id),
        research.workBranch.requiredWorkProduct,
      );
    const visualAnalysis = refreshedBranches.find(
      (item) => item.workBranch?.kind === 'visual_analysis',
    );
    const visualAnalysisVerified = visualAnalysis
      && hasHealthyWorkProduct(
        await this.controlPlane.getCaseOutputs(visualAnalysis.id),
        visualAnalysis.workBranch.requiredWorkProduct,
      );
    let dayCase = requireParallelCase(
      await this.controlPlane.getCase(day.id),
      '目标日期 Case 已消失。',
    );
    const scriptVerified = hasHealthyWorkProduct(
      await this.controlPlane.getCaseOutputs(day.id),
      'ScriptPackage',
    );
    if (
      researchVerified
      && visualAnalysisVerified
      && !scriptVerified
      && dayCase.stageKey === 'parallel_join_gate'
    ) {
      await this.controlPlane.completeParallelGateIssues?.(
        dayCase.id,
        'EvidencePackage 与 VisualAnalysisPackage 已核验；确定性协调器关闭当前汇聚门禁任务并进入脚本。',
      );
      dayCase = await this.controlPlane.transitionCase(dayCase.id, {
        toStageKey:'script',
        expectedVersion:positiveVersion(dayCase.version),
        reason:'EvidencePackage 与 VisualAnalysisPackage 均已核验，主线进入脚本；生图继续并行。',
        force:true,
      });
    } else if (scriptVerified && dayCase.stageKey === 'script') {
      dayCase = await this.controlPlane.transitionCase(dayCase.id, {
        toStageKey:'parallel_join_gate',
        expectedVersion:positiveVersion(dayCase.version),
        reason:'ScriptPackage 已核验，配音分支已可激活，主线返回汇聚门禁。',
        force:false,
      });
    }
    if (joined && dayCase.stageKey === 'parallel_join_gate') {
      await this.controlPlane.completeParallelGateIssues?.(
        dayCase.id,
        '五分支健康 Work Product 已核验；确定性协调器关闭当前汇聚门禁任务并进入渲染。',
      );
      dayCase = await this.controlPlane.transitionCase(dayCase.id, {
        toStageKey:'render',
        expectedVersion:positiveVersion(dayCase.version),
        reason:'研究、素材、画面分析、生图和配音五项 Work Product 均已核验，进入渲染。',
        force:true,
      });
    }

    return {
      created:{ join, branches:refreshedBranches },
      dayCase,
      dispatched,
      completed,
      waiting,
      joined,
    };
  }

  async completeCase(item: DynamicRecord, reason: string) {
    return this.controlPlane.transitionCase(item.id, {
      toStageKey:'done',
      expectedVersion:positiveVersion(item.version),
      reason,
      force:true,
    });
  }

  assertControlPlane() {
    const required = [
      'getCase',
      'getCaseOutputs',
      'listCaseIssueLinks',
      'countActiveParallelIssues',
      'runParallelRoutine',
      'linkCaseIssue',
      'transitionCase',
      'ensureParallelWorkCases',
    ];
    const missing = required.filter((key) => typeof this.controlPlane?.[key] !== 'function');
    if (missing.length) {
      throw new M5ParallelWorkCoordinatorError(
        `并行工作控制面缺少：${missing.join('、')}。`,
      );
    }
  }
}

export class M5ParallelWorkCoordinatorError extends Error {}

function requireParallelCase(value: DynamicRecord | null, message: string): DynamicRecord {
  if (!value) throw new M5ParallelWorkCoordinatorError(message);
  return value;
}

function issueLinks(value: unknown): DynamicRecord[] {
  return (Array.isArray(value) ? value : []).filter((item) => item?.issueId);
}

function issueStatus(item: DynamicRecord): string {
  return String(item?.status || '').trim();
}

function hasHealthyWorkProduct(value: unknown, expectedKind: unknown): boolean {
  const items = Array.isArray(value) ? value : [];
  return items.some((item) =>
    item?.recordKind === 'work_product'
    && item?.type === 'artifact'
    && item?.status === 'active'
    && item?.healthStatus === 'healthy'
    && item?.kind === expectedKind,
  );
}

function positiveVersion(value: unknown): number {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

function hasHealthyWorkProductSync(branch: DynamicRecord, declaredBranches: DynamicRecord[]): boolean {
  const declared = declaredBranches.find((item) => item.id === branch.id);
  return Boolean(
    declared
    && branch.caseKey === declared.caseKey
    && branch.workBranch?.requiredWorkProduct
      === declared.workBranch?.requiredWorkProduct,
  );
}
