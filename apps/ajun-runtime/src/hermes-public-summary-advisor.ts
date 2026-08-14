import { cleanHermesText as cleanText, defaultHermesCommand, NO_SIDE_EFFECT_HERMES_ARGS, parseHermesJson, runHermesCommand, } from './hermes-oneshot-policy.ts';
const MAX_POINTS: any = 4;
export class HermesPublicSummaryAdvisor {
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
    async refine({ source }: any = {}): Promise<any> {
        if (!this.hermesHome || !source?.summary)
            return null;
        const output: any = await this.run(this.command, [...NO_SIDE_EFFECT_HERMES_ARGS, '--oneshot', promptFor(source)], { timeoutMs: this.timeoutMs, env: { ...process.env, HERMES_HOME: this.hermesHome } });
        return parseRefinement(output, source.summary);
    }
}
function promptFor(source: any): any {
    const material: Record<string, any> = { title: cleanText(source?.title, 160), source: cleanText(source?.source, 500), summary: cleanText(source?.summary, 1000) };
    return [
        '你是“A君·军团总管”的公开网页摘要助手。只根据下面已经读取到的单个公开网页摘要，写给负责人的中文重点。',
        '不调用工具、不访问网页、不补充外部知识、不猜测事实。摘要无法证明的内容必须写“无法仅根据已读取内容确认”。',
        '每一条必须附带能在下方摘要中逐字找到的英文 evidence；没有证据的内容不要写。只输出一行 JSON：{"keyPoints":[{"text":"中文重点","evidence":"摘要中的原文短句"}],"recommendation":{"text":"一句只基于这些资料的下一步建议","evidence":"摘要中的原文短句"}}。',
        `已读取资料：${JSON.stringify(material)}`
    ].join('\n');
}
function parseRefinement(raw: any, sourceSummary: any): any {
    const parsed: any = parseHermesJson(raw);
    const keyPoints: any = cleanClaims(parsed?.keyPoints, sourceSummary);
    const recommendation: any = cleanClaim(parsed?.recommendation, sourceSummary, 420);
    if (!keyPoints.length)
        return null;
    return { keyPoints, recommendation, basis: '仅根据已读取的公开网页内容' };
}
function cleanClaims(value: any, sourceSummary: any): any { return (Array.isArray(value) ? value : []).map((item: any): any => cleanClaim(item, sourceSummary, 360)).filter(Boolean).slice(0, MAX_POINTS); }
function cleanClaim(value: any, sourceSummary: any, limit: any): any {
    const text: any = cleanText(value?.text, limit);
    const evidence: any = cleanText(value?.evidence, 1000);
    return text && evidence && normalize(sourceSummary).includes(normalize(evidence)) ? text : null;
}
function normalize(value: any): any { return cleanText(value, 10000).toLowerCase(); }
