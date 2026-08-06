import {
  M5_PLATFORM_IDS,
  M5_SCHEMA_IDS,
} from '@agent-army/m5-contracts';
import {
  M5_SAFE_TEMPLATE_CONTROLS as SAFE_CONTROLS,
  M5ProductionTemplateResolutionError,
  defaultM5ProductionTemplateBinding,
  freezeM5ProductionTemplateBinding as freezeBinding,
  hasSafeM5TemplateControls as safeControls,
  m5GrayProductionTemplateBinding,
  m5ProductionTemplateResolutionBlocked as blockedResolution,
  normalizeM5TemplateGuidance as normalizeGuidance,
  validM5TemplateGuidance,
} from '@agent-army/m5-kernel/production-template-binding';

export {
  M5ProductionTemplateResolutionError,
  defaultM5ProductionTemplateBinding,
  m5GrayProductionTemplateBinding,
  m5ProductionTemplateBindingHash,
  validM5ProductionTemplateBinding,
  validM5TemplateGuidance,
} from '@agent-army/m5-kernel/production-template-binding';

const PROVIDER = 'agent-army.m5-learning';
const DECISION_SCHEMA = M5_SCHEMA_IDS.TEMPLATE_DECISION;
const TEMPLATE_SCHEMA = M5_SCHEMA_IDS.TEMPLATE_VERSION;

/**
 * Read-only resolver for the production content template.
 *
 * It never writes lifecycle state and fails closed to the built-in template
 * when approval lineage is missing, ambiguous or unsafe.
 */
export class M5ProductionTemplateResolver {
  constructor({ governance } = {}) {
    this.governance = governance;
  }

  async resolve(pipelineCaseId) {
    if (typeof this.governance?.getRetrospectiveMetricOutputs !== 'function') {
      return defaultM5ProductionTemplateBinding('resolver_unavailable');
    }
    const caseId = String(pipelineCaseId || '').trim();
    if (!caseId) return defaultM5ProductionTemplateBinding('case_missing');
    const outputs = outputItems(
      await this.governance.getRetrospectiveMetricOutputs(caseId),
    );
    const decisionCandidates = outputs.filter((item) => candidateShape(item, {
      kind:'TemplateDecision',
    }));
    const decisions = decisionCandidates.filter((item) => productShape(item, {
      schemaVersion:DECISION_SCHEMA,
      kind:'TemplateDecision',
    }));
    if (decisionCandidates.length !== decisions.length) {
      throw blockedResolution('decision_candidate_invalid');
    }
    if (decisions.length === 0) return resolveGrayCandidate(caseId, outputs);
    if (decisions.some((item) =>
      !Number.isFinite(Date.parse(String(item.metadata?.decision?.decidedAt || ''))))) {
      throw blockedResolution('decision_time_invalid');
    }
    decisions.sort((left, right) => {
      const byTime = Date.parse(right.metadata.decision.decidedAt)
        - Date.parse(left.metadata.decision.decidedAt);
      return byTime || String(right.id || '').localeCompare(String(left.id || ''));
    });
    const latestAt = decisions[0].metadata.decision.decidedAt;
    const latest = decisions.filter((item) =>
      item.metadata.decision.decidedAt === latestAt);
    if (latest.length !== 1) throw blockedResolution('decision_ambiguous');
    const targetTemplates = grayTargetTemplates(caseId, outputs);
    if (targetTemplates.length > 1) throw blockedResolution('gray_template_ambiguous');
    if (targetTemplates.length === 1) {
      const approvedAt = Date.parse(
        String(targetTemplates[0].metadata.templateVersion.approvedAt || ''),
      );
      if (!Number.isFinite(approvedAt)) throw blockedResolution('gray_template_time_invalid');
      if (approvedAt > Date.parse(latestAt)) return resolveGrayCandidate(caseId, outputs);
    }
    return resolveDecision(latest[0], outputs);
  }

  async resolveGrayForDay(dayCaseId) {
    if (typeof this.governance?.getRetrospectiveMetricOutputs !== 'function') return null;
    const caseId = String(dayCaseId || '').trim();
    if (!caseId) return null;
    const outputs = outputItems(
      await this.governance.getRetrospectiveMetricOutputs(caseId),
    );
    const templates = grayDayTemplates(caseId, outputs);
    if (templates.length > 1) throw blockedResolution('gray_day_template_ambiguous');
    if (templates.length === 0) return null;
    return resolveGrayTemplate(templates[0]);
  }
}

