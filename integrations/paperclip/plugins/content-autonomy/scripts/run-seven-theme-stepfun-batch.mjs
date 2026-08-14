#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertM5BudgetCoverage } from '../../../../../apps/ajun-runtime/src/m5-budget-cost-contract.ts';
import { LocalBudgetTicketAuthority } from '../../../../../apps/ajun-runtime/src/local-budget-ticket-authority.ts';
import { paidParameterChecksum } from '../src/stepfun-tools.ts';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONFIRMATION = 'I_ACCEPT_REAL_STEPFUN_7_THEME_CHARGES';
const OFFICIAL_VOICE = 'vibrant-youth';
export const DEFAULT_TTS_TRANSPORT_REVISION = 'paperclip-b64-v1';
const VISUAL_ACTION_REVISIONS = Object.freeze({
  't03-evidence-chain':'quality-r2',
  't04-role-bundles':'quality-r2',
  't06-budget-gates':'quality-r2',
});
const TTS_ACTION_REVISIONS = Object.freeze({
  't04-role-bundles':'paperclip-b64-t04-r3',
  't06-budget-gates':'paperclip-b64-t06-r2',
  't07-review-learning':'paperclip-b64-t07-r2',
});
const TTS_SPEEDS = Object.freeze({
  't04-role-bundles':1.18,
  't06-budget-gates':1.18,
  't07-review-learning':1.18,
});
const CONTENT_PLUGIN_KEY = 'agent-army.content-autonomy';
const VISION_MAX_INPUT_TOKENS = 128_000;
const VISION_MAX_OUTPUT_TOKENS = 4_096;
const execFileAsync = promisify(execFile);

export const SEVEN_THEMES = Object.freeze([
  theme(
    't01-execution-loop',
    'Agent执行闭环',
    '抽象的智能体控制中心，五段连续动作由光路连接，呈现计划、执行、观察、纠错和审核的循环关系',
    '为什么有些智能体看起来很聪明，真正交任务时却总掉链子？因为回答问题只是起点，完整闭环还要先拆计划，再调用工具执行，并把每一步真实结果读回来。比如网页抓取失败，它不能继续编造结论，而要判断是登录限制、页面变化还是来源不可用，再切换公开接口或请求人工处理。只有产物通过事实和格式审核，任务才算完成。判断一个Agent能不能干活，就看它是否会观察、纠错、恢复和交付，而不是看它会不会说漂亮话。',
  ),
  theme(
    't02-permission-boundary',
    '权限边界',
    '多层安全舱与清晰隔离区，中心任务沿授权通道前进，越界路径被明确阻断',
    '让智能体自动执行，最危险的误区就是一次把所有权限都给它。正确做法是把浏览、生成、发布、付款和账号设置拆成独立能力，每次活动只开放必要范围。比如内容助手可以上传一条已审核视频，却不能顺手私信、评论、投流或删除历史内容。只要遇到验证码、账号切换、风控提示、未知页面或预算超限，执行器就必须停住并留下恢复动作。真正的高权限不是随便做，而是在清楚边界内自动做，越界时坚定地不做。',
  ),
  theme(
    't03-evidence-chain',
    '证据链',
    '多个来源节点汇入可核验的证据包，保留清晰血缘、校验标记和审阅路径',
    '一段内容说得再顺，如果结论找不到来源，就不适合自动发布。可靠流程会先建立证据包：网页保留链接和抓取时间，截图标出区域，视频判断绑定关键帧或时间点，数字记录原始出处。比如要说某个Agent节省了多少时间，不能凭行业印象给出百分比，必须回到真实任务记录；没有证据，就改成可验证的过程描述。脚本、画面和审核都引用同一份证据血缘，修改后重新核对。这样出现争议时，系统能说明依据，也知道该改哪一句。',
  ),
  theme(
    't04-role-bundles',
    '岗位技能包',
    '八个专业工作台围绕同一项目协作，每个工作台只显示本岗位需要的有限工具',
    '把几十个工具一次性塞给所有智能体，不会让团队更专业，只会让选择更混乱、越权面更大。更稳的方式是按岗位发放版本化技能包：研究员负责网页、PDF和来源核验，视频分析师负责字幕、关键帧和视觉证据，创作师负责脚本、画面、配音与渲染，审核官只做事实、版权和隐私门禁。比如总管可以派单和暂停，却不能直接打开浏览器发布。新增技能也要经过发现、审计、合成测试和负责人批准。能力边界清楚以后，多Agent协作才不是角色扮演。',
  ),
  theme(
    't05-idempotent-recovery',
    '幂等与恢复',
    '任务从检查点恢复，已完成产物被锁定复用，失败分支切换到备用路线但不重复执行',
    '自动化真正昂贵的故障，往往不是第一次失败，而是恢复时又生成一次、又扣一次费，甚至重复发布。解决办法是给每个外部动作稳定的行动标识，并在调用前写入状态。比如图片已经生成但费用回执暂时没拿到，系统应该把动作标成未决，禁止自动重放；确认费用事件后，再次执行只读取原产物，Provider调用必须为零。进程重启也从最近检查点继续，不重做已验证步骤。能安全恢复、识别歧义并保持幂等，才是长期自治系统的基本功。',
  ),
  theme(
    't06-budget-gates',
    '预算门禁',
    '公司、岗位、项目三层预算仪表共同约束一次受控调用，费用流向清楚可追踪',
    '模型调用几分钱看似不多，连续批处理、失败重试和多岗位并发后，成本会迅速失控。所以每次付费动作都要在外发前拿到预算许可，而且许可必须同时匹配公司、岗位、项目、运行和具体参数。比如一次视觉分析估算最高两分钱，预算回执就要覆盖这笔上限；缺少任一层、金额不足或身份不匹配，Provider调用数必须保持零。调用完成后再按真实用量写入核心费用事件，费用未确认就不能进入下一阶段。先许可、后调用、再对账，预算才是硬门禁。',
  ),
  theme(
    't07-review-learning',
    '审核与指标学习',
    '内容经过事实、隐私和版权三道审核后进入指标回流，改进建议停留在待审灰度区',
    '内容发布后有了播放、完播和收藏数据，不代表模型可以立刻改生产模板，更不能自动扩大权限。可靠学习需要先积累至少五条同类型真实样本，再提出明确改进假设，例如开场是否太慢、字幕是否过密。新建议先在历史样本离线回放，由审核官确认没有降低事实、版权和隐私门禁，然后只灰度一条内容。表现或质量下降，就回退旧版本。指标负责提供证据，不负责越权做决定。这样系统会逐步变好，却不会为了播放量擅自加频、投流或放松审核。',
  ),
]);

