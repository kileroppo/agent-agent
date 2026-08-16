import { cleanHermesText as cleanText, defaultHermesCommand, NO_SIDE_EFFECT_HERMES_ARGS, parseHermesJson, runHermesCommand, } from './hermes-oneshot-policy.ts';
const MAX_ITEMS: any = 5;
export class HermesIntelResearchAdvisor {
    command: any;
    hermesHome: any;
    run: any;
    timeoutMs: any;
    constructor({ command = defaultHermesCommand(), hermesHome = process.env.AJUN_HERMES_HOME || '', timeoutMs = 18000, run = runHermesCommand }: any = {}) {
        this.command = command;
        this.hermesHome = hermesHome;
        this.timeoutMs = timeoutMs;
        this.run = run;
    }
    async analyze({ topic, sources = [] }: any = {}): Promise<any> {
        const fallback: any = fallbackResearch({ topic, sources });
        if (!this.hermesHome || !sources.length)
            return fallback;
        try {
            const output: any = await this.run(this.command, [...NO_SIDE_EFFECT_HERMES_ARGS, '--oneshot', promptFor(topic, sources)], { timeoutMs: this.timeoutMs, env: { ...process.env, HERMES_HOME: this.hermesHome } });
            const analysis: any = parseResearch(output, sources);
            return analysis ? { ...fallback, ...analysis, aiAssisted: true } : fallback;
        }
        catch {
            return fallback;
        }
    }
}
export function fallbackResearch({ topic, sources = [] }: any = {}): any {
    const cleanSources: any = Array.isArray(sources) ? sources : [];
    const claims: any = cleanSources.flatMap((source: any, index: any): any => {
        const sourceId: any = cleanText(source?.sourceId, 120);
        const fragment: any = Array.isArray(source?.evidenceFragments)
            ? source.evidenceFragments.find((item: any): any => cleanText(item?.fragmentId, 120) && cleanText(item?.text, 1000))
            : null;
        if (!sourceId || !fragment || source?.evidenceEligible === false)
            return [];
        return [{
                claimId: `claim-${index + 1}`,
                text: `资料《${cleanText(source?.title, 160) || '未提供标题'}》明确记录：${cleanText(fragment.text, 420)}`,
                sourceIds: [sourceId],
                evidenceFragments: [{
                        sourceId,
                        fragmentId: cleanText(fragment.fragmentId, 120),
                        text: cleanText(fragment.text, 1000),
                    }],
            }];
    });
    const weather: any = fallbackWeatherResearch({ topic, sources: cleanSources, claims });
    return weather || {
        background: `本报告围绕“${cleanText(topic, 180) || '未命名主题'}”，仅整理本次读取到的 ${cleanSources.length} 条公开来源。`,
        findings: claims.map((claim: any): any => claim.text).slice(0, MAX_ITEMS),
        claims,
        conclusion: '当前结论只限于各来源已明确说明的内容；没有足够交叉证据的判断仍无法确认。',
        recommendations: ['先核对每个关键判断对应的公开来源，再决定是否需要补充更具体的资料。'],
        openQuestions: ['哪些关键结论需要更多公开来源交叉验证？'],
        basis: '仅根据已读取的公开来源内容',
        aiAssisted: false
    };
}
function fallbackWeatherResearch({ topic, sources, claims }: any): any {
    if (!/天气|气温|预报/u.test(String(topic || '')))
        return null;
    const primary: any = sources.find((source: any): any => {
        try {
            const url: any = new URL(String(source?.url || source?.source || ''));
            return url.hostname === 'www.weather.com.cn' && /^\/weather\/\d+\.shtml$/i.test(url.pathname);
        }
        catch {
            return false;
        }
    });
    const fragment: any = primary?.evidenceFragments?.find((item: any): any => parseSevenDayForecast(item?.text).length >= 7);
    const forecast: any[] = parseSevenDayForecast(fragment?.text);
    if (!primary || !fragment || forecast.length < 7)
        return null;
    const forecastText: any = forecast.map((item: any): any => `${item.day}日（${item.label}）${item.weather}，${item.high}℃/${item.low}℃`).join('；');
    const rainDays: any[] = forecast.filter((item: any): any => /雨/u.test(item.weather)).map((item: any): any => `${item.day}日`);
    const hotDays: any[] = forecast.filter((item: any): any => item.high >= 33).map((item: any): any => `${item.day}日`);
    const crossCheck: any = sources.find((source: any): any => {
        try {
            return new URL(String(source?.url || source?.source || '')).hostname.endsWith('nmc.cn');
        }
        catch {
            return false;
        }
    });
    const weatherClaim: any = {
        claimId: 'claim-weather-seven-day',
        text: `当前页面列出的七日预报为：${forecastText}`,
        sourceIds: [cleanText(primary?.sourceId, 120)],
        evidenceFragments: [{
                sourceId: cleanText(primary?.sourceId, 120),
                fragmentId: cleanText(fragment?.fragmentId, 120),
                text: cleanText(fragment?.text, 1000),
            }],
    };
    const recommendations: any[] = [
        rainDays.length
            ? `${rainDays.join('、')}预报含降雨，通勤随身带伞，骑行或步行预留更长时间。`
            : '当前七日页面未列出降雨，出门前仍应刷新短时预报。',
        hotDays.length
            ? `${hotDays.join('、')}最高温达到或超过33℃，户外安排尽量避开午后高温时段，并及时补水防晒。`
            : '户外活动仍需根据当天最高温调整时段并及时补水。',
        `预报会滚动更新；每天出发前再次核对中国天气网${crossCheck ? '和中央气象台' : ''}的最新发布时间与降雨变化。`,
    ];
    return {
        background: `本报告围绕“${cleanText(topic, 180)}”，只整理本次实际读取的公开天气页面。`,
        findings: [weatherClaim.text],
        claims: [weatherClaim, ...claims.filter((claim: any): any => claim.claimId !== weatherClaim.claimId).slice(0, MAX_ITEMS - 1)],
        conclusion: `${forecastText}。${crossCheck ? '中央气象台城市预报已作为第二来源交叉核对；' : ''}天气预报具有时效性，临近出行应以最新页面为准。`,
        recommendations,
        openQuestions: ['不同来源的发布时间和逐日天气若有差异，应以临近出行时更新较新的预报再次核对。'],
        basis: '仅根据已读取的公开来源内容',
        aiAssisted: false,
    };
}
function parseSevenDayForecast(value: any): any[] {
    const text: any = cleanText(value, 1000);
    return [...text.matchAll(/(\d{1,2})日（([^）]{1,8})）\s*([^\d℃]{1,20}?)\s*(\d{2})\s*\/\s*(\d{2})℃/gu)]
        .slice(0, 7)
        .map((match: any): any => ({
        day: match[1],
        label: cleanText(match[2], 20),
        weather: cleanText(match[3], 40),
        high: Number(match[4]),
        low: Number(match[5]),
    }))
        .filter((item: any): any => item.weather && item.high >= item.low && item.high <= 60 && item.low >= -50);
}
function promptFor(topic: any, sources: any): any {
    const material: any = sources.slice(0, MAX_ITEMS).map((source: any, index: any): any => ({
        number: index + 1,
        sourceId: cleanText(source?.sourceId, 120),
        title: cleanText(source?.title, 160),
        url: cleanText(source?.url || source?.source, 400),
        fetchedAt: cleanText(source?.fetchedAt, 120),
        contentHash: cleanText(source?.contentHash, 80),
        evidenceFragments: (Array.isArray(source?.evidenceFragments) ? source.evidenceFragments : [])
            .slice(0, 5)
            .map((fragment: any): any => ({
            fragmentId: cleanText(fragment?.fragmentId, 120),
            text: cleanText(fragment?.text, 1000),
        })),
    }));
    return [
        '你是“小R·情报研究者”的综合助手。只根据下面已经读取到的公开来源写中文研究报告。',
        '不调用工具、不访问网页、不补充外部知识、不猜测事实。来源无法证明的内容必须写“无法仅根据已读取内容确认”。',
        '每条事实 claim 必须逐项列出真正支持它的 sourceIds，并逐来源原样复制 evidenceFragments 中已有的 fragmentId 和 text；禁止把所有来源批量挂到每条结论，禁止改写证据片段。',
        'GitHub 搜索元数据不会出现在可用证据中；不得把仓库名、Stars、语言或描述直接当成事实证据。',
        '只输出一行 JSON：{"background":"背景","claims":[{"text":"事实结论","sourceIds":["source-1"],"evidenceFragments":[{"sourceId":"source-1","fragmentId":"source-1-fragment-1","text":"原样证据片段"}]}],"conclusion":"结论","recommendations":["最多4条行动建议"],"openQuestions":["最多4条未决问题"]}。',
        `研究主题：${JSON.stringify(cleanText(topic, 300))}`,
        `已读取来源：${JSON.stringify(material)}`
    ].join('\n');
}
function parseResearch(raw: any, sources: any): any {
    try {
        const parsed: any = parseHermesJson(raw);
        const background: any = cleanText(parsed?.background, 700);
        const claims: any = cleanClaims(parsed?.claims, sources);
        const findings: any = claims.map((claim: any): any => claim.text);
        const conclusion: any = cleanText(parsed?.conclusion, 900);
        const recommendations: any = cleanList(parsed?.recommendations);
        const openQuestions: any = cleanList(parsed?.openQuestions);
        if (!background || !findings.length || !conclusion)
            return null;
        return { background, findings, claims, conclusion, recommendations, openQuestions, basis: '仅根据已读取的公开来源内容' };
    }
    catch {
        return null;
    }
}
function cleanClaims(value: any, sources: any): any {
    const sourceById: any = new Map((Array.isArray(sources) ? sources : [])
        .map((source: any): any => [cleanText(source?.sourceId, 120), source])
        .filter(([sourceId]: any): any => sourceId));
    return (Array.isArray(value) ? value : []).slice(0, MAX_ITEMS).flatMap((claim: any, index: any): any => {
        const text: any = cleanText(claim?.text, 1000);
        const sourceIds: any[] = [...new Set((Array.isArray(claim?.sourceIds) ? claim.sourceIds : [])
                .map((sourceId: any): any => cleanText(sourceId, 120))
                .filter((sourceId: any): any => sourceById.has(sourceId)))];
        const evidenceFragments: any = (Array.isArray(claim?.evidenceFragments) ? claim.evidenceFragments : [])
            .flatMap((fragment: any): any => {
            const sourceId: any = cleanText(fragment?.sourceId, 120);
            const fragmentId: any = cleanText(fragment?.fragmentId, 120);
            const fragmentText: any = cleanText(fragment?.text, 1000);
            const source: any = sourceById.get(sourceId);
            const exact: any = source?.evidenceFragments?.find((candidate: any): any => cleanText(candidate?.fragmentId, 120) === fragmentId
                && cleanText(candidate?.text, 1000) === fragmentText);
            return exact ? [{ sourceId, fragmentId, text: fragmentText }] : [];
        });
        const fragmentSources: any = new Set(evidenceFragments.map((fragment: any): any => fragment.sourceId));
        if (!text || !sourceIds.length || !sourceIds.every((sourceId: any): any => fragmentSources.has(sourceId)))
            return [];
        return [{
                claimId: `claim-${index + 1}`,
                text,
                sourceIds,
                evidenceFragments,
            }];
    });
}
function cleanList(value: any): any { return (Array.isArray(value) ? value : []).map((item: any): any => cleanText(item, 420)).filter(Boolean).slice(0, MAX_ITEMS); }
