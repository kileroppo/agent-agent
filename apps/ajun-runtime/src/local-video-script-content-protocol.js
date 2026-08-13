import crypto from 'node:crypto';
import { validM5TemplateGuidance } from './m5-production-template-resolver.js';

const FACTUAL_TOPIC_RE = /(?:数据|最新|政策|法律|医学|健康|金融|历史|科学|研究|报告|调查|事实|为什么|是否|会不会|影响|趋势)/i;
const DEFAULT_PLATFORM = 'douyin';

export class LocalVideoScriptContentProtocol {
  constructor({ advisor = null, researcher = null, research = null } = {}) {
    this.advisor = advisor;
    this.researcher = researcher;
    this.researchOverride = research;
  }

  prepare({ task, tasks, topic }) {
    const platform = normalizePlatform(
      task.input?.platforms,
      `${topic}\n${task.input?.description || ''}`,
    );
    return {
      topic,
      platform,
      reference:selectReference({ task, tasks, topic, platform }),
      m5Evidence:findM5EvidencePackage(task, tasks),
      m5VisualAnalysis:findM5VisualAnalysisPackage(task, tasks),
      isM5Script:task.input?.context?.paperclipRoutineKey === 'm5-script',
    };
  }

  async compose({
    task,
    tasks,
    allowAdvisor = true,
    templateBinding = null,
    grayTemplateBinding = null,
    prepared = null,
  }) {
    const context = prepared || this.prepare({ task, tasks,
      topic:text(task.input?.contentGoal || task.input?.topic || task.input?.title, 500) });
    const { topic, platform, reference, isM5Script, m5Evidence, m5VisualAnalysis } = context;
    if (!topic) return rejected('script_topic_required', '请用一句话说明这条视频要讲什么。');
    const research = typeof this.researchOverride === 'function'
      ? await this.researchOverride(topic, task)
      : await this.research(topic, task);
    const fallback = fallbackScript({ topic, platform, reference, research });
    const guidanceProofRequired = isM5Script
      && templateBinding.source !== 'built_in_default'
      && templateBinding.contentGuidance.length > 0;
    const baseline = await this.#draft({
      task,
      topic,
      platform,
      reference,
      research,
      fallback,
      templateBinding,
      allowAdvisor,
      guidanceProofRequired,
    });
    if (guidanceProofRequired && !baseline.advisorApplied) {
      return rejected(
        'm5_template_guidance_not_applied',
        '已批准模板必须逐条回显 guidance 对应的脚本原文片段和 canonical binding hash；当前未得到可信执行结果。',
      );
    }

    const gray = await this.#grayDraft({
      task,
      topic,
      reference,
      research,
      fallback,
      templateBinding:grayTemplateBinding,
      allowAdvisor,
    });
    if (gray?.rejection) return gray.rejection;

    let script = baseline.script;
    let grayScript = gray?.script || null;
    if (isM5Script) {
      if (!m5Evidence) {
        return rejected(
          'm5_evidence_package_required',
          'M5 脚本阶段缺少同一 Case 的 EvidencePackage，不能生成无来源脚本。',
        );
      }
      if (!m5VisualAnalysis) {
        return rejected(
          'm5_visual_analysis_package_required',
          'M5 脚本阶段缺少同一 Case 的 VisualAnalysisPackage，不能跳过画面证据生成脚本。',
        );
      }
      script = bindM5VisualAnalysis(
        bindM5Evidence(script, m5Evidence.data),
        m5VisualAnalysis.data,
      );
      if (grayScript) {
        grayScript = bindM5VisualAnalysis(
          bindM5Evidence(grayScript, m5Evidence.data),
          m5VisualAnalysis.data,
        );
        if (comparableScript(grayScript.fullScript) === comparableScript(script.fullScript)) {
          return rejected(
            'm5_gray_variant_unchanged',
            'gray_douyin 脚本与 baseline 完全相同，不能冒充单变量灰度。',
          );
        }
      }
    }

    return {
      status:'ready',
      topic,
      reference,
      research,
      script,
      modelUsage:baseline.modelUsage,
      advisorApplied:baseline.advisorApplied,
      sources:Array.isArray(m5Evidence?.data?.sources)
        ? m5Evidence.data.sources
        : research?.sources || [],
      sourceRefs:[
        ...reference.sourceRefs,
        ...[m5Evidence?.artifactId, m5VisualAnalysis?.artifactId].filter(Boolean),
      ],
      variants:isM5Script ? {
        baseline:scriptVariant('baseline', script, templateBinding),
        ...(grayScript ? {
          gray_douyin:scriptVariant('gray_douyin', grayScript, grayTemplateBinding),
        } : {}),
      } : null,
    };
  }

  async research(topic, task) {
    if (
      !FACTUAL_TOPIC_RE.test(topic)
      || task.input?.researchMode === 'off'
      || !this.researcher?.execute
    ) return null;
    try {
      const result = await this.researcher.execute({
        taskId:`${task.taskId}-research`,
        taskType:'research.intel-report',
        assigneeAgentId:'intel-researcher',
        input:{
          title:topic,
          topic,
          sourceUrls:(task.input?.sourceUrls || []).slice(0, 3),
          sourceUrl:task.input?.sourceUrl || null,
        },
      });
      const report = result?.artifactRefs
        ?.find((item) => item.type === 'intel_research_report')?.data;
      if (!report?.sources?.length) {
        return { status:'unavailable', report:null, sources:[] };
      }
      return {
        status:'public_sources_used',
        report,
        sources:report.sources.slice(0, 3),
      };
    } catch {
      return { status:'unavailable', report:null, sources:[] };
    }
  }

  async #draft({
    task,
    topic,
    platform,
    reference,
    research,
    fallback,
    templateBinding,
    allowAdvisor,
    guidanceProofRequired,
  }) {
    let script = fallback;
    let modelUsage = null;
    let advisorApplied = false;
    if (allowAdvisor && this.advisor?.scriptPackage) {
      try {
        const advised = await this.advisor.scriptPackage({
          topic,
          platform,
          durationSeconds:durationSeconds(task.input?.durationSeconds),
          reference:reference.promptData,
          research:research?.report || null,
          templateBinding,
          validate:(value) => validScript(value)
            && (!guidanceProofRequired || validBoundScript(value, templateBinding)),
        });
        modelUsage = advised?.usage || null;
        const candidate = advised?.data || advised;
        if (
          validScript(candidate)
          && (!guidanceProofRequired || validBoundScript(candidate, templateBinding))
        ) {
          script = normalizeScript(candidate, fallback);
          advisorApplied = true;
        }
      } catch {
        // 保留无外部副作用、可拍摄的本机兜底稿。
      }
    }
    return { script, modelUsage, advisorApplied };
  }

  async #grayDraft({
    task,
    topic,
    reference,
    research,
    fallback,
    templateBinding,
    allowAdvisor,
  }) {
    if (!templateBinding) return null;
    if (!allowAdvisor || !this.advisor?.scriptPackage) {
      return {
        rejection:rejected(
          'm5_gray_variant_guidance_not_applied',
          '抖音灰度日必须生成独立 gray_douyin 脚本，不能复用 baseline 母版。',
        ),
      };
    }
    let script = null;
    try {
      const advised = await this.advisor.scriptPackage({
        topic,
        platform:'douyin',
        durationSeconds:durationSeconds(task.input?.durationSeconds),
        reference:reference.promptData,
        research:research?.report || null,
        templateBinding,
        validate:(value) => validScript(value) && validBoundScript(value, templateBinding),
      });
      const candidate = advised?.data || advised;
      if (validScript(candidate) && validBoundScript(candidate, templateBinding)) {
        script = normalizeScript(candidate, fallback);
      }
    } catch {
      script = null;
    }
    return script ? { script } : {
      rejection:rejected(
        'm5_gray_variant_guidance_not_applied',
        '抖音灰度脚本未逐条提供 guidance 对应的可定位原文片段，或未回显 canonical binding hash。',
      ),
    };
  }
}