export async function executeSevenThemeBatch({
  themes = SEVEN_THEMES,
  batchVersion,
  ttsTransportRevision = DEFAULT_TTS_TRANSPORT_REVISION,
  replayOnly = false,
  recoveryFrom = null,
  priorLifetimeProviderCalls = 0,
  creatorTools,
  analystTools,
  creatorRun,
  analystRun,
  creatorIssueId,
  analystIssueId,
  goalId,
  commitCost,
  providerCallCount,
  providerRequestCount = providerCallCount,
  probeNarration,
  writeLedger,
}) {
  if (!Array.isArray(themes) || themes.length !== 7) {
    throw safeError('批处理必须且只能包含 7 个主题。');
  }
  const version = actionVersion(batchVersion);
  const transportRevision = actionVersion(ttsTransportRevision);
  const strictReplay = replayOnly === true;
  const recovery = normalizeRecoveryFrom(recoveryFrom);
  const priorLifetime = nonNegativeInteger(
    priorLifetimeProviderCalls,
    '恢复批次缺少有效的历史 Provider 调用数。',
  );
  const providerCallsAtStart = providerCallCount();
  const providerRequestsAtStart = providerRequestCount();
  const actions = [];
  const providerActivity = concurrencyActivity();
  const providerSchedulers = {
    media:concurrencyLimiter(2, providerActivity),
    reasoning:concurrencyLimiter(2, providerActivity),
  };
  const providerSchedulerFor = (action) =>
    action.operation === 'vision' ? providerSchedulers.reasoning : providerSchedulers.media;
  const cancelProviderSchedulers = (error) => {
    providerSchedulers.media.cancel(error);
    providerSchedulers.reasoning.cancel(error);
  };
  const peakProviderConcurrency = () => providerActivity.peak();
  const commitScheduler = concurrencyLimiter(1);

  const themeOutcomes = await mapSettledLimited(themes, 2, async (themeValue, themeIndex) => {
    const current = validateTheme(themeValue, themeIndex);
    const themeDir = `provider/7-theme/${version}/${current.id}`;
    const visualRevision = VISUAL_ACTION_REVISIONS[current.id] || 'base';
    const visualSuffix = visualRevision === 'base' ? '' : `-${visualRevision}`;
    const candidatePath = (candidateIndex) =>
      `${themeDir}/candidate-${candidateIndex}${visualSuffix}.png`;
    const imageActions = [1, 2].map((candidateIndex) => {
      const actionId = stableActionId({
        version,
        issueId:creatorIssueId,
        themeId:current.id,
        operation:`image${candidateIndex}${visualSuffix}`,
      });
      const imageParams = {
        actionId,
        prompt:imagePrompt(current, candidateIndex, visualRevision),
        outputPath:candidatePath(candidateIndex),
        seed:7_300 + themeIndex * 10 + candidateIndex,
        textMode:false,
      };
      const action = actionRecord({
        actionId,
        role:'content-creator',
        operation:'image_generate',
        parameters:imageParams,
        invoke:() => creatorTools.image(imageParams, creatorRun),
      });
      actions.push(action);
      return action;
    });

    const themeTtsRevision = TTS_ACTION_REVISIONS[current.id] || transportRevision;
    const ttsActionId = stableActionId({
      version,
      issueId:creatorIssueId,
      themeId:current.id,
      operation:`tts-${themeTtsRevision}`,
    });
    const ttsParams = {
      actionId:ttsActionId,
      text:current.narration,
      voice:OFFICIAL_VOICE,
      speed:TTS_SPEEDS[current.id] || 1.05,
      outputPath:themeTtsRevision === transportRevision
        ? `${themeDir}/narration.mp3`
        : `${themeDir}/narration-${themeTtsRevision}.mp3`,
    };
    const ttsAction = actionRecord({
      actionId:ttsActionId,
      role:'content-creator',
      operation:'tts',
      parameters:ttsParams,
      invoke:() => creatorTools.tts(ttsParams, creatorRun),
    });
    actions.push(ttsAction);
    const visionActions = [1, 2].map((candidateIndex) => {
      const actionId = stableActionId({
        version,
        issueId:analystIssueId,
        themeId:current.id,
        operation:`vision${candidateIndex}${visualSuffix}`,
      });
      const visionParams = {
        actionId,
        relativePath:candidatePath(candidateIndex),
        prompt:qualityPrompt(current),
      };
      const visionAction = actionRecord({
        actionId,
        role:'video-content-analyst',
        operation:'vision',
        parameters:visionParams,
        invoke:() => analystTools.vision(visionParams, analystRun),
      });
      actions.push(visionAction);
      return visionAction;
    });

    const stopOnFailure = (promise) => promise.catch((error) => {
      cancelProviderSchedulers(error);
      throw error;
    });
    const imagePromises = imageActions.map((action, index) =>
      invokeAndCommit(action, {
        commitCost,
        issueId:creatorIssueId,
        goalId,
        providerScheduler:providerSchedulerFor(action),
        commitScheduler,
      }).then((committed) => ({
        index:index + 1,
        ...safePaidResult(committed, {
          parameterChecksum:action.parameterChecksum,
          promptChecksum:checksum(imagePrompt(current, index + 1, visualRevision)),
        }),
      }))).map(stopOnFailure);
    const narrationPromise = stopOnFailure(invokeAndCommit(ttsAction, {
      commitCost,
      issueId:creatorIssueId,
      goalId,
      providerScheduler:providerSchedulerFor(ttsAction),
      commitScheduler,
    }).then((committed) => safePaidResult(committed, {
      parameterChecksum:ttsAction.parameterChecksum,
      promptChecksum:checksum(current.narration),
    })));
    const visionPromises = visionActions.map((action, index) =>
      imagePromises[index].then(() => invokeAndCommit(action, {
        commitCost,
        issueId:analystIssueId,
        goalId,
        providerScheduler:providerSchedulerFor(action),
        commitScheduler,
      }))).map(stopOnFailure);

    const paidOutcomes = await Promise.allSettled([
      ...imagePromises,
      narrationPromise,
      ...visionPromises,
    ]);
    const paidFailure = paidOutcomes.find((item) => item.status === 'rejected');
    if (paidFailure) throw paidFailure.reason;
    const paidValues = paidOutcomes.map((item) => item.value);
    const candidates = paidValues.slice(0, 2);
    const narrationPaid = paidValues[2];
    const visionResults = paidValues.slice(3);
    if (typeof probeNarration !== 'function') {
      throw safeError('批处理缺少真实旁白音频探测器。');
    }
    const narrationAudio = validateNarrationAudio(
      await probeNarration(narrationPaid.outputPath),
    );
    const narration = { ...narrationPaid, audio:narrationAudio };
    for (let index = 0; index < candidates.length; index += 1) {
      const committed = visionResults[index];
      candidates[index].quality = structuredQuality(committed?.data?.observation, {
        requirePersonFree:current.id === 't04-role-bundles',
      });
      candidates[index].vision = safePaidResult(committed, {
        includeOutput:false,
        parameterChecksum:visionActions[index].parameterChecksum,
      });
    }

    let selected;
    try {
      selected = selectCandidate(candidates, current.id);
    } catch (error) {
      cancelProviderSchedulers(error);
      throw error;
    }
    return {
      id:current.id,
      title:current.title,
      visualRevision,
      ttsRevision:themeTtsRevision,
      promptChecksum:selected.promptChecksum,
      narrationChecksum:checksum(current.narration),
      narrationCharacters:[...current.narration].length,
      candidates,
      narration,
      selectedCandidate:selected.index,
      selectedPath:selected.outputPath,
      selectedChecksum:selected.outputChecksum,
    };
  });
  await Promise.all([
    providerSchedulers.media.drain(),
    providerSchedulers.reasoning.drain(),
  ]);
  await commitScheduler.drain();
  const failedTheme = themeOutcomes.find((item) => item.status === 'rejected');
  if (failedTheme) {
    const failure = failedTheme.reason instanceof Error
      ? failedTheme.reason
      : safeError('7主题批处理失败。');
    const failedLedger = {
      schemaVersion:'agent.army/stepfun-seven-theme-batch/v1',
      generatedAt:new Date().toISOString(),
      batchVersion:version,
      ttsTransportRevision:transportRevision,
      provider:'stepfun',
      status:'failed',
      failure:{
        code:String(failure.code || 'batch_failed'),
        stage:failure.code === 'narration_audio_gate_failed'
          ? 'narration_audio_gate'
          : 'provider_or_quality_gate',
        message:safeShortText(failure.message, 300),
      },
      totalProviderCalls:providerCallCount() - providerCallsAtStart,
      totalProviderRequests:providerRequestCount() - providerRequestsAtStart,
      lifetimeProviderCalls:priorLifetime + providerCallCount() - providerCallsAtStart,
      ...(recovery ? { recoveryFrom:recovery } : {}),
      execution:{
        maxProviderConcurrency:4,
        peakProviderConcurrency:peakProviderConcurrency(),
        coreCostCommitConcurrency:1,
      },
    };
    assertRedactedLedger(failedLedger);
    await writeLedger(failedLedger);
    throw failure;
  }
  const ledgerThemes = themeOutcomes.map((item) => item.value);

  const uniqueActionIds = new Set(actions.map((item) => item.actionId));
  if (actions.length !== 35 || uniqueActionIds.size !== actions.length) {
    throw safeError('7主题批处理必须生成 35 个唯一付费 action。');
  }

  const confirmedReplay = countInitialProviderReuse(ledgerThemes, 'confirmed');
  const pendingCostRecovery = countInitialProviderReuse(ledgerThemes, 'pending_cost');
  const expectedNewProviderCalls = actions.length - confirmedReplay - pendingCostRecovery;
  const actualNewProviderCalls = providerCallCount() - providerCallsAtStart;
  if (
    strictReplay
    && (
      expectedNewProviderCalls !== 0
      || actualNewProviderCalls !== 0
      || providerRequestCount() - providerRequestsAtStart !== 0
      || pendingCostRecovery !== 0
    )
  ) {
    throw safeError(
      'replay-only 要求 35 个 action 全部精确复用已确认状态；禁止新 Provider 调用或费用恢复。',
      'replay_only_not_confirmed',
    );
  }
  if (actualNewProviderCalls !== expectedNewProviderCalls) {
    throw safeError('恢复批次的新 Provider 调用数与已确认回放数不一致。');
  }
  const initialPeakProviderConcurrency = peakProviderConcurrency();
  const replayStart = providerCallCount();
  const replayActions = strictReplay
    ? actions.map((action) => ({
      actionId:action.actionId,
      operation:action.operation,
      parameterChecksum:action.parameterChecksum,
      replayed:true,
    }))
    : await Promise.all(actions.map(async (action) => {
      const replay = await providerSchedulerFor(action).run(action.invoke);
      if (
        replay?.data?.replayed !== true
        || replay?.data?.costCommit?.status !== 'confirmed'
      ) {
        throw safeError(`幂等回放失败：${action.operation} 没有复用已确认结果。`);
      }
      return {
        actionId:action.actionId,
        operation:action.operation,
        parameterChecksum:action.parameterChecksum,
        replayed:true,
      };
    }));
  const replayProviderCalls = providerCallCount() - replayStart;
  if (replayProviderCalls !== 0) {
    throw safeError('幂等回放触发了额外 Provider 调用。');
  }

  const ledger = {
    schemaVersion:'agent.army/stepfun-seven-theme-batch/v1',
    generatedAt:new Date().toISOString(),
    batchVersion:version,
    ttsTransportRevision:transportRevision,
    provider:'stepfun',
    status:'succeeded',
    officialVoice:OFFICIAL_VOICE,
    themeCount:ledgerThemes.length,
    expectedAssets:{ images:14, narrations:7, visionObservations:14 },
    totalProviderCalls:actualNewProviderCalls,
    totalProviderRequests:providerRequestCount() - providerRequestsAtStart,
    lifetimeProviderCalls:priorLifetime + actualNewProviderCalls,
    expectedNewProviderCalls,
    confirmedReplay,
    pendingCostRecovery,
    ...(recovery ? { recoveryFrom:recovery } : {}),
    execution:{
      maxProviderConcurrency:4,
      peakProviderConcurrency:initialPeakProviderConcurrency,
      coreCostCommitConcurrency:1,
      replayOnly:strictReplay,
    },
    themes:ledgerThemes,
    replay:{ providerCalls:0, actions:replayActions },
  };
  assertRedactedLedger(ledger);
  await writeLedger(ledger);
  return ledger;
}

