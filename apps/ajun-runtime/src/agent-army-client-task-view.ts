import { presentTask } from './task-presentation.ts';
export function agentArmyTaskView(task: any = {}, approvals: any = [], detailBaseUrl: any = ''): any {
    const taskApprovals: any = (approvals || []).filter((approval: any): any => (task.approvalRefs || []).includes(approval.approvalId));
    const artifactRefs: any[] = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
    const currentArtifactRefs: any[] = latestArtifactVersions(artifactRefs);
    return {
        taskId: task.taskId,
        title: safeText(task.input?.title, 500),
        taskType: safeText(task.taskType, 120),
        agentId: safeText(task.assigneeAgentId || task.routing?.requestedAgentId, 80) || null,
        status: safeText(task.status, 60),
        currentStage: safeText(task.currentStage, 120),
        updatedAt: task.updatedAt || null,
        progress: task.execution?.xiaodProgress ?? null,
        requiresApproval: taskApprovals.some((approval: any): any => approval.status === 'pending'),
        approvals: taskApprovals.map(agentArmyApprovalView),
        error: task.error ? {
            code: safeText(task.error.code, 120),
            category: safeText(task.error.category, 80),
            retryable: task.error.retryable === true,
            userMessage: safeText(task.error.userMessage, 1000)
        } : null,
        artifacts: currentArtifactRefs.map(artifactView),
        artifactHistory: {
            total: artifactRefs.length,
            current: currentArtifactRefs.length,
            superseded: artifactRefs.length - currentArtifactRefs.length,
        },
        presentation: presentTask(task, { approvals: taskApprovals, detailBaseUrl })
    };
}
export function agentArmyApprovalView(approval: any = {}): any {
    return {
        approvalId: approval.approvalId,
        taskId: approval.taskId || null,
        status: safeText(approval.status, 40),
        governanceMode: safeText(approval.governanceMode, 40),
        action: safeText(approval.action, 100),
        riskLevel: safeText(approval.riskLevel, 40),
        reason: safeText(approval.reason, 700),
        requestedScope: approval.requestedScope ? {
            title: safeText(approval.requestedScope.title, 500),
            taskType: safeText(approval.requestedScope.taskType, 120),
            assigneeAgentId: safeText(approval.requestedScope.assigneeAgentId, 80) || null
        } : null,
        validUntil: approval.validUntil || null,
        privateReadGrantStatus: approval.privateReadGrantStatus ? {
            status: safeText(approval.privateReadGrantStatus.status, 40),
            remainingUses: Number(approval.privateReadGrantStatus.remainingUses) || 0,
            expiresAt: approval.privateReadGrantStatus.expiresAt || null
        } : null
    };
}
function artifactView(artifact: any = {}): any {
    const validation: any = artifact.validation || {};
    const view: Record<string, any> = {
        type: safeText(artifact.type, 120),
        ref: artifactReference(artifact),
        verified: artifact.data?.larkPermissionGranted === true
            || artifact.verified === true
            || (validation.exists === true && validation.readable === true && validation.nonEmpty === true)
    };
    if (artifact.type === 'health_report' && artifact.data) {
        view.report = {
            checkedAt: artifact.data.checkedAt || null,
            overall: safeText(artifact.data.overall, 40),
            components: (Array.isArray(artifact.data.components) ? artifact.data.components : []).slice(0, 12).map((item: any): any => ({
                id: safeText(item?.id, 80),
                name: safeText(item?.name, 120),
                status: safeText(item?.status, 40),
                detail: safeText(item?.detail, 500)
            })),
            recommendedAction: safeText(artifact.data.recommendedAction, 500)
        };
    }
    if (artifact.type === 'intel_research_report' && artifact.data) {
        const topic: any = safeText(artifact.data.topic, 500);
        view.report = {
            topic,
            background: safeText(artifact.data.background, 1200),
            findings: safeResearchList(artifact.data.findings, topic, 8, 800),
            conclusion: safeText(artifact.data.conclusion, 1200),
            recommendations: safeStringList(artifact.data.recommendations, 8, 800),
            openQuestions: safeStringList(artifact.data.openQuestions, 8, 800),
            sources: (Array.isArray(artifact.data.sources) ? artifact.data.sources : []).slice(0, 5).map((item: any): any => ({
                title: safeText(item?.title, 300),
                source: safeText(item?.source, 1000),
                summary: relevantResearchExcerpt(item?.summary, topic, 900)
            }))
        };
    }
    if (artifact.type === 'employee_role_report' && artifact.data) {
        view.report = {
            agentId: safeText(artifact.data.agentId, 80) || null,
            reportedStatus: safeText(artifact.data.reportedStatus, 60),
            summary: safeText(artifact.data.summary, 2000),
            evidence: safeText(artifact.data.evidence, 2000),
            remainingRisks: safeText(artifact.data.remainingRisks, 1200),
        };
    }
    if (artifact.type === 'office_briefing_package' && artifact.data) {
        view.report = {
            title: safeText(artifact.data.title, 500),
            summary: safeText(artifact.data.summary, 1200),
            validation: {
                exists: validation.exists === true,
                readable: validation.readable === true,
                nonEmpty: validation.nonEmpty === true,
                bytes: boundedInteger(validation.bytes, 1, 10_000_000),
                sourceTaskCount: boundedInteger(validation.sourceTaskCount, 0, 100),
                sourceStatusesTruthful: validation.sourceStatusesTruthful === true,
                includesOpenItems: validation.includesOpenItems === true,
                includesNextAction: validation.includesNextAction === true,
                editableFormat: artifact.mimeType === 'text/markdown',
            },
            sourceTasks: (Array.isArray(artifact.data.sourceTasks) ? artifact.data.sourceTasks : []).slice(0, 10).map((item: any): any => ({
                taskId: safeText(item?.taskId, 100),
                title: safeText(item?.title, 500),
                employeeId: safeText(item?.employeeId, 80) || null,
                status: safeText(item?.status, 60)
            })),
            openItems: safeStringList(artifact.data.openItems, 8, 600),
            nextAction: safeText(artifact.data.nextAction, 800),
            contentExcerpt: verifiedOfficeExcerpt(artifact, validation),
        };
    }
    if (artifact.type === 'video_content_analysis_report' && artifact.data) {
        view.report = {
            title: safeText(artifact.data.title, 500),
            summary: safeText(artifact.data.summary, 1600),
            analysisIntent: safeText(artifact.data.analysisIntent || validation.analysisIntent, 40),
            completeness: safeText(artifact.data.completeness || validation.completeness, 40),
            generationMode: safeText(artifact.data.generationMode, 80),
            validation: {
                moduleCount: boundedInteger(validation.moduleCount, 0, 100),
                formalSourceConfirmed: validation.formalSourceConfirmed === true,
                claimsEvidenceLinked: validation.claimsEvidenceLinked === true,
                semanticValidationPassed: validation.semanticValidationPassed === true,
                modeStructurePassed: validation.modeStructurePassed === true,
                visualClaimsEvidenceLinked: validation.visualClaimsEvidenceLinked === true,
                visualAnalysisApplied: validation.visualAnalysisApplied === true,
                controlledVisionInvoked: validation.controlledVisionInvoked === true,
                visualExecutionReceiptValid: validation.visualExecutionReceiptValid === true,
            },
            modules: (Array.isArray(artifact.data.modules) ? artifact.data.modules : []).slice(0, 13).map((item: any): any => ({
                name: safeText(item?.name, 120),
                finding: safeText(item?.finding, 900),
                confidence: safeText(item?.confidence, 40),
                evidence: safeEvidence(item?.evidence),
            })),
            visualFindings: (Array.isArray(artifact.data.visualFindings) ? artifact.data.visualFindings : []).slice(0, 8).map((item: any): any => ({
                category: safeText(item?.category, 120),
                finding: safeText(item?.finding, 700),
                confidence: safeText(item?.confidence, 40),
                evidence: safeEvidence(item?.evidence),
            })),
            reusablePatterns: safeStringList(artifact.data.reusablePatterns, 5, 700),
            actionItems: safeStringList(artifact.data.actionItems, 8, 700),
            sourceMetadata: artifact.data.sourceMetadata ? {
                title: safeText(artifact.data.sourceMetadata.title, 500),
                author: safeText(artifact.data.sourceMetadata.author, 200),
                platform: safeText(artifact.data.sourceMetadata.platform, 80),
                durationSeconds: boundedNumber(artifact.data.sourceMetadata.durationSeconds, 0, 86_400),
                canonicalUrl: safeHttpUrl(artifact.data.sourceMetadata.canonicalUrl),
                publishedAt: safeText(artifact.data.sourceMetadata.publishedAt, 80) || null,
            } : null,
        };
    }
    if (artifact.type === 'autonomous_work_plan' && artifact.data?.plan) {
        const plan: any = artifact.data.plan;
        view.report = {
            status: safeText(plan.status, 60),
            version: Number.isSafeInteger(plan.version) ? plan.version : null,
            steps: (Array.isArray(plan.steps) ? plan.steps : []).slice(0, 20).map((step: any): any => ({
                stepId: safeText(step?.stepId, 128),
                objective: safeText(step?.objective, 500),
                status: safeText(step?.status, 60),
                dependsOn: safeStringList(step?.dependsOn, 20, 128)
            })),
            budget: {
                maxDurationMs: Number(plan.budget?.hardLimits?.maxDurationMs) || null,
                maxModelCalls: Number(plan.budget?.hardLimits?.maxModelCalls) || null,
                maxConcurrency: Number(plan.budget?.hardLimits?.maxConcurrency) || null,
                maxDelegationDepth: Number(plan.budget?.hardLimits?.maxDelegationDepth) || null,
                approvalThresholdUsd: Number(plan.budget?.approvalThresholdUsd) || 0
            }
        };
    }
    if (artifact.type === 'capability_discovery_report' && artifact.data) {
        view.report = {
            requestedCount: Number(artifact.data.requestedCount) || 0,
            activeCount: Number(artifact.data.activeCount) || 0,
            results: (Array.isArray(artifact.data.results) ? artifact.data.results : []).slice(0, 20).map((item: any): any => ({
                capabilityId: safeText(item?.capabilityId, 120),
                status: safeText(item?.status, 60),
                reason: safeText(item?.reason, 500)
            }))
        };
    }
    if (artifact.type === 'cross_agent_mission_summary' && artifact.data) {
        view.report = {
            kind: safeText(artifact.data.kind, 60),
            summary: safeText(artifact.data.summary, 1000),
            completed: artifact.data.completed === true,
            terminal: artifact.data.terminal === true,
            statuses: (Array.isArray(artifact.data.statuses) ? artifact.data.statuses : []).slice(0, 11).map((item: any): any => ({
                title: safeText(item?.title, 500),
                employeeId: safeText(item?.employeeId, 80) || null,
                taskId: safeText(item?.taskId, 100) || null,
                status: safeText(item?.status, 60),
                artifactTypes: safeStringList(item?.artifactTypes, 10, 120)
            })),
            outcome: safeText(artifact.data.decision?.outcome, 60),
            briefing: artifact.data.decision?.briefing ? {
                title: safeText(artifact.data.decision.briefing.title, 500),
                summary: safeText(artifact.data.decision.briefing.summary, 1000),
                openItems: safeStringList(artifact.data.decision.briefing.openItems, 5, 500),
                nextAction: safeText(artifact.data.decision.briefing.nextAction, 500)
            } : null
        };
    }
    return view;
}
function artifactReference(artifact: any = {}): any {
    const artifactId: any = safeText(artifact.artifactId, 200);
    if (artifactId)
        return artifactId;
    const candidate: any = safeText(artifact.ref || artifact.url || artifact.data?.larkUrl || artifact.location, 1000);
    return /^(?:https?:\/\/|runtime:\/\/)/i.test(candidate) ? candidate : null;
}
function safeEvidence(value: any = {}): any {
    const timestamp: any = safeText(value?.timestamp, 40);
    const frameRef: any = safeText(value?.frameRef, 120);
    const fragment: any = safeText(value?.fragment, 500);
    return {
        ...(timestamp ? { timestamp } : {}),
        ...(frameRef ? { frameRef } : {}),
        ...(fragment ? { fragment } : {}),
    };
}
function boundedInteger(value: any, minimum: any, maximum: any): any {
    const number: any = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}