function rejected(code, userMessage) {
  return { status:'needs_input', code, userMessage };
}

function scriptVariant(variantKey, script, templateBinding) {
  return {
    ...structuredClone(script),
    variantKey,
    templateBinding,
    templateGuidanceHash:script.templateBindingHash || null,
    scriptHash:`sha256:${crypto.createHash('sha256')
      .update(String(script.fullScript || ''))
      .digest('hex')}`,
  };
}

function findM5EvidencePackage(task, tasks) {
  const sourceTaskIds = sourceTaskIdSet(task);
  return tasks
    .filter((item) => sourceTaskIds.has(String(item.taskId || '')))
    .flatMap((item) => item.artifactRefs || [])
    .find((artifact) =>
      artifact?.type === 'evidence_package'
      && artifact.validation?.exists === true
      && artifact.validation?.readable === true
      && artifact.validation?.nonEmpty === true
      && validM5EvidencePackage(artifact.data),
    ) || null;
}

function findM5VisualAnalysisPackage(task, tasks) {
  const sourceTaskIds = sourceTaskIdSet(task);
  return tasks
    .filter((item) => sourceTaskIds.has(String(item.taskId || '')))
    .flatMap((item) => item.artifactRefs || [])
    .find((artifact) =>
      artifact?.type === 'visual_analysis_package'
      && artifact.validation?.exists === true
      && artifact.validation?.readable === true
      && artifact.validation?.nonEmpty === true
      && Array.isArray(artifact.data?.insights)
      && artifact.data.insights.length
      && artifact.data.insights.every(validM5VisualInsight),
    ) || null;
}