function countInitialProviderReuse(themes, kind) {
  const field = kind === 'pending_cost' ? 'providerCallReplayed' : 'replayed';
  return themes.reduce((count, current) => count
    + (current.narration?.[field] === true ? 1 : 0)
    + current.candidates.reduce((candidateCount, candidate) => candidateCount
      + (candidate[field] === true ? 1 : 0)
      + (candidate.vision?.[field] === true ? 1 : 0), 0), 0);
}

export function structuredQuality(rawObservation, { requirePersonFree = false } = {}) {
  const source = String(rawObservation || '');
  const parsed = parseJsonObject(source);
  const score = boundedScore(parsed.score, 'score');
  const composition = boundedScore(parsed.composition, 'composition');
  const visualClarity = boundedScore(parsed.visualClarity, 'visualClarity');
  if (typeof parsed.textFree !== 'boolean' || typeof parsed.brandSafe !== 'boolean') {
    throw safeError('视觉质量观察缺少 textFree 或 brandSafe 布尔字段。');
  }
  if (requirePersonFree && typeof parsed.personFree !== 'boolean') {
    throw safeError('视觉质量观察缺少 personFree 布尔字段。');
  }
  const risks = Array.isArray(parsed.risks)
    ? parsed.risks.slice(0, 8).map((item) => safeShortText(item, 120))
    : [];
  return {
    score,
    composition,
    visualClarity,
    textFree:parsed.textFree,
    brandSafe:parsed.brandSafe,
    ...(typeof parsed.personFree === 'boolean' ? { personFree:parsed.personFree } : {}),
    risks,
    observationChecksum:checksum(source),
    observationCharacters:[...source].length,
  };
}

export function validateNarrationAudio(value) {
  const durationSeconds = Number(value?.durationSeconds);
  const codec = safeShortText(value?.codec, 40);
  const sampleRate = Number(value?.sampleRate);
  const channels = Number(value?.channels);
  if (
    !Number.isFinite(durationSeconds)
    || durationSeconds < 30
    || durationSeconds > 44
    || !/^[a-z0-9_-]{2,40}$/i.test(codec)
    || !Number.isSafeInteger(sampleRate)
    || sampleRate < 8_000
    || sampleRate > 192_000
    || !Number.isSafeInteger(channels)
    || channels < 1
    || channels > 8
  ) {
    throw safeError(
      '旁白音频未通过可解码、30至44秒时长或音频流参数门禁。',
      'narration_audio_gate_failed',
    );
  }
  return {
    durationSeconds:Number(durationSeconds.toFixed(3)),
    codec,
    sampleRate,
    channels,
  };
}

