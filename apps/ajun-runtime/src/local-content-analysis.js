import path from 'node:path';
import {
  deriveContentMetrics,
  normalizeContentChannel,
  summarizeComparableContentMetrics,
} from '@agent-army/m5-contracts';
import {
  findArtifact,
  needsInput,
  readArtifactJson,
  readArtifactText,
  readVisualEvidence,
  referencedArtifacts,
  successResult,
  writeArtifact,
} from './local-content-artifacts.js';
import {
  executeM5VisualAnalysis,
  validVisualFindings,
} from './local-content-m5-vision.js';
import { analysisIntentLabel, resolveAnalysisIntent } from './analysis-intent.ts';
import {
  analysisIntentOptions,
  buildModeReport,
  digestCharacterCount,
  mergeAdvisedModeReport,
  nextAnalysisAction,
  validModeReport,
} from './local-content-analysis-modes.js';
import { buildMetricLearning } from './local-content-performance-learning.js';
import { evaluateVisualAnalysis } from './local-content-visual-evaluation.ts';
import { attemptControlledVision } from './workflow/controlled-vision.ts';
import { evaluateModeStructureWithDigestRecovery } from './workflow/digest-structure-recovery.ts';
const FULL_ANALYSIS_MODULES = [
  '基本信息',
  '标题诊断',
  '开头诊断',
  '爆点拆解',
  '全文逐句作用拆解',
  '结构分析',
  '话术技巧与文字洁癖',
  '表达效率检测',
  '认知落差检测',
  '素材盘点',
  'AI辅助创作建议',
  '可模仿点 Top3',
  '爆款结构模板'
];
const FAST_ANALYSIS_MODULES = ['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'];
export const CONTENT_PERFORMANCE_NEXT_ACTIONS = Object.freeze([
  '保留表现较好的开场和结构变量。',
  '下一版只调整一个主要变量，并继续关联原任务与版本。',
]);
export class LocalVideoContentAnalyst {
  constructor({ store, artifactsDir, allowedArtifactRoots = [], advisor = null, visionExecution = null, now = () => new Date() } = {}) {
    this.store = store;
    this.artifactsDir = artifactsDir;
    this.allowedArtifactRoots = allowedArtifactRoots.map((item) => path.resolve(item));
    this.advisor = advisor;
    this.visionExecution = typeof visionExecution === 'function' ? visionExecution : null;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'video-content-analyst'; }

