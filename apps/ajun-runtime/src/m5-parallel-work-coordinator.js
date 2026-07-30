import {
  buildParallelWorkCaseBatch,
  ingestParallelWorkCaseBatch,
} from '../../../integrations/paperclip/m5-content-pipeline/src/index.js';

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

export class M5ParallelWorkCoordinator {
  constructor({ adapter, pipelineId, maxConcurrency = 4 } = {}) {
    if (!adapter || !pipelineId) {
      throw new M5ParallelWorkCoordinatorError('并行工作协调器缺少 Paperclip 适配器或 Pipeline。');
    }
    if (maxConcurrency !== 4) {
      throw new M5ParallelWorkCoordinatorError('M5 并行工作全局并发固定为4。');
    }
    this.adapter = adapter;
    this.pipelineId = pipelineId;
    this.maxConcurrency = maxConcurrency;
  }

  async reconcile(dayCaseId) {
    this.assertAdapter();
    const day = await this.adapter.getCase(dayCaseId);
    if (!day?.id || day.pipelineId !== this.pipelineId || !day.caseKey) {
      throw new M5ParallelWorkCoordinatorError('目标日期 Case 不属于 M5 Pipeline。');
    }
    const campaignId = String(day.fields?.campaignId || '').trim();
    const scheduledDate = String(day.fields?.scheduledDate || '').trim();
    const contentVersion = String(day.fields?.contentVersion || 'v1').trim();
    if (`${campaignId}:${scheduledDate}` !== day.caseKey) {
      throw new M5ParallelWorkCoordinatorError('目标日期 Case 的活动、日期或 caseKey 不一致。');
    }

    const dayOutputs = await this.adapter.getCaseOutputs(day.id);
    if (!hasHealthyWorkProduct(dayOutputs, 'TopicSelection')) {
      return {
        created:null,
        dispatched:[],
        completed:[],
        waiting:[{ kind:'parallel_batch', reason:'topic_not_verified' }],
        joined:false,
      };
    }

    const batch = buildParallelWorkCaseBatch({ campaignId, scheduledDate, contentVersion });
    const ingested = await ingestParallelWorkCaseBatch(
      this.adapter,
      this.pipelineId,
      batch,
      day,
    );
    const dispatched = [];
    const completed = [];
    const waiting = [];

    for (const kind of INITIAL_BRANCH_ORDER) {
      const branch = ingested.branches.find((item) => item.fields?.workBranch?.kind === kind);
      const work = branch?.fields?.workBranch;
      if (!branch || !work) {
        throw new M5ParallelWorkCoordinatorError(`并行工作分支缺失：${kind}。`);
      }
      const outputs = await this.adapter.getCaseOutputs(branch.id);
      const links = issueLinks(await this.adapter.listCaseIssueLinks(branch.id));
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
          (item) => item.fields?.workBranch?.kind === 'assets',
        );
        const assetsReady = assets
          && hasHealthyWorkProduct(
            await this.adapter.getCaseOutputs(assets.id),
            'AssetPackage',
          );
        if (!assetsReady) {
          waiting.push({ kind, reason:'asset_package_not_verified' });
          continue;
        }
      }
      const active = await this.adapter.countActiveParallelIssues(this.pipelineId);
      if (active >= this.maxConcurrency) {
        waiting.push({ kind, reason:'global_concurrency_limit' });
        continue;
      }
      const routineKey = String(work.activationRoutineKey || '').trim();
      if (!routineKey) {
        waiting.push({ kind, reason:'activation_routine_missing' });
        continue;
      }
      const run = await this.adapter.runParallelRoutine({
        branch,
        routineKey,
        idempotencyKey:`${branch.caseKey}:routine:v${positiveVersion(branch.version)}`,
      });
      if (!run?.linkedIssueId) {
        throw new M5ParallelWorkCoordinatorError(`${kind} Routine 没有返回 Paperclip Issue。`);
      }
      await this.adapter.linkCaseIssue(branch.id, run.linkedIssueId, 'automation');
      await this.adapter.linkCaseIssue(day.id, run.linkedIssueId, 'work');
      dispatched.push({
        kind,
        caseId:branch.id,
        routineKey,
        issueId:run.linkedIssueId,
      });
    }

    const refreshedBranches = await Promise.all(
      ingested.branches.map((item) => this.adapter.getCase(item.id)),
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
        const expected = branch.fields?.workBranch?.requiredWorkProduct;
        return Boolean(expected)
          && hasHealthyWorkProduct(await this.adapter.getCaseOutputs(branch.id), expected);
      }))
      : [];
    let joined = false;
    let join = await this.adapter.getCase(ingested.join.id);
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
      (item) => item.fields?.workBranch?.kind === 'research',
    );
    const researchVerified = research
      && hasHealthyWorkProduct(
        await this.adapter.getCaseOutputs(research.id),
        research.fields.workBranch.requiredWorkProduct,
      );
    const visualAnalysis = refreshedBranches.find(
      (item) => item.fields?.workBranch?.kind === 'visual_analysis',
    );
    const visualAnalysisVerified = visualAnalysis
      && hasHealthyWorkProduct(
        await this.adapter.getCaseOutputs(visualAnalysis.id),
        visualAnalysis.fields.workBranch.requiredWorkProduct,
      );
    let dayCase = await this.adapter.getCase(day.id);
    const scriptVerified = hasHealthyWorkProduct(
      await this.adapter.getCaseOutputs(day.id),
      'ScriptPackage',
    );
    if (
      researchVerified
      && visualAnalysisVerified
      && !scriptVerified
      && dayCase.stageKey === 'parallel_join_gate'
    ) {
      await this.adapter.completeParallelGateIssues?.(
        dayCase.id,
        'EvidencePackage 与 VisualAnalysisPackage 已核验；确定性协调器关闭当前汇聚门禁任务并进入脚本。',
      );
      dayCase = await this.adapter.transitionCase(dayCase.id, {
        toStageKey:'script',
        expectedVersion:positiveVersion(dayCase.version),
        reason:'EvidencePackage 与 VisualAnalysisPackage 均已核验，主线进入脚本；生图继续并行。',
        force:true,
      });
    } else if (scriptVerified && dayCase.stageKey === 'script') {
      dayCase = await this.adapter.transitionCase(dayCase.id, {
        toStageKey:'parallel_join_gate',
        expectedVersion:positiveVersion(dayCase.version),
        reason:'ScriptPackage 已核验，配音分支已可激活，主线返回汇聚门禁。',
        force:false,
      });
    }
    if (joined && dayCase.stageKey === 'parallel_join_gate') {
      await this.adapter.completeParallelGateIssues?.(
        dayCase.id,
        '五分支健康 Work Product 已核验；确定性协调器关闭当前汇聚门禁任务并进入渲染。',
      );
      dayCase = await this.adapter.transitionCase(dayCase.id, {
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

  async completeCase(item, reason) {
    return this.adapter.transitionCase(item.id, {
      toStageKey:'done',
      expectedVersion:positiveVersion(item.version),
      reason,
      force:true,
    });
  }

  assertAdapter() {
    const required = [
      'getCase',
      'getCaseOutputs',
      'listCaseIssueLinks',
      'countActiveParallelIssues',
      'runParallelRoutine',
      'linkCaseIssue',
      'ingestCase',
      'replaceCaseBlockers',
      'transitionCase',
    ];
    const missing = required.filter((key) => typeof this.adapter?.[key] !== 'function');
    if (missing.length) {
      throw new M5ParallelWorkCoordinatorError(
        `Paperclip 并行工作适配器缺少：${missing.join('、')}。`,
      );
    }
  }
}

export class M5ParallelWorkCoordinatorError extends Error {}

function issueLinks(value) {
  return (Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [])
    .filter((item) => item?.issue || item?.issueId);
}

function issueStatus(item) {
  return String(item?.issue?.status || item?.status || '').trim();
}

function hasHealthyWorkProduct(value, expectedKind) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
  return items.some((item) =>
    item?.kind === 'work_product'
    && item?.type === 'artifact'
    && item?.status === 'active'
    && item?.healthStatus === 'healthy'
    && item?.metadata?.kind === expectedKind,
  );
}

function positiveVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

function hasHealthyWorkProductSync(branch, declaredBranches) {
  const declared = declaredBranches.find((item) => item.id === branch.id);
  return Boolean(
    declared
    && branch.caseKey === declared.caseKey
    && branch.fields?.workBranch?.requiredWorkProduct
      === declared.fields?.workBranch?.requiredWorkProduct,
  );
}
