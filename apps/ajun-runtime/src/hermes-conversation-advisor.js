import {
  defaultHermesCommand,
  NO_SIDE_EFFECT_HERMES_ARGS,
  parseHermesJson,
  runHermesCommand,
} from './hermes-oneshot-policy.js';

const ACTIONS = new Set(['show_last_usage_items', 'not_applicable']);

// Hermes is used here to understand a follow-up in a conversation, not to
// invent a response. The only accepted action is mapped back to local facts.
export class HermesConversationAdvisor {
  constructor({ command = defaultHermesCommand(), hermesHome = process.env.AJUN_HERMES_HOME || '', timeoutMs = 18_000, run = runHermesCommand } = {}) {
    this.command = command;
    this.hermesHome = hermesHome;
    this.timeoutMs = timeoutMs;
    this.run = run;
  }

  async decide({ message, context } = {}) {
    if (!this.hermesHome || !context?.kind) return null;
    const output = await this.run(this.command, [...NO_SIDE_EFFECT_HERMES_ARGS, '--oneshot', promptFor(message, context)], { timeoutMs:this.timeoutMs, env:{ ...process.env, HERMES_HOME:this.hermesHome } });
    return parseDecision(output);
  }
}

function promptFor(message, context) {
  const safeContext = {
    kind:String(context.kind || ''),
    recordedTaskCount:Number(context.recordedTaskCount || 0),
    actualToolCalls:Number(context.actualToolCalls || 0),
    createdAt:String(context.createdAt || '')
  };
  return [
    '你是“A君·军团总管”的上下文理解助手。你只判断用户是否在追问刚才的“今天实际使用情况”汇总，绝不调用工具、绝不执行任务、绝不补造任务、员工、费用或结果。',
    '只输出一行 JSON：{"action":"show_last_usage_items"|"not_applicable"}。',
    '当用户用自然说法追问“哪几项、具体有哪些、展开看看、刚才那几项是什么、明细”等，且上一次上下文是 usage_report 时，输出 show_last_usage_items。其他情况输出 not_applicable。',
    `上一轮已保存的最小事实：${JSON.stringify(safeContext)}`,
    `用户这句话：${JSON.stringify(String(message || '').slice(0, 1000))}`
  ].join('\n');
}

function parseDecision(raw) {
  const parsed = parseHermesJson(raw);
  return ACTIONS.has(parsed?.action) ? { action:parsed.action } : null;
}