  async execute(task, {
    sourceArtifacts = null,
    allowAdvisor = true,
    providerVision = null,
  } = {}) {
    if (task.taskType === 'content.performance-review') return this.performanceReview(task, { sourceArtifacts });
    if (task.taskType === 'content.campaign-visual-analysis') {
      return this.m5VisualAnalysis(task, {
        sourceArtifacts,
        allowAdvisor,
        providerVision,
      });
    }
    const evidenceMode = task.input?.evidenceMode === 'preliminary' ? 'preliminary' : 'formal';
    const analysis = resolveAnalysisIntent({
      analysisIntent:task.input?.analysisIntent,
      title:task.input?.title,
      description:task.input?.description,
      focus:task.input?.focus,
      depth:task.input?.depth,
    });
    if (analysis.error) {
      return needsInput(
        this.now(),
        analysis.error,
        analysis.error === 'analysis_intent_conflict'
          ? '检测到多个分析模式，请只选择精华提炼、深度拆解、模板学习或风格探索中的一种。'
          : '分析模式无效，请重新选择。',
      );
    }
    const { analysisIntent, depth } = analysis;
    const sources = Array.isArray(sourceArtifacts) ? sourceArtifacts : await referencedArtifacts(task, this.store);
    const transcriptArtifact = evidenceMode === 'formal'
      ? findArtifact(sources, 'confirmed_transcript')
      : findArtifact(sources, 'confirmed_transcript') || findArtifact(sources, 'raw_asr_transcript');
    if (!transcriptArtifact) {
      return needsInput(
        this.now(),
        evidenceMode === 'formal' ? 'confirmed_transcript_required' : 'transcript_artifact_required',
        evidenceMode === 'formal' ? '正式拆解必须引用小D质量门禁通过后的系统确认稿或人工确认稿。' : '初步拆解至少需要引用一份机器转录。'
      );
    }
    const confirmationMode = transcriptArtifact.validation?.confirmationMode === 'automatic' ? 'automatic' : 'human';
    const transcript = await readArtifactText(transcriptArtifact, this.allowedArtifactRoots);
    if (transcript.length < 20) return needsInput(this.now(), 'transcript_artifact_empty', '引用的转录产物为空或不可读。');
    const sourceEvidenceArtifact = findArtifact(sources, 'source_evidence_record');
    const visualArtifact = findArtifact(sources, 'visual_evidence_package');
    const visualMode = task.input?.visualMode === 'off' || task.input?.visualMode === 'required' ? task.input.visualMode : 'auto';
    if (visualMode === 'required' && !visualArtifact) {
      return needsInput(this.now(), 'visual_evidence_required', '本次拆解要求分析画面，但没有可读取的关键帧证据。请补充本地视频、授权素材读取或改用自动模式。');
    }
    const sourceEvidence = sourceEvidenceArtifact ? await readArtifactJson(sourceEvidenceArtifact, this.allowedArtifactRoots) : null;
    const sourceMetadata = normalizeSourceMetadata(sourceEvidence?.sourceMetadata);
    const boomSignal = normalizeBoomSignalContext(task.input?.context?.boomSignal);
    const availableVisualEvidence = visualArtifact && visualMode !== 'off'
      ? await readVisualEvidence(visualArtifact, this.allowedArtifactRoots)
      : null;
    const executeVision = typeof providerVision === 'function' ? providerVision : this.visionExecution;
    const visionAttempt = await attemptControlledVision({ execute:executeVision, task, visualEvidence:availableVisualEvidence });
    const controlledVision = visionAttempt.result;
    const visionFailure = visionAttempt.failureCode;
    if (availableVisualEvidence && visualMode === 'required' && !controlledVision) {
      return needsInput(
        this.now(),
        visionFailure || 'controlled_vision_capability_unavailable',
        '本次必须分析画面，但本机视觉能力在自动启动和安全恢复后仍不可用。请恢复本机视觉模型，或明确改为自动模式接收文字降级结果。',
      );
    }
    const visualEvidence = controlledVision ? availableVisualEvidence : null;
    const effectiveTitle = sourceMetadata.title || clean(task.input?.title, 300) || transcriptArtifact.title || '视频内容';
    const segments = evidenceSegments(transcript);
    const advisorTranscript = segments.map((segment) => (
      segment.timestamp ? `[${segment.timestamp}] ${segment.text}` : segment.text
    )).join('\n\n');
    const fallback = buildAnalysis({ title:effectiveTitle, transcript, segments, analysisIntent, depth, evidenceMode, confirmationMode, focus:task.input?.focus, sourceMetadata });
    let report = fallback;
    let modelUsage = null;
    let advisorApplied = false;
    let advisorFailure = null;
    let semanticRepairApplied = false;
    if (allowAdvisor && this.advisor?.analyze) {
      try {
        const advisedResult = await this.advisor.analyze({
          title:effectiveTitle,
          transcript:advisorTranscript,
          analysisIntent,
          depth,
          evidenceMode,
          focus:task.input?.focus,
          sourceMetadata,
          boomSignal,
          visualEvidence,
          providerVisionObservation:controlledVision?.observation || null,
          priorRuntimeMs:Number(visualEvidence?.selection?.processingDurationMs) || 0,
          validate:(value) => validAdvisedAnalysis(
            normalizeAdvisedAnalysis(value, transcript, visualEvidence),
            transcript,
            depth,
            visualEvidence
          )
        });
        const advised = normalizeAdvisedAnalysis(advisedResult?.data || advisedResult, transcript, visualEvidence);
        modelUsage = advisedResult?.usage || null;
        if (validAdvisedAnalysis(advised, transcript, depth, visualEvidence)) {
          report = mergeAdvisedModeReport(fallback, advised, analysisIntent, transcript);
          advisorApplied = true;
        } else {
          advisorFailure = 'content_analysis_semantic_validation_failed';
        }
      } catch (error) {
        modelUsage = error?.usage || null;
        const repaired = error?.code === 'content_analysis_semantic_validation_failed'
          ? repairAdvisedAnalysis(error?.data, fallback, transcript, depth, visualEvidence)
          : null;
        if (repaired && validAdvisedAnalysis(repaired, transcript, depth, visualEvidence)) {
          report = mergeAdvisedModeReport(fallback, repaired, analysisIntent, transcript);
          advisorApplied = true;
          semanticRepairApplied = true;
        } else {
          advisorFailure = clean(error?.code, 120) || 'content_analysis_advisor_failed';
          /* deterministic evidence-linked report remains available */
        }
      }
    }
    const completedAt = this.now().toISOString();
    const { visualCoverage, visualAnalysisApplied } = evaluateVisualAnalysis({
      visualMode, visualEvidence, advisorApplied, visualFindings:report.visualFindings,
      depth, validateFindings:validVisualFindings,
    });
    if (visualMode === 'required' && !visualAnalysisApplied) {
      return needsInput(
        this.now(),
        advisorFailure || 'controlled_vision_analysis_incomplete',
        '本次必须分析画面，但视觉观察没有形成通过证据门禁的画面结论。系统已停止继续尝试，请恢复分析模型后重试或改为自动模式。',
      );
    }
    const completeness = visualMode === 'off' || visualAnalysisApplied ? 'complete' : 'partial';
    report = {
      ...report,
      title:effectiveTitle,
      sourceMetadata,
      boomSignal,
      visualCoverage,
      visualFindings:Array.isArray(report.visualFindings) ? report.visualFindings : [],
      completeness,
      analysisIntent,
      reportVersion:'video-analysis/v2',
      creationEligible:evidenceMode === 'formal' && transcriptArtifact.type === 'confirmed_transcript',
      ...(analysisIntent === 'digest' ? { availableAnalysisIntents:analysisIntentOptions() } : {}),
      nextAction:{
        ...nextAnalysisAction(analysisIntent),
        sourceTaskIds:[...new Set(sources.map((artifact) => artifact?.taskId).filter(Boolean))],
      },
    };
    const modeStructure = evaluateModeStructureWithDigestRecovery({
      report, transcript, analysisIntent, advisorApplied, semanticRepairApplied,
      validate:(candidate) => validModeReport(candidate, analysisIntent, transcript), measureDigest:digestCharacterCount,
    });
    report = modeStructure.report;
    const sourceRefs = [
      transcriptArtifact.artifactId,
      sourceEvidenceArtifact?.artifactId,
      visualArtifact?.artifactId
    ].filter(Boolean);
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'video_content_analysis_report',
      title:`${effectiveTitle}｜${analysisIntentLabel(analysisIntent)}`,
      data:{
        ...report,
        ...modeStructure.dataFields,
        advisorFailure:advisorFailure || visionFailure,
        semanticRepairApplied,
        sourceTranscriptArtifactId:transcriptArtifact.artifactId,
        sourceTranscriptChecksum:transcriptArtifact.checksum || null,
        visualExecutionReceipt:controlledVision?.receipt || null,
        generatedAt:completedAt,
      },
      sourceRefs,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        evidenceMode,
        analysisIntent,
        reportVersion:'video-analysis/v2',
        claimsEvidenceLinked:true,
        formalSourceConfirmed:evidenceMode !== 'formal' || transcriptArtifact.type === 'confirmed_transcript',
        confirmationMode:evidenceMode === 'formal' ? confirmationMode : null,
        moduleCount:report.modules.length,
        advisorApplied,
        semanticValidationPassed:advisorApplied,
        ...modeStructure.validationFields,
        boomSignalAttached:Boolean(boomSignal),
        semanticRepairApplied,
        visualMode,
        visualCoverage:visualCoverage.status,
        visualClaimsEvidenceLinked:validVisualFindings(report.visualFindings, visualEvidence),
        visualAnalysisApplied,
        controlledVisionInvoked:Boolean(controlledVision),
        visualExecutionReceiptValid:Boolean(controlledVision?.receipt?.receiptId),
        completeness
      },
      completedAt
    });
    return successResult(task, artifact, completedAt, depth === 'full' ? 'full_analysis' : 'fast_analysis', modelUsage);
  }

  async m5VisualAnalysis(task, options = {}) {
    return executeM5VisualAnalysis(this, task, options);
  }

  async performanceReview(task, { sourceArtifacts = null } = {}) {
    const sources = Array.isArray(sourceArtifacts) ? sourceArtifacts : await referencedArtifacts(task, this.store);
    const analysis = findArtifact(sources, 'video_content_analysis_report');
    const draft = findArtifact(sources, 'platform_content_draft');
    const script = findArtifact(sources, 'video_script_package');
    const metrics = normalizeMetrics(task.input?.metrics, task.input?.description);
    if ((!analysis || !draft) && !script) return needsInput(this.now(), 'content_lineage_required', '表现复盘必须引用原拆解与平台草稿，或明确引用已经采用的可拍脚本。');
    if (!Object.keys(metrics).length) return needsInput(this.now(), 'performance_metrics_required', '请提供真实发布指标或指标截图形成的结构化数据。');
    const lifecycle = script ? await templateLifecycleForReview({ store:this.store, script, metrics }) : null;
    const completedAt = this.now().toISOString();
    const normalizedContentMetrics = deriveContentMetrics(metrics);
    const learning = buildMetricLearning(task.input, metrics);
    const data = {
      summary:`已记录 ${Object.keys(metrics).length} 项真实表现指标；本报告只做版本关联和观察，不把单次结果解释为确定因果。`,
      metrics,
      derivedMetrics:normalizedContentMetrics,
      comparableBaseline:summarizeComparableContentMetrics([metrics]),
      comparisonScope:{
        platform:normalizeContentChannel(task.input?.platform),
        contentType:clean(task.input?.contentType, 80) || null,
        observationWindow:clean(task.input?.observationWindow, 120) || null,
        comparableSampleCount:learning.comparableSampleCount,
        declaredComparableSampleCount:learning.declaredComparableSampleCount,
      },
      observations:metricObservations(metrics),
      learning,
      nextActions:[...CONTENT_PERFORMANCE_NEXT_ACTIONS],
      decision:clean(task.input?.decision, 80) || 'collect_more_samples',
      experiment:task.input?.experiment && !Array.isArray(task.input.experiment)
        ? structuredClone(task.input.experiment)
        : null,
      lineage:{
        analysisArtifactId:analysis?.artifactId || null,
        draftArtifactId:draft?.artifactId || null,
        templateArtifactId:script?.artifactId || null
      },
      ...(lifecycle ? { templateLifecycle:lifecycle } : {}),
      generatedAt:completedAt
    };
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'content_performance_report',
      title:`${task.input?.title || '内容'}｜表现复盘`,
      data,
      sourceRefs:[analysis?.artifactId, draft?.artifactId, script?.artifactId].filter(Boolean),
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        metricsProvided:true,
        causalClaimAvoided:true,
        comparableScopeExplicit:true,
        metricBindingComplete:learning.metricBindingComplete,
        learningProposalReviewRequired:learning.status !== 'proposed' || learning.requiresHumanReview === true,
        productionMutationAllowed:false,
        singleExperimentEnforced:!Array.isArray(task.input?.experiment),
        ...(lifecycle ? { templateState:lifecycle.state } : {}),
      },
      completedAt
    });
    return successResult(task, artifact, completedAt, 'performance_review');
  }
}


