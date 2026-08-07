export const ANALYSIS_INTENTS = Object.freeze(['digest', 'deep', 'template', 'style']);

const ANALYSIS_INTENT_PATTERNS = Object.freeze({
  digest:/(?:总结|提炼|精华|快速看懂|重点是什么)/u,
  deep:/(?:深度拆解|完整分析|完整拆解|为什么有效|学习方法|13\s*模块)/iu,
  template:/(?:模板学习|提取模板|学习模板|复用结构|开头套路|填空模板)/u,
  style:/(?:换种风格|风格探索|专业版|幽默版|故事版|数据版)/u,
});

export function resolveAnalysisIntent({ analysisIntent, title = '', description = '', focus = '', depth } = {}) {
  const explicit = String(analysisIntent || '').trim();
  if (explicit) {
    if (!ANALYSIS_INTENTS.includes(explicit)) {
      return { error:'invalid_analysis_intent', matched:[], analysisIntent:null, depth:null };
    }
    return normalized(explicit);
  }

  const text = `${title}\n${description}\n${focus}`;
  const matched = ANALYSIS_INTENTS.filter((intent) => ANALYSIS_INTENT_PATTERNS[intent].test(text));
  if (matched.length > 1) {
    return { error:'analysis_intent_conflict', matched, analysisIntent:null, depth:null };
  }
  if (matched.length === 1) return { ...normalized(matched[0]), matched };
  return normalized(depth === 'full' ? 'deep' : 'digest');
}

export function analysisDepth(analysisIntent) {
  return analysisIntent === 'digest' ? 'fast' : 'full';
}

export function analysisIntentLabel(analysisIntent) {
  return {
    digest:'精华提炼',
    deep:'深度拆解',
    template:'模板学习',
    style:'风格探索',
  }[analysisIntent] || '精华提炼';
}

function normalized(analysisIntent) {
  return { error:null, matched:[], analysisIntent, depth:analysisDepth(analysisIntent) };
}