function boundedNumber(value: any, minimum: any, maximum: any): any {
    const number: any = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}
function safeHttpUrl(value: any): any {
    const candidate: any = safeText(value, 1000);
    return /^https?:\/\//i.test(candidate) ? candidate : null;
}
function safeOfficeExcerpt(value: any, limit: any): any {
    return safeText(value, 12_000)
        .replace(/file:\/\/\/[^\s）)]+/gi, '[本地产物引用已脱敏]')
        .replace(/\b\/Users\/[^\s）)]+/g, '[本地路径已脱敏]')
        .slice(0, limit);
}
function verifiedOfficeExcerpt(artifact: any, validation: any): any {
    const eligible = validation.exists === true
        && validation.readable === true
        && validation.nonEmpty === true
        && boundedInteger(validation.bytes, 1, 10_000_000) !== null
        && validation.sourceStatusesTruthful === true
        && validation.includesOpenItems === true
        && validation.includesNextAction === true
        && artifact.mimeType === 'text/markdown';
    return eligible ? safeOfficeExcerpt(artifact.data?.markdown, 2400) : '';
}
function latestArtifactVersions(artifacts: any[]): any[] {
    const latestIndexById: any = new Map();
    artifacts.forEach((artifact: any, index: any): any => {
        const artifactId: any = artifactVersionKey(artifact);
        if (artifactId)
            latestIndexById.set(artifactId, index);
    });
    return artifacts.filter((artifact: any, index: any): any => {
        const artifactId: any = artifactVersionKey(artifact);
        return !artifactId || latestIndexById.get(artifactId) === index;
    });
}
function artifactVersionKey(artifact: any): any {
    if (artifact?.type === 'employee_role_report' && safeText(artifact?.data?.agentId, 80))
        return `employee_role_report:${safeText(artifact.data.agentId, 80)}`;
    return safeText(artifact?.artifactId, 200);
}
function safeText(value: any, limit: any = 500): any {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function safeStringList(value: any, maxItems: any, maxChars: any): any {
    const values: any = Array.isArray(value) ? value : value == null ? [] : [value];
    return [...new Set(values.map((item: any): any => safeText(item, maxChars)).filter(Boolean))].slice(0, maxItems);
}
function safeResearchList(value: any, topic: any, maxItems: any, maxChars: any): any {
    const values: any = Array.isArray(value) ? value : value == null ? [] : [value];
    return [...new Set(values.map((item: any): any => relevantResearchExcerpt(item, topic, maxChars)).filter(Boolean))].slice(0, maxItems);
}
function relevantResearchExcerpt(value: any, topic: any, limit: any): any {
    const text: any = safeText(value, 6000);
    if (!text)
        return '';
    if (String(topic || '').includes('天气')) {
        const weatherMarkers: any[] = [/>\s*[\u4e00-\u9fff]{2,10}\s*-\s*(?:今天|今日)/, /当前位置\s*[:：]\s*[\u4e00-\u9fff]{2,10}天气/];
        const indexes: any[] = weatherMarkers.map((pattern: any): any => text.search(pattern)).filter((index: any): any => index >= 0);
        if (indexes.length)
            return text.slice(Math.min(...indexes), Math.min(...indexes) + limit).trim();
    }
    return text.slice(0, limit);
}