export function evidenceSegments(transcript) {
  const body = String(transcript || '').replace(/^---[\s\S]*?---\s*/m, '').replace(/^#\s+[^\n]+\n+/m, '');
  const timed = [...body.matchAll(/\[((?:\d{2}:)?\d{2}:\d{2})\]\s*([^\n]+)/g)].map((match) => ({ timestamp:match[1], text:clean(match[2], 500) }));
  if (timed.length) return groupEvidenceSegments(timed);
  const untimed = body.split(/\n+/).map((line) => clean(line, 500)).filter((line) => line.length >= 8).map((text) => ({ timestamp:null, text }));
  return groupEvidenceSegments(untimed);
}

function groupEvidenceSegments(segments, maxBlocks = 30) {
  if (segments.length <= maxBlocks) return segments;
  const groupSize = Math.ceil(segments.length / maxBlocks);
  const grouped = [];
  for (let index = 0; index < segments.length; index += groupSize) {
    const group = segments.slice(index, index + groupSize);
    grouped.push({
      timestamp:group[0]?.timestamp || null,
      text:clean(group.map((item) => item.text).join(' '), 2_000)
    });
  }
  return grouped;
}

function buildAnalysis({ title, segments, analysisIntent, depth, evidenceMode, confirmationMode = 'human', focus, sourceMetadata = {} }) {
  const usable = segments.length ? segments : [{ timestamp:null, text:'当前转录没有足够可引用片段。' }];
  const moduleNames = depth === 'full' ? FULL_ANALYSIS_MODULES : FAST_ANALYSIS_MODULES;
  const modules = moduleNames.map((name, index) => {
    const evidence = usable[index % usable.length];
    if (depth === 'full') return buildFullModule({ name, index, title, evidence, segments:usable, focus, sourceMetadata });
    return {
      name,
      finding:moduleFinding(name, evidence.text, focus),
      evidence:{ timestamp:evidence.timestamp, fragment:evidence.text },
      confidence:evidence.timestamp ? 'high' : 'medium'
    };
  });
  const report = {
    title:clean(title, 300) || '视频内容拆解',
    evidenceMode,
    confirmationMode:evidenceMode === 'formal' ? confirmationMode : null,
    evidenceLabel:evidenceMode === 'formal'
      ? confirmationMode === 'automatic' ? '系统质量确认稿' : '人工确认稿'
      : '未经确认的机器稿',
    depth,
    summary:`基于${evidenceMode === 'formal' ? confirmationMode === 'automatic' ? '系统质量确认稿' : '人工确认稿' : '机器稿'}完成 ${modules.length} 个模块的证据化拆解。`,
    modules,
    reusablePatterns:depth === 'full'
      ? modules.find((item) => item.name === '可模仿点 Top3')?.reusablePoints || []
      : modules.slice(0, 3).map((item) => `${item.name}：${item.finding}`),
    actionItems:modules.slice(-3).map((item) => item.optimization?.[0]?.action || `围绕“${item.name}”做一项可单独验证的改动。`)
  };
  return {
    ...report,
    ...buildModeReport({ analysisIntent, segments:usable, modules, evidenceMode, sourceMetadata }),
  };
}

function moduleFinding(name, evidence, focus) {
  const emphasis = clean(focus, 120);
  return `该模块应以“${evidence}”为当前证据基点${emphasis ? `，重点核对${emphasis}` : ''}；后续优化不得超出该片段能够支持的范围。`;
}

function buildFullModule({ name, index, title, evidence, segments, focus, sourceMetadata = {} }) {
  const label = sentenceRole(evidence.text);
  const originalAnalysis = [{
    claim:fullOriginalClaim(name, title, evidence.text, label),
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text }
  }];
  const diagnosis = [{
    issue:fullDiagnosis(name, evidence.text, label),
    severity:index < 5 ? 'high' : 'medium',
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text }
  }];
  const optimization = [{
    action:fullOptimization(name, evidence.text, focus),
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text }
  }];
  const module = {
    name,
    finding:originalAnalysis[0].claim,
    originalAnalysis,
    diagnosis,
    optimization,
    evidence:{ timestamp:evidence.timestamp, fragment:evidence.text },
    confidence:evidence.timestamp ? 'high' : 'medium'
  };
  if (name === '基本信息') {
    module.metadata = {
      title:sourceMetadata.title || clean(title, 160) || '未提供',
      author:sourceMetadata.author || '未提供',
      platform:sourceMetadata.platform || '未提供',
      publishedAt:sourceMetadata.publishedAt || '未提供',
      duration:Number.isFinite(sourceMetadata.durationSeconds) ? `${sourceMetadata.durationSeconds} 秒` : '未提供',
      engagement:sourceMetadata.engagement ? JSON.stringify(sourceMetadata.engagement) : '未提供；不得推测'
    };
  }
  if (name === '标题诊断') module.titleFormula = titleFormulaFor(title);
  if (name === '全文逐句作用拆解') {
    module.sentenceBreakdown = segments.map((segment) => ({
      timestamp:segment.timestamp,
      original:segment.text,
      role:sentenceRole(segment.text),
      explanation:sentenceRoleExplanation(sentenceRole(segment.text)),
      evidence:{ timestamp:segment.timestamp, fragment:segment.text }
    }));
  }
  if (name === '可模仿点 Top3') {
    module.reusablePoints = segments.slice(0, 3).map((segment, position) => ({
      rank:position + 1,
      pattern:`${sentenceRole(segment.text)}：${segment.text}`,
      howToReuse:'复用这句话承担的结构作用，不复制原句、身份、案例或结果承诺。',
      caution:'改写后仍需回到自己的事实与素材核对。',
      evidence:{ timestamp:segment.timestamp, fragment:segment.text }
    }));
  }
  if (name === '爆款结构模板') {
    module.structureTemplate = {
      opening:`用“${segments[0]?.text || evidence.text}”承担开场问题或结果承诺，但不得夸大。`,
      body:`按 ${segments.length} 个可核验片段递进展开，每段只承担一个主要作用。`,
      ending:`用“${segments.at(-1)?.text || evidence.text}”对应的收束方式给出一个行动指令。`,
      disclaimer:'这是结构复用模板，不构成播放量或转化承诺。'
    };
  }
  return module;
}

