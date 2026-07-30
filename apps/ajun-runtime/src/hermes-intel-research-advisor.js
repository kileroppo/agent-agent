import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { NO_SIDE_EFFECT_HERMES_ARGS } from './hermes-oneshot-policy.js';

const MAX_ITEMS = 5;

export class HermesIntelResearchAdvisor {
  constructor({ command = process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local', 'bin', 'hermes'), hermesHome = process.env.AJUN_HERMES_HOME || '', timeoutMs = 18_000, run = runCommand } = {}) {
    this.command = command;
    this.hermesHome = hermesHome;
    this.timeoutMs = timeoutMs;
    this.run = run;
  }

  async analyze({ topic, sources = [] } = {}) {
    const fallback = fallbackResearch({ topic, sources });
    if (!this.hermesHome || !sources.length) return fallback;
    try {
      const output = await this.run(this.command, [...NO_SIDE_EFFECT_HERMES_ARGS, '--oneshot', promptFor(topic, sources)], { timeoutMs:this.timeoutMs, env:{ ...process.env, HERMES_HOME:this.hermesHome } });
      const analysis = parseResearch(output, sources);
      return analysis ? { ...fallback, ...analysis, aiAssisted:true } : fallback;
    } catch { return fallback; }
  }
}

export function fallbackResearch({ topic, sources = [] } = {}) {
  const cleanSources = Array.isArray(sources) ? sources : [];
  const claims = cleanSources.flatMap((source, index) => {
    const sourceId = cleanText(source?.sourceId, 120);
    const fragment = Array.isArray(source?.evidenceFragments)
      ? source.evidenceFragments.find((item) => cleanText(item?.fragmentId, 120) && cleanText(item?.text, 1000))
      : null;
    if (!sourceId || !fragment || source?.evidenceEligible === false) return [];
    return [{
      claimId:`claim-${index + 1}`,
      text:`资料《${cleanText(source?.title, 160) || '未提供标题'}》明确记录：${cleanText(fragment.text, 420)}`,
      sourceIds:[sourceId],
      evidenceFragments:[{
        sourceId,
        fragmentId:cleanText(fragment.fragmentId, 120),
        text:cleanText(fragment.text, 1000),
      }],
    }];
  });
  return {
    background:`本报告围绕“${cleanText(topic, 180) || '未命名主题'}”，仅整理本次读取到的 ${cleanSources.length} 条公开来源。`,
    findings:claims.map((claim) => claim.text).slice(0, MAX_ITEMS),
    claims,
    conclusion:'当前结论只限于各来源已明确说明的内容；没有足够交叉证据的判断仍无法确认。',
    recommendations:['先核对每个关键判断对应的公开来源，再决定是否需要补充更具体的资料。'],
    openQuestions:['哪些关键结论需要更多公开来源交叉验证？'],
    basis:'仅根据已读取的公开来源内容',
    aiAssisted:false
  };
}

function promptFor(topic, sources) {
  const material = sources.slice(0, MAX_ITEMS).map((source, index) => ({
    number:index + 1,
    sourceId:cleanText(source?.sourceId, 120),
    title:cleanText(source?.title, 160),
    url:cleanText(source?.url || source?.source, 400),
    fetchedAt:cleanText(source?.fetchedAt, 120),
    contentHash:cleanText(source?.contentHash, 80),
    evidenceFragments:(Array.isArray(source?.evidenceFragments) ? source.evidenceFragments : [])
      .slice(0, 5)
      .map((fragment) => ({
        fragmentId:cleanText(fragment?.fragmentId, 120),
        text:cleanText(fragment?.text, 1000),
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

function parseResearch(raw, sources) {
  try {
    const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text);
    const background = cleanText(parsed?.background, 700);
    const claims = cleanClaims(parsed?.claims, sources);
    const findings = claims.map((claim) => claim.text);
    const conclusion = cleanText(parsed?.conclusion, 900);
    const recommendations = cleanList(parsed?.recommendations);
    const openQuestions = cleanList(parsed?.openQuestions);
    if (!background || !findings.length || !conclusion) return null;
    return { background, findings, claims, conclusion, recommendations, openQuestions, basis:'仅根据已读取的公开来源内容' };
  } catch { return null; }
}
function cleanClaims(value, sources) {
  const sourceById = new Map((Array.isArray(sources) ? sources : [])
    .map((source) => [cleanText(source?.sourceId, 120), source])
    .filter(([sourceId]) => sourceId));
  return (Array.isArray(value) ? value : []).slice(0, MAX_ITEMS).flatMap((claim, index) => {
    const text = cleanText(claim?.text, 1_000);
    const sourceIds = [...new Set(
      (Array.isArray(claim?.sourceIds) ? claim.sourceIds : [])
        .map((sourceId) => cleanText(sourceId, 120))
        .filter((sourceId) => sourceById.has(sourceId)),
    )];
    const evidenceFragments = (Array.isArray(claim?.evidenceFragments) ? claim.evidenceFragments : [])
      .flatMap((fragment) => {
        const sourceId = cleanText(fragment?.sourceId, 120);
        const fragmentId = cleanText(fragment?.fragmentId, 120);
        const fragmentText = cleanText(fragment?.text, 1_000);
        const source = sourceById.get(sourceId);
        const exact = source?.evidenceFragments?.find((candidate) =>
          cleanText(candidate?.fragmentId, 120) === fragmentId
          && cleanText(candidate?.text, 1_000) === fragmentText
        );
        return exact ? [{ sourceId, fragmentId, text:fragmentText }] : [];
      });
    const fragmentSources = new Set(evidenceFragments.map((fragment) => fragment.sourceId));
    if (!text || !sourceIds.length || !sourceIds.every((sourceId) => fragmentSources.has(sourceId))) return [];
    return [{
      claimId:`claim-${index + 1}`,
      text,
      sourceIds,
      evidenceFragments,
    }];
  });
}
function cleanList(value) { return (Array.isArray(value) ? value : []).map((item) => cleanText(item, 420)).filter(Boolean).slice(0, MAX_ITEMS); }
function cleanText(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function runCommand(command, args, { timeoutMs, env }) { return new Promise((resolve, reject) => execFile(command, args, { timeout:timeoutMs, maxBuffer:16 * 1024, env }, (error, stdout) => error ? reject(error) : resolve(stdout))); }