function sourceTaskIdSet(task) {
  return new Set(
    Array.isArray(task.input?.context?.sourceTaskIds)
      ? task.input.context.sourceTaskIds.map(String)
      : [],
  );
}

function bindM5Evidence(script, evidence) {
  const sourceIds = new Set(
    evidence.sources.map((source) => String(source?.sourceId || '')).filter(Boolean),
  );
  const claim = evidence.claims.find((item) =>
    text(item?.text, 1_000)
    && Array.isArray(item?.sourceIds)
    && item.sourceIds.length >= 2
    && item.sourceIds.every((sourceId) => sourceIds.has(String(sourceId)))
    && validEvidenceFragments(item)
  );
  if (!claim) {
    const error = new Error('M5 EvidencePackage 没有可由至少两个来源共同支持的结论。');
    error.code = 'm5_evidence_claim_binding_invalid';
    error.category = 'quality';
    error.retryable = true;
    throw error;
  }
  const statement = text(claim.text, 500);
  const fullScript = `${script.fullScript}\n\n可核验结论：${statement}`;
  return {
    ...script,
    fullScript,
    shots:buildShots(fullScript, script.durationSeconds || 45),
    factBindings:[{
      claimId:String(claim.claimId || '').trim(),
      statement,
      sourceIds:claim.sourceIds.map(String),
      evidenceFragments:claim.evidenceFragments.map((fragment) => ({
        sourceId:String(fragment.sourceId),
        fragmentId:String(fragment.fragmentId),
        text:text(fragment.text, 1_000),
      })),
    }],
    prohibitedStatements:Array.isArray(evidence.prohibitedStatements)
      ? evidence.prohibitedStatements.slice(0, 10)
      : [],
  };
}

function bindM5VisualAnalysis(script, visualAnalysis) {
  const bindings = visualAnalysis.insights.map((item, index) => ({
    insightId:String(item.insightId || `visual-${index + 1}`).slice(0, 120),
    finding:text(item.finding, 500),
    frameRef:text(item.frameRef, 120),
    timestamp:text(item.timestamp, 40),
    evidenceKind:text(item.evidenceKind, 80),
  }));
  const shots = script.shots.map((shot, index) => {
    const binding = bindings[index % bindings.length];
    return {
      ...shot,
      visual:binding.finding,
      frameRef:binding.frameRef,
      evidenceTimestamp:binding.timestamp,
      evidenceKind:binding.evidenceKind,
    };
  });
  return { ...script, shots, visualAnalysisBindings:bindings };
}

function validM5VisualInsight(item) {
  return Boolean(
    text(item?.finding, 500)
    && text(item?.frameRef, 120)
    && text(item?.timestamp, 40)
    && text(item?.evidenceKind, 80),
  );
}

function validM5EvidencePackage(evidence) {
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
  if (
    !/^agent\.army\/evidence-package\/v2$/.test(String(evidence?.schemaVersion || ''))
    || sources.length < 2
    || !sources.every(validM5Source)
    || !Array.isArray(evidence?.claims)
    || !evidence.claims.length
  ) return false;
  const sourceIds = new Set(sources.map((source) => String(source.sourceId)));
  return evidence.claims.every((claim) =>
    text(claim?.text, 1_000)
    && Array.isArray(claim?.sourceIds)
    && claim.sourceIds.length >= 2
    && claim.sourceIds.every((sourceId) => sourceIds.has(String(sourceId)))
    && validEvidenceFragments(claim)
  );
}