function theme(id, title, visualBrief, narration) {
  return Object.freeze({ id, title, visualBrief, narration });
}

function validateTheme(value, index) {
  const narrationCharacters = [...String(value?.narration || '').trim()].length;
  if (
    !value
    || !/^t0[1-7]-[a-z0-9-]{3,40}$/.test(String(value.id || ''))
    || !String(value.title || '').trim()
    || !String(value.visualBrief || '').trim()
    || !String(value.narration || '').trim()
    || narrationCharacters < 150
    || narrationCharacters > 220
  ) {
    throw safeError(`第 ${index + 1} 个主题定义无效。`);
  }
  return value;
}

function imagePrompt(current, candidateIndex, visualRevision = 'base') {
  const variant = candidateIndex === 1
    ? '电影感纵深、冷蓝青色光线、主体集中、留出安全字幕区'
    : '清晰几何空间、深蓝紫色光线、层次分明、适合快速混剪';
  const revisionInstruction = visualRevision === 'base'
    ? null
    : current.id === 't04-role-bundles'
      ? '画面中不得出现任何人、人体、脸、头像、机器人或类人轮廓；只能使用八个抽象几何工作台和无标记光线表达协作，所有表面完全空白。'
      : current.id === 't06-budget-gates'
      ? '只用三个不同大小的纯色圆环和一束光表示三层约束；圆环表面完全空白，禁止仪表盘、刻度、数字、货币符号、图标、表格、界面卡片、标签或任何细碎标记。'
      : '只使用连续实心形状、光线和空白连接线表达关系；所有节点、标签位、标牌、屏幕和卡片必须完全空白，禁止细碎符号或伪文字纹理。';
  return [
    'AI Agent实战主题的高质量短视频视觉素材。',
    current.visualBrief,
    variant,
    revisionInstruction,
    '无人物肖像、无品牌、无商标、无界面截图、无水印。',
    '画面中不得出现任何文字、字母、数字或类似文字的符号。',
    '干净、高对比、专业、可作为30至60秒竖屏视频的补充画面。',
  ].filter(Boolean).join(' ');
}

function qualityPrompt(current) {
  const requirePersonFree = current.id === 't04-role-bundles';
  return [
    `评估这张“${current.title}”候选画面。`,
    '只根据可见画面判断，不猜测来源。',
    '只返回一个JSON对象，不要Markdown：',
    requirePersonFree
      ? '{"score":0,"composition":0,"visualClarity":0,"textFree":true,"brandSafe":true,"personFree":true,"risks":[]}'
      : '{"score":0,"composition":0,"visualClarity":0,"textFree":true,"brandSafe":true,"risks":[]}',
    requirePersonFree
      ? '三个分数必须是0到100整数；textFree表示完全没有文字或伪文字；brandSafe表示没有品牌、商标或水印；personFree表示完全没有人、脸、头像、机器人或类人轮廓；risks为简短字符串数组。'
      : '三个分数必须是0到100整数；textFree表示完全没有文字或伪文字；brandSafe表示没有品牌、商标、水印或真人肖像；risks为简短字符串数组。',
  ].join(' ');
}

function selectCandidate(candidates, themeId = 'unknown-theme') {
  const eligible = candidates.filter((item) =>
    item.quality?.textFree === true
    && item.quality?.brandSafe === true
    && (themeId !== 't04-role-bundles' || item.quality?.personFree === true));
  if (eligible.length === 0) {
    throw safeError(`${themeId} 的两张候选均未通过无文字和品牌安全门禁，禁止选择。`);
  }
  return [...eligible].sort((left, right) =>
    right.quality.score - left.quality.score
    || right.quality.visualClarity - left.quality.visualClarity
    || left.index - right.index)[0];
}

function actionRecord({ actionId, role, operation, parameters, invoke }) {
  const parameterChecksum = paidParameterChecksum(parameters);
  return Object.freeze({ actionId, role, operation, parameterChecksum, invoke });
}

async function invokeAndCommit(action, {
  commitCost,
  issueId,
  goalId,
  providerScheduler,
  commitScheduler,
}) {
  const result = await providerScheduler.run(action.invoke);
  const committed = await commitScheduler.run(() => commitCost({
      actionId:action.actionId,
      issueId,
      goalId,
      result,
      role:action.role,
      operation:action.operation,
    }));
  if (
    committed?.data?.costCommit?.status !== 'confirmed'
    || committed?.data?.nextStageAllowed !== true
  ) {
    throw safeError(`付费 action ${action.actionId} 尚未完成费用确认。`);
  }
  return committed;
}

function safePaidResult(result, {
  includeOutput = true,
  parameterChecksum,
  promptChecksum,
} = {}) {
  const data = result?.data || {};
  const recordedPromptChecksum = String(data.callRecord?.promptChecksum || '');
  if (
    recordedPromptChecksum
    && promptChecksum
    && recordedPromptChecksum !== promptChecksum
  ) {
    throw safeError('付费工具结果的 Prompt 血缘与请求不一致。');
  }
  const safe = {
    actionId:String(data.actionId || ''),
    operation:String(data.operation || ''),
    parameterChecksum:String(parameterChecksum || ''),
    ...(promptChecksum
      ? { promptChecksum:recordedPromptChecksum || String(promptChecksum) }
      : {}),
    model:String(data.model || ''),
    replayed:data.replayed === true,
    providerCallReplayed:data.providerCallReplayed === true,
    costCents:Number(data.callRecord?.costEvent?.costCents || 0),
    costEventId:String(data.costCommit?.costEventId || ''),
    outputChecksum:includeOutput ? String(data.checksum || '') : null,
    outputPath:includeOutput ? String(data.relativePath || '') : null,
  };
  if (
    !safe.actionId
    || !safe.operation
    || !/^sha256:[a-f0-9]{64}$/.test(safe.parameterChecksum)
    || (promptChecksum && !/^sha256:[a-f0-9]{64}$/.test(safe.promptChecksum))
    || !safe.model
    || !UUID.test(safe.costEventId)
    || !Number.isSafeInteger(safe.costCents)
    || safe.costCents <= 0
    || (includeOutput && (
      !/^sha256:[a-f0-9]{64}$/.test(safe.outputChecksum)
      || !safe.outputPath
    ))
  ) {
    throw safeError('付费工具结果缺少可核验的费用或产物元数据。');
  }
  return safe;
}

function parseJsonObject(value) {
  const trimmed = value.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw safeError('视觉质量观察不是有效 JSON。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw safeError('视觉质量观察必须是 JSON 对象。');
  }
  return parsed;
}

function boundedScore(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw safeError(`视觉质量观察的 ${field} 必须是0到100整数。`);
  }
  return value;
}

function safeShortText(value, maximum) {
  const text = String(value || '').trim();
  if (!text || text.length > maximum || /(?:sk-|Bearer\s|token|cookie|password|secret|\/Users\/)/i.test(text)) {
    return 'redacted-risk';
  }
  return text;
}

