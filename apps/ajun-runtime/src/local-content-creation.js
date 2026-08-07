import path from 'node:path';
import {
  buildM5PlatformCopy,
  deriveM5ContentVersionId,
  validM5MediaChecksum,
} from '@agent-army/m5-kernel/content-version';
import {
  CONTENT_PLATFORM_PLAYBOOKS,
  contentQualityChecklist,
  normalizeContentBrief,
  normalizeContentChannel,
} from '@agent-army/m5-contracts';
import { validM5ProductionTemplateBinding } from './m5-production-template-resolver.js';
import {
  findArtifact,
  needsInput,
  readArtifactText,
  referencedArtifacts,
  successResult,
  writeArtifact,
} from './local-content-artifacts.js';
import { evidenceSegments } from './local-content-analysis.js';

export class LocalContentCreator {
  constructor({
    store,
    artifactsDir,
    allowedArtifactRoots = [],
    advisor = null,
    scriptPackage = null,
    now = () => new Date(),
  } = {}) {
    this.store = store;
    this.artifactsDir = artifactsDir;
    this.allowedArtifactRoots = allowedArtifactRoots.map((item) => path.resolve(item));
    this.advisor = advisor;
    this.scriptPackage = scriptPackage;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'content-creator'; }

  async execute(task, { sourceArtifacts = null, allowAdvisor = true } = {}) {
    if (task.taskType === 'content.video-script-package') {
      if (!this.scriptPackage?.execute) return needsInput(this.now(), 'video_script_package_unavailable', '可拍脚本能力暂时不可用。');
      return this.scriptPackage.execute(task, { allowAdvisor });
    }
    const sources = Array.isArray(sourceArtifacts) ? sourceArtifacts : await referencedArtifacts(task, this.store);
    if (task.input?.context?.paperclipRoutineKey === 'm5-platform-adapt') {
      return this.m5PlatformAdapt(task, sources);
    }
    const transcriptArtifact = findArtifact(sources, 'confirmed_transcript');
    const analysisArtifact = findArtifact(sources, 'video_content_analysis_report');
    if (!transcriptArtifact) return needsInput(this.now(), 'confirmed_transcript_required', '小创必须引用系统质量确认稿或人工确认稿。');
    if (!analysisArtifact || analysisArtifact.data?.evidenceMode !== 'formal') return needsInput(this.now(), 'formal_analysis_required', '小创必须引用小拆基于确认稿生成的正式分析。');
    const platforms = normalizePlatforms(task.input?.platforms, `${task.input?.title || ''}\n${task.input?.description || ''}`);
    if (!platforms.length) return needsInput(this.now(), 'platform_required', '请明确至少一个目标平台。');
    if (platforms.length > 3) return needsInput(this.now(), 'platform_limit_exceeded', '首版一次最多生成三个平台版本。');
    const transcript = await readArtifactText(transcriptArtifact, this.allowedArtifactRoots);
    const evidence = evidenceSegments(transcript);
    const fallback = buildDrafts({
      title:task.input?.title,
      contentGoal:task.input?.contentGoal || task.input?.description,
      platforms,
      analysis:analysisArtifact.data,
      evidence
    });
    let drafts = fallback;
    let modelUsage = null;
    let advisorApplied = false;
    if (allowAdvisor && this.advisor?.draft) {
      try {
        const advisedResult = await this.advisor.draft({ title:task.input?.title, contentGoal:task.input?.contentGoal, platforms, transcript, analysis:analysisArtifact.data });
        const advised = advisedResult?.data || advisedResult;
        modelUsage = advisedResult?.usage || null;
        if (validAdvisedDrafts(advised, platforms)) {
          drafts = enrichDrafts(advised);
          advisorApplied = true;
        }
      } catch (error) {
        modelUsage = error?.usage || null;
        /* safe local draft remains available */
      }
    }
    const completedAt = this.now().toISOString();
    const contentBrief = normalizeContentBrief({
      accountPositioning:task.input?.accountPositioning || analysisArtifact.data?.positioning,
      audience:task.input?.audience || analysisArtifact.data?.audience || '当前主题的明确目标读者，发布前需由负责人核对。',
      goal:task.input?.contentGoal || task.input?.description || '基于确认稿生成可审核的平台原生内容。',
      coreJudgment:analysisArtifact.data?.summary || evidence[0]?.text || '只表达确认稿和正式分析可以支持的判断。',
      evidenceRefs:[transcriptArtifact.artifactId, analysisArtifact.artifactId],
      constraints:[
        '不新增确认稿和正式分析之外的事实、数字、身份、经历或因果结论。',
        '草稿不等于发布授权，任何外部写入继续走 Paperclip 审批。',
      ],
      channels:platforms,
      primaryAction:task.input?.primaryAction || '让读者完成一个可以立即验证的小动作。',
      experiment:task.input?.experiment,
      assumptions:task.input?.audience ? [] : ['目标受众使用当前正式分析的默认定位，发布前需核对。'],
      confirmationStatus:task.input?.briefConfirmed === true ? 'confirmed' : 'assumed_defaults',
    });
    const data = {
      contentGoal:clean(task.input?.contentGoal || task.input?.description, 500) || '基于已确认内容生成可审核草稿',
      platforms,
      contentBrief,
      contentStrategy:{
        primaryPlatform:platforms[0],
        extensionPlatforms:platforms.slice(1),
        singleExperiment:contentBrief?.experiment || null,
        strategyStatus:contentBrief?.confirmationStatus || 'needs_confirmation',
      },
      drafts,
      sourceTranscriptChecksum:transcriptArtifact.checksum || null,
      analysisArtifactId:analysisArtifact.artifactId,
      publishingStatus:'draft_only',
      generationMode:advisorApplied ? 'hermes_advisor' : 'deterministic_fallback',
      generatedAt:completedAt
    };
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'platform_content_draft',
      title:`${task.input?.title || '内容'}｜平台草稿`,
      data,
      sourceRefs:[transcriptArtifact.artifactId, analysisArtifact.artifactId],
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        confirmedTranscriptUsed:true,
        formalAnalysisUsed:true,
        platformCount:platforms.length,
        externalSideEffects:0,
        humanChecklistPresent:true,
        contentBriefPresent:Boolean(contentBrief),
        semanticQualityGateCount:drafts.every((draft) => draft.qualityChecklist?.length === 6) ? 6 : 0,
        visualAnchorPresent:drafts.every((draft) => Boolean(draft.visualAnchor)),
        advisorApplied,
      },
      completedAt
    });
    return successResult(task, artifact, completedAt, 'platform_draft', modelUsage);
  }

  async m5PlatformAdapt(task, sources) {
    const script = findArtifact(sources, 'video_script_package');
    const render = findArtifact(sources, 'render_package');
    const context = task.input?.context || {};
    const platform = String(context.pipelineCase?.fields?.platform || '').trim();
    const renderOutput = render?.data?.outputs?.[platform] || render?.data;
    const mediaPath = safeM5RelativePath(renderOutput?.relativePath || renderOutput?.outputPath);
    const checksum = String(renderOutput?.checksum || '').trim().toLowerCase();
    const audioHash = String(renderOutput?.audioHash || '').trim().toLowerCase();
    const voiceProviderActionId = String(renderOutput?.voiceProviderActionId || '').trim();
    const pipelineCaseId = String(context.pipelineCaseId || '').trim();
    const dayCaseId = String(context.pipelineCase?.parentCaseId || '').trim();
    const scheduledDate = String(context.pipelineCase?.fields?.scheduledDate || '').trim();
    if (!script?.data?.fullScript) {
      return needsInput(this.now(), 'm5_script_package_required', 'M5 平台适配缺少同一 Case 的可核验 ScriptPackage。');
    }
    if (!['douyin', 'xiaohongshu'].includes(platform)) {
      return needsInput(this.now(), 'm5_platform_required', 'M5 平台适配缺少同一 Case 的可信平台字段。');
    }
    if (
      !mediaPath
      || !validM5MediaChecksum(checksum)
      || !/^sha256:[0-9a-f]{64}$/i.test(audioHash)
      || !voiceProviderActionId
    ) {
      return needsInput(this.now(), 'm5_render_package_required', 'M5 平台适配缺少带真实相对路径和 sha256 的 RenderPackage。');
    }
    const contentVersionId = deriveM5ContentVersionId({
      pipelineCaseId,
      platform,
      mediaChecksum:checksum,
    });
    if (!contentVersionId) {
      return needsInput(this.now(), 'm5_content_version_identity_invalid', 'M5 平台版本身份无法从当前 Case、平台和成片哈希派生。');
    }
    const completedAt = this.now().toISOString();
    if (!dayCaseId || !scheduledDate) {
      return needsInput(this.now(), 'm5_day_case_lineage_required', 'M5 平台适配缺少日期父 Case 或预约日期血缘。');
    }
    const renderVariantKey = String(renderOutput?.variantKey || 'baseline');
    const grayScriptVariant = script.data?.variants?.gray_douyin || null;
    if (!['baseline', 'gray_douyin'].includes(renderVariantKey)) {
      return needsInput(this.now(), 'm5_variant_lineage_mismatch', '平台成片声明了未知脚本变体，已停止适配。');
    }
    if (platform === 'xiaohongshu' && renderVariantKey !== 'baseline') {
      return needsInput(this.now(), 'm5_cross_platform_gray_rejected', '小红书禁止消费 gray_douyin 脚本、配音或成片。');
    }
    if (platform === 'douyin' && grayScriptVariant && renderVariantKey !== 'gray_douyin') {
      return needsInput(this.now(), 'm5_gray_variant_render_required', '当前抖音 Case 已绑定灰度脚本，但成片不是 gray_douyin，禁止降级为 baseline 继续发布。');
    }
    const expectedVariantKey = renderVariantKey;
    const scriptVariant = script.data?.variants?.[expectedVariantKey]
      || (expectedVariantKey === 'baseline' ? {
        ...script.data,
        variantKey:'baseline',
        templateBinding:script.data?.templateLifecycle?.templateBinding,
      } : null);
    const templateBinding = scriptVariant?.templateBinding;
    const exactGrayTarget = templateBinding?.source === 'approved_single_gray'
      && templateBinding?.grayRelease === true
      && templateBinding?.applicationScope === 'full_content_variant'
      && templateBinding?.grayTargetCaseId === pipelineCaseId
      && templateBinding?.grayTargetDayCaseId === dayCaseId
      && templateBinding?.grayTargetScheduledDate === scheduledDate
      && templateBinding?.grayTargetPlatform === platform
      && platform === 'douyin';
    if (expectedVariantKey === 'gray_douyin' && !exactGrayTarget) {
      return needsInput(this.now(), 'm5_gray_target_mismatch', 'gray_douyin 没有精确绑定当前抖音平台 Case、日期父 Case和预约日期，已停止适配。');
    }
    if (
      expectedVariantKey === 'baseline'
      && (templateBinding?.source === 'approved_single_gray' || templateBinding?.grayRelease === true)
    ) {
      return needsInput(this.now(), 'm5_gray_variant_lineage_mismatch', 'baseline 成片不得携带灰度模板绑定，已停止适配。');
    }
    if (
      !scriptVariant?.fullScript
      || !validM5ProductionTemplateBinding(templateBinding)
      || renderVariantKey !== expectedVariantKey
      || renderOutput?.templateBindingHash !== templateBinding.bindingHash
      || (renderOutput?.scriptHash || null) !== (scriptVariant.scriptHash || null)
    ) {
      return needsInput(this.now(), 'm5_variant_lineage_mismatch', '平台脚本、配音或成片的 variant/binding/scriptHash 血缘不一致。');
    }
    const copy = buildM5PlatformCopy(scriptVariant, platform);
    const templateApplication = {
      mode:'verified_full_content_variant',
      variantKey:expectedVariantKey,
      bindingHash:templateBinding.bindingHash,
      scriptHash:scriptVariant.scriptHash,
      renderChecksum:checksum,
    };
    const contentVersion = {
      contentVersionId,
      platform,
      dayCaseId,
      platformCaseId:pipelineCaseId,
      scheduledDate,
      checksum,
      mediaPath,
      ...copy,
      sourceScriptArtifactId:script.artifactId,
      sourceRenderArtifactId:render.artifactId,
      publishingStatus:'draft_only',
      generatedAt:completedAt,
      templateVersionId:String(
        templateBinding?.templateVersionId || 'm5-template-default-v1',
      ),
      templateWorkProductId:templateBinding?.templateWorkProductId || null,
      templateBindingHash:templateBinding.bindingHash,
      templateApplication,
      audioHash,
      voiceProviderActionId,
      grayRelease:expectedVariantKey === 'gray_douyin' && exactGrayTarget,
    };
    const artifact = await writeArtifact({
      artifactsDir:this.artifactsDir,
      task,
      type:'platform_content_draft',
      title:`${task.input?.title || 'M5 内容'}｜${platform === 'douyin' ? '抖音' : '小红书'}版本`,
      data:{
        contentVersion,
        publishingStatus:'draft_only',
        adaptationMode:'m5_deterministic_from_verified_script_and_render',
      },
      sourceRefs:[script.artifactId, render.artifactId],
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        sourceScriptVerified:true,
        sourceRenderVerified:true,
        mediaChecksumBound:true,
        externalSideEffects:0,
      },
      completedAt,
    });
    return successResult(task, artifact, completedAt, 'm5_platform_adapt');
  }
}