function validM5Source(source) {
  let parsed;
  try { parsed = new URL(String(source?.url || '')); } catch { return false; }
  return ['http:', 'https:'].includes(parsed.protocol)
    && !parsed.username
    && !parsed.password
    && source?.kind !== 'github_metadata'
    && Number.isFinite(Date.parse(String(source?.fetchedAt || '')))
    && /^[0-9a-f]{64}$/i.test(String(source?.contentHash || '').replace(/^sha256:/i, ''))
    && Array.isArray(source?.evidenceFragments)
    && source.evidenceFragments.some((fragment) =>
      String(fragment?.fragmentId || '').trim()
      && text(fragment?.text, 1_000)
    );
}

function validEvidenceFragments(claim) {
  if (!Array.isArray(claim?.evidenceFragments)) return false;
  const fragmentSources = new Set(claim.evidenceFragments
    .filter((fragment) =>
      String(fragment?.fragmentId || '').trim()
      && text(fragment?.text, 1_000)
    )
    .map((fragment) => String(fragment.sourceId || '')));
  return claim.sourceIds.every((sourceId) => fragmentSources.has(String(sourceId)));
}

function selectReference({ task, tasks, topic, platform }) {
  const explicitIds = sourceTaskIdSet(task);
  const sameChat = task.source?.chatRef
    ? tasks.filter((item) => item.source?.chatRef === task.source.chatRef)
    : [];
  const allArtifacts = tasks.flatMap((item) =>
    (item.artifactRefs || []).map((artifact) => ({ artifact, task:item }))
  );
  const explicit = allArtifacts.filter(({ task:item }) => explicitIds.has(item.taskId));
  const recentSameChat = sameChat.flatMap((item) =>
    (item.artifactRefs || []).map((artifact) => ({ artifact, task:item }))
  );
  const pool = explicit.length ? explicit : recentSameChat.length ? recentSameChat : allArtifacts;
  const explicitScript = explicit.find(({ artifact }) =>
    artifact.type === 'video_script_package' && artifact.data?.fullScript
  );
  if (explicitScript) {
    return referenceResult(explicitScript.artifact, 'user_specified_reference', 1);
  }

  const analyses = pool
    .filter(({ artifact }) =>
      artifact.type === 'video_content_analysis_report'
      && artifact.data?.evidenceMode === 'formal'
    )
    .map((entry) => ({ ...entry, score:referenceScore(topic, entry.artifact.data) }))
    .sort((left, right) => right.score - left.score || taskTime(right.task) - taskTime(left.task));
  const lifecycleByTemplate = new Map(allArtifacts
    .filter(({ artifact }) =>
      artifact.type === 'content_performance_report'
      && artifact.data?.lineage?.templateArtifactId
    )
    .sort((left, right) => taskTime(left.task) - taskTime(right.task))
    .map(({ artifact }) => [artifact.data.lineage.templateArtifactId, artifact.data.templateLifecycle]));
  const scripts = allArtifacts
    .filter(({ artifact }) =>
      artifact.type === 'video_script_package'
      && ['validated', 'trial'].includes(artifact.data?.templateLifecycle?.state)
    )
    .map((entry) => {
      const lifecycle = lifecycleByTemplate.get(entry.artifact.artifactId);
      return lifecycle
        ? { ...entry, artifact:{ ...entry.artifact, data:{ ...entry.artifact.data, templateLifecycle:lifecycle } } }
        : entry;
    })
    .filter(({ artifact }) => artifact.data?.templateLifecycle?.state !== 'retired')
    .filter(({ artifact }) => !artifact.data?.platform || artifact.data.platform === platform)
    .map((entry) => ({ ...entry, score:referenceScore(topic, entry.artifact.data) }))
    .sort((left, right) =>
      templateRank(right.artifact) - templateRank(left.artifact) || right.score - left.score
    );

  const explicitAnalysis = analyses[0];
  const template = !explicitIds.size ? scripts.find((entry) => entry.score > 0) : null;
  const analysis = template
    ? null
    : explicitAnalysis && (
      explicitIds.size
      || /(?:刚才|这个|上一个|参考)/.test(topic)
      || explicitAnalysis.score > 0
    ) ? explicitAnalysis : null;
  if (template) {
    return referenceResult(
      template.artifact,
      template.artifact.data?.templateLifecycle?.state === 'validated'
        ? 'validated_template'
        : 'trial_template',
      template.score,
    );
  }
  if (analysis) {
    return referenceResult(
      analysis.artifact,
      explicitIds.size || /(?:刚才|这个|上一个)/.test(topic)
        ? 'user_specified_reference'
        : 'reference_case',
      analysis.score,
    );
  }
  return {
    publicMatch:{ type:'universal_base', label:'通用基础结构' },
    promptData:{
      type:'universal_base',
      structure:['结果或冲突开场', '解释问题', '给出一个可执行动作'],
    },
    sourceRefs:[],
  };
}