function stableActionId({ version, issueId, themeId, operation }) {
  const actionId = `m5_7theme_${issueId.slice(0, 8)}_${themeId}_${operation}_${version}`;
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)) {
    throw safeError('批处理 actionId 无效。');
  }
  return actionId;
}

function assertRedactedLedger(ledger) {
  const serialized = JSON.stringify(ledger);
  if (
    /STEPFUN_API_KEY|authorization|Bearer\s|(?:sk|api)[-_][A-Za-z0-9]{12,}|\/Users\/|file:\/\//i.test(serialized)
    || serialized.includes('"observation"')
    || serialized.includes('"promptText"')
    || serialized.includes('"narrationText"')
  ) {
    throw safeError('批处理账本包含禁止持久化的敏感或自由文本字段。');
  }
}

async function mapSettledLimited(values, maximum, operation) {
  const outcomes = new Array(values.length);
  let nextIndex = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        outcomes[index] = {
          status:'fulfilled',
          value:await operation(values[index], index),
        };
      } catch (reason) {
        outcomes[index] = { status:'rejected', reason };
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length:Math.min(maximum, values.length) },
    () => worker(),
  ));
  return outcomes.filter(Boolean);
}

function concurrencyActivity() {
  let active = 0;
  let peak = 0;
  return Object.freeze({
    enter:() => {
      active += 1;
      peak = Math.max(peak, active);
    },
    leave:() => {
      active -= 1;
      if (active < 0) throw safeError('并发活动计数失衡。');
    },
    peak:() => peak,
  });
}

function concurrencyLimiter(maximum, activity = null) {
  let active = 0;
  let peak = 0;
  let cancelled = null;
  const waiting = [];
  const idleWaiters = [];
  const settleIdle = () => {
    if (active === 0 && waiting.length === 0) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };
  const release = () => {
    active -= 1;
    if (!cancelled) waiting.shift()?.resolve();
    settleIdle();
  };
  return {
    peak:() => peak,
    drain:() => active === 0 && waiting.length === 0
      ? Promise.resolve()
      : new Promise((resolve) => idleWaiters.push(resolve)),
    cancel:(error) => {
      if (cancelled) return;
      cancelled = error instanceof Error ? error : safeError('批处理已取消。');
      for (const waiter of waiting.splice(0)) waiter.reject(cancelled);
      settleIdle();
    },
    async run(operation) {
      if (cancelled) throw cancelled;
      if (active >= maximum) await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      if (cancelled) throw cancelled;
      active += 1;
      peak = Math.max(peak, active);
      activity?.enter();
      try {
        return await operation();
      } finally {
        activity?.leave();
        release();
      }
    },
  };
}