function fullOriginalClaim(name, title, fragment, label) {
  if (name === '基本信息') return `当前可核验标题为“${clean(title, 160) || '未提供'}”；其余元数据未提供，不做推测。`;
  if (name === '标题诊断') return `标题当前匹配“${titleFormulaFor(title).category}”倾向；正文证据片段为“${fragment}”。`;
  if (name === '全文逐句作用拆解') return `确认稿共识别 ${label} 等逐句作用；完整逐句表见本模块 sentenceBreakdown。`;
  return `该模块当前最直接的原文证据是“${fragment}”，主要承担${label}作用。`;
}

function fullDiagnosis(name, fragment, label) {
  if (name === '认知落差检测') return `仅凭当前来源不能判断同行是否已讲清同一主题；可确认的是该片段以${label}传递“${fragment}”。`;
  if (name === '表达效率检测') return `需要核对“${fragment}”是否同时承担多个任务；若无法删减而不损失证据，才保留。`;
  if (name === '基本信息') return '作者、平台、发布时间和互动指标缺失；不得补写或据此推断内容表现。';
  return `该片段的${label}作用可识别，但仍需检查其承诺、上下文和后续兑现是否一致。`;
}

function fullOptimization(name, fragment, focus) {
  const emphasis = clean(focus, 120);
  if (name === '全文逐句作用拆解') return '逐句检查重复、填充词和生硬过渡；每次删改后保留原时间点和版本关系。';
  if (name === '标题诊断') return `先确保标题承诺能由“${fragment}”和正文兑现，再从同类标题公式中选择，不追加无证据数字。`;
  if (name === '爆款结构模板') return '只复用开头—主体—收束的任务分配，不复制原作者的独特表达、案例和结果数字。';
  return `围绕“${fragment}”只改一个变量并保留对照版本${emphasis ? `，优先核对${emphasis}` : ''}。`;
}

