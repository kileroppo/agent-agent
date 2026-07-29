import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class HermesContentGrowthAdvisor {
  constructor({
    command = process.env.AJUN_HERMES_COMMAND || '/Users/pengaro/.local/bin/hermes',
    hermesHome = '',
    timeoutMs = 240_000,
    run = runCommand,
    nowMs = () => Date.now()
  } = {}) {
    this.command = command;
    this.hermesHome = hermesHome;
    this.timeoutMs = timeoutMs;
    this.run = run;
    this.nowMs = nowMs;
  }

  async analyze({ title, transcript, depth, evidenceMode, focus, sourceMetadata = null, visualEvidence = null, priorRuntimeMs = 0, validate = null } = {}) {
    if (!this.hermesHome) return null;
    const full = depth === 'full';
    const totalRuntimeMs = full ? 720_000 : 300_000;
    const maxRuntimeMs = Math.max(0, totalRuntimeMs - Math.max(0, Number(priorRuntimeMs) || 0));
    const storyboardPaths = Array.isArray(visualEvidence?.storyboards)
      ? visualEvidence.storyboards.map((item) => String(item?.filePath || '')).filter(Boolean).slice(0, 4)
      : [];
    return this.invokeWithBudget(
      analysisPrompt({ title, transcript, depth, evidenceMode, focus, sourceMetadata, visualEvidence, storyboardPaths }),
      {
        maxAttempts:2,
        maxRuntimeMs,
        perAttemptMs:full ? Math.min(this.timeoutMs, 360_000) : Math.min(this.timeoutMs, 120_000),
        validate,
        toolsets:storyboardPaths.length ? 'vision' : ''
      }
    );
  }

  async draft({ title, contentGoal, platforms, transcript, analysis } = {}) {
    if (!this.hermesHome) return null;
    return this.invokeWithBudget(
      draftPrompt({ title, contentGoal, platforms, transcript, analysis }),
      {
        maxAttempts:2,
        maxRuntimeMs:300_000,
        perAttemptMs:Math.min(this.timeoutMs, 150_000)
      }
    );
  }

  async scriptPackage({ topic, platform, durationSeconds, reference, research, validate = null } = {}) {
    if (!this.hermesHome) return null;
    return this.invokeWithBudget(
      scriptPackagePrompt({ topic, platform, durationSeconds, reference, research }),
      {
        maxAttempts:2,
        maxRuntimeMs:300_000,
        perAttemptMs:Math.min(this.timeoutMs, 150_000),
        validate
      }
    );
  }

  async invokeWithBudget(prompt, { maxAttempts, maxRuntimeMs, perAttemptMs, validate = null, toolsets = '' }) {
    const startedAt = this.nowMs();
    let attempts = 0;
    let usage = null;
    let lastError = null;
    let lastInvalidData = null;
    while (attempts < maxAttempts) {
      const elapsedMs = Math.max(0, this.nowMs() - startedAt);
      const remainingMs = maxRuntimeMs - elapsedMs;
      if (remainingMs <= 0) break;
      attempts += 1;
      try {
        const result = await this.invoke(prompt, Math.max(1, Math.min(perAttemptMs, remainingMs)), { toolsets });
        if (typeof validate === 'function' && validate(result.data) !== true) {
          const invalid = new Error('Hermes 内容结果未通过证据结构校验。');
          invalid.code = 'content_analysis_semantic_validation_failed';
          invalid.usage = result.usage;
          invalid.data = result.data;
          throw invalid;
        }
        return {
          ...result,
          usage:mergeUsage(usage, result.usage),
          executionBudget:{ attempts, maxAttempts, maxRuntimeMs, exhausted:false }
        };
      } catch (error) {
        usage = mergeUsage(usage, error?.usage);
        if (error?.code === 'content_analysis_semantic_validation_failed' && error?.data) {
          lastInvalidData = error.data;
        }
        lastError = error;
      }
    }
    const failure = lastError instanceof Error ? lastError : new Error('Hermes 内容执行预算已耗尽。');
    failure.usage = usage;
    if (!failure.data && lastInvalidData) failure.data = lastInvalidData;
    failure.executionBudget = {
      attempts,
      maxAttempts,
      maxRuntimeMs,
      exhausted:attempts >= maxAttempts || this.nowMs() - startedAt >= maxRuntimeMs
    };
    throw failure;
  }

  async invoke(prompt, timeoutMs, { toolsets = '' } = {}) {
    const usageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-usage-'));
    const usagePath = path.join(usageDirectory, 'usage.json');
    try {
      const args = ['--ignore-rules', '--usage-file', usagePath];
      if (toolsets) args.push('--toolsets', toolsets);
      args.push('--oneshot', prompt);
      const output = await this.run(this.command, args, {
        timeoutMs,
        env:{ ...process.env, HERMES_HOME:this.hermesHome }
      });
      return {
        data:parseJson(output),
        usage:await readUsage(usagePath)
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.usage = await readUsage(usagePath);
      throw failure;
    } finally {
      await fs.rm(usageDirectory, { recursive:true, force:true });
    }
  }
}

function analysisPrompt({ title, transcript, depth, evidenceMode, focus, sourceMetadata, visualEvidence, storyboardPaths }) {
  const modules = depth === 'full'
    ? ['基本信息', '标题诊断', '开头诊断', '爆点拆解', '全文逐句作用拆解', '结构分析', '话术技巧与文字洁癖', '表达效率检测', '认知落差检测', '素材盘点', 'AI辅助创作建议', '可模仿点 Top3', '爆款结构模板']
    : ['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'];
  return [
    storyboardPaths.length
      ? '你是小拆的受控图文分析执行器。只根据给定转录、来源信息和受控故事板分析，不访问网络；只允许调用 vision_analyze 读取列出的故事板，不得调用其他工具。'
      : '你是小拆的受控分析执行器。只根据给定转录分析，不访问网络，不调用工具，不补充外部事实。',
    '每个模块必须使用转录中逐字存在的 fragment；能识别时间点时同时填写 timestamp，缺失时填 null。',
    storyboardPaths.length
      ? '必须逐张读取故事板。画面判断只能写入 visualFindings，并引用关键帧目录中逐字存在的 frameId 与完全一致的 timestamp；不得仅凭字幕猜测镜头、字幕样式、人物、动作、场景、剪辑或节奏。完整模式至少给出 5 项、覆盖至少 3 种 category；快速模式至少给出 3 项、覆盖至少 2 种 category。没有证据的类别宁可不写，不得为了凑类别编造。'
      : '没有提供画面证据，visualFindings 必须返回空数组，不得猜测镜头、人物、字幕样式或剪辑。',
    depth === 'full'
      ? '每个模块必须同时包含 originalAnalysis、diagnosis、optimization 三个非空数组；每项判断都要带 evidence。给定转录已整理为最多 30 个连续证据段落；全文逐句作用拆解必须让 sentenceBreakdown 逐项覆盖每个段落且不遗漏，逐项格式为 {"original":"段落原文","role":"作用","explanation":"解释","evidence":{"timestamp":"00:00或null","fragment":"与该段落逐字一致的完整原文"}}。'
      : '快速模式每个模块包含 finding、evidence 和 confidence。',
    'modules 必须按“必须覆盖模块”的顺序逐项输出，不得改名、合并或遗漏。',
    '只输出单行 JSON：{"summary":"摘要","modules":[{"name":"模块","finding":"判断","originalAnalysis":[{"claim":"原文分析","evidence":{"timestamp":"00:00或null","fragment":"原文"}}],"diagnosis":[{"issue":"问题","severity":"high|medium|low","evidence":{"timestamp":"00:00或null","fragment":"原文"}}],"optimization":[{"action":"具体改法","evidence":{"timestamp":"00:00或null","fragment":"原文"}}],"evidence":{"timestamp":"00:00或null","fragment":"原文"},"confidence":"high|medium|low"}],"visualFindings":[{"category":"opening_visual_hook|shot_and_pacing|captions_and_graphics|people_objects_scenes|reusable_visual_pattern","finding":"只描述可见事实及其内容作用","evidence":{"timestamp":"与帧目录完全一致","frameRef":"frame-001"},"confidence":"high|medium|low"}],"reusablePatterns":["模式"],"actionItems":["行动"]}。',
    depth === 'full'
      ? '“全文逐句作用拆解”对应的模块对象必须在上述字段之外实际包含 "sentenceBreakdown":[{"original":"完整证据段落原文","role":"作用","explanation":"解释","evidence":{"timestamp":null,"fragment":"完整证据段落原文"}}]，不得只在 finding 中声称已覆盖。'
      : '',
    `必须覆盖模块：${JSON.stringify(modules)}`,
    `标题：${JSON.stringify(clean(title, 300))}`,
    `证据模式：${JSON.stringify(evidenceMode)}`,
    `分析重点：${JSON.stringify(clean(focus, 300))}`,
    `真实来源信息：${JSON.stringify(sourceMetadata || {})}`,
    `关键帧目录：${JSON.stringify((visualEvidence?.frames || []).map((frame) => ({ frameId:frame.frameId, timestamp:frame.timestamp, reason:frame.reason })))}`,
    `受控故事板路径：${JSON.stringify(storyboardPaths)}`,
    `转录：${JSON.stringify(String(transcript || '').slice(0, 80_000))}`
  ].join('\n');
}

function draftPrompt({ title, contentGoal, platforms, transcript, analysis }) {
  return [
    '你是小创的受控草稿执行器。只根据已通过系统质量门禁或真人听审的确认稿和正式分析写草稿，不访问平台、不发布、不新增事实或承诺流量。',
    '每个平台必须包含 titleCandidates、opening、body、pacing、adaptation、evidence、humanChecklist。evidence 只能引用确认稿原文。',
    '只输出一个 JSON 数组，数组顺序与目标平台一致，不能增加平台。',
    `标题：${JSON.stringify(clean(title, 300))}`,
    `内容目标：${JSON.stringify(clean(contentGoal, 500))}`,
    `目标平台：${JSON.stringify(platforms)}`,
    `正式分析：${JSON.stringify(analysis).slice(0, 30_000)}`,
    `已确认转录稿：${JSON.stringify(String(transcript || '').slice(0, 80_000))}`
  ].join('\n');
}

function scriptPackagePrompt({ topic, platform, durationSeconds, reference, research }) {
  return [
    '你是小创的可拍短视频脚本执行器。用户只需要一版主方案，不要给模板选择题，不要解释内部 Agent、文件或任务系统。',
    '先用第一性原理和对抗式检查修正脚本：开场三秒是否值得继续看、观点是否成立、是否有空话、是否像真实口播、是否能实际拍摄、是否复制参考视频的独特表达。',
    '只能复用参考内容的结构作用，不能复制原句、身份、案例、数字和结果承诺。公开资料没有支持的事实不得写入脚本；资料不足时改写为观点或方法，不要编造。',
    '只输出 JSON：{"headline":"标题","platform":"平台","durationSeconds":45,"aspectRatio":"9:16","audience":"受众","hook":"三秒钩子","fullScript":"完整口播稿，至少80字","shootingNotes":["拍摄提示"],"shots":[{"startSeconds":0,"endSeconds":5,"narration":"台词","visual":"画面"}],"qualityReview":{"factuality":"事实检查","imitation":"模仿边界","shootability":"可拍性","unresolved":[]},"structure":["开场","展开","收束"]}。',
    `主题：${JSON.stringify(String(topic || '').slice(0, 1000))}`,
    `平台与时长：${JSON.stringify({ platform, durationSeconds })}`,
    `参考结构：${JSON.stringify(reference || null).slice(0, 12_000)}`,
    `最多三条公开资料：${JSON.stringify(research || null).slice(0, 12_000)}`
  ].join('\n');
}

function parseJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

function runCommand(command, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout:timeoutMs, maxBuffer:512 * 1024, env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function readUsage(usagePath) {
  try {
    const payload = JSON.parse(await fs.readFile(usagePath, 'utf8'));
    const inputTokens = nonNegativeInteger(payload.input_tokens);
    const outputTokens = nonNegativeInteger(payload.output_tokens);
    const apiCalls = nonNegativeInteger(payload.api_calls);
    const estimatedCost = Number(payload.estimated_cost_usd);
    return {
      model:{
        provider:clean(payload.provider, 80),
        model:clean(payload.model, 120),
        ...(inputTokens !== null ? { inputTokens } : {}),
        ...(outputTokens !== null ? { outputTokens } : {}),
        ...(apiCalls !== null ? { apiCalls } : {}),
        ...(Number.isFinite(estimatedCost) && estimatedCost >= 0 ? { cost:{ amount:estimatedCost, currency:'USD' } } : {})
      }
    };
  } catch {
    return null;
  }
}

function clean(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function mergeUsage(left, right) {
  const first = left?.model;
  const second = right?.model;
  if (!first && !second) return null;
  const base = second || first;
  const inputTokens = sumDefined(first?.inputTokens, second?.inputTokens);
  const outputTokens = sumDefined(first?.outputTokens, second?.outputTokens);
  const apiCalls = sumDefined(first?.apiCalls, second?.apiCalls);
  const firstCost = first?.cost?.currency === 'USD' ? Number(first.cost.amount) : null;
  const secondCost = second?.cost?.currency === 'USD' ? Number(second.cost.amount) : null;
  const costAmount = sumDefined(
    Number.isFinite(firstCost) ? firstCost : null,
    Number.isFinite(secondCost) ? secondCost : null
  );
  return {
    model:{
      provider:clean(base?.provider, 80),
      model:clean(base?.model, 120),
      ...(inputTokens !== null ? { inputTokens } : {}),
      ...(outputTokens !== null ? { outputTokens } : {}),
      ...(apiCalls !== null ? { apiCalls } : {}),
      ...(costAmount !== null ? { cost:{ amount:costAmount, currency:'USD' } } : {})
    }
  };
}

function sumDefined(left, right) {
  const values = [left, right].filter((value) => Number.isFinite(value) && value >= 0);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}
