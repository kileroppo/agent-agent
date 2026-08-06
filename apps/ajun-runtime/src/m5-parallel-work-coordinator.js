import {
  M5ParallelWorkCoordinator as KernelParallelWorkCoordinator,
  M5ParallelWorkCoordinatorError,
} from '@agent-army/m5-kernel/parallel-work-coordinator';
import {
  normalizePaperclipCase,
  normalizePaperclipWorkProduct,
} from '@agent-army/m5-kernel';
import {
  buildParallelWorkCaseBatch,
  ingestParallelWorkCaseBatch,
} from '@agent-army/m5-content-pipeline';

export { M5ParallelWorkCoordinatorError };

export class M5ParallelWorkCoordinator extends KernelParallelWorkCoordinator {
  constructor({ adapter, controlPlane, ...options } = {}) {
    super({
      ...options,
      controlPlane:controlPlane || legacyParallelControlPlane(adapter),
    });
  }

  async reconcile(caseId) {
    return legacyResult(await super.reconcile(caseId));
  }
}

function legacyParallelControlPlane(adapter) {
  return {
    getCase:async (id) => normalizePaperclipCase(await adapter.getCase(id)),
    getCaseOutputs:async (id) => (await adapter.getCaseOutputs(id))
      .map(normalizePaperclipWorkProduct).filter(Boolean),
    listCaseIssueLinks:async (id) => (await adapter.listCaseIssueLinks(id)).map((item) => ({
      issueId:item?.issue?.id || item?.issueId || null,
      status:item?.issue?.status || item?.status || null,
      title:item?.issue?.title || '',
      description:item?.issue?.description || '',
    })),
    countActiveParallelIssues:(...args) => adapter.countActiveParallelIssues(...args),
    runParallelRoutine:(input) => adapter.runParallelRoutine({
      ...input,
      branch:legacyCase(input.branch),
    }),
    linkCaseIssue:(...args) => adapter.linkCaseIssue(...args),
    completeParallelGateIssues:(...args) => adapter.completeParallelGateIssues?.(...args),
    transitionCase:async (...args) => normalizePaperclipCase(await adapter.transitionCase(...args)),
    async ensureParallelWorkCases(pipelineId, day) {
      const batch = buildParallelWorkCaseBatch({
        campaignId:day.campaignId,
        scheduledDate:day.scheduledDate,
        contentVersion:day.contentVersion || 'v1',
      });
      const result = await ingestParallelWorkCaseBatch(adapter, pipelineId, batch, legacyCase(day));
      return {
        join:normalizePaperclipCase(result.join),
        branches:result.branches.map(normalizePaperclipCase),
      };
    },
  };
}

function legacyResult(value) {
  return {
    ...value,
    created:value.created && {
      join:legacyCase(value.created.join),
      branches:value.created.branches.map(legacyCase),
    },
    dayCase:value.dayCase ? legacyCase(value.dayCase) : value.dayCase,
  };
}

function legacyCase(value) {
  if (!value) return value;
  return {
    id:value.id,
    version:value.version,
    pipelineId:value.pipelineId,
    projectId:value.projectId,
    parentCaseId:value.parentCaseId,
    caseKey:value.caseKey,
    stageKey:value.stageKey,
    fields:{
      campaignGrant:value.campaignGrant || undefined,
      campaignPlan:value.campaignPlan || undefined,
      campaignId:value.campaignId || undefined,
      scheduledDate:value.scheduledDate || undefined,
      theme:value.theme || undefined,
      assetRightsBasis:value.assetRightsBasis || undefined,
      platform:value.platform || undefined,
      contentVersion:value.contentVersion || undefined,
      workBranch:value.workBranch || undefined,
      parallelJoin:value.parallelJoin || undefined,
      m5ContentRecovery:value.contentRecovery || undefined,
      m5StageRecovery:value.stageRecovery || undefined,
    },
  };
}
