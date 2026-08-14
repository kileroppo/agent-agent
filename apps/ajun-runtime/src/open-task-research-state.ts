import { createHash } from 'node:crypto';
import { INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT } from '@agent-army/m5-kernel/routine-execution-contract';
const CONTROLLED_SOURCE_MATERIAL: any = Symbol.for('agent.army.openResearch.controlledSourceMaterial');
function recoverIntelResearchOpenTaskState({ workProducts, issueId, runId, }: any = {}): any {
    const safeIssueId: any = String(issueId || '').trim();
    const safeRunId: any = String(runId || '').trim();
    const items: any = Array.isArray(workProducts)
        ? workProducts
        : Array.isArray(workProducts?.items)
            ? workProducts.items
            : [];
    const sourceObservations: any = uniqueVerifiedSourceObservations(items.flatMap((item: any): any => {
        if (workProductKind(item) !== 'OpenResearchStep'
            || workProductSchemaVersion(item) !== 'agent.army/open-research-step/v1'
            || item?.metadata?.issueId !== safeIssueId
            || item?.metadata?.runId !== safeRunId)
            return [];
        return [item.metadata.observation, item.metadata.nextObservation];
    }), { issueId: safeIssueId, runId: safeRunId });
    const completedReports: any = items
        .map((item: any): any => healthyResearchReportWorkProduct(item, {
        issueId: safeIssueId,
        runId: safeRunId,
        sourceObservations,
    }))
        .filter(Boolean);
    if (completedReports.length > 1) {
        const checksums: any = new Set(completedReports.map((item: any): any => item.artifact.checksum));
        if (checksums.size > 1) {
            throw new Error('Paperclip 当前 Run 存在多个不同 ResearchReport，拒绝自动选择。');
        }
    }
    const candidates: any = items.flatMap((item: any): any => {
        const metadata: any = item?.metadata;
        const observation: any = metadata?.nextObservation || metadata?.observation;
        if (workProductKind(item) !== 'OpenResearchStep'
            || workProductSchemaVersion(item) !== 'agent.army/open-research-step/v1'
            || metadata?.issueId !== safeIssueId
            || metadata?.runId !== safeRunId
            || observation?.issueId !== safeIssueId
            || observation?.runId !== safeRunId
            || observation?.provenance !== 'trusted_role_tool_adapter'
            || !metadata?.decision?.decisionId)
            return [];
        const progress: Record<string, any> = {
            stepsUsed: requiredProgressInteger(metadata.progress?.stepsUsed, 'stepsUsed'),
            safeRetriesUsed: requiredProgressInteger(metadata.progress?.safeRetriesUsed, 'safeRetriesUsed'),
            replansUsed: requiredProgressInteger(metadata.progress?.replansUsed, 'replansUsed'),
        };
        return [{
                id: String(item.id || '').trim() || null,
                decisionId: String(metadata.decision.decisionId),
                lastDecision: metadata.decision,
                lastObservation: observation,
                progress,
                budget: canonicalOpenResearchBudget(metadata.budget),
                recordedAt: String(metadata.recordedAt || ''),
            }];
    }).sort((left: any, right: any): any => right.progress.stepsUsed - left.progress.stepsUsed
        || Date.parse(right.recordedAt || 0) - Date.parse(left.recordedAt || 0));
    if (!candidates.length && !completedReports.length)
        return null;
    if (!candidates.length) {
        return {
            lastObservation: null,
            lastDecision: null,
            sourceObservations,
            progress: completedReports[0].progress,
            budget: completedReports[0].budget,
            workProductId: completedReports[0].id,
            completedReport: completedReports[0],
        };
    }
    const latest: any = candidates[0];
    const drift: any = candidates.find((candidate: any): any => candidate !== latest
        && candidate.progress.stepsUsed === latest.progress.stepsUsed
        && candidate.decisionId !== latest.decisionId);
    if (drift) {
        throw new Error('Paperclip 存在多个同进度开放研究 Work Product，拒绝自动选择。');
    }
    return {
        lastObservation: latest.lastObservation,
        lastDecision: latest.lastDecision,
        sourceObservations,
        progress: latest.progress,
        budget: latest.budget,
        workProductId: latest.id,
        completedReport: completedReports[0] || null,
    };
}
function addVerifiedSourceObservation(observations: any, observation: any, expectedScope: any): any {
    const verified: any = verifiedSourceObservation(observation, expectedScope);
    if (!verified)
        return;
    const key: any = `${verified.result.sourceEvidence.url}|${verified.result.sourceEvidence.contentHash}`;
    const index: any = observations.findIndex((item: any): any => `${item.result.sourceEvidence.url}|${item.result.sourceEvidence.contentHash}` === key);
    if (index < 0)
        observations.push(verified);
}
function uniqueVerifiedSourceObservations(observations: any, expectedScope: any): any {
    const result: any[] = [];
    for (const observation of observations) {
        addVerifiedSourceObservation(result, observation, expectedScope);
    }
    return result;
}
function verifiedSourceObservation(observation: any, { issueId, runId }: any = {}): any {
    const evidence: any = observation?.result?.sourceEvidence;
    const expectedIssueId: any = String(issueId || '').trim();
    const expectedRunId: any = String(runId || '').trim();
    if (observation?.schemaVersion !== 'agent.army/tool-observation/v1'
        || !expectedIssueId
        || !expectedRunId
        || observation?.issueId !== expectedIssueId
        || observation?.runId !== expectedRunId
        || observation?.outcome !== 'succeeded'
        || observation?.classification !== 'source_verified'
        || observation?.provenance !== 'trusted_role_tool_adapter'
        || !String(observation?.observationId || '').trim()
        || !publicResearchUrl(evidence?.url)
        || !validTimestampText(evidence?.fetchedAt)
        || !validHashText(evidence?.contentHash)
        || !String(evidence?.sourceId || '').trim()
        || !String(evidence?.evidenceFragment?.fragmentId || '').trim()
        || !String(evidence?.evidenceFragment?.text || '').trim())
        return null;
    return observation;
}
function verifiedResearchReportArtifact({ artifact, task, issueId, runId, sourceObservations, }: any = {}): any {
    const validation: any = artifact?.validation || {};
    const verifiedObservations: any = uniqueVerifiedSourceObservations(sourceObservations, {
        issueId,
        runId,
    });
    const sourceIds: any = verifiedObservations.map((item: any): any => item.observationId);
    const expectedChecksum: any = `sha256:${createHash('sha256')
        .update(canonicalJson(artifact?.data || null))
        .digest('hex')}`;
    if (artifact?.type !== 'intel_research_report'
        || String(artifact?.taskId || '') !== String(task?.taskId || '')
        || !String(artifact?.artifactId || '').trim()
        || !/^runtime:\/\/[^/]+\/intel-research-report$/.test(String(artifact?.location || ''))
        || !/^sha256:[0-9a-f]{64}$/i.test(String(artifact?.checksum || ''))
        || artifact.checksum.toLowerCase() !== expectedChecksum
        || artifact?.data?.schemaVersion !== 'agent.army/intel-research-report/v1'
        || artifact?.data?.runId !== runId
        || !reportDataMatchesSourceObservations(artifact.data, verifiedObservations)
        || validation.exists !== true
        || validation.readable !== true
        || validation.nonEmpty !== true
        || validation.publicReadOnly !== true
        || validation.minimumSourcesMet !== true
        || validation.claimEvidenceBound !== true
        || validation.currentRun !== true
        || Number(validation.sourceCount) < 2
        || sourceIds.length < 2) {
        throw new Error('小R受控执行器没有生成可核验的当前 Run 研究报告产物。');
    }
    return structuredClone(artifact);
}
function reportDataMatchesSourceObservations(report: any, observations: any): any {
    const reportedObservationIds: any = Array.isArray(report?.sourceObservationIds)
        ? [...new Set(report.sourceObservationIds.map(String).filter(Boolean))]
        : [];
    const expectedObservationIds: any = observations.map((item: any): any => item.observationId);
    if (reportedObservationIds.length !== expectedObservationIds.length
        || !expectedObservationIds.every((id: any): any => reportedObservationIds.includes(id)))
        return false;
    const expectedSources: any = new Map(observations.map((observation: any): any => {
        const evidence: any = observation.result.sourceEvidence;
        const controlledSummary: any = String(observation?.[CONTROLLED_SOURCE_MATERIAL]?.summary || '').trim();
        return [String(evidence.sourceId), {
                url: publicResearchUrl(evidence.url),
                contentHash: normalizeContentHash(evidence.contentHash),
                fragmentId: String(evidence.evidenceFragment.fragmentId),
                fragmentText: controlledSummary || null,
            }];
    }));
    const reportSources: any = Array.isArray(report?.sources) ? report.sources : [];
    if (reportSources.length !== expectedSources.size)
        return false;
    for (const source of reportSources) {
        const expected: any = expectedSources.get(String(source?.sourceId || ''));
        const fragments: any = Array.isArray(source?.evidenceFragments)
            ? source.evidenceFragments
            : [];
        if (!expected
            || publicResearchUrl(source?.url || source?.source) !== expected.url
            || normalizeContentHash(source?.contentHash) !== expected.contentHash
            || !fragments.some((fragment: any): any => String(fragment?.fragmentId || '') === expected.fragmentId
                && String(fragment?.text || '').trim()
                && (expected.fragmentText == null
                    || String(fragment?.text || '') === expected.fragmentText)))
            return false;
    }
    const claims: any = Array.isArray(report?.claims) ? report.claims : [];
    return claims.length > 0 && claims.every((claim: any): any => {
        const sourceIds: any = Array.isArray(claim?.sourceIds)
            ? [...new Set(claim.sourceIds.map(String).filter(Boolean))]
            : [];
        const fragments: any = Array.isArray(claim?.evidenceFragments)
            ? claim.evidenceFragments
            : [];
        return Boolean(String(claim?.text || '').trim())
            && sourceIds.length > 0
            && sourceIds.every((sourceId: any): any => {
                const expected: any = expectedSources.get(sourceId);
                const source: any = reportSources.find((item: any): any => String(item?.sourceId || '') === sourceId);
                const reportFragment: any = source?.evidenceFragments?.find((fragment: any): any => String(fragment?.fragmentId || '') === expected?.fragmentId);
                return expected && fragments.some((fragment: any): any => String(fragment?.sourceId || '') === sourceId
                    && String(fragment?.fragmentId || '') === expected.fragmentId
                    && String(fragment?.text || '') === String(reportFragment?.text || ''));
            });
    });
}
function normalizeContentHash(value: any): any {
    const text: any = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}