function checksum(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

export function createPaperclipPaidBridge({
  apiBase,
  companyId,
  projectId,
  pluginId,
  config,
  authority,
  runsByRole,
  fetchImpl,
  replayOnly = false,
}) {
  const rates = validRates(config?.costRatesCents);
  const strictReplay = replayOnly === true;
  if (!strictReplay) {
    if (!authority?.sign) throw safeError('A君预算票据签发器不可用，Provider 未调用。');
    if (normalizePem(authority.publicKey) !== normalizePem(config?.budgetTicketPublicKey)) {
      throw safeError('A君预算票据私钥与已安装插件公钥不匹配，Provider 未调用。');
    }
  }
  let providerCalls = 0;
  let providerRequests = 0;

  const execute = async (toolName, operation, parameters, run) => {
    let routedParameters = parameters;
    if (!strictReplay) {
      const maximumCostCents = maximumPaidCost(operation, parameters, rates);
      const overview = await readJson(fetchImpl,
        `${apiBase}/api/companies/${encodeURIComponent(companyId)}/budgets/overview`,
      );
      let scopes;
      try {
        scopes = assertM5BudgetCoverage({
          overview,
          companyId,
          agentId:run.agentId,
          projectId,
          maximumCostCents,
        });
      } catch (error) {
        throw safeError(`${String(error?.message || 'Paperclip 公司、岗位或项目预算不足')} Provider 未调用。`);
      }
      const budgetTicket = authority.sign({
        run,
        actionId:parameters.actionId,
        operation,
        maximumCostCents,
        parameters,
        scopes,
      });
      routedParameters = { ...parameters, budgetTicket };
    }
    const routed = await writeJson(fetchImpl,
      `${apiBase}/api/plugins/tools/execute`,
      {
        tool:`${CONTENT_PLUGIN_KEY}:${toolName}`,
        parameters:routedParameters,
        runContext:run,
      },
      'Paperclip 内容插件执行结果不确定；禁止自动重放 Provider',
    );
    if (
      routed?.pluginId !== CONTENT_PLUGIN_KEY
      || routed?.toolName !== toolName
      || !routed?.result
    ) {
      throw safeError('Paperclip 返回了不匹配的内容插件工具回执。');
    }
    const result = routed.result;
    const costStatus = result?.data?.costCommit?.status;
    if (
      strictReplay
      && (
        result?.error
        || result?.data?.replayed !== true
        || result?.data?.nextStageAllowed !== true
        || costStatus !== 'confirmed'
        || result?.data?.actionId !== parameters.actionId
        || result?.data?.operation !== operation
      )
    ) {
      throw safeError(
        `replay-only 拒绝未确认、缺失或参数漂移的 action：${safeShortText(parameters.actionId, 180)}`,
        'replay_only_not_confirmed',
      );
    }
    const priorProviderCall = result?.data?.providerCallReplayed === true;
    if (result?.data?.replayed !== true && !priorProviderCall) {
      providerRequests += result?.data?.providerAttempts == null
        ? (result?.data?.callRecord ? 1 : 0)
        : nonNegativeInteger(
          result.data.providerAttempts,
          '插件返回的 Provider 请求次数无效。',
        );
      if (result?.data?.callRecord) providerCalls += 1;
    }
    if (result.error && costStatus !== 'pending_core_cost_event') {
      throw safeError(
        `内容插件执行失败（${safeShortText(parameters.actionId, 180)}）：${safeShortText(result.error, 300)}`,
      );
    }
    return result;
  };

  return {
    creatorTools:{
      image:(params, run) => execute('stepfun-image-generate', 'image_generate', params, run),
      tts:(params, run) => execute('stepfun-tts', 'tts', params, run),
    },
    analystTools:{
      vision:(params, run) => execute('stepfun-vision', 'vision', params, run),
    },
    providerCallCount:() => providerCalls,
    providerRequestCount:() => providerRequests,
    commitCost:(input) => {
      if (strictReplay) {
        if (
          input?.result?.data?.replayed !== true
          || input?.result?.data?.nextStageAllowed !== true
          || input?.result?.data?.costCommit?.status !== 'confirmed'
        ) {
          throw safeError(
            `replay-only 禁止为 action 创建或确认新费用：${safeShortText(input?.actionId, 180)}`,
            'replay_only_cost_claim_denied',
          );
        }
        return input.result;
      }
      return commitCoreCost({
        apiBase,
        companyId,
        pluginId,
        fetchImpl,
        ...input,
        run:runsByRole?.[input.role],
      });
    },
  };
}

async function commitCoreCost({
  apiBase,
  companyId,
  pluginId,
  run,
  actionId,
  result,
  fetchImpl,
}) {
  if (result?.data?.costCommit?.status === 'confirmed') return result;
  const providerCallReplayed = result?.data?.providerCallReplayed === true;
  if (result?.data?.costCommit?.status !== 'pending_core_cost_event') {
    throw safeError(`付费 action ${actionId} 缺少待提交费用事件。`);
  }
  const claimed = await pluginAction({
    fetchImpl,
    apiBase,
    pluginId,
    companyId,
    action:'cost-event-claim',
    params:{ actionId, runContext:run },
  });
  const commit = claimed?.data?.costCommit;
  if (commit?.status !== 'submitting_core_cost_event' || !UUID.test(String(commit.submissionId))) {
    throw safeError(`付费 action ${actionId} 没有返回有效费用提交租约。`);
  }
  const costEvent = validatedCostEvent(commit.costEvent, run);
  const created = await writeJson(fetchImpl,
    `${apiBase}/api/companies/${encodeURIComponent(companyId)}/cost-events`,
    costEvent,
    'Paperclip 费用提交结果不确定；禁止重放 Provider',
  );
  const costEventId = uuid(created?.id, 'Paperclip 没有返回有效费用事件 ID。');
  assertCreatedCostEvent(created, costEvent, run);
  const confirmed = await pluginAction({
    fetchImpl,
    apiBase,
    pluginId,
    companyId,
    action:'cost-event-confirm',
    params:{
      actionId,
      submissionId:commit.submissionId,
      costEventId,
      runContext:run,
    },
  });
  if (
    confirmed?.data?.costCommit?.status !== 'confirmed'
    || confirmed?.data?.nextStageAllowed !== true
  ) {
    throw safeError(`付费 action ${actionId} 的核心费用确认回执无效。`);
  }
  return providerCallReplayed
    ? {
      ...confirmed,
      data:{
        ...confirmed.data,
        providerCallReplayed:true,
      },
    }
    : confirmed;
}

async function verifyRoleContext({
  fetchImpl,
  apiBase,
  companyId,
  projectId,
  goalId,
  issueId,
  runId,
  expectedRole,
}) {
  const [run, issue, linked] = await Promise.all([
    readJson(fetchImpl, `${apiBase}/api/heartbeat-runs/${encodeURIComponent(runId)}`),
    readJson(fetchImpl, `${apiBase}/api/issues/${encodeURIComponent(issueId)}`),
    readJson(fetchImpl, `${apiBase}/api/heartbeat-runs/${encodeURIComponent(runId)}/issues`),
  ]);
  const agentId = uuid(run?.agentId, `${expectedRole} Run 缺少有效 Agent。`);
  const agent = await readJson(fetchImpl, `${apiBase}/api/agents/${encodeURIComponent(agentId)}`);
  if (
    run?.id !== runId
    || run?.companyId !== companyId
    || run?.status !== 'running'
    || issue?.id !== issueId
    || issue?.companyId !== companyId
    || issue?.projectId !== projectId
    || issue?.goalId !== goalId
    || issue?.assigneeAgentId !== agentId
    || agent?.companyId !== companyId
    || agent?.metadata?.agentArmyId !== expectedRole
    || !list(linked).some((item) => item?.issueId === issueId)
  ) {
    throw safeError(`${expectedRole} 的 Issue、active Run、Agent 或项目上下文不一致。`);
  }
  return { companyId, agentId, projectId, runId, status:'running' };
}

async function resolveWorkspace({
  fetchImpl,
  apiBase,
  companyId,
  plugin,
  requestedWorkspace,
}) {
  const status = await readJson(fetchImpl,
    `${apiBase}/api/plugins/${encodeURIComponent(plugin.id)}/companies/${encodeURIComponent(companyId)}/local-folders/content-workspace/status`,
  );
  if (!status?.healthy || !status?.writable || !status?.realPath) {
    throw safeError('Paperclip content-workspace 未处于健康可写状态。');
  }
  const configured = await fs.realpath(status.realPath);
  const requested = await fs.realpath(path.resolve(requestedWorkspace));
  if (configured !== requested) {
    throw safeError('--workspace 必须与 Paperclip content-workspace 完全一致。');
  }
  return requested;
}

async function resolveContentPlugin({ fetchImpl, apiBase, companyId }) {
  const plugins = await readJson(fetchImpl, `${apiBase}/api/plugins`);
  const plugin = list(plugins).find((item) => item?.pluginKey === CONTENT_PLUGIN_KEY);
  if (!plugin?.id || plugin?.status !== 'ready') {
    throw safeError('content-autonomy 插件未处于 ready。');
  }
  const record = await readJson(fetchImpl,
    `${apiBase}/api/plugins/${encodeURIComponent(plugin.id)}/config?companyId=${encodeURIComponent(companyId)}`,
  );
  const config = record?.configJson;
  validRates(config?.costRatesCents);
  if (
    !String(config?.budgetTicketPublicKey || '').includes('BEGIN PUBLIC KEY')
    || !Array.isArray(config?.officialTtsVoices)
    || !config.officialTtsVoices.includes(OFFICIAL_VOICE)
  ) {
    throw safeError('content-autonomy 插件缺少预算验签公钥或指定官方音色。');
  }
  return { ...plugin, config };
}

async function secureDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(segment)) throw safeError('受控工作区子目录名称无效。');
    const candidate = path.join(current, segment);
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError('受控工作区子目录不是普通目录。');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await fs.mkdir(candidate, { mode:0o700 });
    }
    const real = await fs.realpath(candidate);
    if (!real.startsWith(`${root}${path.sep}`)) throw safeError('受控工作区子目录发生符号链接逃逸。');
    current = real;
  }
  return current;
}

async function assertExistingPrivateKey(file) {
  const absolute = path.resolve(required(file, '--budget-private-key-file 缺失。'));
  const stat = await fs.lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') throw safeError('预算票据私钥不存在；禁止自动创建。');
    throw error;
  });
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw safeError('预算票据私钥必须是当前用户持有的 0600 普通文件。');
  }
  return absolute;
}

function createNarrationProbe(workspaceRoot) {
  return async (relativePath) => {
    const target = path.resolve(workspaceRoot, String(relativePath || ''));
    const real = await fs.realpath(target).catch(() => {
      throw safeError('旁白音频产物不存在。');
    });
    if (!real.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw safeError('旁白音频通过符号链接逃逸受控工作区。');
    }
    const stat = await fs.lstat(real);
    if (!stat.isFile() || stat.isSymbolicLink()) throw safeError('旁白音频不是普通文件。');
    let probe;
    try {
      const output = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels',
        '-of', 'json',
        real,
      ], { timeout:30_000, maxBuffer:1_000_000 });
      probe = JSON.parse(output.stdout);
      await execFileAsync('ffmpeg', [
        '-v', 'error',
        '-i', real,
        '-map', '0:a:0',
        '-f', 'null',
        '-',
      ], { timeout:120_000, maxBuffer:1_000_000 });
    } catch {
      throw safeError('旁白音频无法被 ffprobe/FFmpeg 完整读取或解码。');
    }
    const stream = list(probe?.streams).find((item) => item?.codec_type === 'audio');
    return {
      durationSeconds:Number(probe?.format?.duration),
      codec:String(stream?.codec_name || ''),
      sampleRate:Number(stream?.sample_rate),
      channels:Number(stream?.channels),
    };
  };
}

