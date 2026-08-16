import { createHash } from 'node:crypto';
import { fallbackResearch } from './hermes-intel-research-advisor.ts';
import { MAX_RESEARCH_SOURCES, OpenResearchSourceAcquisition, } from './open-research-source-acquisition.ts';
export class LocalIntelResearcher {
    githubResearch: any;
    githubSearch: any;
    grokConsult: any;
    now: any;
    publicReport: any;
    publicWebFetch: any;
    publicWebSearch: any;
    researchAdvisor: any;
    sourceAcquisition: any;
    constructor({ publicWebFetch, publicWebSearch = null, githubSearch = null, publicReport = null, githubResearch = null, researchAdvisor = null, grokConsult = null, now = (): any => new Date() }: any = {}) {
        this.publicWebFetch = publicWebFetch;
        this.publicWebSearch = publicWebSearch;
        this.githubSearch = githubSearch;
        this.publicReport = publicReport;
        this.githubResearch = githubResearch;
        this.researchAdvisor = researchAdvisor;
        this.grokConsult = grokConsult;
        this.now = now;
        this.sourceAcquisition = new OpenResearchSourceAcquisition({
            publicWebFetch,
            publicWebSearch,
            githubSearch,
        });
    }
    supports(agent: any): any { return agent?.agentId === 'intel-researcher'; }
    async execute(task: any, { roleToolContext = null }: any = {}): Promise<any> {
        if (shouldUseGrok(task))
            return this.executeGrokSearch(task);
        if (task?.taskType === 'report.public-material') {
            if (!this.publicReport?.execute)
                return needsInput(this.now(), 'public_report_unavailable', '小R的公开网页整理能力暂时不可用。');
            return this.publicReport.execute(task, { roleToolContext });
        }
        if (task?.taskType === 'research.github-search') {
            if (!this.githubResearch?.execute)
                return needsInput(this.now(), 'github_research_unavailable', '小R的公开 GitHub 检索能力暂时不可用。');
            return this.githubResearch.execute(task, { roleToolContext });
        }
        const isCampaignResearch: any = task?.taskType === 'content.campaign-research';
        const isCampaignEvidence: any = task?.taskType === 'content.campaign-evidence';
        const topic: any = String(task?.input?.topic
            || task?.input?.context?.pipelineCase?.fields?.theme
            || task?.input?.title
            || '').trim();
        if (!topic)
            return needsInput(this.now(), 'research_topic_required', '请说明要研究的主题。小R只会读取公开来源，不会猜测研究目标。');
        const acquisition: any = await this.sourceAcquisition.acquire({
            task,
            topic,
            roleToolContext,
            discover: (value: any, context: any): any => this.discover(value, context),
            readSources: (...args: any): any => (this.readSources as any)(...args),
        });
        if (!acquisition.ready) {
            return needsInput(this.now(), acquisition.code, acquisition.userMessage);
        }
        const { discovery, evidenceSources, executionMode, preparedSources, usageTools, } = acquisition;
        const analysis: any = await this.analyze(topic, evidenceSources);
        const completedAt: any = this.now().toISOString();
        const researchMethod: any = buildResearchMethod({
            discovery,
            sources: preparedSources,
            claims: analysis.claims,
        });
        const report: any = isCampaignEvidence
            ? campaignEvidencePackage({ task, topic, sources: evidenceSources, analysis, completedAt, researchMethod })
            : {
                ...(isCampaignResearch ? { schemaVersion: 'agent.army/campaign-research/v2' } : {}),
                topic,
                sources: preparedSources,
                ...analysis,
                researchMethod,
                ...(isCampaignResearch ? {
                    contentOpportunity: buildContentOpportunity({
                        task,
                        topic,
                        sources: evidenceSources,
                        analysis,
                        researchMethod,
                    }),
                } : {}),
            };
        return {
            status: 'succeeded',
            currentStage: isCampaignEvidence
                ? 'campaign_evidence_ready'
                : isCampaignResearch ? 'campaign_research_ready' : 'intel_research_ready',
            execution: { executor: task.assigneeAgentId || 'intel-researcher', mode: executionMode, startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: 'research_ready' },
            usage: { tools: usageTools },
            artifactRefs: [{
                    artifactId: `${isCampaignEvidence ? 'campaign-evidence' : isCampaignResearch ? 'campaign-research' : 'intel-research'}:${task.taskId}`,
                    taskId: task.taskId,
                    type: isCampaignEvidence
                        ? 'evidence_package'
                        : isCampaignResearch ? 'campaign_research_report' : 'intel_research_report',
                    title: `${topic} ${isCampaignEvidence ? '证据包' : '研究报告'}`,
                    location: `runtime://${task.taskId}/${isCampaignEvidence ? 'campaign-evidence' : isCampaignResearch ? 'campaign-research' : 'intel-research-report'}`,
                    mimeType: 'application/json',
                    accessScope: 'local-owner',
                    createdAt: completedAt,
                    validation: {
                        exists: true,
                        readable: true,
                        nonEmpty: true,
                        publicReadOnly: true,
                        sourceCount: preparedSources.length,
                        evidenceSourceCount: evidenceSources.length,
                        minimumSourcesMet: !isCampaignResearch && !isCampaignEvidence ? undefined : evidenceSources.length >= 2,
                        claimEvidenceBound: report.claims?.every(validClaimEvidenceBinding) === true,
                        topicRelevanceMet: evidenceSources.length > 0
                            && evidenceSources.every((source: any): any => source.topicRelevant !== false),
                        searchDiversityMet: discovery ? researchMethod.coverage.searchDiversityMet : undefined,
                        counterEvidenceSearched: discovery ? researchMethod.coverage.counterEvidenceSearched : undefined,
                        contentOpportunityPresent: isCampaignResearch
                            ? report.contentOpportunity?.schemaVersion === 'agent.army/content-opportunity/v1'
                            : undefined,
                        structured: true,
                    },
                    data: report
                }]
        };
    }
    async executeGrokSearch(task: any): Promise<any> {
        if (!this.grokConsult)
            return needsInput(this.now(), 'grok_consult_unavailable', '小R的 Grok 受控插件尚未接入。');
        const health: any = await this.grokConsult.health();
        if (health.status !== 'ready')
            return needsInput(this.now(), 'grok_login_required', health.safeMessage);
        const query: any = String(task?.input?.topic || task?.input?.title || '').trim();
        const result: any = await this.grokConsult.searchX({ query, hours: 24, maxResults: 10 });
        const completedAt: any = this.now().toISOString();
        const text: any = String(result.text || '').trim();
        const sourceUrls: any = publicUrls(text).slice(0, 10);
        if (!text || !sourceUrls.length) {
            return {
                status: 'waiting_test',
                currentStage: 'grok_public_x_research_requires_review',
                execution: { executor: 'intel-researcher', mode: 'yichen-grok-consult-mcp', finishedAt: completedAt, outcome: 'source_evidence_missing' },
                usage: { tools: [{ id: 'yichen-grok-consult', name: 'Grok 公开 X 检索', calls: 1 }] },
                error: {
                    code: 'grok_public_sources_missing',
                    message: 'Grok 返回了文本，但没有可核验的公开来源链接。',
                    userMessage: '小R拿到了 Grok 查询文本，但没有可核验的公开 X 来源链接；已转为待测试，不冒充完整研究报告。',
                    category: 'manual',
                    stage: 'grok_public_x_research',
                    retryable: false,
                    occurredAt: completedAt,
                },
                artifactRefs: [{
                        artifactId: `grok-consult-raw:${task.taskId}`,
                        taskId: task.taskId,
                        type: 'intel_x_search_raw_result',
                        title: `${query} Grok 公开检索原始结果`,
                        location: `runtime://${task.taskId}/grok-consult-raw`,
                        mimeType: 'text/plain',
                        accessScope: 'local-owner',
                        createdAt: completedAt,
                        validation: { exists: true, readable: true, nonEmpty: Boolean(text), publicReadOnly: true, sourceUrlsPresent: false, route: result.route },
                        data: { query, result: text, route: result.route },
                    }],
            };
        }
        const report: Record<string, any> = {
            schemaVersion: 'agent.army/intel-x-search-report/v1',
            topic: query,
            background: '通过受控 Grok 插件检索最近 24 小时的公开 X/Twitter 内容。',
            findings: [text.slice(0, 4000)],
            conclusion: text.slice(0, 4000),
            recommendations: ['打开下列公开来源逐条复核后再用于业务决策。'],
            openQuestions: ['当前结果是否覆盖了足够多的独立公开账号，仍需人工判断。'],
            sources: sourceUrls.map((source: any, index: any): any => ({ title: `公开 X 来源 ${index + 1}`, source })),
            route: result.route,
            generatedAt: completedAt,
        };
        return {
            status: 'succeeded', currentStage: 'grok_public_x_research_ready',
            execution: { executor: 'intel-researcher', mode: 'yichen-grok-consult-mcp', finishedAt: completedAt, outcome: 'research_ready' },
            usage: { tools: [{ id: 'yichen-grok-consult', name: 'Grok 公开 X 检索', calls: 1 }] },
            artifactRefs: [{ artifactId: `grok-consult:${task.taskId}`, taskId: task.taskId, type: 'intel_research_report', title: `${query} Grok 公开检索`, location: `runtime://${task.taskId}/grok-consult`, mimeType: 'application/json', accessScope: 'local-owner', createdAt: completedAt, validation: { exists: true, readable: true, nonEmpty: true, publicReadOnly: true, structured: true, sourceCount: sourceUrls.length, sourceUrlsPresent: true, route: result.route }, data: report }],
        };
    }
    async synthesizeVerifiedReport({ task, runId, sourceObservations = [], }: any = {}): Promise<any> {
        if (task?.taskType !== 'research.open-investigation') {
            throw new Error('小R受控报告执行器只接受开放研究任务。');
        }
        const safeRunId: any = String(runId || '').trim();
        if (!safeRunId)
            throw new Error('小R受控报告执行器缺少当前 Paperclip Run。');
        const topic: any = String(task?.input?.topic
            || task?.input?.title
            || task?.input?.goalSpec?.objective
            || '').trim();
        if (!topic)
            throw new Error('小R受控报告执行器缺少研究主题。');
        const sources: any = this.sourceAcquisition.fromVerifiedObservations(sourceObservations);
        if (sources.length < 2) {
            throw new Error('小R受控报告执行器至少需要两个真实公开来源 Observation。');
        }
        const analysis: any = await this.analyze(topic, sources);
        if (!reportClaimsBoundToSources(analysis, sources)) {
            throw new Error('小R受控报告没有把事实结论逐项绑定到真实来源 Observation。');
        }
        const completedAt: any = this.now().toISOString();
        const report: Record<string, any> = {
            schemaVersion: 'agent.army/intel-research-report/v1',
            topic,
            runId: safeRunId,
            sources,
            ...analysis,
            researchMethod: buildResearchMethod({ sources, claims: analysis.claims }),
            sourceObservationIds: sources.map((source: any): any => source.observationId),
            generatedAt: completedAt,
            limitation: '报告只陈述当前受控适配器已核验的公开来源证据，不使用任务正文自报结果。',
        };
        const checksum: any = `sha256:${createHash('sha256')
            .update(canonicalJson(report))
            .digest('hex')}`;
        return {
            artifactId: `intel-research:${task.taskId}:${safeRunId}`,
            taskId: String(task.taskId || '').trim(),
            type: 'intel_research_report',
            title: `${topic} 研究报告`,
            location: `runtime://${task.taskId}/intel-research-report`,
            mimeType: 'application/json',
            checksum,
            accessScope: 'local-owner',
            createdAt: completedAt,
            validation: {
                exists: true,
                readable: true,
                nonEmpty: true,
                publicReadOnly: true,
                sourceCount: sources.length,
                minimumSourcesMet: true,
                claimEvidenceBound: true,
                currentRun: true,
            },
            data: report,
        };
    }
    async discover(topic: any, roleToolContext: any = null): Promise<any> {
        this.sourceAcquisition.publicWebSearch = this.publicWebSearch;
        this.sourceAcquisition.githubSearch = this.githubSearch;
        return this.sourceAcquisition.discover(topic, roleToolContext);
    }
    async readSources(urls: any, roleToolContext: any = null, readModes: any = new Map(), candidatesByUrl: any = new Map(), task: any = null): Promise<any> {
        this.sourceAcquisition.publicWebFetch = this.publicWebFetch;
        return this.sourceAcquisition.readSources(urls, roleToolContext, readModes, candidatesByUrl, task);
    }
    async analyze(topic: any, sources: any): Promise<any> {
        if (typeof this.researchAdvisor?.analyze !== 'function')
            return fallbackResearch({ topic, sources });
        try {
            return await this.researchAdvisor.analyze({ topic, sources }) || fallbackResearch({ topic, sources });
        }
        catch {
            return fallbackResearch({ topic, sources });
        }
    }
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
function shouldUseGrok(task: any): any {
    const text: any = `${task?.input?.title || ''}\n${task?.input?.description || ''}\n${task?.input?.topic || ''}`;
    return /\bGrok\b|(?:搜索|查|研究).{0,8}(?:X\/Twitter|Twitter|推特)|(?:X\/Twitter|Twitter|推特).{0,8}(?:搜索|查|研究)/i.test(text);
}
function publicUrls(text: any): any {
    return [...new Set([...String(text || '').matchAll(/https?:\/\/[^\s<>()\[\]{}"'，。；：！？、【】（）《》“”‘’]+/gi)]
            .map((match: any): any => match[0].replace(/[.,;:!?]+$/g, ''))
            .filter((url: any): any => /^https?:\/\//i.test(url)))];
}
function campaignEvidencePackage({ task, topic, sources, analysis, completedAt, researchMethod }: any): any {
    const sourceRefs: any = sources.map((source: any, index: any): any => ({
        sourceId: String(source.sourceId || `source-${index + 1}`),
        title: String(source.title || `来源 ${index + 1}`).slice(0, 300),
        url: String(source.url || source.source || '').slice(0, 1000),
        fetchedAt: source.fetchedAt || completedAt,
        kind: source.kind || 'public_web',
        contentHash: String(source.contentHash || '').slice(0, 64) || null,
        evidenceFragments: Array.isArray(source.evidenceFragments)
            ? source.evidenceFragments.map((fragment: any): any => ({
                fragmentId: String(fragment.fragmentId || '').slice(0, 120),
                text: String(fragment.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
            })).filter((fragment: any): any => fragment.fragmentId && fragment.text)
            : [],
    }));
    const claims: any = (Array.isArray(analysis.claims) ? analysis.claims : [])
        .map((claim: any, index: any): any => normalizeClaim(claim, sourceRefs, index))
        .filter((claim: any): any => claim
        && claim.sourceIds.length >= 2
        && validClaimEvidenceBinding(claim));
    if (!claims.length) {
        const error: any = new Error('M5 证据包没有逐项绑定至少两个来源及原文片段的结论，拒绝生成空证据包。');
        error.code = 'campaign_evidence_claims_missing';
        error.category = 'quality';
        error.retryable = true;
        throw error;
    }
    return {
        schemaVersion: 'agent.army/evidence-package/v2',
        topic,
        scheduledDate: task.input?.context?.pipelineCase?.fields?.scheduledDate || null,
        sources: sourceRefs,
        claims,
        prohibitedStatements: [
            '来源没有直接支持的数字或效果承诺',
            '把测试、配置或本机页面说成真实平台发布',
            '敏感数据、账号信息、Token、Cookie 或本机路径',
        ],
        sourceMinimum: 2,
        researchMethod,
        generatedAt: completedAt,
    };
}
function normalizeClaim(claim: any, sources: any, index: any): any {
    const text: any = String(claim?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const sourceById: any = new Map(sources.map((source: any): any => [String(source.sourceId), source]));
    const sourceIds: any[] = [...new Set((Array.isArray(claim?.sourceIds) ? claim.sourceIds : [])
            .map(String)
            .filter((sourceId: any): any => sourceById.has(sourceId)))];
    const evidenceFragments: any = (Array.isArray(claim?.evidenceFragments) ? claim.evidenceFragments : [])
        .flatMap((fragment: any): any => {
        const sourceId: any = String(fragment?.sourceId || '');
        const source: any = sourceById.get(sourceId);
        const fragmentId: any = String(fragment?.fragmentId || '').slice(0, 120);
        const fragmentText: any = String(fragment?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
        const sourceFragment: any = source?.evidenceFragments?.find((candidate: any): any => candidate.fragmentId === fragmentId
            && candidate.text === fragmentText);
        return sourceFragment ? [{ sourceId, fragmentId, text: fragmentText }] : [];
    });
    if (!text || !sourceIds.length)
        return null;
    return {
        claimId: String(claim?.claimId || `claim-${index + 1}`).slice(0, 120),
        text,
        sourceIds,
        evidenceFragments,
        status: 'requires_script_faithfulness',
    };
}
function validClaimEvidenceBinding(claim: any): any {
    if (!String(claim?.text || '').trim()
        || !Array.isArray(claim?.sourceIds)
        || !claim.sourceIds.length
        || !Array.isArray(claim?.evidenceFragments))
        return false;
    const fragmentSourceIds: any = new Set(claim.evidenceFragments
        .filter((fragment: any): any => String(fragment?.fragmentId || '').trim() && String(fragment?.text || '').trim())
        .map((fragment: any): any => String(fragment.sourceId || '')));
    return claim.sourceIds.every((sourceId: any): any => fragmentSourceIds.has(String(sourceId)));
}
function reportClaimsBoundToSources(analysis: any, sources: any): any {
    const claims: any = Array.isArray(analysis?.claims) ? analysis.claims : [];
    if (!claims.length)
        return false;
    const byId: any = new Map(sources.map((source: any): any => [source.sourceId, source]));
    return claims.every((claim: any): any => {
        if (!validClaimEvidenceBinding(claim))
            return false;
        return claim.sourceIds.every((sourceId: any): any => {
            const source: any = byId.get(String(sourceId));
            if (!source)
                return false;
            return claim.evidenceFragments
                .filter((fragment: any): any => String(fragment?.sourceId) === String(sourceId))
                .every((fragment: any): any => source.evidenceFragments.some((candidate: any): any => candidate.fragmentId === fragment.fragmentId
                && candidate.text === fragment.text));
        });
    });
}
function buildContentOpportunity({ task, topic, sources, analysis, researchMethod }: any): any {
    const claims: any = Array.isArray(analysis?.claims) ? analysis.claims : [];
    const platform: any = String(task?.input?.platform || '').trim() || null;
    const timeWindow: any = String(task?.input?.timeWindow || '').trim() || null;
    const opportunitySignals: any = claims.slice(0, 5).map((claim: any): any => ({
        claimId: String(claim?.claimId || ''),
        signal: String(claim?.text || claim?.claim || claim?.statement || claim?.finding || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        sourceIds: [...new Set((claim?.sourceIds || []).map(String).filter(Boolean))],
        evidenceStrength: (claim?.sourceIds || []).length >= 2
            ? 'multiple_source_fragments'
            : 'single_source_fragment',
        proofBoundary: '公开互动、搜索结果和单个高表现样本只能作为需求发现信号，不证明销量、转化或可复制因果。',
    })).filter((item: any): any => item.signal && item.sourceIds.length);
    return {
        schemaVersion: 'agent.army/content-opportunity/v1',
        researchQuestion: topic,
        platform,
        timeWindow,
        sampleLimit: MAX_RESEARCH_SOURCES,
        sourceCount: sources.length,
        opportunitySignals,
        originalAngles: opportunitySignals.slice(0, 3).map((item: any, index: any): any => ({
            angleId: `angle-${index + 1}`,
            premise: item.signal,
            treatment: '只复用需求和结构启发；标题、开场、论证、案例与措辞必须重新创作。',
            evidenceRefs: item.sourceIds,
        })),
        researchSafety: {
            publicReadOnly: true,
            mainAccountAutomation: false,
            interactions: false,
            publishing: false,
            counterEvidenceSearched: researchMethod?.coverage?.counterEvidenceSearched === true,
        },
        unproven: [
            '公开互动不等于销量、收入或转化。',
            '一次高表现不等于稳定规律。',
            '没有对照实验时不得把结构相关性写成因果。',
        ],
    };
}
function buildResearchMethod({ discovery = null, sources = [], claims = [] }: any = {}): any {
    const queryPlan: any = Array.isArray(discovery?.queryPlan)
        ? discovery.queryPlan.map((lane: any): any => ({ ...lane }))
        : [];
    const selectedLaneIds: any = distinct(discovery?.selectedLaneIds || []);
    const resultLaneIds: any = distinct(discovery?.resultLaneIds || []);
    const plannedRequiredDiversity: any[] = queryPlan
        .filter((lane: any): any => lane.requiredForDiversity === true)
        .map((lane: any): any => lane.id);
    const requiredDiversity: any[] = plannedRequiredDiversity.length
        ? plannedRequiredDiversity
        : ['primary', 'practice', 'investigative', 'counterevidence'];
    const plannedMinimumSelectedSources: any = queryPlan
        .map((lane: any): any => Number(lane.minimumSelectedSources))
        .find((value: any): any => Number.isSafeInteger(value) && value > 0);
    const minimumSelectedSources: any = plannedMinimumSelectedSources
        || Math.min(MAX_RESEARCH_SOURCES, requiredDiversity.length);
    const sourceById: any = new Map(sources.map((source: any): any => [String(source?.sourceId || ''), source]));
    const sourceAssessments: any = sources.map((source: any): any => ({
        sourceId: String(source?.sourceId || ''),
        discoveryLaneIds: distinct(source?.discovery?.laneIds || []),
        evidenceEligible: source?.evidenceEligible === true,
        topicRelevant: source?.topicRelevant !== false,
        authority: 'not_inferred_from_search_rank_or_title',
        interestConflict: 'not_established',
        independence: 'not_established',
    }));
    const claimLedger: any = (Array.isArray(claims) ? claims : []).map((claim: any): any => {
        const sourceIds: any = distinct(claim?.sourceIds || []);
        const domains: any = distinct(sourceIds.flatMap((sourceId: any): any => {
            const source: any = sourceById.get(String(sourceId));
            try {
                return [new URL(source?.url || source?.source).hostname.toLowerCase()];
            }
            catch {
                return [];
            }
        }));
        return {
            claimId: String(claim?.claimId || ''),
            sourceIds,
            claimNature: 'source_supported_statement',
            evidenceLevel: sourceIds.length >= 2 ? 'multiple_source_fragments' : 'single_source_fragment',
            independence: sourceIds.length < 2
                ? 'not_established'
                : domains.length >= 2
                    ? 'multiple_domains_not_proven_independent'
                    : 'multiple_sources_same_domain',
            counterEvidenceStatus: 'not_identified_at_claim_level',
        };
    });
    return {
        schemaVersion: 'agent.army/research-method/v1',
        strategy: queryPlan.length ? 'multi_lane_discovery' : 'provided_sources_review',
        queryPlan,
        coverage: {
            queryCount: Number(discovery?.searchCalls || 0),
            completedLaneIds: distinct(discovery?.completedLaneIds || []),
            resultLaneIds,
            selectedLaneIds,
            candidateCount: Number(discovery?.candidateCount || 0),
            selectedSourceCount: sources.length,
            omittedLaneIds: queryPlan.map((lane: any): any => lane.id).filter((laneId: any): any => !selectedLaneIds.includes(laneId)),
            searchDiversityMet: requiredDiversity.every((laneId: any): any => resultLaneIds.includes(laneId))
                && selectedLaneIds.length >= minimumSelectedSources,
            counterEvidenceSearched: Number(discovery?.searchCalls || 0) > 0
                && queryPlan.some((lane: any): any => lane.id === 'counterevidence'),
        },
        epistemicPolicy: {
            searchRankIsTruthSignal: false,
            authorityLabelIsTruthSignal: false,
            clickbaitTerms: 'discovery_only',
            primaryOrIndependentCorroborationRequiredForStrongClaim: true,
            searchSnippetIsEvidence: false,
        },
        sourceAssessments,
        claimLedger,
        limitations: [
            '不同域名不等于真正独立来源，转载链和共同上游仍需人工或后续研究核对。',
            '利益冲突只有在原文明确披露或出现可核验证据时才能确认；当前默认不推断。',
            '反向搜索已执行不等于已经找到反证；每条主张仍须按证据片段判断。',
        ],
    };
}
function distinct(values: any): any {
    return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}
function needsInput(now: any, code: any, userMessage: any): any { return { status: 'needs_input', currentStage: code, error: { code, userMessage, category: 'needs_input', stage: 'input', occurredAt: now.toISOString() } }; }
