export type AnalysisDepth = 'fast' | 'full';
export type AnalysisIntentError = 'invalid_analysis_intent' | 'analysis_intent_conflict';

type AnalysisIntentDefinition = Readonly<{
  pattern: RegExp;
  depth: AnalysisDepth;
  label: string;
}>;

const ANALYSIS_INTENT_DEFINITIONS = Object.freeze({
  digest:{
    pattern:/(?:总结|提炼|精华|快速看懂|重点是什么)/u,
    depth:'fast',
    label:'精华提炼',
  },
  deep:{
    pattern:/(?:深度拆解|完整分析|完整拆解|为什么有效|学习方法|13\s*模块)/iu,
    depth:'full',
    label:'深度拆解',
  },
  template:{
    pattern:/(?:模板学习|提取模板|学习模板|复用结构|开头套路|填空模板)/u,
    depth:'full',
    label:'模板学习',
  },
  style:{
    pattern:/(?:换种风格|风格探索|专业版|幽默版|故事版|数据版)/u,
    depth:'full',
    label:'风格探索',
  },
} as const satisfies Readonly<Record<string, AnalysisIntentDefinition>>);

export type AnalysisIntent = keyof typeof ANALYSIS_INTENT_DEFINITIONS;
export const ANALYSIS_INTENTS = Object.freeze(
  Object.keys(ANALYSIS_INTENT_DEFINITIONS) as AnalysisIntent[],
);

export type AnalysisIntentResolution = Readonly<{
  error: AnalysisIntentError | null;
  matched: readonly AnalysisIntent[];
  analysisIntent: AnalysisIntent | null;
  depth: AnalysisDepth | null;
}>;

export type AnalysisIntentInput = Readonly<{
  analysisIntent?: unknown;
  title?: unknown;
  description?: unknown;
  focus?: unknown;
  depth?: unknown;
}>;

export function resolveAnalysisIntent({
  analysisIntent,
  title = '',
  description = '',
  focus = '',
  depth,
}: AnalysisIntentInput = {}): AnalysisIntentResolution {
  const explicit = String(analysisIntent || '').trim();
  if (explicit) {
    if (!isAnalysisIntent(explicit)) {
      return { error:'invalid_analysis_intent', matched:[], analysisIntent:null, depth:null };
    }
    return normalized(explicit);
  }

  const text = `${title}\n${description}\n${focus}`;
  const matched = ANALYSIS_INTENTS.filter((intent) => (
    ANALYSIS_INTENT_DEFINITIONS[intent].pattern.test(text)
  ));
  if (matched.length > 1) {
    return { error:'analysis_intent_conflict', matched, analysisIntent:null, depth:null };
  }
  if (matched.length === 1) return { ...normalized(matched[0]), matched };
  return normalized(depth === 'full' ? 'deep' : 'digest');
}

export function analysisDepth(analysisIntent: unknown): AnalysisDepth {
  return analysisIntent === 'digest' ? ANALYSIS_INTENT_DEFINITIONS.digest.depth : 'full';
}

export function analysisIntentLabel(analysisIntent: unknown): string {
  return typeof analysisIntent === 'string' && isAnalysisIntent(analysisIntent)
    ? ANALYSIS_INTENT_DEFINITIONS[analysisIntent].label
    : ANALYSIS_INTENT_DEFINITIONS.digest.label;
}

function isAnalysisIntent(value: string): value is AnalysisIntent {
  return Object.hasOwn(ANALYSIS_INTENT_DEFINITIONS, value);
}

function normalized(analysisIntent: AnalysisIntent): AnalysisIntentResolution {
  return { error:null, matched:[], analysisIntent, depth:analysisDepth(analysisIntent) };
}