function sentenceRole(text) {
  const value = String(text || '');
  if (/关注|点赞|收藏|评论|留言|转发|私信/.test(value)) return 'CTA引导';
  if (/比如|例如|我曾|有一次|案例/.test(value)) return '案例故事';
  if (/\d/.test(value)) return '数据支撑';
  if (/但是|然而|不过|接下来|然后|所以/.test(value)) return '过渡衔接';
  if (/不要|别|避免|必须|不能/.test(value)) return '避坑提醒';
  if (/为什么|问题|痛点|困扰/.test(value)) return '痛点共鸣';
  if (/方法|步骤|框架|原则/.test(value)) return '框架命名';
  if (/最后|总结|总之/.test(value)) return '收尾总结';
  return '观点抛出';
}

function sentenceRoleExplanation(role) {
  return ({
    CTA引导:'推动观众执行一个明确动作。',
    案例故事:'用具体经历帮助理解抽象观点。',
    数据支撑:'用数字增强可核验性，但数字仍需来源。',
    过渡衔接:'连接上下段并提示结构推进。',
    避坑提醒:'指出不能做或容易出错的边界。',
    痛点共鸣:'建立用户问题和继续观看理由。',
    框架命名:'把方法压缩成可记忆结构。',
    收尾总结:'回收前文并结束叙事。',
    观点抛出:'给出当前段落的主要判断。'
  })[role];
}