async function atomicJson(file, value) {
  const parent = await fs.realpath(path.dirname(file));
  const temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode:0o600,
    flag:'wx',
  });
  await fs.rename(temporary, file);
}

export async function readAndArchivePriorLedger(batchRoot) {
  const root = await fs.realpath(batchRoot);
  const ledgerFile = path.join(root, 'ledger.json');
  let stat;
  try {
    stat = await fs.lstat(ledgerFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { recoveryFrom:null, priorLifetimeProviderCalls:0, archivedFile:null };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw safeError('既有批处理账本不是普通文件，拒绝恢复。');
  }
  const bytes = await fs.readFile(ledgerFile);
  let prior;
  try {
    prior = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw safeError('既有批处理账本不是有效 JSON，拒绝恢复。');
  }
  assertRedactedLedger(prior);
  if (prior.status !== 'failed') {
    const recoveryFrom = normalizeRecoveryFrom(prior.recoveryFrom);
    return {
      recoveryFrom,
      priorLifetimeProviderCalls:nonNegativeInteger(
        prior.lifetimeProviderCalls ?? prior.totalProviderCalls ?? 0,
        '既有成功账本的 Provider 调用数无效。',
      ),
      archivedFile:null,
    };
  }

  const checksumValue = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const checksumHex = checksumValue.slice('sha256:'.length);
  const archiveFile = `ledger.failed.${checksumHex}.json`;
  const archivePath = path.join(root, archiveFile);
  try {
    await fs.writeFile(archivePath, bytes, { flag:'wx', mode:0o600 });
    await fs.chmod(archivePath, 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const [archiveStat, archived] = await Promise.all([
      fs.lstat(archivePath),
      fs.readFile(archivePath),
    ]);
    if (
      !archiveStat.isFile()
      || archiveStat.isSymbolicLink()
      || (archiveStat.mode & 0o777) !== 0o600
      || !archived.equals(bytes)
    ) {
      throw safeError('既有失败账本归档冲突，拒绝覆盖。');
    }
  }
  const recoveryFrom = normalizeRecoveryFrom({
    checksum:checksumValue,
    providerCalls:nonNegativeInteger(
      prior.totalProviderCalls,
      '既有失败账本的 Provider 调用数无效。',
    ),
    code:String(prior.failure?.code || ''),
    ttsRevision:String(prior.ttsTransportRevision || 'unrecorded'),
    archiveFile,
  });
  return {
    recoveryFrom,
    priorLifetimeProviderCalls:nonNegativeInteger(
      prior.lifetimeProviderCalls ?? prior.totalProviderCalls,
      '既有失败账本的累计 Provider 调用数无效。',
    ),
    archivedFile:archiveFile,
  };
}

async function pluginAction({
  fetchImpl,
  apiBase,
  pluginId,
  companyId,
  action,
  params,
}) {
  const response = await writeJson(fetchImpl,
    `${apiBase}/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(action)}`,
    { companyId, params },
    `Paperclip 内容插件费用动作 ${action} 结果不确定`,
  );
  if (!response?.data || typeof response.data !== 'object') {
    throw safeError(`Paperclip 内容插件费用动作 ${action} 回执无效。`);
  }
  return response.data;
}

function maximumPaidCost(operation, parameters, rates) {
  let value;
  if (operation === 'image_generate') {
    value = Number(rates.imagePerGeneration);
  } else if (operation === 'tts') {
    value = String(parameters?.text || '').length
      * Number(rates.ttsPerThousandCharacters) / 1000;
  } else if (operation === 'vision') {
    value = (
      VISION_MAX_INPUT_TOKENS * Number(rates.visionInputPerMillionTokens)
      + VISION_MAX_OUTPUT_TOKENS * Number(rates.visionOutputPerMillionTokens)
    ) / 1_000_000;
  } else {
    throw safeError(`不支持的 StepFun 付费操作：${operation}。`);
  }
  const maximum = Math.ceil(value);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw safeError(`StepFun ${operation} 没有有效费率，Provider 未调用。`);
  }
  return maximum;
}

function validRates(value) {
  const fields = [
    'visionInputPerMillionTokens',
    'visionOutputPerMillionTokens',
    'imagePerGeneration',
    'ttsPerThousandCharacters',
  ];
  if (
    !value
    || fields.some((field) => !Number.isFinite(value[field]) || value[field] < 0)
    || fields.every((field) => value[field] === 0)
  ) {
    throw safeError('无法从已安装插件读取有效 StepFun 费率，Provider 未调用。');
  }
  return value;
}

function normalizePem(value) {
  return String(value || '').replaceAll('\r\n', '\n').trim();
}

function validatedCostEvent(value, run) {
  if (
    !run
    || !value
    || typeof value !== 'object'
    || value.agentId !== run.agentId
    || value.projectId !== run.projectId
    || value.heartbeatRunId !== run.runId
    || value.provider !== 'stepfun'
    || value.biller !== 'stepfun'
    || value.billingType !== 'metered_api'
    || !String(value.billingCode || '').startsWith('m5:')
    || !String(value.model || '').trim()
    || !Number.isInteger(value.costCents)
    || value.costCents <= 0
    || Number.isNaN(Date.parse(value.occurredAt))
  ) {
    throw safeError('费用事件与当前 Paperclip 运行不一致，禁止记账。');
  }
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens']) {
    if (!Number.isInteger(value[field]) || value[field] < 0) {
      throw safeError('费用事件 Token 用量无效，禁止记账。');
    }
  }
  return {
    agentId:value.agentId,
    projectId:value.projectId,
    heartbeatRunId:value.heartbeatRunId,
    provider:value.provider,
    biller:value.biller,
    billingType:value.billingType,
    billingCode:value.billingCode,
    model:value.model,
    inputTokens:value.inputTokens,
    cachedInputTokens:value.cachedInputTokens,
    outputTokens:value.outputTokens,
    costCents:value.costCents,
    occurredAt:value.occurredAt,
  };
}

function assertCreatedCostEvent(created, expected, run) {
  if (
    created?.agentId !== run.agentId
    || created?.projectId !== run.projectId
    || created?.heartbeatRunId !== run.runId
    || created?.provider !== expected.provider
    || created?.model !== expected.model
    || created?.billingCode !== expected.billingCode
    || created?.costCents !== expected.costCents
  ) {
    throw safeError('Paperclip 费用回执与提交内容不一致；插件保持未确认，禁止继续。');
  }
}

async function readJson(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { headers:{ accept:'application/json' } });
  } catch {
    throw safeError(`Paperclip GET ${new URL(url).pathname} 未完成。`);
  }
  if (!response?.ok) throw safeError(`Paperclip GET ${new URL(url).pathname} 返回 HTTP ${response?.status || 'unknown'}。`);
  return response.json();
}

