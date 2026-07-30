import crypto from 'node:crypto';

const PROVIDER = 'agent-army.m5-learning';
const RETROSPECTIVE_PROVIDER = 'agent-army.m5-retrospective';
const CONTENT_PROVIDER = 'agent-army.content-autonomy';
const METRIC_PROVIDER = 'agent-army.publisher-gateway';

const SCHEMAS = Object.freeze({
  retrospective:'agent.army/m5-retrospective/v1',
  offlineReplay:'agent.army/m5-offline-replay/v1',
  proposal:'agent.army/learning-proposal/v1',
  template:'agent.army/template-version/v1',
  grayRelease:'agent.army/template-gray-release/v1',
  decision:'agent.army/template-decision/v1',
  contentVersion:'agent.army/content-version/v1',
  machineReview:'agent.army/machine-review/v1',
  metric:'agent.army/metric-snapshot/v1',
});

const REQUIRED_REVIEW_CHECKS = Object.freeze([
  'facts',
  'privacy',
  'rights',
  'media',
  'claims',
  'grantScope',
  'duplicate',
]);
const PRIMARY_METRIC_PRIORITY = Object.freeze([
  'completionRate',
  'saveRate',
  'engagementRate',
  'views',
  'likes',
]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Deterministic M5 learning lifecycle.
 *
 * Every durable state is an Issue Work Product attached to the existing
 * Paperclip Case. The coordinator does not keep a local store and never
 * mutates prompts, permissions, cadence, promotion or account settings.
 */
export class M5LearningLifecycle {
  constructor({ governance, now = () => new Date() } = {}) {
    this.governance = governance;
    this.now = now;
  }

  async advance({ caseId, issueId, runId } = {}) {
    this.assertDependencies();
    const context = {
      caseId:uuid(caseId, '学习生命周期 Case 标识无效。'),
      issueId:uuid(issueId, '学习生命周期 Issue 标识无效。'),
      runId:uuid(runId, '学习生命周期 Run 标识无效。'),
    };
    const [casePayload, pipelinePayload] = await Promise.all([
      this.governance.getPipelineCaseOutputs(context.caseId),
      this.governance.getRetrospectiveMetricOutputs(context.caseId),
    ]);
    const caseOutputs = outputItems(casePayload);
    const pipelineOutputs = mergeOutputs(caseOutputs, outputItems(pipelinePayload));
    const retrospective = uniqueProduct(
      caseOutputs,
      (item) => trustedProduct(item, {
        provider:RETROSPECTIVE_PROVIDER,
        schemaVersion:SCHEMAS.retrospective,
        kind:'Retrospective',
      }) && item.metadata?.report?.status === 'proposal_ready',
      '可信 Retrospective',
    );
    if (!retrospective) {
      throw new M5LearningLifecycleError('当前 Case 没有达到五条真实样本门槛的 Retrospective。');
    }

    const decision = lifecycleProduct(caseOutputs, SCHEMAS.decision, 'TemplateDecision');
    if (decision) {
      return {
        state:decision.metadata.decision.status,
        replayed:true,
        workProductId:decision.id,
      };
    }

    const offlineReplay = lifecycleProduct(caseOutputs, SCHEMAS.offlineReplay, 'OfflineReplay');
    if (!offlineReplay) {
      const replay = buildOfflineReplay(retrospective, pipelineOutputs, this.now());
      return this.write(context, {
        kind:'OfflineReplay',
        schemaVersion:SCHEMAS.offlineReplay,
        type:'document',
        title:'M5 模板离线历史回放',
        summary:`已在 ${replay.sampleCount} 条历史内容上重放事实、隐私、版权和媒体门禁；不声称播放量提升。`,
        data:{ replay },
      });
    }

    const proposalProduct = lifecycleProduct(caseOutputs, SCHEMAS.proposal, 'LearningProposal');
    if (!proposalProduct) {
      const proposal = materializeProposal(retrospective, offlineReplay);
      return this.write(context, {
        kind:'LearningProposal',
        schemaVersion:SCHEMAS.proposal,
        type:'document',
        status:'ready_for_review',
        reviewState:'needs_board_review',
        title:'M5 模板改进提案',
        summary:'离线回放已通过，等待审核官在 Paperclip 审批；不会自动修改生产模板。',
        data:{ proposal },
      });
    }

    if (proposalProduct.reviewState === 'changes_requested') {
      return this.writeDecision(context, {
        status:'rejected',
        templateVersionId:null,
        previousTemplateVersionId:defaultTemplateVersionId(proposalProduct),
        grayContentVersionId:null,
        reasons:['审核官要求修改，未创建新模板版本。'],
        automaticRollback:false,
      });
    }
    if (proposalProduct.reviewState !== 'approved') {
      return {
        state:'waiting_reviewer_approval',
        replayed:true,
        workProductId:proposalProduct.id,
      };
    }

    const templateProduct = lifecycleProduct(caseOutputs, SCHEMAS.template, 'TemplateVersion');
    if (!templateProduct) {
      const templateVersion = approvedTemplateVersion(proposalProduct, offlineReplay, this.now());
      return this.write(context, {
        kind:'TemplateVersion',
        schemaVersion:SCHEMAS.template,
        type:'document',
        title:`M5 模板版本 ${templateVersion.version}`,
        summary:'审核已通过；新版本只允许一条灰度内容，尚未成为生产默认版本。',
        data:{ templateVersion },
      });
    }

    const templateVersion = templateProduct.metadata.templateVersion;
    const grayCandidates = trustedGrayContentVersions(pipelineOutputs, templateVersion.templateVersionId);
    if (grayCandidates.length > 1) {
      throw new M5LearningLifecycleError(
        `模板版本 ${templateVersion.templateVersionId} 只能灰度一条内容，当前发现 ${grayCandidates.length} 条。`,
      );
    }
    if (grayCandidates.length === 0) {
      return {
        state:'waiting_single_gray_content',
        replayed:true,
        workProductId:templateProduct.id,
      };
    }

    const grayContentVersion = grayCandidates[0];
    const grayRelease = lifecycleProduct(caseOutputs, SCHEMAS.grayRelease, 'TemplateGrayRelease');
    if (!grayRelease) {
      return this.write(context, {
        kind:'TemplateGrayRelease',
        schemaVersion:SCHEMAS.grayRelease,
        type:'artifact',
        title:'M5 单条模板灰度',
        summary:`模板 ${templateVersion.templateVersionId} 仅绑定内容 ${grayContentVersion.contentVersionId}。`,
        data:{
          grayRelease:{
            templateVersionId:templateVersion.templateVersionId,
            contentVersionId:grayContentVersion.contentVersionId,
            platform:grayContentVersion.platform,
            maximumUses:1,
            usedUses:1,
            releasedAt:validDate(this.now()).toISOString(),
            automaticProductionMutation:false,
          },
        },
      });
    }
    if (
      grayRelease.metadata.grayRelease?.templateVersionId !== templateVersion.templateVersionId
      || grayRelease.metadata.grayRelease?.contentVersionId !== grayContentVersion.contentVersionId
      || grayRelease.metadata.grayRelease?.maximumUses !== 1
      || grayRelease.metadata.grayRelease?.usedUses !== 1
    ) {
      throw new M5LearningLifecycleError('单条灰度 Work Product 与审核后的模板版本不一致。');
    }

    const review = uniqueMachineReview(pipelineOutputs, grayContentVersion.contentVersionId);
    const snapshot = uniqueGrayMetric(pipelineOutputs, grayContentVersion);
    if (!review || !snapshot) {
      return {
        state:'waiting_gray_quality_and_72h_metric',
        replayed:true,
        workProductId:grayRelease.id,
      };
    }
    const outcome = evaluateGrayOutcome({
      offlineReplay:offlineReplay.metadata.replay,
      templateVersion,
      grayContentVersion,
      review,
      snapshot,
    });
    return this.writeDecision(context, outcome);
  }

  async writeDecision(context, decision) {
    return this.write(context, {
      kind:'TemplateDecision',
      schemaVersion:SCHEMAS.decision,
      type:'document',
      title:decision.status === 'rolled_back' ? 'M5 模板自动回退决定' : 'M5 模板灰度决定',
      summary:decision.status === 'rolled_back'
        ? `质量或指标下降，已决定回退到 ${decision.previousTemplateVersionId}。`
        : decision.status === 'validated'
          ? '单条灰度质量与主指标未下降，模板版本通过灰度。'
          : '模板提案未通过审核。',
      data:{
        decision:{
          ...decision,
          decidedAt:validDate(this.now()).toISOString(),
          controls:productionControls(),
        },
      },
    });
  }

  async write(context, {
    kind,
    schemaVersion,
    type,
    title,
    summary,
    data,
    status = 'active',
    reviewState = 'none',
  }) {
    const product = await this.governance.createIssueWorkProduct(context.issueId, {
      type,
      provider:PROVIDER,
      externalId:externalId(context.caseId, kind),
      title,
      status,
      reviewState,
      isPrimary:false,
      healthStatus:'healthy',
      summary,
      metadata:{
        schemaVersion,
        kind,
        caseId:context.caseId,
        ...data,
      },
      createdByRunId:context.runId,
    }, { runId:context.runId });
    return {
      state:stateForKind(kind, data),
      replayed:false,
      createdKind:kind,
      workProductId:product?.id || null,
    };
  }

  assertDependencies() {
    const required = [
      'getPipelineCaseOutputs',
      'getRetrospectiveMetricOutputs',
      'createIssueWorkProduct',
    ];
    if (required.some((method) => typeof this.governance?.[method] !== 'function')) {
      throw new M5LearningLifecycleError('M5 学习生命周期缺少 Paperclip Case/Work Product 适配。');
    }
  }
}

export class M5LearningLifecycleError extends Error {}

export function buildOfflineReplay(retrospectiveProduct, pipelineOutputs, now = new Date()) {
  const report = retrospectiveProduct?.metadata?.report;
  const proposal = report?.learningProposal;
  if (
    proposal?.status !== 'proposed'
    || proposal.offlineReplayRequired !== true
    || proposal.reviewerApprovalRequired !== true
    || proposal.grayReleaseLimit !== 1
    || proposal.automaticProductionMutation !== false
    || !safeProductionControls(report?.controls)
  ) {
    throw new M5LearningLifecycleError('LearningProposal 未保持离线回放、人工审核和单条灰度安全边界。');
  }
  const refs = new Set(Array.isArray(report.metricSnapshotRefs) ? report.metricSnapshotRefs : []);
  if (refs.size < 5 || Number(report.sampleCount) < 5) {
    throw new M5LearningLifecycleError('离线回放至少需要五条同类型真实 72h 指标。');
  }
  const samples = trusted72hSnapshots(pipelineOutputs)
    .filter((item) => refs.has(item.snapshot.snapshotId));
  if (samples.length !== refs.size) {
    throw new M5LearningLifecycleError('离线回放无法回读全部历史 MetricSnapshot。');
  }
  const reviews = samples.map((sample) =>
    uniqueMachineReview(pipelineOutputs, sample.snapshot.contentVersionId));
  if (reviews.some((review) => !review || !machineReviewPassed(review))) {
    throw new M5LearningLifecycleError('离线回放要求每条历史内容都能回到通过的 MachineReview。');
  }
  const baselineMetrics = aggregateNumericMetrics(samples.map((item) => item.snapshot.metrics));
  const primaryMetric = PRIMARY_METRIC_PRIORITY.find((key) =>
    Number.isFinite(Number(baselineMetrics[key])));
  if (!primaryMetric) {
    throw new M5LearningLifecycleError('离线回放没有可比较的主指标。');
  }
  return {
    replayId:`replay_${digest(`${proposal.proposalId}:${[...refs].sort().join(':')}`).slice(0, 24)}`,
    proposalId:proposal.proposalId,
    status:'passed_for_review',
    sampleType:report.sampleType,
    sampleCount:samples.length,
    metricSnapshotRefs:[...refs].sort(),
    machineReviewRefs:reviews.map((item) => item.id).sort(),
    baselineMetrics,
    primaryMetric,
    safetyReplay:{
      facts:true,
      privacy:true,
      rights:true,
      media:true,
      claims:true,
      grantScope:true,
      duplicate:true,
    },
    historicalOnly:true,
    estimatedLift:null,
    performanceClaimed:false,
    replayedAt:validDate(now).toISOString(),
    controls:productionControls(),
  };
}

function materializeProposal(retrospectiveProduct, offlineReplayProduct) {
  const source = retrospectiveProduct.metadata.report.learningProposal;
  const replay = offlineReplayProduct.metadata.replay;
  if (
    replay.status !== 'passed_for_review'
    || replay.proposalId !== source.proposalId
    || replay.performanceClaimed !== false
  ) {
    throw new M5LearningLifecycleError('离线回放与 LearningProposal 不一致。');
  }
  return {
    ...structuredClone(source),
    status:'proposed',
    offlineReplayId:replay.replayId,
    baseTemplateVersionId:'m5-template-default-v1',
    requestedChangeCount:1,
    controls:productionControls(),
  };
}

function approvedTemplateVersion(proposalProduct, offlineReplayProduct, now) {
  const proposal = proposalProduct.metadata.proposal;
  const replay = offlineReplayProduct.metadata.replay;
  if (
    proposal?.offlineReplayId !== replay?.replayId
    || proposal?.requestedChangeCount !== 1
    || !safeProductionControls(proposal?.controls)
  ) {
    throw new M5LearningLifecycleError('审核后的提案与离线回放或单变量约束不一致。');
  }
  const previousTemplateVersionId = String(
    proposal.baseTemplateVersionId || 'm5-template-default-v1',
  );
  return {
    templateVersionId:`template_${digest(`${proposal.proposalId}:v2`).slice(0, 24)}`,
    version:2,
    previousTemplateVersionId,
    sourceProposalId:proposal.proposalId,
    sourceOfflineReplayId:replay.replayId,
    state:'gray_ready',
    grayReleaseLimit:1,
    productionDefault:false,
    suggestedChanges:structuredClone(proposal.suggestedChanges || []).slice(0, 1),
    approvedAt:validDate(now).toISOString(),
    controls:productionControls(),
  };
}

function evaluateGrayOutcome({
  offlineReplay,
  templateVersion,
  grayContentVersion,
  review,
  snapshot,
}) {
  const primaryMetric = offlineReplay.primaryMetric;
  const baseline = Number(offlineReplay.baselineMetrics?.[primaryMetric]);
  const actual = Number(snapshot.metrics?.[primaryMetric]);
  const qualityPassed = machineReviewPassed(review);
  const comparable = Number.isFinite(baseline) && Number.isFinite(actual);
  const metricDeclined = !comparable || actual < baseline;
  const reasons = [];
  if (!qualityPassed) reasons.push('灰度内容机器审核质量低于生产门禁。');
  if (!comparable) reasons.push(`灰度 72h 指标缺少可比较主指标 ${primaryMetric}。`);
  else if (metricDeclined) reasons.push(`灰度主指标 ${primaryMetric} 从历史均值 ${baseline} 降至 ${actual}。`);
  const rollback = !qualityPassed || metricDeclined;
  return {
    status:rollback ? 'rolled_back' : 'validated',
    templateVersionId:templateVersion.templateVersionId,
    previousTemplateVersionId:templateVersion.previousTemplateVersionId,
    activeTemplateVersionId:rollback
      ? templateVersion.previousTemplateVersionId
      : templateVersion.templateVersionId,
    grayContentVersionId:grayContentVersion.contentVersionId,
    grayMetricSnapshotId:snapshot.snapshotId,
    grayMachineReviewId:review.id,
    qualityPassed,
    performance:{
      primaryMetric,
      baseline,
      actual:Number.isFinite(actual) ? actual : null,
      comparable,
      declined:metricDeclined,
    },
    reasons,
    automaticRollback:rollback,
    productionDefault:!rollback,
  };
}

function trustedGrayContentVersions(outputs, templateVersionId) {
  const byContentVersion = new Map();
  for (const item of outputItems(outputs)) {
    if (!trustedProduct(item, {
      provider:CONTENT_PROVIDER,
      schemaVersion:SCHEMAS.contentVersion,
      kind:'ContentVersion',
    })) continue;
    const version = item.metadata?.contentVersion;
    if (
      version?.templateVersionId !== templateVersionId
      || version?.grayRelease !== true
      || !String(version.contentVersionId || '').trim()
      || !['douyin', 'xiaohongshu'].includes(version.platform)
    ) continue;
    byContentVersion.set(version.contentVersionId, structuredClone(version));
  }
  return [...byContentVersion.values()];
}

function uniqueMachineReview(outputs, contentVersionId) {
  const matches = outputItems(outputs).filter((item) =>
    trustedProduct(item, {
      provider:CONTENT_PROVIDER,
      schemaVersion:SCHEMAS.machineReview,
      kind:'MachineReview',
    })
    && item.metadata?.reviewReport?.contentVersionId === contentVersionId);
  if (matches.length > 1) {
    throw new M5LearningLifecycleError(`内容 ${contentVersionId} 存在多个可信 MachineReview。`);
  }
  return matches[0] || null;
}

function uniqueGrayMetric(outputs, contentVersion) {
  const matches = trusted72hSnapshots(outputs).filter((item) =>
    item.snapshot.contentVersionId === contentVersion.contentVersionId
    && item.snapshot.platform === contentVersion.platform);
  if (matches.length > 1) {
    throw new M5LearningLifecycleError(`灰度内容 ${contentVersion.contentVersionId} 存在多个可信 72h 指标。`);
  }
  return matches[0]?.snapshot || null;
}

function trusted72hSnapshots(outputs) {
  const byContentVersion = new Map();
  for (const item of outputItems(outputs)) {
    if (!trustedProduct(item, {
      provider:METRIC_PROVIDER,
      schemaVersion:SCHEMAS.metric,
      kind:'MetricSnapshot',
    }) || item.metadata?.checkpoint !== '72h') continue;
    const snapshot = item.metadata?.snapshot;
    if (
      !snapshot
      || !String(snapshot.snapshotId || '').trim()
      || !String(snapshot.contentVersionId || '').trim()
      || !['douyin', 'xiaohongshu'].includes(snapshot.platform)
      || !Number.isFinite(Date.parse(snapshot.collectedAt))
      || !snapshot.metrics
      || typeof snapshot.metrics !== 'object'
      || Array.isArray(snapshot.metrics)
    ) continue;
    const current = byContentVersion.get(snapshot.contentVersionId);
    if (!current || Date.parse(snapshot.collectedAt) > Date.parse(current.snapshot.collectedAt)) {
      byContentVersion.set(snapshot.contentVersionId, { id:item.id, snapshot:structuredClone(snapshot) });
    }
  }
  return [...byContentVersion.values()];
}

function machineReviewPassed(item) {
  const report = item?.metadata?.reviewReport;
  return report?.status === 'passed'
    && REQUIRED_REVIEW_CHECKS.every((key) => report?.checks?.[key] === true);
}

function aggregateNumericMetrics(metricsList) {
  const values = new Map();
  for (const metrics of metricsList) {
    for (const [key, value] of Object.entries(metrics || {})) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      const entries = values.get(key) || [];
      entries.push(numeric);
      values.set(key, entries);
    }
  }
  return Object.fromEntries([...values.entries()].map(([key, entries]) => [
    key,
    entries.reduce((total, value) => total + value, 0) / entries.length,
  ]));
}