function referenceResult(artifact, type, score) {
  const data = artifact.data || {};
  const structure = data.modules?.find((item) => item.name === '爆款结构模板')?.structureTemplate
    || data.referenceMatch?.structure
    || data.reusablePatterns
    || [];
  return {
    publicMatch:{
      type,
      label:type === 'validated_template'
        ? '已验证结构'
        : type === 'trial_template' ? '试用结构' : '参考视频结构',
      sourceTitle:data.sourceMetadata?.title || data.title || artifact.title || null,
    },
    promptData:{
      type,
      sourceTitle:data.sourceMetadata?.title || data.title || artifact.title || null,
      summary:data.summary || null,
      structure,
      reusablePatterns:(data.reusablePatterns || []).slice(0, 5),
      score,
    },
    sourceRefs:[artifact.artifactId],
  };
}

function fallbackScript({ topic, platform, reference, research }) {
  const factual = research?.sources?.[0]?.summary;
  const hook = `先别急着给“${topic}”下结论，真正影响结果的是你接下来怎么判断和行动。`;
  const proof = factual
    ? `公开资料里有一个值得核对的信号：${text(factual, 220)}`
    : '这版先讲判断方法，不编造没有来源的数字和事实。';
  const fullScript = [
    hook,
    `很多人谈到“${topic}”时，会直接站队，但这会漏掉真正重要的前提。`,
    proof,
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

function normalizeScript(value, fallback) {
  const fullScript = text(value.fullScript, 10_000);
  const duration = durationSeconds(value.durationSeconds || fallback.durationSeconds);
  const shootingNotes = stringList(value.shootingNotes, 8, 300);
  return {
    ...fallback,
    headline:text(value.headline, 160) || fallback.headline,
    platform:normalizePlatform([value.platform], value.platform) || fallback.platform,
    durationSeconds:duration,
    aspectRatio:text(value.aspectRatio, 20) || fallback.aspectRatio,
    audience:text(value.audience, 300) || fallback.audience,
    hook:text(value.hook, 500) || fallback.hook,
    fullScript,
    shootingNotes:shootingNotes.length ? shootingNotes : fallback.shootingNotes,
    shots:normalizeShots(value.shots, fullScript, duration),
    qualityReview:{
      factuality:text(value.qualityReview?.factuality, 500) || fallback.qualityReview.factuality,
      imitation:text(value.qualityReview?.imitation, 500) || fallback.qualityReview.imitation,
      shootability:text(value.qualityReview?.shootability, 500) || fallback.qualityReview.shootability,
      unresolved:stringList(value.qualityReview?.unresolved, 5, 300),
    },
    structure:Array.isArray(value.structure) || typeof value.structure === 'object'
      ? value.structure
      : fallback.structure,
    templateBindingHash:text(value.templateBindingHash, 80) || null,
    templateApplicationEvidence:normalizeTemplateApplicationEvidence(
      value.templateApplicationEvidence,
    ),
  };
}

function validScript(value) {
  return Boolean(
    text(value?.headline, 160)
    && text(value?.hook, 500)
    && text(value?.fullScript, 10_000).length >= 80
    && Array.isArray(value?.shootingNotes)
    && value.shootingNotes.length
    && value?.qualityReview
  );
}

function validBoundScript(value, templateBinding) {
  return value?.templateBindingHash === templateBinding.bindingHash
    && validTemplateApplicationEvidence(value, templateBinding);
}

function validTemplateApplicationEvidence(value, templateBinding) {
  const guidance = Array.isArray(templateBinding?.contentGuidance)
    ? templateBinding.contentGuidance.map((item) => text(item, 240)).filter(Boolean)
    : [];
  if (!guidance.length) return true;
  if (!validM5TemplateGuidance(guidance)) return false;
  const evidence = normalizeTemplateApplicationEvidence(value?.templateApplicationEvidence);
  if (evidence.length !== guidance.length) return false;
  const fullScript = comparableScript(value?.fullScript);
  const fragments = new Set();
  for (let index = 0; index < guidance.length; index += 1) {
    const item = evidence[index];
    const fragment = comparableScript(item?.scriptFragment);
    if (
      item?.guidance !== guidance[index]
      || fragment.length < 8
      || !/[\p{L}\p{N}]/u.test(fragment)
      || !fullScript.includes(fragment)
    ) return false;
    fragments.add(fragment);
  }
  return evidence.length < 2 || fragments.size === evidence.length;
}

function normalizeTemplateApplicationEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => ({
    guidance:text(item?.guidance, 240),
    scriptFragment:text(item?.scriptFragment, 500),
  }));
}

