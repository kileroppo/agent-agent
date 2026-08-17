export const DISCOVERY_RESULTS_PER_LANE: any = 2;
const DISCOVERY_LANE_SELECTION_PRIORITY: any = Object.freeze([
    'primary', 'practice', 'investigative', 'counterevidence', 'baseline', 'expert',
]);

export function researchQueryPlan(topic: any): any {
    const baseQuery: any = discoveryQuery(topic).replace(/\s+/g, ' ').trim().slice(0, 300);
    const weather: any = weatherResearchContext(topic);
    if (weather) {
        return [
            ['baseline', '天气基线', '读取目标城市的七天天气预报', `${weather.location} 7天天气预报`],
            ['primary', '中国天气网', '优先读取中国天气网的目标城市预报', `site:weather.com.cn ${weather.location} 天气`],
            ['counterevidence', '中央气象台', '用中央气象台城市预报交叉核对', `site:nmc.cn ${weather.location} 天气`],
        ].map(([id, label, purpose, query]: any): any => ({
            id, label, purpose, query, requiredForDiversity: true, minimumSelectedSources: 2,
            credibilityPolicy: 'forecast_must_name_the_requested_location_and_be_read_from_the_target_page',
        }));
    }
    const chinese: any = /[\u3400-\u9fff]/.test(baseQuery);
    const lanes: any = chinese
        ? [
            ['baseline', '中性基线', '建立定义、范围和基本事实，不预设结论', ''],
            ['primary', '一手证据', '优先发现原始数据、法规、论文和正式报告', '原始数据 法规 论文 官方报告'],
            ['expert', '人物谱系', '发现先驱、代表人物、批评者及其原始作品', '创始人 先驱 专家 批评者 访谈 代表作'],
            ['practice', '实践现场', '发现实施成本、失败复盘和普通从业者经验', '实操 案例 复盘 失败 成本 从业者'],
            ['investigative', '利益审查', '发现处罚、诉讼、利益冲突与可信调查线索', '调查 处罚 诉讼 利益冲突 争议'],
            ['counterevidence', '反向验证', '主动搜索质疑、局限、反例、撤稿与辟谣', '反对 质疑 局限 失败 反例 撤稿 辟谣'],
        ]
        : [
            ['baseline', 'neutral baseline', 'Establish definitions, scope, and baseline facts without assuming a conclusion', ''],
            ['primary', 'primary evidence', 'Find original data, regulation, research, and official reports', 'official data report regulation research'],
            ['expert', 'expert lineage', 'Find pioneers, representative experts, critics, interviews, and original works', 'pioneer leading expert critic interview original work'],
            ['practice', 'practice evidence', 'Find implementation cases, costs, failures, and practitioner lessons', 'case study implementation failure cost practitioner lessons learned'],
            ['investigative', 'interest review', 'Find investigations, enforcement, litigation, conflicts of interest, and controversy', 'investigation enforcement litigation conflict of interest controversy'],
            ['counterevidence', 'counter evidence', 'Actively search for criticism, limitations, failures, counterexamples, and debunking', 'criticism limitations failed counterexample retraction debunked'],
        ];
    return lanes.map(([id, label, purpose, suffix]: any): any => ({
        id, label, purpose, query: suffix ? `${baseQuery} ${suffix}` : baseQuery,
        credibilityPolicy: id === 'investigative'
            ? 'discovery_lead_requires_primary_or_independent_corroboration'
            : 'search_rank_and_wording_are_not_credibility_signals',
    }));
}

export function selectDiverseCandidates(candidates: any, limit: any): any {
    const pool: any[] = [...candidates.values()];
    const selected: any[] = [];
    const selectedUrls: any = new Set();
    for (const laneId of DISCOVERY_LANE_SELECTION_PRIORITY) {
        const candidate: any = pool.find((item: any): any => item.laneIds.has(laneId) && !selectedUrls.has(sourceIdentity(item.url)));
        if (!candidate)
            continue;
        selected.push(materializeCandidate(candidate, laneId));
        selectedUrls.add(sourceIdentity(candidate.url));
        if (selected.length >= limit)
            return selected;
    }
    for (const candidate of pool) {
        if (selectedUrls.has(sourceIdentity(candidate.url)))
            continue;
        selected.push(materializeCandidate(candidate, [...candidate.laneIds][0] || 'baseline'));
        selectedUrls.add(sourceIdentity(candidate.url));
        if (selected.length >= limit)
            break;
    }
    return selected;
}