function titleFormulaFor(title) {
  const value = clean(title, 200);
  if (!value) return { category:'未提供标题', formulaRange:null, note:'没有标题，无法匹配公式。' };
  if (/\d/.test(value)) return { category:'数字锚定或结果承诺', formulaRange:'26–40', note:'需核对数字与时间承诺是否有来源。' };
  if (/为什么/.test(value)) return { category:'认知冲突', formulaRange:'1–6', note:'正文必须真正解释原因。' };
  if (/如何|怎么/.test(value)) return { category:'结果承诺', formulaRange:'33–40', note:'正文必须给出可执行路径。' };
  if (/别|停止|戒掉/.test(value)) return { category:'行动号召', formulaRange:'61–66', note:'需避免空洞命令式表达。' };
  if (/\?|？|秘密|想不到/.test(value)) return { category:'好奇缺口', formulaRange:'7–12', note:'不能用悬念掩盖正文信息不足。' };
  return { category:'陈述型，未匹配强触发公式', formulaRange:null, note:'优先核对标题承诺与正文一致，而不是强套公式。' };
}


function normalizeMetrics(value, description) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [clean(key, 80), metricValue(item)]).filter(([key, item]) => key && item !== ''));
  }
  const matches = [...String(description || '').matchAll(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})\s*[:：]\s*([0-9.]+%?|[0-9.]+[万亿]?)/g)];
  return Object.fromEntries(matches.slice(0, 20).map((match) => [match[1], match[2]]));
}

function metricValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isFinite(Number(value)) && value !== null && value !== '') return String(value).slice(0, 120);
  return clean(value, 120);
}

export function metricObservations(metrics) {
  return Object.entries(metrics).slice(0, 6).map(([key, value]) => `${key} 为 ${value}；仅记录观察，尚不能据此确认单一内容变量的因果影响。`);
}

function normalizeBoomSignalContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const grade = ['T1', 'T2', 'T3'].includes(String(value.grade || '').toUpperCase())
    ? String(value.grade).toUpperCase()
    : null;
  const sourceRef = clean(value.sourceRef, 2000);
  if (!grade || !sourceRef) return null;
  const snapshot = JSON.parse(JSON.stringify(value));
  return JSON.stringify(snapshot).length <= 12_000 ? snapshot : null;
}

