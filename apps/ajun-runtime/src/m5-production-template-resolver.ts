import { M5_PLATFORM_IDS, M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
import { M5_SAFE_TEMPLATE_CONTROLS as SAFE_CONTROLS, M5ProductionTemplateResolutionError, defaultM5ProductionTemplateBinding, freezeM5ProductionTemplateBinding as freezeBinding, hasSafeM5TemplateControls as safeControls, m5GrayProductionTemplateBinding, m5ProductionTemplateResolutionBlocked as blockedResolution, normalizeM5TemplateGuidance as normalizeGuidance, validM5TemplateGuidance, } from '@agent-army/m5-kernel/production-template-binding';
export { M5ProductionTemplateResolutionError, defaultM5ProductionTemplateBinding, m5GrayProductionTemplateBinding, m5ProductionTemplateBindingHash, validM5ProductionTemplateBinding, validM5TemplateGuidance, } from '@agent-army/m5-kernel/production-template-binding';
const PROVIDER: any = 'agent-army.m5-learning';
const DECISION_SCHEMA: any = M5_SCHEMA_IDS.TEMPLATE_DECISION;
const TEMPLATE_SCHEMA: any = M5_SCHEMA_IDS.TEMPLATE_VERSION;
/**
 * Read-only resolver for the production content template.
 *
 * It never writes lifecycle state and fails closed to the built-in template
 * when approval lineage is missing, ambiguous or unsafe.
 */
export class M5ProductionTemplateResolver {
    governance: any;
    constructor({ governance }: any = {}) {
        this.governance = governance;
    }
    async resolve(pipelineCaseId: any): Promise<any> {
        if (typeof this.governance?.getRetrospectiveMetricOutputs !== 'function') {
            return defaultM5ProductionTemplateBinding('resolver_unavailable');
        }
        const caseId: any = String(pipelineCaseId || '').trim();
        if (!caseId)
            return defaultM5ProductionTemplateBinding('case_missing');
        const outputs: any = outputItems(await this.governance.getRetrospectiveMetricOutputs(caseId));
        const decisionCandidates: any = outputs.filter((item: any): any => candidateShape(item, {
            kind: 'TemplateDecision',
        }));
        const decisions: any = decisionCandidates.filter((item: any): any => productShape(item, {
            schemaVersion: DECISION_SCHEMA,
            kind: 'TemplateDecision',
        }));
        if (decisionCandidates.length !== decisions.length) {
            throw blockedResolution('decision_candidate_invalid');
        }
        if (decisions.length === 0)
            return resolveGrayCandidate(caseId, outputs);
        if (decisions.some((item: any): any => !Number.isFinite(Date.parse(String(item.metadata?.decision?.decidedAt || ''))))) {
            throw blockedResolution('decision_time_invalid');
        }
        decisions.sort((left: any, right: any): any => {
            const byTime: any = Date.parse(right.metadata.decision.decidedAt)
                - Date.parse(left.metadata.decision.decidedAt);
            return byTime || String(right.id || '').localeCompare(String(left.id || ''));
        });
        const latestAt: any = decisions[0].metadata.decision.decidedAt;
        const latest: any = decisions.filter((item: any): any => item.metadata.decision.decidedAt === latestAt);
        if (latest.length !== 1)
            throw blockedResolution('decision_ambiguous');
        const targetTemplates: any = grayTargetTemplates(caseId, outputs);
        if (targetTemplates.length > 1)
            throw blockedResolution('gray_template_ambiguous');
        if (targetTemplates.length === 1) {
            const approvedAt: any = Date.parse(String(targetTemplates[0].metadata.templateVersion.approvedAt || ''));
            if (!Number.isFinite(approvedAt))
                throw blockedResolution('gray_template_time_invalid');
            if (approvedAt > Date.parse(latestAt))
                return resolveGrayCandidate(caseId, outputs);
        }
        return resolveDecision(latest[0], outputs);
    }
    async resolveGrayForDay(dayCaseId: any): Promise<any> {
        if (typeof this.governance?.getRetrospectiveMetricOutputs !== 'function')
            return null;
        const caseId: any = String(dayCaseId || '').trim();
        if (!caseId)
            return null;
        const outputs: any = outputItems(await this.governance.getRetrospectiveMetricOutputs(caseId));
        const templates: any = grayDayTemplates(caseId, outputs);
        if (templates.length > 1)
            throw blockedResolution('gray_day_template_ambiguous');
        if (templates.length === 0)
            return null;
        return resolveGrayTemplate(templates[0]);
    }
}
function resolveDecision(product: any, outputs: any): any {
    const decision: any = product.metadata.decision;
    if (!safeControls(decision.controls))
        throw blockedResolution('unsafe_controls');
    if (decision.status === 'validated') {
        if (decision.productionDefault !== true
            || decision.automaticRollback !== false
            || decision.activeTemplateVersionId !== decision.templateVersionId
            || !String(decision.activeTemplateVersionId || '').trim())
            throw blockedResolution('validated_decision_invalid');
        const templates: any = outputs.filter((item: any): any => productShape(item, { schemaVersion: TEMPLATE_SCHEMA, kind: 'TemplateVersion' })
            && item.metadata?.templateVersion?.templateVersionId === decision.activeTemplateVersionId);
        if (templates.length !== 1)
            throw blockedResolution('template_lineage_missing');
        const template: any = templates[0].metadata.templateVersion;
        if (template.productionDefault !== false
            || template.state !== 'gray_ready'
            || !safeControls(template.controls)
            || template.previousTemplateVersionId !== decision.previousTemplateVersionId
            || !validM5TemplateGuidance(template.suggestedChanges))
            throw blockedResolution('template_lineage_invalid');
        return approvedBinding({
            product,
            decision,
            templateProduct: templates[0],
            contentGuidance: normalizeGuidance(template.suggestedChanges),
        });
    }
    if (decision.status === 'rolled_back') {
        if (decision.productionDefault !== false
            || decision.automaticRollback !== true
            || decision.activeTemplateVersionId !== decision.previousTemplateVersionId
            || !String(decision.activeTemplateVersionId || '').trim())
            throw blockedResolution('rollback_decision_invalid');
        return approvedBinding({ product, decision, contentGuidance: [] });
    }
    throw blockedResolution('decision_not_approved');
}
function approvedBinding({ product, decision, templateProduct = null, contentGuidance }: any): any {
    return freezeBinding({
        schemaVersion: M5_SCHEMA_IDS.PRODUCTION_TEMPLATE_BINDING,
        templateVersionId: decision.activeTemplateVersionId,
        source: 'approved_learning_decision',
        decisionStatus: decision.status,
        decisionWorkProductId: String(product.id || ''),
        templateWorkProductId: templateProduct ? String(templateProduct.id || '') : null,
        productionDefault: decision.status === 'validated',
        contentGuidance,
        controls: SAFE_CONTROLS,
    });
}
function resolveGrayCandidate(caseId: any, outputs: any): any {
    const templates: any = grayTargetTemplates(caseId, outputs);
    if (templates.length > 1)
        throw blockedResolution('gray_template_ambiguous');
    if (templates.length !== 1)
        return defaultM5ProductionTemplateBinding('decision_not_approved');
    return resolveGrayTemplate(templates[0]);
}
function resolveGrayTemplate(product: any): any {
    const template: any = product.metadata.templateVersion;
    if (template.state !== 'gray_ready'
        || template.productionDefault !== false
        || template.grayReleaseLimit !== 1
        || template.grayTargetPlatform !== M5_PLATFORM_IDS.DOUYIN
        || template.applicationScope !== 'full_content_variant'
        || !safeControls(template.controls)
        || !validM5TemplateGuidance(template.suggestedChanges)
        || !String(template.templateVersionId || '').trim())
        throw blockedResolution('gray_template_invalid');
    return m5GrayProductionTemplateBinding({
        templateVersion: template,
        templateWorkProductId: String(product.id || ''),
    });
}
function grayTargetTemplates(caseId: any, outputs: any): any {
    return outputs.filter((item: any): any => productShape(item, { schemaVersion: TEMPLATE_SCHEMA, kind: 'TemplateVersion' })
        && item.metadata?.templateVersion?.grayTargetCaseId === caseId);
}
function grayDayTemplates(caseId: any, outputs: any): any {
    return outputs.filter((item: any): any => productShape(item, { schemaVersion: TEMPLATE_SCHEMA, kind: 'TemplateVersion' })
        && item.metadata?.templateVersion?.grayTargetDayCaseId === caseId);
}
function candidateShape(item: any, { kind }: any): any {
    return item?.kind === 'work_product'
        && item?.type === 'document'
        && item?.provider === PROVIDER
        && ['active', 'approved'].includes(item?.status)
        && item?.metadata?.kind === kind;
}
function productShape(item: any, { schemaVersion, kind }: any): any {
    return item?.kind === 'work_product'
        && item?.type === 'document'
        && item?.provider === PROVIDER
        && item?.sourceTrust == null
        && ['active', 'approved'].includes(item?.status)
        && item?.healthStatus === 'healthy'
        && item?.metadata?.schemaVersion === schemaVersion
        && item?.metadata?.kind === kind;
}
function outputItems(value: any): any {
    return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
