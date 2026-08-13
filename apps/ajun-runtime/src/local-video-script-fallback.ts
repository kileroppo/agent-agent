export function createLocalVideoScriptFallback({
  topic,
  platform,
  reference,
  research,
  sourceContext = null,
  buildShots,
}: any) {
  const factual = research?.sources?.[0]?.summary;
  const hook = `先别急着给“${topic}”下结论，真正影响结果的是你接下来怎么判断和行动。`;
  const analysisSummary = clean(sourceContext?.formalAnalysis?.summary, 500);
  const transcriptExcerpt = clean(sourceContext?.confirmedTranscript?.excerpt, 500);
  const proof = analysisSummary
    ? `正式拆解给出的可用结论是：${analysisSummary}`
    : factual
      ? `公开资料里有一个值得核对的信号：${clean(factual, 220)}`
      : '这版先讲判断方法，不编造没有来源的数字和事实。';
  const fullScript = [
    hook,
    `很多人谈到“${topic}”时，会直接站队，但这会漏掉真正重要的前提。`,
    proof,
    ...(transcriptExcerpt ? [`确认稿里的原始表达是：${transcriptExcerpt}`] : []),
    '更务实的做法是：先确认问题发生在谁身上，再找一个最小可验证动作，最后只根据真实反馈继续调整。',
    '你今天不用把整件事想透，只要先完成那个能得到真实反馈的小动作。',
  ].join('\n\n');
  return {
    headline:`${topic}：别急着站队，先做这个判断`,
    platform,
    durationSeconds:45,
    aspectRatio:'9:16',
    audience:'对该主题感兴趣、希望得到清晰行动建议的普通用户',
    hook,
    fullScript,
    shootingNotes:[
      '正面口播，开场三秒直接说钩子。',
      '中段只配与论点直接相关的画面或截图。',
      '结尾保留一个行动指令。',
    ],
    shots:buildShots(fullScript, 45),
    qualityReview:{
      factuality:factual
        ? '公开来源已附在 sources.md，发布前仍需核对原网页。'
        : '未使用外部事实；不得自行补写数据。',
      imitation:'只复用参考内容的结构作用，不复制原句、身份、案例和结果承诺。',
      shootability:'已压缩为单人口播可执行版本。',
      unresolved:[],
    },
    structure:reference.promptData?.structure || [],
  };
}

function clean(value: unknown, limit: number) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
