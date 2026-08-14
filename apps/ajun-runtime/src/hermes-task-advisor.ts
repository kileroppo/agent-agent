import { cleanHermesText as cleanText, defaultHermesCommand, NO_SIDE_EFFECT_HERMES_ARGS, parseHermesJson, runHermesCommand, } from './hermes-oneshot-policy.ts';
const MAX_ITEMS: any = 4;
export class HermesTaskAdvisor {
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
    async advise({ request, employees = [] }: any = {}): Promise<any> {
        if (!this.hermesHome)
            return null;
        const output: any = await this.run(this.command, [...NO_SIDE_EFFECT_HERMES_ARGS, '--oneshot', promptFor(request, employees)], { timeoutMs: this.timeoutMs, env: { ...process.env, HERMES_HOME: this.hermesHome } });
        return parseAdvice(output);
    }
}
function promptFor(request: any, employees: any): any {
    return [
        '你是“A君·军团总管”的任务理解助手。只解释用户想要什么和安全的下一步，不调用工具、不执行任务、不承诺系统没有的能力。',
        '只输出一行 JSON：{"understanding":"一句话说明用户真正想要的结果","deliverable":"用户最后应收到什么","missing":["最多4项确实缺少的信息或材料"],"safeNextStep":"当前最小、无登录无外发无付费的下一步"}。',
        '只能依据当前员工清单判断能力。清单没有的能力必须明确说当前没有对应员工，不能编造员工、数据、完成结果或外部访问。',
        `当前员工清单：${JSON.stringify(normalizeEmployees(employees))}`,
        `用户原话：${JSON.stringify(String(request || '').slice(0, 2000))}`
    ].join('\n');
}
function parseAdvice(raw: any): any {
    const parsed: any = parseHermesJson(raw);
    const understanding: any = cleanText(parsed?.understanding, 300);
    const deliverable: any = cleanText(parsed?.deliverable, 300);
    const safeNextStep: any = cleanText(parsed?.safeNextStep, 400);
    if (!understanding || !deliverable || !safeNextStep)
        return null;
    const missing: any = Array.isArray(parsed?.missing) ? parsed.missing.map((item: any): any => cleanText(item, 180)).filter(Boolean).slice(0, MAX_ITEMS) : [];
    return { understanding, deliverable, missing, safeNextStep };
}
function normalizeEmployees(employees: any): any {
    return (Array.isArray(employees) ? employees : []).map((employee: any): any => ({
        name: cleanText(employee?.name, 80),
        taskTypes: Array.isArray(employee?.acceptedTaskTypes) ? employee.acceptedTaskTypes.map((type: any): any => cleanText(type, 100)).filter(Boolean).slice(0, 8) : []
    })).filter((employee: any): any => employee.name);
}