function buildDrafts({ title, contentGoal, platforms, analysis, evidence }) {
  const proof = evidence[0] || { timestamp:null, text:'确认稿缺少可展示片段' };
  const second = evidence[1] || proof;
  return enrichDrafts(platforms.map((platform) => ({
    platform,
    titleCandidates:[
      `${clean(title, 80) || '这条内容'}：先看最关键的一步`,
      `我从这段内容里拆出了一个可复用方法`,
      `别急着照抄，先把这件事想明白`
    ],
    opening:`${proof.text}——这是整条内容最值得先讲清楚的部分。`,
    body:[
      `目标：${clean(contentGoal, 240) || '让读者理解并能执行一个具体方法。'}`,
      `核心展开：${second.text}`,
      `收束：把方法拆成一个今天就能验证的小动作。`
    ],
    pacing:['前 3 秒直接给出问题或结果。', '中段用确认稿中的具体片段支撑。', '结尾只给一个行动指令。'],
    adaptation:platformAdaptation(platform),
    evidence:[proof, second],
    humanChecklist:['事实、数字和身份均能回到确认稿。', '没有复制他人的独特表达。', '标题承诺与正文一致。', '发布前由真人检查平台规范和最终措辞。'],
    analysisSummary:clean(analysis?.summary, 500)
  })));
}