function resolveDecision(product, outputs) {
  const decision = product.metadata.decision;
  if (!safeControls(decision.controls)) throw blockedResolution('unsafe_controls');
  if (decision.status === 'validated') {
    if (
      decision.productionDefault !== true
      || decision.automaticRollback !== false
      || decision.activeTemplateVersionId !== decision.templateVersionId
      || !String(decision.activeTemplateVersionId || '').trim()
    ) throw blockedResolution('validated_decision_invalid');
    const templates = outputs.filter((item) =>
      productShape(item, { schemaVersion:TEMPLATE_SCHEMA, kind:'TemplateVersion' })
      && item.metadata?.templateVersion?.templateVersionId === decision.activeTemplateVersionId);
    if (templates.length !== 1) throw blockedResolution('template_lineage_missing');
    const template = templates[0].metadata.templateVersion;
    if (
      template.productionDefault !== false
      || template.state !== 'gray_ready'
      || !safeControls(template.controls)
      || template.previousTemplateVersionId !== decision.previousTemplateVersionId
      || !validM5TemplateGuidance(template.suggestedChanges)
    ) throw blockedResolution('template_lineage_invalid');
    return approvedBinding({
      product,
      decision,
      templateProduct:templates[0],
      contentGuidance:normalizeGuidance(template.suggestedChanges),
    });
  }
  if (decision.status === 'rolled_back') {
    if (
      decision.productionDefault !== false
      || decision.automaticRollback !== true
      || decision.activeTemplateVersionId !== decision.previousTemplateVersionId
      || !String(decision.activeTemplateVersionId || '').trim()
    ) throw blockedResolution('rollback_decision_invalid');
    return approvedBinding({ product, decision, contentGuidance:[] });
  }
  throw blockedResolution('decision_not_approved');
}

function approvedBinding({ product, decision, templateProduct = null, contentGuidance }) {
  return freezeBinding({
    schemaVersion:M5_SCHEMA_IDS.PRODUCTION_TEMPLATE_BINDING,
    templateVersionId:decision.activeTemplateVersionId,
    source:'approved_learning_decision',
    decisionStatus:decision.status,
    decisionWorkProductId:String(product.id || ''),
    templateWorkProductId:templateProduct ? String(templateProduct.id || '') : null,
    productionDefault:decision.status === 'validated',
    contentGuidance,
    controls:SAFE_CONTROLS,
  });
}

function resolveGrayCandidate(caseId, outputs) {
  const templates = grayTargetTemplates(caseId, outputs);
  if (templates.length > 1) throw blockedResolution('gray_template_ambiguous');
  if (templates.length !== 1) return defaultM5ProductionTemplateBinding('decision_not_approved');
  return resolveGrayTemplate(templates[0]);
}

function resolveGrayTemplate(product) {
  const template = product.metadata.templateVersion;
  if (
    template.state !== 'gray_ready'
    || template.productionDefault !== false
    || template.grayReleaseLimit !== 1
    || template.grayTargetPlatform !== M5_PLATFORM_IDS.DOUYIN
    || template.applicationScope !== 'full_content_variant'
    || !safeControls(template.controls)
    || !validM5TemplateGuidance(template.suggestedChanges)
    || !String(template.templateVersionId || '').trim()
  ) throw blockedResolution('gray_template_invalid');
  return m5GrayProductionTemplateBinding({
    templateVersion:template,
    templateWorkProductId:String(product.id || ''),
  });
}

function grayTargetTemplates(caseId, outputs) {
  return outputs.filter((item) =>
    productShape(item, { schemaVersion:TEMPLATE_SCHEMA, kind:'TemplateVersion' })
    && item.metadata?.templateVersion?.grayTargetCaseId === caseId);
}

function grayDayTemplates(caseId, outputs) {
  return outputs.filter((item) =>
    productShape(item, { schemaVersion:TEMPLATE_SCHEMA, kind:'TemplateVersion' })
    && item.metadata?.templateVersion?.grayTargetDayCaseId === caseId);
}

function candidateShape(item, { kind }) {
  return item?.kind === 'work_product'
    && item?.type === 'document'
    && item?.provider === PROVIDER
    && ['active', 'approved'].includes(item?.status)
    && item?.metadata?.kind === kind;
}

function productShape(item, { schemaVersion, kind }) {
  return item?.kind === 'work_product'
    && item?.type === 'document'
    && item?.provider === PROVIDER
    && item?.sourceTrust == null
    && ['active', 'approved'].includes(item?.status)
    && item?.healthStatus === 'healthy'
    && item?.metadata?.schemaVersion === schemaVersion
    && item?.metadata?.kind === kind;
}

function outputItems(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
