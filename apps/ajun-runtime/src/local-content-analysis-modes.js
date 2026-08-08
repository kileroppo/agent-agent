export function buildModeReport({ analysisIntent, segments, modules, evidenceMode, sourceMetadata = {} } = {}) {
  const usable = Array.isArray(segments) && segments.length ? segments : [{ timestamp:null, text:'当前转录没有足够可引用片段。' }];
  if (analysisIntent === 'digest') return { digest:buildDigest(usable, modules, evidenceMode) };
  if (analysisIntent === 'deep') return { modules:modules.map(addTeachingFields) };
  if (analysisIntent === 'template') return { templateLearning:buildTemplateLearning(usable) };
  if (analysisIntent === 'style') return { styleExploration:buildStyleExploration(usable, sourceMetadata) };
  return {};
}

export function analysisIntentOptions() {
  return [
    { id:'digest', label:'精华提炼' },
    { id:'deep', label:'深度拆解' },
    { id:'template', label:'模板学习' },
    { id:'style', label:'风格探索' },
  ];
}

export function nextAnalysisAction(analysisIntent) {
  return ({
    digest:{ action:'continue_deep_analysis', label:'继续深度拆解', targetAnalysisIntent:'deep' },
    deep:{ action:'extract_fillable_template', label:'提取可填写模板', targetAnalysisIntent:'template' },
    template:{ action:'create_from_template', label:'用这个结构写我的主题', targetAgentId:'content-creator', requiresExplicitApproval:true },
    style:{ action:'create_selected_style', label:'选择这个风格生成全文', targetAgentId:'content-creator', requiresExplicitApproval:true },
  })[analysisIntent];
}

export function mergeAdvisedModeReport(fallback, advised, analysisIntent, transcript) {
  const merged = { ...fallback, ...advised, evidenceMode:fallback.evidenceMode, confirmationMode:fallback.confirmationMode, depth:fallback.depth };
  if (analysisIntent === 'deep' && Array.isArray(merged.modules)) {
    const fallbackByName = new Map(fallback.modules.map((module) => [module.name, module]));
    merged.modules = merged.modules.map((module) => ({ ...fallbackByName.get(module.name), ...module }));
  }
  const sectionKey = ({ digest:'digest', template:'templateLearning', style:'styleExploration' })[analysisIntent];
  if (sectionKey && (!advised?.[sectionKey] || !validModeReport({ ...fallback, [sectionKey]:advised[sectionKey] }, analysisIntent, transcript))) {
    merged[sectionKey] = fallback[sectionKey];
  }
  return merged;
}

export function digestCharacterCount(digest) {
  return [
    digest?.oneSentenceSummary,
    ...(digest?.corePoints || []).map((item) => item?.point),
    ...(digest?.goldenQuotes || []).map((item) => item?.quote),
    ...(digest?.actionItems || []),
  ].map((item) => String(item || '')).join('').length;
}

export function validModeReport(report, analysisIntent, transcript) {
  if (analysisIntent === 'digest') {
    const digest = report?.digest;
    return Boolean(
      clean(digest?.oneSentenceSummary, 180)
      && Array.isArray(digest?.corePoints) && digest.corePoints.length >= 3 && digest.corePoints.length <= 5
      && digest.corePoints.every((item) => evidenceMatches(transcript, item?.evidence))
      && Array.isArray(digest?.goldenQuotes) && digest.goldenQuotes.length >= 2 && digest.goldenQuotes.length <= 3
      && digest.goldenQuotes.every((item) => item?.quote === item?.evidence?.fragment && evidenceMatches(transcript, item.evidence))
      && Array.isArray(digest?.actionItems) && digest.actionItems.length >= 1 && digest.actionItems.length <= 3
    );
  }
  if (analysisIntent === 'template') {
    const template = report?.templateLearning;
    return template?.status === 'candidate'
      && Array.isArray(template?.structure) && template.structure.length === 3
      && template.structure.every((item) => item?.placeholder && item?.replacementGuide && evidenceMatches(transcript, item?.evidence))
      && Array.isArray(template?.openingTemplates) && template.openingTemplates.length === 3
      && Boolean(template?.differentTopicExample && template?.originalityReminder);
  }
  if (analysisIntent === 'style') {
    const style = report?.styleExploration;
    return style?.factsLocked === true
      && Array.isArray(style?.facts) && style.facts.length >= 1
      && style.facts.every((item) => evidenceMatches(transcript, item?.evidence))
      && Array.isArray(style?.variants) && style.variants.length === 4
      && style.variants.every((item) => clean(item?.sample, 250).length >= 150 && clean(item?.sample, 250).length <= 250);
  }
  return Array.isArray(report?.modules)
    && report.modules.length === 13
    && report.modules.every((module) => module?.observedFact?.evidence?.fragment && module?.mechanismInference?.certainty === 'inference');
}

function buildDigest(segments, modules, evidenceMode) {
  const selected = coverageSegments(segments, 3);
  return {
    status:evidenceMode === 'formal' ? 'formal' : 'preliminary',
    oneSentenceSummary:clean(selected.map((item) => item.text).join('；'), 120),
    corePoints:selected.map((segment) => ({ point:clean(segment.text, 100), evidence:evidenceFor(segment) })),
    goldenQuotes:selected.map((segment) => {
      const quote = verbatimQuote(segment.text);
      return { quote, evidence:{ timestamp:segment.timestamp, fragment:quote } };
    }),
    actionItems:modules.slice(-2).map((module) => clean(module.optimization?.[0]?.action || module.finding, 50)),
    evidenceStatus:evidenceMode === 'formal' ? 'confirmed_transcript' : 'preliminary_unconfirmed',
  };
}