async function writeJson(fetchImpl, url, body, message) {
  let response;
  try {
    response = await fetchImpl(url, {
      method:'POST',
      headers:{ accept:'application/json', 'content-type':'application/json' },
      body:JSON.stringify(body),
    });
  } catch {
    throw safeError(`${message}：网络请求未完成。`);
  }
  if (!response?.ok) throw safeError(`${message}：HTTP ${response?.status || 'unknown'}。`);
  return response.json();
}

function list(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function loopbackBase(value) {
  const url = new URL(String(value || ''));
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/'
  ) {
    throw safeError('--api-base 只允许本机 Paperclip HTTP 地址。');
  }
  return url.toString().replace(/\/$/, '');
}

function parseArgs(args) {
  const allowed = new Set([
    'api-base',
    'company-id',
    'project-id',
    'goal-id',
    'creator-issue-id',
    'creator-run-id',
    'analyst-issue-id',
    'analyst-run-id',
    'budget-private-key-file',
    'workspace',
    'batch-version',
    'tts-transport-revision',
    'confirm-paid',
    'replay-only',
  ]);
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    const key = item.startsWith('--') ? item.slice(2) : '';
    if (key === 'replay-only') {
      if (key in result) throw safeError(`参数无效：${item || '(empty)'}。`);
      result[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || key in result) {
      throw safeError(`参数无效：${item || '(empty)'}。`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function actionVersion(value) {
  const version = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{2,24}$/.test(version)) throw safeError('--batch-version 格式无效。');
  return version;
}

function normalizeRecoveryFrom(value) {
  if (value == null) return null;
  const result = {
    checksum:String(value.checksum || ''),
    providerCalls:nonNegativeInteger(value.providerCalls, '恢复来源的 Provider 调用数无效。'),
    code:String(value.code || ''),
    ttsRevision:String(value.ttsRevision || ''),
    archiveFile:String(value.archiveFile || ''),
  };
  if (
    !/^sha256:[a-f0-9]{64}$/.test(result.checksum)
    || !/^[a-z0-9_-]{2,80}$/i.test(result.code)
    || !/^[A-Za-z0-9_-]{2,24}$/.test(result.ttsRevision)
    || !/^ledger\.failed\.[a-f0-9]{64}\.json$/.test(result.archiveFile)
  ) {
    throw safeError('恢复来源账本血缘无效。');
  }
  return result;
}

function nonNegativeInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw safeError(message);
  return number;
}

function uuid(value, message) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw safeError(message);
  return id;
}

function required(value, message) {
  const text = String(value || '').trim();
  if (!text) throw safeError(message);
  return text;
}

function safeError(message, code = 'safe_batch_error') {
  const error = new Error(message);
  error.name = 'SafeBatchError';
  error.code = code;
  return error;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const replayOnly = options['replay-only'] === true;
    if (replayOnly && ('confirm-paid' in options || 'budget-private-key-file' in options)) {
      throw safeError('replay-only 禁止 --confirm-paid 和 --budget-private-key-file。');
    }
    if (!replayOnly && options['confirm-paid'] !== CONFIRMATION) {
      throw safeError(`真实调用未执行：必须显式传入 --confirm-paid ${CONFIRMATION}`);
    }
    const apiBase = loopbackBase(options['api-base'] || 'http://127.0.0.1:3100');
    const companyId = uuid(options['company-id'], '--company-id 必须是 UUID。');
    const projectId = uuid(options['project-id'], '--project-id 必须是 UUID。');
    const goalId = uuid(options['goal-id'], '--goal-id 必须是 UUID。');
    const creatorIssueId = uuid(options['creator-issue-id'], '--creator-issue-id 必须是 UUID。');
    const creatorRunId = uuid(options['creator-run-id'], '--creator-run-id 必须是 UUID。');
    const analystIssueId = uuid(options['analyst-issue-id'], '--analyst-issue-id 必须是 UUID。');
    const analystRunId = uuid(options['analyst-run-id'], '--analyst-run-id 必须是 UUID。');
    const privateKeyFile = replayOnly
      ? null
      : await assertExistingPrivateKey(options['budget-private-key-file']);
    const requestedWorkspace = required(options.workspace, '--workspace 缺失。');
    const batchVersion = actionVersion(options['batch-version'] || 'v1');
    const ttsTransportRevision = actionVersion(
      options['tts-transport-revision'] || DEFAULT_TTS_TRANSPORT_REVISION,
    );
    const fetchImpl = fetch;

    const [creatorRun, analystRun, plugin, authority] = await Promise.all([
      verifyRoleContext({
        fetchImpl, apiBase, companyId, projectId, goalId,
        issueId:creatorIssueId,
        runId:creatorRunId,
        expectedRole:'content-creator',
      }),
      verifyRoleContext({
        fetchImpl, apiBase, companyId, projectId, goalId,
        issueId:analystIssueId,
        runId:analystRunId,
        expectedRole:'video-content-analyst',
      }),
      resolveContentPlugin({ fetchImpl, apiBase, companyId }),
      replayOnly ? null : LocalBudgetTicketAuthority.open(privateKeyFile),
    ]);
    const workspaceRoot = await resolveWorkspace({
      fetchImpl,
      apiBase,
      companyId,
      plugin,
      requestedWorkspace,
    });

    const batchRoot = await secureDirectory(workspaceRoot, ['provider', '7-theme', batchVersion]);
    for (const current of SEVEN_THEMES) {
      await secureDirectory(batchRoot, [current.id]);
    }
    const priorLedger = await readAndArchivePriorLedger(batchRoot);
    const bridge = createPaperclipPaidBridge({
      apiBase,
      companyId,
      projectId,
      pluginId:plugin.id,
      config:plugin.config,
      authority,
      replayOnly,
      runsByRole:{
        'content-creator':creatorRun,
        'video-content-analyst':analystRun,
      },
      fetchImpl,
    });

    const ledger = await executeSevenThemeBatch({
      batchVersion,
      ttsTransportRevision,
      replayOnly,
      recoveryFrom:priorLedger.recoveryFrom,
      priorLifetimeProviderCalls:priorLedger.priorLifetimeProviderCalls,
      creatorTools:bridge.creatorTools,
      analystTools:bridge.analystTools,
      creatorRun,
      analystRun,
      creatorIssueId,
      analystIssueId,
      goalId,
      providerCallCount:bridge.providerCallCount,
      providerRequestCount:bridge.providerRequestCount,
      commitCost:bridge.commitCost,
      probeNarration:createNarrationProbe(workspaceRoot),
      writeLedger:(value) => atomicJson(path.join(batchRoot, 'ledger.json'), value),
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion:ledger.schemaVersion,
      batchVersion:ledger.batchVersion,
      ttsTransportRevision:ledger.ttsTransportRevision,
      themeCount:ledger.themeCount,
      totalProviderCalls:ledger.totalProviderCalls,
      totalProviderRequests:ledger.totalProviderRequests,
      expectedNewProviderCalls:ledger.expectedNewProviderCalls,
      confirmedReplay:ledger.confirmedReplay,
      pendingCostRecovery:ledger.pendingCostRecovery,
      replayProviderCalls:ledger.replay.providerCalls,
      ledgerPath:path.relative(workspaceRoot, path.join(batchRoot, 'ledger.json')),
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'StepFun 7主题批处理失败。'}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) await main();
