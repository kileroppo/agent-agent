const DEFAULT_HIGH_RISK_ACTIONS = Object.freeze([
  '外发', '发布', '删除', '付款', '付费', '扩权', '敏感',
]);

export function hasAffirmativeRiskIntent(
  value: unknown,
  actions: readonly string[] = DEFAULT_HIGH_RISK_ACTIONS,
): boolean {
  const text = String(value || '');
  if (/(?:发布|下发|安排|创建)\s*(?:一个|一项|个|项)?\s*(?:测试)?任务|(?:发布|生成)\s*(?:平台)?(?:草稿|草案|脚本)/.test(text)) {
    return false;
  }
  return actions.some((action) => {
    let startAt = 0;
    while (startAt < text.length) {
      const index = text.indexOf(action, startAt);
      if (index < 0) return false;
      if (!isExplicitlyNegated(text.slice(0, index))) return true;
      startAt = index + action.length;
    }
    return false;
  });
}

function isExplicitlyNegated(prefix: string): boolean {
  if (/(?:不|无|禁止|不得|不可|不能|无需|不用|不需要|不允许|不涉及)\s*$/.test(prefix)) return true;
  const clause = String(prefix || '').split(/[，,。；;：:！？!?\n]/).at(-1) || '';
  return /^\s*(?:请)?(?:不|不要|不得|禁止|不可|不能|无需|不用|不需要|不允许|不涉及)[^，,。；;：:！？!?\n]{0,80}(?:、|或|和|以及)\s*$/.test(clause);
}