function buildShots(script, duration) {
  const paragraphs = String(script).split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const step = Math.max(3, duration / Math.max(paragraphs.length, 1));
  return paragraphs.map((narration, index) => ({
    index:index + 1,
    startSeconds:Number((index * step).toFixed(2)),
    endSeconds:Number(Math.min(duration, (index + 1) * step).toFixed(2)),
    narration,
    visual:index === 0
      ? '正面口播，字幕突出冲突或结果。'
      : '使用与当前句子直接相关的口播、截图或素材。',
  }));
}

function normalizeShots(value, script, duration) {
  if (!Array.isArray(value) || !value.length) return buildShots(script, duration);
  const shots = value.slice(0, 30).map((item, index) => ({
    index:index + 1,
    startSeconds:Number.isFinite(Number(item?.startSeconds))
      ? Math.max(0, Number(item.startSeconds))
      : null,
    endSeconds:Number.isFinite(Number(item?.endSeconds))
      ? Math.min(duration, Number(item.endSeconds))
      : null,
    narration:text(item?.narration, 1_000),
    visual:text(item?.visual, 500),
  })).filter((item) => item.narration);
  return shots.length
    && shots.every((item) => item.startSeconds !== null && item.endSeconds > item.startSeconds)
    ? shots
    : buildShots(script, duration);
}

function referenceScore(topic, data) {
  const target = tokens(topic);
  const source = tokens([
    data?.title,
    data?.sourceMetadata?.title,
    data?.summary,
    ...(data?.reusablePatterns || []),
  ].map((item) => typeof item === 'string' ? item : JSON.stringify(item || '')).join(' '));
  if (!target.size || !source.size) return 0;
  return [...target].filter((item) => source.has(item)).length / target.size;
}

function tokens(value) {
  const compact = String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set(String(value || '').toLowerCase().match(/[a-z0-9]{2,}/g) || []);
  for (let index = 0; index < compact.length - 1; index += 1) {
    result.add(compact.slice(index, index + 2));
  }
  return result;
}

function normalizePlatform(value, sourceText) {
  const explicit = Array.isArray(value)
    ? value.map((item) => text(item, 40).toLowerCase()).filter(Boolean)
    : [];
  if (explicit.length) return explicit[0];
  if (/小红书|xiaohongshu|xhs/i.test(sourceText)) return 'xiaohongshu';
  if (/视频号|shipinhao/i.test(sourceText)) return 'shipinhao';
  if (/b站|哔哩哔哩|bilibili/i.test(sourceText)) return 'bilibili';
  return DEFAULT_PLATFORM;
}

function durationSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), 15), 600) : 45;
}

function comparableScript(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function templateRank(artifact) {
  return artifact.data?.templateLifecycle?.state === 'validated' ? 2 : 1;
}

function stringList(value, count, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => text(item, limit))
    .filter(Boolean)
    .slice(0, count);
}

function taskTime(task) {
  return Date.parse(task?.updatedAt || task?.createdAt || 0) || 0;
}

function text(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
