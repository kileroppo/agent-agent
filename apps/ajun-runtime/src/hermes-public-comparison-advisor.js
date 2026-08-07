import {
  cleanHermesText as cleanText,
  defaultHermesCommand,
  NO_SIDE_EFFECT_HERMES_ARGS,
  parseHermesJson,
  runHermesCommand,
} from './hermes-oneshot-policy.js';

const MAX_POINTS = 4;

export class HermesPublicComparisonAdvisor {
  constructor({ command = defaultHermesCommand(), hermesHome = process.env.AJUN_HERMES_HOME || '', timeoutMs = 18_000, run = runHermesCommand } = {}) {
    this.command = command;
    this.hermesHome = hermesHome;
    this.timeoutMs = timeoutMs;
    this.run = run;
  }

  async compare({ sources = [] } = {}) {
    if (!this.hermesHome || !Array.isArray(sources) || sources.length < 2) return null;
    const output = await this.run(this.command, [...NO_SIDE_EFFECT_HERMES_ARGS, '--oneshot', promptFor(sources)], { timeoutMs:this.timeoutMs, env:{ ...process.env, HERMES_HOME:this.hermesHome } });
    return parseComparison(output);
  }
}

function promptFor(sources) {
  const material = sources.map((source, index) => ({ number:index + 1, title:cleanText(source?.title, 160), summary:cleanText(source?.summary, 1000) }));
  return [
    '你是“A君·军团总管”的公开资料对比助手。只根据下面已经读取到的公开网页摘要，写给负责人看的中文对比结论。',
    '不调用工具、不访问网页、不补充外部知识、不猜测事实。摘要无法证明的内容必须写“无法仅根据已读取内容确认”。',
    '只输出一行 JSON：{"commonPoints":["最多4条共同点"],"differences":["最多4条主要差别，每条清楚指出涉及的资料编号"],"recommendation":"一句只基于这些资料的下一步建议"}。',
    `已读取资料：${JSON.stringify(material)}`
  ].join('\n');
}

function parseComparison(raw) {
  const parsed = parseHermesJson(raw);
  const commonPoints = cleanList(parsed?.commonPoints);
  const differences = cleanList(parsed?.differences);
  const recommendation = cleanText(parsed?.recommendation, 420);
  if (!recommendation || (!commonPoints.length && !differences.length)) return null;
  return { commonPoints, differences, recommendation, basis:'仅根据已读取的公开网页内容' };
}

function cleanList(value) { return (Array.isArray(value) ? value : []).map((item) => cleanText(item, 360)).filter(Boolean).slice(0, MAX_POINTS); }
