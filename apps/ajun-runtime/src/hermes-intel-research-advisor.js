import { execFile } from 'node:child_process';

const MAX_ITEMS = 5;

export class HermesIntelResearchAdvisor {
  constructor({ command = process.env.AJUN_HERMES_COMMAND || '/Users/pengaro/.local/bin/hermes', hermesHome = process.env.AJUN_HERMES_HOME || '', timeoutMs = 18_000, run = runCommand } = {}) {
    this.command = command;
    this.hermesHome = hermesHome;
    this.timeoutMs = timeoutMs;
    this.run = run;
  }

  async analyze({ topic, sources = [] } = {}) {
    const fallback = fallbackResearch({ topic, sources });
    if (!this.hermesHome || !sources.length) return fallback;
    try {
      const output = await this.run(this.command, ['--ignore-rules', '--oneshot', promptFor(topic, sources)], { timeoutMs:this.timeoutMs, env:{ ...process.env, HERMES_HOME:this.hermesHome } });
      const analysis = parseResearch(output);
      return analysis ? { ...fallback, ...analysis, aiAssisted:true } : fallback;
    } catch { return fallback; }
  }
}

export function fallbackResearch({ topic, sources = [] } = {}) {
  const cleanSources = Array.isArray(sources) ? sources : [];
  return {
    background:`本报告围绕“${cleanText(topic, 180) || '未命名主题'}”，仅整理本次读取到的 ${cleanSources.length} 条公开来源。`,
    findings:cleanSources.map((source, index) => `资料${index + 1}《${cleanText(source?.title, 160) || '未提供标题'}》：${cleanText(source?.summary, 420) || '没有可用摘要。'}`).slice(0, MAX_ITEMS),
    conclusion:'当前结论只限于各来源已明确说明的内容；没有足够交叉证据的判断仍无法确认。',
    recommendations:['先核对每个关键判断对应的公开来源，再决定是否需要补充更具体的资料。'],
    openQuestions:['哪些关键结论需要更多公开来源交叉验证？'],
    basis:'仅根据已读取的公开来源内容',
    aiAssisted:false
  };
}

function promptFor(topic, sources) {
  const material = sources.slice(0, MAX_ITEMS).map((source, index) => ({ number:index + 1, title:cleanText(source?.title, 160), source:cleanText(source?.source, 400), summary:cleanText(source?.summary, 1000) }));
  return [
    '你是“小R·情报研究者”的综合助手。只根据下面已经读取到的公开来源写中文研究报告。',
    '不调用工具、不访问网页、不补充外部知识、不猜测事实。来源无法证明的内容必须写“无法仅根据已读取内容确认”。',
    '只输出一行 JSON：{"background":"背景","findings":["最多5条关键发现"],"conclusion":"结论","recommendations":["最多4条行动建议"],"openQuestions":["最多4条未决问题"]}。',
    `研究主题：${JSON.stringify(cleanText(topic, 300))}`,
    `已读取来源：${JSON.stringify(material)}`
  ].join('\n');
}

function parseResearch(raw) {
  try {
    const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text);
    const background = cleanText(parsed?.background, 700);
    const findings = cleanList(parsed?.findings);
    const conclusion = cleanText(parsed?.conclusion, 900);
    const recommendations = cleanList(parsed?.recommendations);
    const openQuestions = cleanList(parsed?.openQuestions);
    if (!background || !findings.length || !conclusion) return null;
    return { background, findings, conclusion, recommendations, openQuestions, basis:'仅根据已读取的公开来源内容' };
  } catch { return null; }
}
function cleanList(value) { return (Array.isArray(value) ? value : []).map((item) => cleanText(item, 420)).filter(Boolean).slice(0, MAX_ITEMS); }
function cleanText(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function runCommand(command, args, { timeoutMs, env }) { return new Promise((resolve, reject) => execFile(command, args, { timeout:timeoutMs, maxBuffer:16 * 1024, env }, (error, stdout) => error ? reject(error) : resolve(stdout))); }