function coverageSegments(segments, maximum) {
  if (segments.length <= maximum) return [...segments];
  const indexes = Array.from({ length:maximum }, (_, index) => Math.round(index * (segments.length - 1) / (maximum - 1)));
  return [...new Set(indexes)].map((index) => segments[index]);
}

function addTeachingFields(module) {
  return {
    ...module,
    observedFact:{ statement:clean(module.finding, 500), evidence:module.evidence },
    mechanismInference:{ statement:`分析推断：该片段可能通过降低理解成本或制造信息推进来维持注意。`, certainty:'inference' },
    applicableWhen:'自己的内容具备同类信息任务，并且有事实材料能够支撑该结构时。',
    failureConditions:'事实不足、承诺超出证据，或只复制措辞而没有对应内容时会失效。',
    validationMethod:'下一版只改变这一项，关联同平台同口径指标并保留原版本作对照。',
    reuseMethod:'复用结构作用和信息顺序，替换为自己的事实、案例与表达。',
  };
}

function buildTemplateLearning(segments) {
  const first = segments[0];
  const middle = segments[Math.min(1, segments.length - 1)] || first;
  const last = segments.at(-1) || first;
  return {
    status:'candidate', name:'结构模板候选',
    structure:[
      { module:'开场', purpose:'快速建立问题或结果预期', placeholder:'[目标人群遇到的问题或可核验结果]', replacementGuide:'替换为自己的真实结果或问题，不复制原句。', evidence:evidenceFor(first) },
      { module:'展开', purpose:'按单一逻辑递进解释方法和限制', placeholder:'[步骤/原因/限制条件]', replacementGuide:'每段只承担一个信息任务，并补充自己的事实依据。', evidence:evidenceFor(middle) },
      { module:'收束', purpose:'给出下一步行动并关闭叙事', placeholder:'[读者可以立刻执行的一步]', replacementGuide:'行动必须具体且不包含无法证实的结果承诺。', evidence:evidenceFor(last) },
    ],
    openingTemplates:['先给结果：[我用____解决了____，但只适用于____。]', '先提冲突：[大多数人以为____，实际关键是____。]', '先给场景：[如果你正在____，先检查____。]'],
    communicationElements:[
      { element:'结果前置', usage:'先交付可核验信息，再解释过程。', evidence:evidenceFor(first) },
      { element:'单线推进', usage:'每个段落只解决一个问题。', evidence:evidenceFor(middle) },
      { element:'行动收束', usage:'用一个低门槛动作结束。', evidence:evidenceFor(last) },
    ],
    differentTopicExample:'示例主题：家庭收纳。开场写真实痛点，中段给三个可执行分区步骤，结尾只要求今天清理一个抽屉。',
    originalityReminder:'模板仅复用结构作用；必须使用自己的原创内容、事实、案例和表达，并完成事实与平台合规核验。',
    performanceClaim:'没有合格真实指标，仅作为结构模板候选，不构成爆款或转化承诺。',
  };
}

function buildStyleExploration(segments, sourceMetadata) {
  const facts = segments.slice(0, 3).map((segment) => ({ fact:segment.text, evidence:evidenceFor(segment) }));
  const factText = facts.map((item) => item.fact).join('；');
  const topic = sourceMetadata?.title || '这个主题';
  return {
    facts, factsLocked:true, dataStatus:'insufficient',
    variants:[
      styleVariant('professional', '专业严谨版', `讨论${topic}时，先明确可核验事实：${factText}。据此可把方法拆成前提、步骤与限制三个部分。执行时应保留来源和版本记录，每轮只验证一个变量，避免把经验判断写成确定因果。`, '知识讲解、专业账号', '可信、清晰', '语气可能偏冷'),
      styleVariant('humorous', '轻松幽默版', `别急着把${topic}讲成一门玄学。先看原材料里真正说了什么：${factText}。做法很朴素——一次改一个地方，记下结果，再决定要不要保留。少一点“我感觉”，多一点能回头核对的证据。`, '轻内容、社交平台', '亲近、易读', '幽默过度会削弱严肃信息'),
      styleVariant('story', '故事化版', `一开始，我们只想弄清${topic}。线索依次出现：${factText}。转折在于，真正有用的不是照搬一句话，而是看懂它在什么时候推进信息、什么时候提醒限制。最后留下的行动，是只改一个变量并记录结果。`, '案例复盘、人物叙事', '有推进感', '故事包装不能替代事实'),
      styleVariant('evidence', '证据驱动版', `当前没有可用于比较的真实表现数据，因此只做证据驱动表达。确认稿支持的事实包括：${factText}。这些信息只能说明内容采用了相应结构，不能证明播放或转化提升；后续需关联同平台、同口径指标再评估。`, '研究复盘、数据尚不完整', '边界清楚', '数据不足时冲击力较弱'),
    ],
    recommendation:{ style:'professional', reason:'当前素材以方法和限制条件为主，专业严谨版最能保持事实边界。' },
  };
}

function styleVariant(id, name, sample, applicableScene, advantage, risk) {
  const suffix = ' 所有结论仍需回到确认稿核对，完整创作必须在用户选定风格后交给小创。';
  let text = clean(`${sample}${suffix}`, 250);
  if (text.length < 150) text = clean(`${text}${suffix}`, 250);
  return { id, name, sample:text, applicableScene, advantage, risk };
}

function evidenceFor(segment) { return { timestamp:segment?.timestamp || null, fragment:segment?.text || '' }; }
function evidenceMatches(transcript, evidence) { const fragment = clean(evidence?.fragment, 500); return Boolean(fragment && String(transcript || '').includes(fragment)); }
function verbatimQuote(value) { const text = clean(value, 500); return text.match(/^.{4,136}?[。！？!?](?=\s|$)/u)?.[0] || clean(text, 140); }
function clean(value, max) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