function lifecycleProduct(outputs, schemaVersion, kind) {
  return uniqueProduct(
    outputs,
    (item) => trustedProduct(item, { provider:PROVIDER, schemaVersion, kind }),
    kind,
  );
}

function uniqueProduct(outputs, predicate, label) {
  const matches = outputItems(outputs).filter(predicate);
  if (matches.length > 1) {
    throw new M5LearningLifecycleError(`当前 Case 存在多个 ${label} Work Product。`);
  }
  return matches[0] || null;
}

function trustedProduct(item, { provider, schemaVersion, kind }) {
  return item?.kind === 'work_product'
    && item?.provider === provider
    && item?.sourceTrust == null
    && ['active', 'approved', 'ready_for_review', 'changes_requested'].includes(item?.status)
    && item?.healthStatus === 'healthy'
    && item?.metadata?.schemaVersion === schemaVersion
    && item?.metadata?.kind === kind;
}

function mergeOutputs(left, right) {
  const rows = new Map();
  for (const item of [...left, ...right]) {
    const key = String(item?.id || `${item?.provider}:${item?.externalId}:${rows.size}`);
    if (!rows.has(key)) rows.set(key, item);
  }
  return [...rows.values()];
}

function outputItems(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function safeProductionControls(value) {
  return value?.promptMutation === false
    && value?.permissionExpansion === false
    && value?.frequencyIncrease === false
    && value?.paidPromotion === false;
}

function productionControls() {
  return {
    promptMutation:false,
    permissionExpansion:false,
    frequencyIncrease:false,
    paidPromotion:false,
  };
}

function defaultTemplateVersionId(proposalProduct) {
  return String(proposalProduct?.metadata?.proposal?.baseTemplateVersionId || 'm5-template-default-v1');
}

function stateForKind(kind, data) {
  if (kind === 'OfflineReplay') return 'offline_replay_passed';
  if (kind === 'LearningProposal') return 'waiting_reviewer_approval';
  if (kind === 'TemplateVersion') return 'waiting_single_gray_content';
  if (kind === 'TemplateGrayRelease') return 'waiting_gray_quality_and_72h_metric';
  if (kind === 'TemplateDecision') return data.decision.status;
  return 'unknown';
}

function externalId(caseId, kind) {
  return `m5_learning_${digest(`${caseId}:${kind}`).slice(0, 32)}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function uuid(value, message) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw new M5LearningLifecycleError(message);
  return id;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new M5LearningLifecycleError('学习生命周期时钟无效。');
  return date;
}
