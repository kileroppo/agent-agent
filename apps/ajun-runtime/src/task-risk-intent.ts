const DEFAULT_HIGH_RISK_ACTIONS = Object.freeze([
  '对外正式发布', '真实付款', '实际扣费', '破坏性删除', '强制扩权',
]);

export function hasAffirmativeRiskIntent(
  value: unknown,
  actions: readonly string[] = DEFAULT_HIGH_RISK_ACTIONS,
): boolean {
  const text = String(value || '');
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