async function templateLifecycleForReview({ store, script, metrics }) {
  const tasks = typeof store?.list === 'function' ? await store.list() : [];
  const previous = tasks
    .flatMap((item) => item.artifactRefs || [])
    .filter((artifact) => artifact.type === 'content_performance_report' && artifact.data?.lineage?.templateArtifactId === script.artifactId)
    .map((artifact) => artifact.data?.templateLifecycle?.metBaseline)
    .filter((value) => typeof value === 'boolean');
  const metBaseline = metricBoolean(metrics.metBaseline ?? metrics.relativeToBaseline);
  const outcomes = metBaseline === null ? previous : [...previous, metBaseline];
  const baselineSampleSize = Math.max(0, Number(metrics.baselineSampleSize) || 0);
  let state = 'trial';
  let reason = '继续试用；还没有足够的可比较真实表现。';
  if (outcomes.slice(-3).length === 3 && outcomes.slice(-3).every((value) => value === false)) {
    state = 'retired';
    reason = '连续三次低于账号基准，停止自动优先匹配。';
  } else if (baselineSampleSize >= 5 && outcomes.length >= 3 && outcomes.filter(Boolean).length >= 2) {
    state = 'validated';
    reason = '至少使用三次、至少两次达到账号基准，且基准样本不少于五条。';
  }
  return {
    state,
    reason,
    metBaseline,
    comparableUseCount:outcomes.length,
    metBaselineCount:outcomes.filter(Boolean).length,
    baselineSampleSize,
    templateArtifactId:script.artifactId
  };
}

function metricBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', '是', '达到', '高于', 'above', 'met'].includes(normalized)) return true;
  if (['false', 'no', '否', '未达到', '低于', 'below', 'missed'].includes(normalized)) return false;
  return null;
}

function validAdvisedAnalysis(value, transcript, depth, visualEvidence = null) {
  if (!value || !Array.isArray(value.modules)) return false;
  const expected = depth === 'full' ? FULL_ANALYSIS_MODULES : FAST_ANALYSIS_MODULES;
  const byName = new Map(value.modules.map((module) => [clean(module?.name, 120), module]));
  if (!expected.every((name) => byName.has(name))) return false;
  const modulesValid = expected.every((name) => {
    const module = byName.get(name);
    if (!validAdvisedModuleCore(module, transcript, depth)) return false;
    if (name !== '全文逐句作用拆解') return true;
    return validSentenceBreakdown(module.sentenceBreakdown, transcript, { requireCoverage:true });
  });
  return modulesValid && validVisualFindings(value.visualFindings, visualEvidence, {
    minFindings:visualEvidence ? depth === 'full' ? 5 : 3 : 0,
    minCategories:visualEvidence ? depth === 'full' ? 3 : 2 : 0
  });
}

function repairAdvisedAnalysis(value, fallback, transcript, depth, visualEvidence = null) {
  value = normalizeAdvisedAnalysis(value, transcript, visualEvidence);
  if (!value || !Array.isArray(value.modules) || !fallback?.modules?.length) return null;
  const expected = depth === 'full' ? FULL_ANALYSIS_MODULES : FAST_ANALYSIS_MODULES;
  const advisedByName = new Map(value.modules.map((module) => [clean(module?.name, 120), module]));
  const fallbackByName = new Map(fallback.modules.map((module) => [clean(module?.name, 120), module]));
  let contributedModules = 0;
  const modules = expected.map((name) => {
    const advised = advisedByName.get(name);
    const safeFallback = fallbackByName.get(name);
    if (!advised || !validAdvisedModuleCore(advised, transcript, depth)) return safeFallback;
    contributedModules += 1;
    if (name !== '全文逐句作用拆解') return advised;
    if (!validSentenceBreakdown(advised.sentenceBreakdown, transcript, { requireCoverage:false })) return safeFallback;
    if (validSentenceBreakdown(advised.sentenceBreakdown, transcript, { requireCoverage:true })) return advised;
    return { ...advised, sentenceBreakdown:safeFallback?.sentenceBreakdown || [] };
  });
  const minimumContribution = depth === 'full' ? 7 : 3;
  if (contributedModules < minimumContribution) return null;
  return {
    ...fallback,
    summary:clean(value.summary, 1_000) || fallback.summary,
    modules,
    reusablePatterns:Array.isArray(value.reusablePatterns) && value.reusablePatterns.length
      ? value.reusablePatterns
      : fallback.reusablePatterns,
    actionItems:Array.isArray(value.actionItems) && value.actionItems.length
      ? value.actionItems
      : fallback.actionItems,
    visualFindings:validVisualFindings(value.visualFindings, visualEvidence, {
      minFindings:visualEvidence ? depth === 'full' ? 5 : 3 : 0,
      minCategories:visualEvidence ? depth === 'full' ? 3 : 2 : 0
    }) ? value.visualFindings : []
  };
}

