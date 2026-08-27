import { evidenceMatches } from './local-content-evidence.ts';

export function buildModeReport({ analysisIntent, segments, modules, evidenceMode, sourceMetadata = {} }: any = {}): any {
    const usable: any = Array.isArray(segments) && segments.length ? segments : [{ timestamp: null, text: '当前转录没有足够可引用片段。' }];
    if (analysisIntent === 'digest')
        return { digest: buildDigest(usable, modules, evidenceMode) };
    if (analysisIntent === 'deep')
        return { modules: modules.map(addTeachingFields) };
    if (analysisIntent === 'template')
        return { templateLearning: buildTemplateLearning(usable) };
    if (analysisIntent === 'style')
        return { styleExploration: buildStyleExploration(usable, sourceMetadata) };
    return {};
}
export function analysisIntentOptions(): any {
    return [
        { id: 'digest', label: '精华提炼' },
        { id: 'deep', label: '深度拆解' },
        { id: 'template', label: '模板学习' },
        { id: 'style', label: '风格探索' },
    ];
}
export function nextAnalysisAction(analysisIntent: any): any {
    return (({
        digest: { action: 'continue_deep_analysis', label: '继续深度拆解', targetAnalysisIntent: 'deep' },
        deep: { action: 'extract_fillable_template', label: '提取可填写模板', targetAnalysisIntent: 'template' },
        template: { action: 'create_from_template', label: '用这个结构写我的主题', targetAgentId: 'content-creator', requiresExplicitApproval: true },
        style: { action: 'create_selected_style', label: '选择这个风格生成全文', targetAgentId: 'content-creator', requiresExplicitApproval: true },
    }) as any)[analysisIntent];
}
export function mergeAdvisedModeReport(fallback: any, advised: any, analysisIntent: any, transcript: any): any {
    const merged: Record<string, any> = { ...fallback, ...advised, evidenceMode: fallback.evidenceMode, confirmationMode: fallback.confirmationMode, depth: fallback.depth };
    if (analysisIntent === 'deep' && Array.isArray(merged.modules)) {
        const fallbackByName: any = new Map(fallback.modules.map((module: any): any => [module.name, module]));
        merged.modules = merged.modules.map((module: any): any => ({ ...fallbackByName.get(module.name), ...module }));
    }
    const sectionKey: any = (({ digest: 'digest', template: 'templateLearning', style: 'styleExploration' }) as any)[analysisIntent];
    if (sectionKey && (!(advised as any)?.[sectionKey] || !validModeReport({ ...fallback, [sectionKey]: (advised as any)[sectionKey] }, analysisIntent, transcript))) {
        (merged as any)[sectionKey] = (fallback as any)[sectionKey];
    }
    return merged;
}
export function digestCharacterCount(digest: any): any {
    return [
        digest?.oneSentenceSummary,
        ...(digest?.corePoints || []).map((item: any): any => item?.point),
        ...(digest?.goldenQuotes || []).map((item: any): any => item?.quote),
        ...(digest?.actionItems || []),
    ].map((item: any): any => String(item || '')).join('').length;
}
export function validModeReport(report: any, analysisIntent: any, transcript: any): any {
    if (analysisIntent === 'digest') {
        const digest: any = report?.digest;
        return Boolean(clean(digest?.oneSentenceSummary, 180)
            && Array.isArray(digest?.corePoints) && digest.corePoints.length >= 3 && digest.corePoints.length <= 5
            && digest.corePoints.every((item: any): any => modeEvidenceMatches(transcript, item?.evidence))
            && Array.isArray(digest?.goldenQuotes) && digest.goldenQuotes.length >= 2 && digest.goldenQuotes.length <= 3
            && digest.goldenQuotes.every((item: any): any => item?.quote === item?.evidence?.fragment && modeEvidenceMatches(transcript, item.evidence))
            && Array.isArray(digest?.actionItems) && digest.actionItems.length >= 1 && digest.actionItems.length <= 3);
    }
    if (analysisIntent === 'template') {
        const template: any = report?.templateLearning;
        return template?.status === 'candidate'
            && Array.isArray(template?.structure) && template.structure.length === 3
            && template.structure.every((item: any): any => item?.placeholder && item?.replacementGuide && modeEvidenceMatches(transcript, item?.evidence))
            && Array.isArray(template?.openingTemplates) && template.openingTemplates.length === 3
            && Boolean(template?.differentTopicExample && template?.originalityReminder);
    }
    if (analysisIntent === 'style') {
        const style: any = report?.styleExploration;
        return style?.factsLocked === true
            && Array.isArray(style?.facts) && style.facts.length >= 1
            && style.facts.every((item: any): any => modeEvidenceMatches(transcript, item?.evidence))
            && Array.isArray(style?.variants) && style.variants.length === 4
            && style.variants.every((item: any): any => clean(item?.sample, 250).length >= 150 && clean(item?.sample, 250).length <= 250);
    }
    return Array.isArray(report?.modules)
        && report.modules.length === 13
        && report.modules.every((module: any): any => module?.observedFact?.evidence?.fragment && module?.mechanismInference?.certainty === 'inference');
}
function modeEvidenceMatches(transcript: any, evidence: any): any {
    const fragment: any = clean(evidence?.fragment, 500);
    return Boolean(fragment && String(transcript || '').includes(fragment));
}
function buildDigest(segments: any, modules: any, evidenceMode: any): any {
    const selected: any = coverageSegments(segments, 3);
    return {
        status: evidenceMode === 'formal' ? 'formal' : 'preliminary',
        oneSentenceSummary: clean(selected.map((item: any): any => item.text).join('；'), 120),
        corePoints: selected.map((segment: any): any => ({ point: clean(segment.text, 100), evidence: evidenceFor(segment) })),
        goldenQuotes: selected.map((segment: any): any => {
            const quote: any = verbatimQuote(segment.text);
            return { quote, evidence: { timestamp: segment.timestamp, fragment: quote } };
        }),
        actionItems: modules.slice(-2).map((module: any): any => clean((module.optimization as any)?.[0]?.action || module.finding, 50)),
        evidenceStatus: evidenceMode === 'formal' ? 'confirmed_transcript' : 'preliminary_unconfirmed',
    };
}
function coverageSegments(segments: any, maximum: any): any {
    if (segments.length <= maximum)
        return [...segments];
    const indexes: any = Array.from({ length: maximum }, (_: any, index: any): any => Math.round(index * (segments.length - 1) / (maximum - 1)));
    return [...new Set(indexes)].map((index: any): any => (segments as any)[index]);
}
function addTeachingFields(module: any): any {
    return {
        ...module,
        observedFact: { statement: clean(module.finding, 500), evidence: module.evidence },
        mechanismInference: { statement: `分析推断：该片段可能通过降低理解成本或制造信息推进来维持注意。`, certainty: 'inference' },
        applicableWhen: '自己的内容具备同类信息任务，并且有事实材料能够支撑该结构时。',
        failureConditions: '事实不足、承诺超出证据，或只复制措辞而没有对应内容时会失效。',
        validationMethod: '下一版只改变这一项，关联同平台同口径指标并保留原版本作对照。',
        reuseMethod: '复用结构作用和信息顺序，替换为自己的事实、案例与表达。',
    };
}
function buildTemplateLearning(segments: any): any {
    const first: any = (segments as any)[0];
    const middle: any = (segments as any)[Math.min(1, segments.length - 1)] || first;
    const last: any = segments.at(-1) || first;
    return {
        status: 'candidate', name: '结构模板候选',
        structure: [
            { module: '开场', purpose: '快速建立问题或结果预期', placeholder: '[目标人群遇到的问题或可核验结果]', replacementGuide: '替换为自己的真实结果或问题，不复制原句。', evidence: evidenceFor(first) },
            { module: '展开', purpose: '按单一逻辑递进解释方法和限制', placeholder: '[步骤/原因/限制条件]', replacementGuide: '每段只承担一个信息任务，并补充自己的事实依据。', evidence: evidenceFor(middle) },
            { module: '收束', purpose: '给出下一步行动并关闭叙事', placeholder: '[读者可以立刻执行的一步]', replacementGuide: '行动必须具体且不包含无法证实的结果承诺。', evidence: evidenceFor(last) },
        ],
        openingTemplates: ['先给结果：[我用____解决了____，但只适用于____。]', '先提冲突：[大多数人以为____，实际关键是____。]', '先给场景：[如果你正在____，先检查____。]'],
        communicationElements: [
            { element: '结果前置', usage: '先交付可核验信息，再解释过程。', evidence: evidenceFor(first) },
            { element: '单线推进', usage: '每个段落只解决一个问题。', evidence: evidenceFor(middle) },
            { element: '行动收束', usage: '用一个低门槛动作结束。', evidence: evidenceFor(last) },
        ],
        differentTopicExample: '示例主题：家庭收纳。开场写真实痛点，中段给三个可执行分区步骤，结尾只要求今天清理一个抽屉。',
        originalityReminder: '模板仅复用结构作用；必须使用自己的原创内容、事实、案例和表达，并完成事实与平台合规核验。',
        performanceClaim: '没有合格真实指标，仅作为结构模板候选，不构成爆款或转化承诺。',
    };
}
function buildStyleExploration(segments: any, sourceMetadata: any): any {
    const facts: any = segments.slice(0, 3).map((segment: any): any => ({ fact: segment.text, evidence: evidenceFor(segment) }));
    const factText: any = facts.map((item: any): any => item.fact).join('；');
    const topic: any = sourceMetadata?.title || '这个主题';
    return {
        facts, factsLocked: true, dataStatus: 'insufficient',
        variants: [
            styleVariant('professional', '专业严谨版', `讨论${topic}时，先明确可核验事实：${factText}。据此可把方法拆成前提、步骤与限制三个部分。执行时应保留来源和版本记录，每轮只验证一个变量，避免把经验判断写成确定因果。`, '知识讲解、专业账号', '可信、清晰', '语气可能偏冷'),
            styleVariant('humorous', '轻松幽默版', `别急着把${topic}讲成一门玄学。先看原材料里真正说了什么：${factText}。做法很朴素——一次改一个地方，记下结果，再决定要不要保留。少一点“我感觉”，多一点能回头核对的证据。`, '轻内容、社交平台', '亲近、易读', '幽默过度会削弱严肃信息'),
            styleVariant('story', '故事化版', `一开始，我们只想弄清${topic}。线索依次出现：${factText}。转折在于，真正有用的不是照搬一句话，而是看懂它在什么时候推进信息、什么时候提醒限制。最后留下的行动，是只改一个变量并记录结果。`, '案例复盘、人物叙事', '有推进感', '故事包装不能替代事实'),
            styleVariant('evidence', '证据驱动版', `当前没有可用于比较的真实表现数据，因此只做证据驱动表达。确认稿支持的事实包括：${factText}。这些信息只能说明内容采用了相应结构，不能证明播放或转化提升；后续需关联同平台、同口径指标再评估。`, '研究复盘、数据尚不完整', '边界清楚', '数据不足时冲击力较弱'),
        ],
        recommendation: { style: 'professional', reason: '当前素材以方法和限制条件为主，专业严谨版最能保持事实边界。' },
    };
}
function styleVariant(id: any, name: any, sample: any, applicableScene: any, advantage: any, risk: any): any {
    const suffix: any = ' 所有结论仍需回到确认稿核对，完整创作必须在用户选定风格后交给小创。';
    let text: any = clean(`${sample}${suffix}`, 250);
    if (text.length < 150)
        text = clean(`${text}${suffix}`, 250);
    return { id, name, sample: text, applicableScene, advantage, risk };
}
function evidenceFor(segment: any): any { return { timestamp: segment?.timestamp || null, fragment: segment?.text || '' }; }
function verbatimQuote(value: any): any { const text: any = clean(value, 500); return (text.match(/^.{4,136}?[。！？!?](?=\s|$)/u) as any)?.[0] || clean(text, 140); }
function clean(value: any, max: any): any { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