function materializeCandidate(candidate: any, selectedForLane: any): any {
    return { url: candidate.url, title: candidate.title, laneIds: [...candidate.laneIds],
        queries: [...candidate.queries], ranks: [...candidate.ranks], selectedForLane,
        selectionLaneIds: [selectedForLane] };
}

export function sourceDiscoveryMetadata(candidate: any): any {
    return candidate ? { laneIds: [...candidate.laneIds], queries: [...candidate.queries],
        ranks: [...candidate.ranks], selectedForLane: candidate.selectedForLane,
        candidateTitle: candidate.title } : null;
}

export function publicSourceUrl(value: any): any {
    try {
        const parsed: any = new URL(String(value || ''));
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString() : null;
    }
    catch { return null; }
}

export function sourceIdentity(value: any): any {
    try {
        const parsed: any = new URL(String(value || ''));
        parsed.hash = '';
        parsed.protocol = 'https:';
        return parsed.toString();
    }
    catch { return String(value || ''); }
}

function discoveryQuery(topic: any): any {
    const value: any = String(topic || '');
    if (/(?:agent|智能体).{0,12}(?:治理|管控|权限)|(?:治理|管控|权限).{0,12}(?:agent|智能体)/i.test(value))
        return 'agent governance';
    if (/多智能体|multi[\s-]?agent/i.test(value))
        return 'multi-agent governance';
    return value;
}

export function discoveryResultRelevant(topic: any, result: any): any {
    const weather: any = weatherResearchContext(topic);
    if (!weather)
        return true;
    const title: any = String(result?.title || '').replace(/\s+/g, ' ').trim();
    const url: any = publicSourceUrl(result?.url);
    if (!url)
        return false;
    const location: any = weather.location.replace(/[市县区]$/u, '');
    return Boolean(location && title.includes(location) && /天气|气温|预报|降雨|降水/u.test(title));
}

export function discoveryResultPriority(topic: any, result: any): any {
    if (!weatherResearchContext(topic))
        return 0;
    try {
        const url: any = new URL(String(result?.url || ''));
        const host: any = url.hostname.toLowerCase();
        if (host === 'www.weather.com.cn' && /^\/weather\/\d+\.shtml$/i.test(url.pathname)) return 100;
        if (host === 'www.nmc.cn' && /^\/publish\/forecast\//i.test(url.pathname)) return 100;
        if (host.endsWith('.weather.com.cn') || host === 'weather.com.cn') return 80;
        if (host.endsWith('.nmc.cn') || host === 'nmc.cn') return 80;
        return 10;
    }
    catch { return 0; }
}

export function sourcePageRelevant(topic: any, page: any, candidate: any): any {
    const weather: any = weatherResearchContext(topic);
    if (!weather)
        return true;
    const location: any = weather.location.replace(/[市县区]$/u, '');
    const material: any = `${String(page?.title || candidate?.title || '')}\n${String(page?.text || '')}`;
    return Boolean(location && material.includes(location)
        && /天气|气温|预报|℃|降雨|降水|晴|多云|小雨|中雨|大雨/u.test(material));
}

export function weatherResearchContext(topic: any): any {
    const value: any = String(topic || '').replace(/\s+/g, ' ').trim();
    const weatherIndex: any = value.search(/天气|气温|天气预报/u);
    if (weatherIndex < 0)
        return null;
    const before: any = value.slice(0, weatherIndex)
        .replace(/[，。！？、,!.?]/g, ' ')
        .replace(/帮我|麻烦|请|查下|查一下|查询|看看|想知道|了解/g, ' ')
        .replace(/最近|未来|接下来|过去|近|这/g, ' ')
        .replace(/一周|七天|7天|一个星期|本周|下周/g, ' ')
        .replace(/的/g, ' ').trim();
    const locations: any = before.match(/[\u3400-\u9fff]{2,16}(?:市|县|区)?/g) || [];
    const location: any = String(locations.at(-1) || '').trim();
    return location ? { location } : null;
}

export function distinct(values: any): any {
    return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}
