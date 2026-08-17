import { DISCOVERY_RESULTS_PER_LANE, discoveryResultPriority, discoveryResultRelevant, distinct, publicSourceUrl, researchQueryPlan, selectDiverseCandidates, sourceDiscoveryMetadata, sourceIdentity, sourcePageRelevant, weatherResearchContext, } from './open-research-discovery-policy.ts';
const CONTROLLED_SOURCE_MATERIAL: any = Symbol.for('agent.army.openResearch.controlledSourceMaterial');
export const MAX_RESEARCH_SOURCES: any = 5;
export class OpenResearchSourceAcquisition {
    githubSearch: any;
    publicWebFetch: any;
    publicWebSearch: any;
    constructor({ publicWebFetch, publicWebSearch = null, githubSearch = null }: any = {}) {
        this.publicWebFetch = publicWebFetch;
        this.publicWebSearch = publicWebSearch;
        this.githubSearch = githubSearch;
    }
    async acquire({ task, topic, roleToolContext = null, discover = (value: any, context: any): any => this.discover(value, context), readSources = (...args: any): any => (this.readSources as any)(...args), }: any = {}): Promise<any> {
        const isCampaignResearch: any = task?.taskType === 'content.campaign-research';
        const isCampaignEvidence: any = task?.taskType === 'content.campaign-evidence';
        let sourceUrls: any = sourceList(task?.input);
        let discovery: any = null;
        if (sourceUrls.length > MAX_RESEARCH_SOURCES) {
            return unavailable('research_source_limit_exceeded', '一次最多研究五条公开网页来源；请分批发送，避免遗漏资料。');
        }
        if (!sourceUrls.length) {
            discovery = await discover(topic, roleToolContext);
            sourceUrls = discovery.urls;
        }
        const { sources, failures } = await readSources(sourceUrls, roleToolContext, sourceReadModes(task?.input), discovery?.candidatesByUrl, task);
        if (!sources.length && discovery?.githubSources?.length) {
            (sources.push as any)(...discovery.githubSources);
        }
        if (!sources.length) {
            return unavailable('research_sources_unavailable', `${failures[0] || discovery?.failures?.[0] || '没有得到可读取的公开来源。'} 请补充公开来源链接或换一个更具体的主题。`);
        }
        const preparedSources: any = prepareResearchSources(sources);
        const evidenceSources: any = preparedSources.filter((source: any): any => source.evidenceEligible === true);
        if ((isCampaignResearch || isCampaignEvidence) && evidenceSources.length < 2) {
            return unavailable('campaign_research_minimum_sources', `M5 内容研究至少需要两个同时具有 URL、抓取时间和内容哈希的公开正文来源，当前只有 ${evidenceSources.length} 个；GitHub 搜索元数据不能直接算证据。`);
        }
        const usageTools: any[] = [];
        if (discovery?.searched) {
            usageTools.push({
                id: 'public-web-search',
                name: '公开网页搜索',
                calls: discovery.searchCalls || 1,
            });
        }
        if (discovery?.githubSearched) {
            usageTools.push({ id: 'github-public-search', name: '公开 GitHub 项目检索', calls: 1 });
        }
        if (sourceUrls.length) {
            usageTools.push({
                id: 'public-web-fetch',
                name: '公开网页读取',
                calls: sources.filter((source: any): any => source.kind === 'public_web').length,
            });
        }
        return {
            ready: true,
            discovery,
            preparedSources,
            evidenceSources,
            executionMode: discovery
                ? 'public_discovery_and_research'
                : 'provided_sources_research',
            usageTools: usageTools.filter((tool: any): any => tool.calls > 0),
        };
    }
    async discover(topic: any, roleToolContext: any = null): Promise<any> {
        const queryPlan: any = researchQueryPlan(topic);
        const baseQuery: any = queryPlan[0].query;
        const resultsPerLane: any = weatherResearchContext(topic)
            ? MAX_RESEARCH_SOURCES
            : DISCOVERY_RESULTS_PER_LANE;
        const failures: any[] = [];
        let searchCalls: any = 0;
        const candidates: any = new Map();
        const completedLaneIds: any[] = [];
        const resultLaneIds: any[] = [];
        if (this.publicWebSearch?.search) {
            const attempts: any[] = [];
            for (const lane of queryPlan) {
                searchCalls += 1;
                try {
                    const search: any = roleToolContext
                        ? await roleToolContext.execute({
                            toolId: 'content.public.search',
                            externalSideEffect: 'network-read',
                            url: 'https://html.duckduckgo.com/html/',
                            input: { query: lane.query, limit: resultsPerLane },
                        })
                        : await this.publicWebSearch.search({
                            query: lane.query,
                            limit: resultsPerLane,
                        });
                    attempts.push({ lane, search });
                }
                catch (error: any) {
                    attempts.push({ lane, error });
                }
            }
            for (const attempt of attempts) {
                if (attempt.error) {
                    failures.push(`${attempt.lane.label}：${attempt.error?.message || '公开搜索暂时无法读取。'}`);
                    continue;
                }
                completedLaneIds.push(attempt.lane.id);
                const results: any = (Array.isArray(attempt.search?.results) ? attempt.search.results : [])
                    .filter((item: any): any => discoveryResultRelevant(topic, item))
                    .sort((left: any, right: any): any => discoveryResultPriority(topic, right) - discoveryResultPriority(topic, left));
                if (results.some((item: any): any => publicSourceUrl(item?.url))) {
                    resultLaneIds.push(attempt.lane.id);
                }
                for (const [rank, result] of results.entries()) {
                    const url: any = publicSourceUrl(result?.url);
                    if (!url)
                        continue;
                    const identity: any = sourceIdentity(url);
                    const current: any = candidates.get(identity) || {
                        url,
                        title: String(result?.title || '').trim().slice(0, 300) || null,
                        laneIds: new Set(),
                        queries: new Set(),
                        ranks: [],
                    };
                    if (String(current.url).startsWith('http:') && url.startsWith('https:'))
                        current.url = url;
                    current.laneIds.add(attempt.lane.id);
                    current.queries.add(attempt.lane.query);
                    current.ranks.push(rank + 1);
                    candidates.set(identity, current);
                }
            }
            if (candidates.size) {
                const selected: any = selectDiverseCandidates(candidates, MAX_RESEARCH_SOURCES);
                return {
                    urls: selected.map((candidate: any): any => candidate.url),
                    searched: true,
                    searchCalls,
                    githubSearched: false,
                    failures,
                    queryPlan,
                    completedLaneIds,
                    resultLaneIds,
                    candidateCount: candidates.size,
                    selectedLaneIds: distinct(selected.flatMap((candidate: any): any => candidate.selectionLaneIds)),
                    candidatesByUrl: new Map(selected.map((candidate: any): any => [candidate.url, candidate])),
                };
            }
        }
        if (this.githubSearch?.search) {
            try {
                const search: any = roleToolContext
                    ? await roleToolContext.execute({
                        toolId: 'github.public.search',
                        externalSideEffect: 'network-read',
                        url: 'https://api.github.com/search/repositories',
                        input: { operation: 'search', query: baseQuery, limit: 3 },
                    })
                    : await this.githubSearch.search({ query: baseQuery, limit: 3 });
                return {
                    urls: [],
                    searched: Boolean(this.publicWebSearch),
                    searchCalls,
                    githubSearched: true,
                    failures,
                    queryPlan,
                    completedLaneIds,
                    resultLaneIds,
                    candidateCount: candidates.size,
                    selectedLaneIds: [],
                    candidatesByUrl: new Map(),
                    githubSources: search.results.map((item: any): any => ({
                        kind: 'github_metadata',
                        title: item.fullName,
                        source: item.url,
                        summary: item.description || '仓库没有提供描述。',
                        fetchedAt: search.searchedAt,
                        truncated: false,
                        evidenceEligible: false,
                        evidenceExclusionReason: 'github_metadata_only',
                    })),
                };
            }
            catch (error: any) {
                failures.push(error?.message || '公开 GitHub 来源暂时无法读取。');
            }
        }
        return {
            urls: [],
            searched: Boolean(this.publicWebSearch),
            searchCalls,
            githubSearched: Boolean(this.githubSearch),
            githubSources: [],
            failures,
            queryPlan,
            completedLaneIds,
            resultLaneIds,
            candidateCount: candidates.size,
            selectedLaneIds: [],
            candidatesByUrl: new Map(),
        };
    }
    async readSources(urls: any, roleToolContext: any = null, readModes: any = new Map(), candidatesByUrl: any = new Map(), task: any = null): Promise<any> {
        const sources: any[] = [];
        const failures: any[] = [];
        for (const sourceUrl of urls) {
            try {
                const readMode: any = readModes.get(sourceUrl)
                    || (/\.pdf(?:$|[?#])/i.test(sourceUrl) ? 'pdf' : 'static');
                const toolId: any = readMode === 'pdf'
                    ? 'content.public.pdf.read'
                    : readMode === 'dynamic'
                        ? 'content.public.dynamic.read'
                        : 'content.public.fetch';
                    const page: any = roleToolContext
                        ? await roleToolContext.execute({
                        toolId,
                        externalSideEffect: 'network-read',
                        url: sourceUrl,
                        input: { sourceUrl },
                    })
                    : await this.publicWebFetch.acquire({ sourceUrl, task });
                    const candidate: any = candidatesByUrl?.get?.(sourceUrl);
                    const pageTopic: any = researchTopic(task);
                    if (candidate && !sourcePageRelevant(pageTopic, page, candidate)) {
                        failures.push(`公开来源与研究主题不匹配：${String(page.title || candidate.title || sourceUrl).slice(0, 160)}`);
                        continue;
                    }
                    sources.push({
                    kind: readMode === 'pdf'
                        ? 'public_pdf'
                        : readMode === 'dynamic' ? 'public_dynamic_web' : 'public_web',
                    title: page.title || '未提供标题的公开来源',
                    source: page.sourceRef,
                    summary: summarize(page.text, pageTopic),
                    contentHash: page.contentHash || null,
                    fetchedAt: page.fetchedAt,
                    truncated: Boolean(page.truncated),
                    topicRelevant: candidate ? true : null,
                    discovery: sourceDiscoveryMetadata(candidate),
                });
            }
            catch (error: any) {
                failures.push(error?.message || '公开来源暂时无法读取。');
            }
        }
        return { sources, failures };
    }
    fromVerifiedObservations(observations: any): any {
        const unique: any = new Map();
        for (const observation of Array.isArray(observations) ? observations : []) {
            const evidence: any = observation?.result?.sourceEvidence;
            const source: any = publicSourceUrl(evidence?.url);
            const fetchedAt: any = validTimestamp(evidence?.fetchedAt);
            const contentHash: any = validContentHash(evidence?.contentHash);
            const observationId: any = String(observation?.observationId || '').trim();
            const sourceId: any = String(evidence?.sourceId || '').trim();
            const fragmentId: any = String(evidence?.evidenceFragment?.fragmentId || '').trim();
            const fragmentText: any = String(evidence?.evidenceFragment?.text || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 900);
            const controlledSummary: any = String(observation?.[CONTROLLED_SOURCE_MATERIAL]?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 900);
            if (observation?.schemaVersion !== 'agent.army/tool-observation/v1'
                || observation?.outcome !== 'succeeded'
                || observation?.classification !== 'source_verified'
                || observation?.provenance !== 'trusted_role_tool_adapter'
                || !observationId
                || !sourceId
                || !source
                || !fetchedAt
                || !contentHash
                || !fragmentId
                || !fragmentText)
                continue;
            unique.set(`${source}|${contentHash}`, {
                kind: String(evidence.kind || 'public_web'),
                observationId,
                sourceId,
                title: String(evidence.title || '未提供标题的公开来源').slice(0, 300),
                source,
                url: source,
                fetchedAt,
                contentHash,
                summary: controlledSummary || fragmentText,
                evidenceEligible: true,
                evidenceFragments: [{
                        fragmentId,
                        text: controlledSummary || fragmentText,
                    }],
            });
        }
        return [...unique.values()];
    }
}
function prepareResearchSources(sources: any): any {
    return (Array.isArray(sources) ? sources : []).map((source: any, index: any): any => {
        const sourceId: any = `source-${index + 1}`;
        const url: any = publicSourceUrl(source?.source);
        const fetchedAt: any = validTimestamp(source?.fetchedAt);
        const contentHash: any = validContentHash(source?.contentHash);
        const summary: any = String(source?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 900);
        const metadataOnly: any = source?.kind === 'github_metadata';
        const unusableBody: any = unusablePublicSourceBody(summary);
        const evidenceEligible: any = !metadataOnly && !unusableBody && Boolean(url && fetchedAt && contentHash && summary);
        return {
            ...source,
            sourceId,
            url,
            fetchedAt: fetchedAt || source?.fetchedAt || null,
            contentHash,
            evidenceEligible,
            evidenceExclusionReason: evidenceEligible
                ? null
                : metadataOnly
                    ? 'github_metadata_only'
                    : unusableBody
                        ? 'fetch_error_or_redirect_placeholder'
                    : 'missing_url_fetched_at_content_hash_or_text',
            evidenceFragments: evidenceEligible
                ? [{ fragmentId: `${sourceId}-fragment-1`, text: summary }]
                : [],
        };
    });
}
function unusablePublicSourceBody(summary: any): any {
    const text: any = String(summary || '').replace(/\s+/g, ' ').trim();
    if (!text)
        return false;
    return /^(?:please\s+click\s+here\s+if\s+the\s+page\s+does\s+not\s+redirect\s+automatically|无法访问此网站|this\s+site\s+can(?:not|'t)\s+be\s+reached|the\s+page\s+is\s+not\s+redirecting)/i.test(text);
}
function sourceList(input: any): any {
    return [...new Set([
            ...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []),
            input?.sourceUrl,
        ].map((value: any): any => String(value || '').trim()).filter(Boolean))];
}
function sourceReadModes(input: any): any {
    const modes: any = new Map();
    for (const url of Array.isArray(input?.dynamicSourceUrls) ? input.dynamicSourceUrls : []) {
        const normalized: any = String(url || '').trim();
        if (normalized)
            modes.set(normalized, 'dynamic');
    }
    for (const url of Array.isArray(input?.pdfSourceUrls) ? input.pdfSourceUrls : []) {
        const normalized: any = String(url || '').trim();
        if (normalized)
            modes.set(normalized, 'pdf');
    }
    return modes;
}
function validTimestamp(value: any): any {
    const timestamp: any = String(value || '').trim();
    return Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
}
function validContentHash(value: any): any {
    const hash: any = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}
function researchTopic(task: any): any {
    return String(task?.input?.topic
        || task?.input?.context?.pipelineCase?.fields?.theme
        || task?.input?.title
        || '').trim();
}
function summarize(text: any, topic: any = ''): any {
    const compact: any = String(text || '').replace(/\s+/g, ' ').trim();
    const weather: any = weatherResearchContext(topic);
    if (weather) {
        const location: any = weather.location.replace(/[市县区]$/u, '');
        const index: any = compact.indexOf(location);
        const markerIndexes: any[] = [
            compact.search(/\d{1,2}日（今天）/u),
            compact.search(/发布时间[:：]\s*\d{2}-\d{2}\s+\d{2}:\d{2}/u),
        ].filter((value: any): any => value >= 0);
        const anchor: any = markerIndexes[0] ?? index;
        if (anchor >= 0) {
            return compact.slice(Math.max(0, anchor - 220), anchor + 1_200).slice(0, 900)
                || '公开网页没有可用正文。';
        }
    }
    const sentences: any = compact.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
    return (sentences.length ? sentences.slice(0, 3).join(' ') : compact).slice(0, 900)
        || '公开网页没有可用正文。';
}
function unavailable(code: any, userMessage: any): any {
    return { ready: false, code, userMessage };
}