function enrichDrafts(drafts) {
  return drafts.map((draft) => {
    const platform = normalizeContentChannel(draft?.platform) || String(draft?.platform || '');
    const playbook = CONTENT_PLATFORM_PLAYBOOKS[platform] || null;
    const qualityChecklist = playbook ? contentQualityChecklist(platform) : [];
    return {
      ...draft,
      platform,
      platformPlaybook:playbook,
      visualAnchor:draft?.visualAnchor || (playbook ? {
        style:'统一、克制、证据优先',
        palette:'沿用账号已确认色板；无档案时使用单一强调色',
        composition:playbook.visual,
        typography:'手机优先，封面标题与正文标题一致',
        evidencePolicy:'真实界面优先；没有真实素材时使用场景或隐喻，不虚构产品 UI',
      } : null),
      qualityChecklist,
      humanChecklist:[
        ...(Array.isArray(draft?.humanChecklist) ? draft.humanChecklist : []),
        ...qualityChecklist.map((item) => item.instruction),
      ],
    };
  });
}

function safeM5RelativePath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  if (
    !relative
    || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
    || !/\.mp4$/i.test(relative)
  ) return null;
  return relative;
}


function normalizePlatforms(value, text) {
  const explicit = Array.isArray(value) ? value : [];
  const inferred = [
    [/抖音|douyin/i, 'douyin'],
    [/小红书|xiaohongshu|xhs/i, 'xiaohongshu'],
    [/微信公众号|公众号|wechat[_ -]?mp/i, 'wechat_official_account'],
    [/视频号|shipinhao|wechat[_ -]?channels/i, 'wechat_channels'],
    [/b站|哔哩哔哩|bilibili/i, 'bilibili']
  ].filter(([pattern]) => pattern.test(text)).map(([, platform]) => platform);
  return [...new Set([...explicit, ...inferred].map((item) => (
    normalizeContentChannel(item) || clean(item, 40).toLowerCase()
  )).filter(Boolean))];
}

function normalizeMetrics(value, description) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [clean(key, 80), metricValue(item)]).filter(([key, item]) => key && item !== ''));
  }
  const matches = [...String(description || '').matchAll(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})\s*[:：]\s*([0-9.]+%?|[0-9.]+[万亿]?)/g)];
  return Object.fromEntries(matches.slice(0, 20).map((match) => [match[1], match[2]]));
}


function platformAdaptation(platform) {
  return ({
    douyin:'短句、强开场、单一行动指令；成片仍需真人核对画面和音乐版权。',
    xiaohongshu:'标题体现具体收益与适用人群，正文保留可收藏的步骤。',
    wechat_official_account:'结构完整、段落适合手机阅读，标题、摘要、封面和外链在草稿预览中逐项核对。',
    wechat_channels:'表达更完整，强化可信依据和关系传播语境。',
    bilibili:'允许更长铺垫，但章节承诺与证据仍需清楚。'
  })[platform] || '按目标平台长度和展示形式调整，但不改变已确认事实。';
}


function validAdvisedDrafts(value, platforms) {
  return Array.isArray(value) && value.length === platforms.length && value.every((draft) => Array.isArray(draft?.humanChecklist) && draft.humanChecklist.length > 0);
}

function clean(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