function normalizeAdvisedAnalysis(value, transcript, visualEvidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const modules = Array.isArray(value.modules) ? value.modules.map((module) => {
    if (!module || typeof module !== 'object' || Array.isArray(module)) return module;
    if (evidenceMatches(transcript, module.evidence)) return module;
    const evidence = [
      ...(Array.isArray(module.originalAnalysis) ? module.originalAnalysis : []),
      ...(Array.isArray(module.diagnosis) ? module.diagnosis : []),
      ...(Array.isArray(module.optimization) ? module.optimization : [])
    ].map((item) => item?.evidence).find((item) => evidenceMatches(transcript, item));
    return evidence ? { ...module, evidence } : module;
  }) : value.modules;
  return {
    ...value,
    modules,
    visualFindings:normalizeVisualFindings(value.visualFindings, visualEvidence)
  };
}

function normalizeVisualFindings(value, visualEvidence) {
  const findings = Array.isArray(value) ? value : [];
  if (!visualEvidence) return findings;
  const frames = new Map((visualEvidence.frames || []).map((frame) => [String(frame.frameId || ''), frame]));
  return findings.map((item) => {
    const frameRef = clean(item?.evidence?.frameRef, 120);
    const frame = frames.get(frameRef);
    return frame ? {
      ...item,
      evidence:{ ...item.evidence, frameRef, timestamp:String(frame.timestamp || '') }
    } : item;
  });
}


function normalizeSourceMetadata(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const duration = Number(metadata.durationSeconds);
  const engagement = metadata.engagement && typeof metadata.engagement === 'object' && !Array.isArray(metadata.engagement)
    ? metadata.engagement
    : null;
  return {
    title:clean(metadata.title, 500) || null,
    author:clean(metadata.author, 300) || null,
    platform:clean(metadata.platform, 80) || null,
    durationSeconds:Number.isFinite(duration) && duration >= 0 ? duration : null,
    canonicalUrl:clean(metadata.canonicalUrl, 2000) || null,
    publishedAt:clean(metadata.publishedAt, 120) || null,
    engagement:engagement && Object.keys(engagement).length ? engagement : null
  };
}

function validAdvisedModuleCore(module, transcript, depth) {
  if (!evidenceMatches(transcript, module?.evidence)) return false;
  if (depth !== 'full') return true;
  return evidenceLinkedItems(module.originalAnalysis, transcript)
    && evidenceLinkedItems(module.diagnosis, transcript)
    && evidenceLinkedItems(module.optimization, transcript);
}

function validSentenceBreakdown(value, transcript, { requireCoverage }) {
  const breakdown = Array.isArray(value) ? value : [];
  if (!breakdown.length || !breakdown.every((item) => evidenceMatches(transcript, breakdownEvidence(item)))) return false;
  if (!requireCoverage) return true;
  const covered = breakdown.map((item) => evidenceText(breakdownEvidence(item)?.fragment)).join('');
  return evidenceSegments(transcript).every((segment) => covered.includes(evidenceText(segment.text)));
}


function evidenceLinkedItems(value, transcript) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => evidenceMatches(transcript, item?.evidence));
}

function evidenceMatches(transcript, evidence) {
  const fragment = clean(evidence?.fragment, 500);
  if (!fragment || evidenceText(fragment).length < 4) return false;
  const segments = evidenceSegments(transcript);
  const transcriptText = segments.map((segment) => segment.text).join(' ');
  if (!evidenceText(transcriptText).includes(evidenceText(fragment))) return false;
  const timeline = new Set(segments.map((segment) => segment.timestamp).filter(Boolean));
  if (!timeline.size) return true;
  const timestamp = clean(evidence?.timestamp, 40);
  return Boolean(timestamp && timeline.has(timestamp));
}
function breakdownEvidence(item) {
  if (item?.evidence?.fragment) return item.evidence;
  const fragment = item?.fragment || item?.original || item?.text;
  return fragment ? { timestamp:item?.timestamp ?? null, fragment } : null;
}

function evidenceText(value) {
  // “[时间点缺失]”是小D在无时间轴稿上附加的证据等级标记，
  // 不是作者原话。模型引用真实原句时可省略该标记，不能因此误判为
  // “来源片段不存在”。
  return normalize(value)
    .replace(/\[\s*时间点缺失\s*\]/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function clean(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function normalize(value) { return clean(value, 100_000).toLowerCase(); }