function openResearchReportWorkProduct({ task, assignment, artifact, sourceObservations, progress, budget, now, }: any = {}): any {
    const sourceObservationIds: any = uniqueVerifiedSourceObservations(sourceObservations, {
        issueId: assignment.issueId,
        runId: assignment.runId,
    })
        .map((item: any): any => item.observationId);
    const idempotencyHash: any = createHash('sha256')
        .update(JSON.stringify({
        issueId: assignment.issueId,
        runId: assignment.runId,
        sourceObservationIds,
        checksum: artifact.checksum,
    }))
        .digest('hex');
    return {
        type: 'document',
        provider: 'agent-army.intel-researcher',
        externalId: `open-research-report:${idempotencyHash}`,
        title: artifact.title,
        status: 'active',
        reviewState: 'none',
        isPrimary: true,
        healthStatus: 'healthy',
        summary: '小R已生成来源可核验的公开研究报告。',
        createdByRunId: assignment.runId,
        metadata: {
            kind: 'ResearchReport',
            schemaVersion: 'agent.army/intel-research-report/v1',
            idempotencyKey: `open-research-report:${idempotencyHash}`,
            taskId: String(task?.taskId || '').trim(),
            issueId: assignment.issueId,
            runId: assignment.runId,
            artifactRef: artifact.location,
            artifact,
            report: artifact.data,
            sourceObservationIds,
            validation: {
                exists: true,
                readable: true,
                nonEmpty: true,
                publicReadOnly: true,
                sourceCount: sourceObservationIds.length,
                minimumSourcesMet: sourceObservationIds.length >= 2,
                claimEvidenceBound: artifact.validation.claimEvidenceBound === true,
                currentRun: artifact.data.runId === assignment.runId,
            },
            progress,
            budget,
            recordedAt: now().toISOString(),
        },
    };
}
function healthyResearchReportWorkProduct(value: any, { issueId, runId, sourceObservations, }: any = {}): any {
    const metadata: any = value?.metadata;
    const artifact: any = metadata?.artifact;
    const validation: any = metadata?.validation || {};
    const sourceObservationIds: any = Array.isArray(metadata?.sourceObservationIds)
        ? [...new Set(metadata.sourceObservationIds.map(String).filter(Boolean))]
        : [];
    const verifiedObservations: any = uniqueVerifiedSourceObservations(sourceObservations, {
        issueId,
        runId,
    });
    const expectedObservationIds: any = verifiedObservations.map((item: any): any => item.observationId);
    const expectedChecksum: any = `sha256:${createHash('sha256')
        .update(canonicalJson(artifact?.data || null))
        .digest('hex')}`;
    if (workProductKind(value) !== 'ResearchReport'
        || workProductSchemaVersion(value) !== 'agent.army/intel-research-report/v1'
        || value?.healthStatus !== 'healthy'
        || metadata?.issueId !== issueId
        || metadata?.runId !== runId
        || metadata?.artifactRef !== artifact?.location
        || artifact?.type !== 'intel_research_report'
        || artifact?.data?.schemaVersion !== 'agent.army/intel-research-report/v1'
        || artifact?.data?.runId !== runId
        || !/^runtime:\/\/[^/]+\/intel-research-report$/.test(String(artifact?.location || ''))
        || !/^sha256:[0-9a-f]{64}$/i.test(String(artifact?.checksum || ''))
        || artifact.checksum.toLowerCase() !== expectedChecksum
        || !reportDataMatchesSourceObservations(artifact.data, verifiedObservations)
        || artifact?.validation?.exists !== true
        || artifact?.validation?.readable !== true
        || artifact?.validation?.nonEmpty !== true
        || artifact?.validation?.claimEvidenceBound !== true
        || validation.exists !== true
        || validation.readable !== true
        || validation.nonEmpty !== true
        || validation.claimEvidenceBound !== true
        || validation.currentRun !== true
        || sourceObservationIds.length < 2
        || sourceObservationIds.length !== expectedObservationIds.length
        || !expectedObservationIds.every((id: any): any => sourceObservationIds.includes(id)))
        return null;
    return {
        id: String(value.id || '').trim() || null,
        artifact: structuredClone(artifact),
        artifactRef: artifact.location,
        sourceObservationIds,
        progress: normalizedRecoveredProgress(metadata.progress),
        budget: canonicalOpenResearchBudget(metadata.budget),
    };
}
function workProductKind(value: any): any {
    return String(value?.metadata?.kind || value?.type || '').trim();
}
function workProductSchemaVersion(value: any): any {
    return String(value?.metadata?.schemaVersion || value?.schemaVersion || '').trim();
}
function canonicalJson(value: any): any {
    return JSON.stringify(canonicalValue(value));
}
function canonicalValue(value: any): any {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.keys(value).sort().map((key: any): any => [key, canonicalValue(value[key])]));
}
function normalizedRecoveredProgress(value: any): any {
    return {
        stepsUsed: requiredProgressInteger(value?.stepsUsed, 'stepsUsed'),
        safeRetriesUsed: requiredProgressInteger(value?.safeRetriesUsed, 'safeRetriesUsed'),
        replansUsed: requiredProgressInteger(value?.replansUsed, 'replansUsed'),
    };
}
function completedReportObservation({ assignment, report, stepNumber, now, }: any = {}): any {
    return {
        schemaVersion: 'agent.army/tool-observation/v1',
        observationId: `${assignment.runId}:open-research:report:${stepNumber}`,
        issueId: assignment.issueId,
        runId: assignment.runId,
        toolId: 'controlled.intel-research-report',
        outcome: 'succeeded',
        classification: 'goal_satisfied',
        provenance: 'trusted_report_executor',
        result: {
            acceptanceSatisfied: true,
            evidenceSourceCount: report.sourceObservationIds.length,
            workProduct: {
                type: 'ResearchReport',
                schemaVersion: 'agent.army/intel-research-report/v1',
                runId: assignment.runId,
                artifactRef: report.artifactRef,
                sourceObservationIds: report.sourceObservationIds,
                validation: {
                    exists: true,
                    readable: true,
                    nonEmpty: true,
                    claimEvidenceBound: true,
                },
            },
        },
        recordedAt: now().toISOString(),
    };
}
function completedOpenResearchResult({ report, issueId, runId, progress, budget, now, reusedReport, }: any = {}): any {
    return {
        status: 'succeeded',
        currentStage: 'open_research_complete',
        artifactRefs: [report.artifact],
        execution: {
            openResearch: {
                schemaVersion: 'agent.army/open-research-runtime-state/v1',
                issueId,
                runId,
                lastObservation: null,
                lastDecision: null,
                progress,
                budget,
                lastWorkProductId: report.id,
                projectionSource: 'paperclip_work_product',
                updatedAt: now().toISOString(),
            },
        },
        openResearch: {
            decision: {
                action: 'complete',
                executionStatus: 'complete',
                selectedToolId: null,
            },
            reportWorkProductId: report.id,
            sourceObservationIds: report.sourceObservationIds,
            reusedReport: reusedReport === true,
        },
    };
}
function requiredProgressInteger(value: any, label: any): any {
    const normalized: any = Number(value);
    if (!Number.isInteger(normalized) || normalized < 0) {
        throw new Error(`小R开放研究进度 ${label} 缺失或无效。`);
    }
    return normalized;
}
function requiredBudgetInteger(value: any, label: any, { positive = false }: any = {}): any {
    const normalized: any = Number(value);
    if (!Number.isInteger(normalized)
        || normalized < 0
        || (positive && normalized === 0)) {
        throw new Error(`小R开放研究预算 ${label} 缺失或无效。`);
    }
    return normalized;
}
function canonicalOpenResearchBudget(value: any): any {
    return {
        remainingUnits: requiredBudgetInteger(value?.remainingUnits, 'remainingUnits'),
        estimatedNextStepUnits: requiredBudgetInteger(value?.estimatedNextStepUnits, 'estimatedNextStepUnits', { positive: true }),
    };
}
function assertOpenResearchToolBudget(progress: any, budget: any): any {
    if (progress.stepsUsed >= INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps) {
        throw new Error('小R开放研究步骤预算已耗尽。');
    }
    if (budget.remainingUnits < budget.estimatedNextStepUnits) {
        throw new Error('小R开放研究费用预算不足。');
    }
}
function publicResearchUrl(value: any): any {
    const raw: any = String(value || '').trim();
    if (!raw)
        return null;
    let parsed: any;
    try {
        parsed = new URL(raw);
    }
    catch {
        return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username
        || parsed.password
        || /^(?:localhost|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/i.test(parsed.hostname))
        return null;
    return parsed.toString();
}
function validTimestampText(value: any): any {
    const text: any = String(value || '').trim();
    return Number.isFinite(Date.parse(text)) ? text : null;
}
function validHashText(value: any): any {
    const text: any = String(value || '').trim();
    return /^sha256:[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : null;
}
function healthyOpenResearchWorkProduct(value: any, { runId }: any = {}): any {
    const type: any = String(value?.type || '').trim();
    const schemaVersion: any = String(value?.schemaVersion || '').trim();
    const artifactRef: any = String(value?.artifactRef || '').trim();
    const sourceObservationIds: any = Array.isArray(value?.sourceObservationIds)
        ? [...new Set(value.sourceObservationIds.map(String).filter(Boolean))]
        : [];
    const validation: any = value?.validation || {};
    if (type !== 'ResearchReport'
        || schemaVersion !== 'agent.army/intel-research-report/v1'
        || value?.runId !== runId
        || !artifactRef
        || sourceObservationIds.length < 2
        || validation.exists !== true
        || validation.readable !== true
        || validation.nonEmpty !== true
        || validation.claimEvidenceBound !== true)
        return null;
    return {
        type,
        schemaVersion,
        artifactRef,
        runId,
        sourceObservationIds,
        validation: {
            exists: true,
            readable: true,
            nonEmpty: true,
            claimEvidenceBound: true,
        },
    };
}
export const openTaskResearchState: any = Object.freeze({
    recover: recoverIntelResearchOpenTaskState,
    sources: Object.freeze({
        addVerified: addVerifiedSourceObservation,
        publicUrl: publicResearchUrl,
        validTimestamp: validTimestampText,
        validHash: validHashText,
    }),
    report: Object.freeze({
        verifyArtifact: verifiedResearchReportArtifact,
        workProduct: openResearchReportWorkProduct,
        completedObservation: completedReportObservation,
        completedResult: completedOpenResearchResult,
    }),
    progress: Object.freeze({
        requiredInteger: requiredProgressInteger,
        requiredBudgetInteger,
        canonicalBudget: canonicalOpenResearchBudget,
        assertToolBudget: assertOpenResearchToolBudget,
    }),
    healthyCompletion: healthyOpenResearchWorkProduct,
});
