import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { M5_STEPFUN_MODELS } from '@agent-army/m5-contracts';
import { coded, safeRelativePath, sha256 } from './policy.js';
import {
  callRecord,
  costForImage,
  costForTts,
  costForVision,
  reportCostMetric
} from './call-record.js';
import { requirePaperclipSecretRef } from './secret-ref.js';
import { reservePaidToolBudget } from './paid-budget-guard.js';

const MODELS = Object.freeze({
  vision:M5_STEPFUN_MODELS.vision,
  image:M5_STEPFUN_MODELS.image_generate,
  tts:M5_STEPFUN_MODELS.tts,
});
const VISION_MAX_INPUT_TOKENS = 128_000;
const VISION_MAX_OUTPUT_TOKENS = 4_096;
const MAX_IMAGE_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_TTS_OUTPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 6_500;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const LEGACY_RATE_LIMIT_INCIDENT = 'm5v1-20260730-stepfun-429';
const LEGACY_RATE_LIMIT_ACTIONS = Object.freeze({
  'm5_7theme_14beee9d_t03-evidence-chain_image1_m5v1':{
    runId:'e8a85c3c-7de4-49ec-b845-3ac5e063e542',
    errorCode:'stepfun_request_failed',
    stateChecksum:'sha256:44f3005adffc50206df0e146f534b8d5a445fe8d4e9029ad4c1f22f20ce17ef6',
    parameterChecksum:'sha256:b094fe35baf9b510a0d00ab34c5108497e4f3a1756111f5b7478821304ace4c5',
  },
  'm5_7theme_14beee9d_t03-evidence-chain_tts-paperclip-b64-v1_m5v1':{
    runId:'e8a85c3c-7de4-49ec-b845-3ac5e063e542',
    errorCode:'stepfun_tts_failed',
    stateChecksum:'sha256:9d5b3f6753120f57ede66b17b063fb976335c0209f43b2443b66c585eb3cf274',
    parameterChecksum:'sha256:5de4c0932234f0f5d0741dde5c2ebddf91668c36196495c9d90472393b338884',
  },
});

export class StepFunContentTools {
  constructor({
    ctx,
    paidBudgetChecker = null,
    minRequestIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
    maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
    random = Math.random,
    legacyRateLimitActions = LEGACY_RATE_LIMIT_ACTIONS,
  }) {
    this.ctx = ctx;
    this.paidBudgetChecker = paidBudgetChecker;
    this.inflight = new Map();
    this.legacyRateLimitActions = legacyRateLimitActions;
    this.rateLimit = {
      minRequestIntervalMs:nonnegativeInteger(minRequestIntervalMs),
      maxRateLimitRetries:nonnegativeInteger(maxRateLimitRetries),
      maxRetryDelayMs:nonnegativeInteger(maxRetryDelayMs),
      sleep,
      now,
      random,
      lastStartedAt:new Map(),
      tails:new Map(),
    };
  }

  async vision(params, run) {
    const { root, absolute } = await this.inputPath(run.companyId, params.relativePath);
    const bytes = await fs.readFile(absolute);
    if (bytes.length > 12 * 1024 * 1024) throw coded('image_too_large', '视觉输入图片超过 12MB。');
    const detectedMime = detectImageMime(bytes);
    const declaredMime = imageMimeFromPath(absolute);
    if (!detectedMime || detectedMime !== declaredMime) {
      throw coded('invalid_image_mime', '视觉输入只允许内容与扩展名一致的 PNG、JPEG 或 WebP。');
    }
    const config = await this.config();
    this.assertBillableRate('vision', config.costRatesCents);
    const maximumCostCents = Math.ceil(
      (
        VISION_MAX_INPUT_TOKENS * Number(config.costRatesCents.visionInputPerMillionTokens)
        + VISION_MAX_OUTPUT_TOKENS * Number(config.costRatesCents.visionOutputPerMillionTokens)
      ) / 1_000_000,
    );
    return this.paidAction(params, run, 'vision', maximumCostCents, async () => {
      const requested = await this.request(config, '/chat/completions', {
        model:MODELS.vision,
        max_tokens:VISION_MAX_OUTPUT_TOKENS,
        messages:[{
          role:'user',
          content:[
            { type:'text', text:String(params.prompt) },
            { type:'image_url', image_url:{ url:`data:${detectedMime};base64,${bytes.toString('base64')}` } }
          ]
        }]
      }, 'reasoning');
      const response = requested.payload;
      if (!response?.usage || (!Number.isFinite(response.usage.prompt_tokens) && !Number.isFinite(response.usage.completion_tokens))) {
        throw coded('stepfun_usage_missing', 'StepFun 视觉响应缺少可计费 usage；本次 action 进入歧义状态，禁止自动重放。');
      }
      const record = callRecord({
        run,
        actionId:params.actionId,
        model:MODELS.vision,
        operation:'vision',
        prompt:params.prompt,
        inputs:[{ relativePath:path.relative(root, absolute), checksum:sha256(bytes) }],
        usage:{
          inputTokens:response?.usage?.prompt_tokens,
          cachedInputTokens:response?.usage?.prompt_tokens_details?.cached_tokens,
          outputTokens:response?.usage?.completion_tokens
        },
        costCents:costForVision(response?.usage, config.costRatesCents)
      });
      const costReporting = await reportCostMetric(this.ctx, record);
      return {
        content:'视觉证据已生成。',
        data:{
          model:MODELS.vision,
          sourcePath:path.relative(root, absolute),
          sourceChecksum:sha256(bytes),
          observation:response?.choices?.[0]?.message?.content || '',
          callRecord:record,
          providerAttempts:requested.providerAttempts,
          rateLimitRejections:requested.rateLimitRejections,
          costReporting,
          nextStageAllowed:false,
          costCommit:{ status:'pending_core_cost_event', costEvent:record.costEvent }
        }
      };
    });
  }

  async image(params, run) {
    assertImageOutputPath(params.outputPath);
    const config = await this.config();
    this.assertBillableRate('image_generate', config.costRatesCents);
    const maximumCostCents = Math.ceil(costForImage(config.costRatesCents));
    return this.paidAction(params, run, 'image_generate', maximumCostCents, async () => {
      const requested = await this.request(config, '/images/generations', {
        model:MODELS.image,
        prompt:String(params.prompt),
        response_format:'b64_json',
        size:'1360x768',
        cfg_scale:1,
        steps:8,
        seed:Number.isInteger(params.seed) ? params.seed : 0,
        text_mode:params.textMode === true
      }, 'media');
      const encoded = requested.payload?.data?.[0]?.b64_json;
      if (!encoded) throw coded('stepfun_image_empty', 'StepFun 没有返回图片数据。');
      const bytes = providerBase64Bytes(
        encoded,
        'stepfun_image_invalid',
        'StepFun 返回的图片 Base64 无效。',
      );
      assertProviderImage(bytes, params.outputPath);
      const output = await this.writeBinary(run.companyId, params.outputPath, bytes);
      const record = callRecord({
        run,
        actionId:params.actionId,
        model:MODELS.image,
        operation:'image_generate',
        prompt:params.prompt,
        seed:Number.isInteger(params.seed) ? params.seed : 0,
        outputs:[{ relativePath:output.relativePath, checksum:output.checksum, bytes:output.bytes }],
        costCents:costForImage(config.costRatesCents)
      });
      const costReporting = await reportCostMetric(this.ctx, record);
      return {
        content:'图片已写入受控内容工作区。',
        data:{
          model:MODELS.image,
          seed:params.seed || 0,
          ...output,
          callRecord:record,
          providerAttempts:requested.providerAttempts,
          rateLimitRejections:requested.rateLimitRejections,
          costReporting,
          nextStageAllowed:false,
          costCommit:{ status:'pending_core_cost_event', costEvent:record.costEvent }
        }
      };
    });
  }

  async imageEdit(params, run) {
    assertImageOutputPath(params.outputPath);
    const { root, absolute } = await this.inputPath(run.companyId, params.inputPath);
    const bytes = await fs.readFile(absolute);
    if (bytes.length > 12 * 1024 * 1024) throw coded('image_too_large', '图片编辑输入超过 12MB。');
    const detectedMime = detectImageMime(bytes);
    const declaredMime = imageMimeFromPath(absolute);
    if (!detectedMime || detectedMime !== declaredMime) {
      throw coded('invalid_image_mime', '图片编辑输入只允许内容与扩展名一致的 PNG、JPEG 或 WebP。');
    }
    const config = await this.config();
    this.assertBillableRate('image_edit', config.costRatesCents);
    const maximumCostCents = Math.ceil(costForImage(config.costRatesCents));
    return this.paidAction(params, run, 'image_edit', maximumCostCents, async () => {
      const apiKey = await this.resolveApiKey(config);
      const requested = await this.fetchWithRateLimit('media', async () => {
        const form = new FormData();
        form.append('model', MODELS.image);
        form.append('image', new Blob([bytes], { type:detectedMime }), path.basename(absolute));
        form.append('prompt', String(params.prompt));
        form.append('response_format', 'b64_json');
        form.append('cfg_scale', '1');
        form.append('steps', '8');
        form.append('seed', String(Number.isInteger(params.seed) ? params.seed : 0));
        form.append('text_mode', String(params.textMode === true));
        return this.ctx.http.fetch(`${config.stepfunMediaBaseUrl}/images/edits`, {
          method:'POST',
          headers:{ authorization:`Bearer ${apiKey}` },
          body:form
        });
      });
      const response = requested.response;
      if (!response.ok) throw httpError('stepfun_image_edit_failed', 'StepFun 图片编辑', response, requested);
      const payload = await response.json();
      const encoded = payload?.data?.[0]?.b64_json;
      if (!encoded) throw coded('stepfun_image_empty', 'StepFun 图片编辑没有返回图片数据。');
      const outputBytes = providerBase64Bytes(
        encoded,
        'stepfun_image_invalid',
        'StepFun 图片编辑返回的 Base64 无效。',
      );
      assertProviderImage(outputBytes, params.outputPath);
      const output = await this.writeBinary(run.companyId, params.outputPath, outputBytes);
      const record = callRecord({
        run,
        actionId:params.actionId,
        model:MODELS.image,
        operation:'image_edit',
        prompt:params.prompt,
        seed:Number.isInteger(params.seed) ? params.seed : 0,
        inputs:[{ relativePath:path.relative(root, absolute), checksum:sha256(bytes), bytes:bytes.length }],
        outputs:[{ relativePath:output.relativePath, checksum:output.checksum, bytes:output.bytes }],
        costCents:costForImage(config.costRatesCents)
      });
      const costReporting = await reportCostMetric(this.ctx, record);
      return {
        content:'编辑图片已写入受控内容工作区。',
        data:{
          model:MODELS.image,
          seed:Number.isInteger(params.seed) ? params.seed : 0,
          inputPath:path.relative(root, absolute),
          inputChecksum:sha256(bytes),
          ...output,
          callRecord:record,
          providerAttempts:requested.providerAttempts,
          rateLimitRejections:requested.rateLimitRejections,
          costReporting,
          nextStageAllowed:false,
          costCommit:{ status:'pending_core_cost_event', costEvent:record.costEvent }
        }
      };
    });
  }

  async tts(params, run) {
    if (/clone|克隆|复刻/i.test(String(params.voice))) throw coded('voice_clone_denied', '首版只允许官方音色，禁止克隆真人音色。');
    if (!/\.mp3$/i.test(String(params.outputPath || ''))) {
      throw coded('invalid_tts_output', 'StepFun TTS 只允许输出 .mp3 文件。');
    }
    const config = await this.config();
    this.assertBillableRate('tts', config.costRatesCents);
    if (!config.officialTtsVoices.includes(String(params.voice))) {
      throw coded('tts_voice_not_allowed', '该音色不在负责人登记的 StepFun 官方音色白名单内。');
    }
    const maximumCostCents = Math.ceil(costForTts(params.text, config.costRatesCents));
    return this.paidAction(params, run, 'tts', maximumCostCents, async () => {
      const apiKey = await this.resolveApiKey(config);
      const requested = await this.fetchWithRateLimit('media', () =>
        this.ctx.http.fetch(`${config.stepfunMediaBaseUrl}/audio/speech`, {
          method:'POST',
          headers:{ 'content-type':'application/json', authorization:`Bearer ${apiKey}` },
          body:JSON.stringify({
            model:MODELS.tts,
            input:String(params.text),
            voice:String(params.voice),
            speed:Number(params.speed || 1),
            response_format:'mp3'
          })
        }));
      const response = requested.response;
      if (!response.ok) throw httpError('stepfun_tts_failed', 'StepFun TTS', response, requested);
      const bytes = await paperclipResponseBytes(response);
      if (!isMp3(bytes) || bytes.length > MAX_TTS_OUTPUT_BYTES) {
        throw coded('stepfun_tts_invalid', 'StepFun TTS 返回的 MP3 无效或超过 50MB。');
      }
      const output = await this.writeBinary(run.companyId, params.outputPath, bytes);
      const record = callRecord({
        run,
        actionId:params.actionId,
        model:MODELS.tts,
        operation:'tts',
        prompt:params.text,
        outputs:[{ relativePath:output.relativePath, checksum:output.checksum, bytes:output.bytes }],
        costCents:costForTts(params.text, config.costRatesCents)
      });
      const costReporting = await reportCostMetric(this.ctx, record);
      return {
        content:'旁白已写入受控内容工作区。',
        data:{
          model:MODELS.tts,
          voice:String(params.voice),
          speed:Number(params.speed || 1),
          ...output,
          callRecord:record,
          providerAttempts:requested.providerAttempts,
          rateLimitRejections:requested.rateLimitRejections,
          costReporting,
          nextStageAllowed:false,
          costCommit:{ status:'pending_core_cost_event', costEvent:record.costEvent }
        }
      };
    });
  }

  async claimCostEvent(params, run) {
    const actionId = validActionId(params.actionId);
    return this.withCostTransition(run, actionId, async () => {
      const stateKey = paidActionStateKey(run.projectId, actionId);
      const existing = await this.ctx.state.get(stateKey);
      if (!existing) throw coded('paid_action_not_found', '没有找到对应的付费 action，禁止创建费用提交。');
      assertPaidActionContext(existing, run);
      if (existing.state === 'confirmed') {
        return {
          content:'费用事件已经确认。',
          data:{ ...existing.resultData, replayed:true, nextStageAllowed:true }
        };
      }
      if (existing.state === 'cost_event_submitting') {
        const error = coded('cost_event_submitting', '费用事件已经领取提交租约；结果未决时禁止再次提交。');
        error.data = existing.resultData;
        throw error;
      }
      if (existing.state !== 'cost_event_pending') {
        throw coded('paid_action_ambiguous', '付费 action 不处于可提交费用的状态。');
      }
      const costEvent = existing.resultData?.costCommit?.costEvent;
      if (!costEvent) throw coded('cost_event_missing', '付费 action 缺少费用事件草稿。');
      const submissionId = crypto.randomUUID();
      const resultData = {
        ...existing.resultData,
        nextStageAllowed:false,
        costCommit:{
          status:'submitting_core_cost_event',
          submissionId,
          costEvent
        }
      };
      await this.ctx.state.set(stateKey, {
        ...existing,
        state:'cost_event_submitting',
        submissionId,
        resultData,
        updatedAt:new Date().toISOString()
      });
      return {
        content:'费用事件提交租约已领取；只允许向 Paperclip 核心费用接口提交一次。',
        data:resultData
      };
    });
  }

  async confirmCostEvent(params, run) {
    const actionId = validActionId(params.actionId);
    const submissionId = validUuid(params.submissionId, 'cost_submission_id_invalid', '费用提交租约标识无效。');
    const costEventId = validUuid(params.costEventId, 'cost_event_id_invalid', 'Paperclip 费用事件标识无效。');
    return this.withCostTransition(run, actionId, async () => {
      const stateKey = paidActionStateKey(run.projectId, actionId);
      const existing = await this.ctx.state.get(stateKey);
      if (!existing) throw coded('paid_action_not_found', '没有找到对应的付费 action，禁止确认费用。');
      assertPaidActionContext(existing, run);
      if (existing.state === 'confirmed') {
        if (existing.costEventId !== costEventId || existing.submissionId !== submissionId) {
          throw coded('cost_confirmation_conflict', '费用已经由另一条 Paperclip 回执确认，拒绝覆盖。');
        }
        return {
          content:'费用事件已经确认。',
          data:{ ...existing.resultData, replayed:true, nextStageAllowed:true }
        };
      }
      if (existing.state !== 'cost_event_submitting' || existing.submissionId !== submissionId) {
        throw coded('cost_submission_mismatch', '费用提交租约与当前未决记录不一致。');
      }
      const resultData = {
        ...existing.resultData,
        nextStageAllowed:true,
        costCommit:{
          status:'confirmed',
          submissionId,
          costEventId,
          costEvent:existing.resultData?.costCommit?.costEvent
        }
      };
      await this.ctx.state.set(stateKey, {
        ...existing,
        state:'confirmed',
        submissionId,
        costEventId,
        resultData,
        confirmedAt:new Date().toISOString(),
        updatedAt:new Date().toISOString()
      });
      return {
        content:'Paperclip 核心费用事件已经确认，允许继续下一阶段。',
        data:resultData
      };
    });
  }

  async reconcileLegacyRateLimit(params, run) {
    const actionId = validActionId(params.actionId);
    const expected = this.legacyRateLimitActions[actionId];
    if (!expected || run.runId !== expected.runId) {
      throw coded('legacy_rate_limit_scope_denied', '该动作不属于已核验的M5限流事故范围。');
    }
    return this.withCostTransition(run, actionId, async () => {
      const stateKey = paidActionStateKey(run.projectId, actionId);
      const existing = await this.ctx.state.get(stateKey);
      if (
        existing?.state === 'rate_limited'
        && existing?.legacyIncidentId === LEGACY_RATE_LIMIT_INCIDENT
        && existing?.parameterChecksum === expected.parameterChecksum
      ) {
        return {
          content:'历史429状态已经完成精确迁移。',
          data:{ actionId, state:'rate_limited', replayed:true, providerCalls:0 },
        };
      }
      if (
        existing?.actionId !== actionId
        || existing?.state !== 'ambiguous'
        || existing?.runId !== expected.runId
        || existing?.errorCode !== expected.errorCode
        || sha256(Buffer.from(stableJson(existing))) !== expected.stateChecksum
      ) {
        throw coded('legacy_rate_limit_state_mismatch', '历史429状态与事故快照不一致，拒绝迁移。');
      }
      await this.ctx.state.set(stateKey, {
        ...existing,
        state:'rate_limited',
        parameterChecksum:expected.parameterChecksum,
        errorCode:'stepfun_rate_limited',
        httpStatus:429,
        providerAttempts:1,
        rateLimitRejections:1,
        legacyIncidentId:LEGACY_RATE_LIMIT_INCIDENT,
        legacyStateChecksum:expected.stateChecksum,
        updatedAt:new Date().toISOString(),
      });
      return {
        content:'历史429状态已迁移为同参数可恢复状态。',
        data:{ actionId, state:'rate_limited', replayed:false, providerCalls:0 },
      };
    });
  }

  async paidAction(params, run, operation, maximumCostCents, execute) {
    const actionId = validActionId(params.actionId);
    const parameterChecksum = paidParameterChecksum(params);
    const stateKey = paidActionStateKey(run.projectId, actionId);
    const memoryKey = `${run.projectId}:${actionId}`;
    if (this.inflight.has(memoryKey)) throw coded('paid_action_in_progress', '相同付费 action 正在执行，禁止并发重放。');
    this.inflight.set(memoryKey, true);
    let invocationStarted = false;
    try {
      const existing = await this.ctx.state.get(stateKey);
      if (existing) {
        if (existing.state === 'confirmed') {
          assertPaidActionReplayContext(existing, run);
          if (
            existing.operation !== operation
            || existing.parameterChecksum !== parameterChecksum
          ) {
            throw coded(
              'paid_action_context_mismatch',
              '已确认付费 action 的参数或操作发生变化；必须使用新的 action revision。',
            );
          }
          await this.assertConfirmedOutput(existing, run);
          return {
            content:'已复用完成且费用已确认的付费 action。',
            data:{ ...existing.resultData, replayed:true, nextStageAllowed:true }
          };
        }
        if (existing.state === 'rate_limited') {
          assertPaidActionReplayContext(existing, run);
          if (
            existing.operation !== operation
            || existing.parameterChecksum !== parameterChecksum
          ) {
            throw coded('paid_action_context_mismatch', '限流恢复的付费 action 参数或操作发生变化。');
          }
        } else {
          assertPaidActionContext(existing, run);
        }
        if (existing.state === 'rate_limited') {
          // 官方明确HTTP 429代表超限请求未处理；允许同参数重新取得预算预留后继续。
        } else {
          const error = coded(
            existing.state === 'cost_event_pending'
              ? 'cost_event_pending'
              : existing.state === 'cost_event_submitting'
                ? 'cost_event_submitting'
                : 'paid_action_ambiguous',
            existing.state === 'cost_event_pending'
              ? '付费调用已经完成但核心 cost_event 尚未确认，禁止重放和进入下一阶段。'
              : existing.state === 'cost_event_submitting'
                ? '费用事件已经领取提交租约；结果未决时禁止重放、重复计费或进入下一阶段。'
                : '该付费 action 已存在未决记录，禁止自动重放。'
          );
          error.data = existing.resultData
            ? { ...existing.resultData, providerCallReplayed:true }
            : { actionId, operation, state:existing.state, providerCallReplayed:true };
          throw error;
        }
      }
      const budgetReservation = await reservePaidToolBudget({
        checker:this.paidBudgetChecker,
        run,
        actionId,
        operation,
        maximumCostCents,
        budgetTicket:params.budgetTicket,
        parameters:params,
      });
      await this.ctx.state.set(stateKey, {
        actionId,
        operation,
        state:'invoking',
        agentId:run.agentId,
        companyId:run.companyId,
        projectId:run.projectId,
        runId:run.runId,
        parameterChecksum,
        budgetReservation,
        startedAt:new Date().toISOString()
      });
      invocationStarted = true;
      const result = await execute();
      const resultData = {
        ...result.data,
        actionId,
        operation,
        nextStageAllowed:false
      };
      await this.ctx.state.set(stateKey, {
        actionId,
        operation,
        state:'cost_event_pending',
        agentId:run.agentId,
        companyId:run.companyId,
        projectId:run.projectId,
        runId:run.runId,
        parameterChecksum,
        budgetReservation,
        resultData,
        updatedAt:new Date().toISOString()
      });
      return { ...result, data:resultData };
    } catch (error) {
      if (invocationStarted && error?.retryableWithoutCharge === true) {
        await this.ctx.state.set(stateKey, {
          actionId,
          operation,
          state:'rate_limited',
          agentId:run.agentId,
          companyId:run.companyId,
          projectId:run.projectId,
          runId:run.runId,
          parameterChecksum,
          errorCode:String(error?.code || 'stepfun_rate_limited'),
          providerAttempts:nonnegativeInteger(error?.data?.providerAttempts),
          rateLimitRejections:nonnegativeInteger(error?.data?.rateLimitRejections),
          updatedAt:new Date().toISOString()
        }).catch(() => undefined);
      } else if (invocationStarted) {
        await this.ctx.state.set(stateKey, {
          actionId,
          operation,
          state:'ambiguous',
          agentId:run.agentId,
          companyId:run.companyId,
          projectId:run.projectId,
          runId:run.runId,
          errorCode:String(error?.code || 'paid_action_failed'),
          updatedAt:new Date().toISOString()
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.inflight.delete(memoryKey);
    }
  }

  async assertConfirmedOutput(existing, run) {
    const isVision = existing.operation === 'vision';
    if (!isVision && !['image_generate', 'image_edit', 'tts'].includes(existing.operation)) return;
    const relativePath = isVision
      ? existing.resultData?.sourcePath
      : existing.resultData?.relativePath;
    const expectedChecksum = String(isVision
      ? existing.resultData?.sourceChecksum
      : existing.resultData?.checksum || '');
    if (!relativePath || !/^sha256:[a-f0-9]{64}$/.test(expectedChecksum)) {
      throw coded('paid_action_artifact_invalid', '已确认付费 action 缺少可核验的本地文件血缘。');
    }
    const status = await this.ctx.localFolders.status(run.companyId, 'content-workspace');
    if (!status?.healthy || !status?.realPath) {
      throw coded('paid_action_artifact_unavailable', '已确认付费 action 的受控工作区不可用。');
    }
    const root = await fs.realpath(status.realPath);
    const candidate = path.resolve(root, safeRelativePath(relativePath));
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件不在受控工作区。');
    }
    let stat;
    let real;
    try {
      stat = await fs.lstat(candidate);
      real = await fs.realpath(candidate);
    } catch {
      throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件不存在。');
    }
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || !real.startsWith(`${root}${path.sep}`)
    ) {
      throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件路径无效。');
    }
    const bytes = await fs.readFile(real);
    if (sha256(bytes) !== expectedChecksum) {
      throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件哈希不匹配。');
    }
  }

  async withCostTransition(run, actionId, execute) {
    const memoryKey = `cost-transition:${run.projectId}:${actionId}`;
    if (this.inflight.has(memoryKey)) throw coded('cost_transition_in_progress', '相同费用事件正在变更状态。');
    this.inflight.set(memoryKey, true);
    try {
      return await execute();
    } finally {
      this.inflight.delete(memoryKey);
    }
  }

  assertBillableRate(operation, rates) {
    const valid = operation === 'image_generate' || operation === 'image_edit'
      ? Number(rates.imagePerGeneration) > 0
      : operation === 'tts'
        ? Number(rates.ttsPerThousandCharacters) > 0
        : Number(rates.visionInputPerMillionTokens) > 0 || Number(rates.visionOutputPerMillionTokens) > 0;
    if (!valid) throw coded('billing_rate_missing', `付费工具 ${operation} 没有有效费率，调用已在外发前拒绝。`);
  }

  async request(config, endpoint, body, route = 'reasoning') {
    const apiKey = await this.resolveApiKey(config);
    const baseUrl = route === 'media' ? config.stepfunMediaBaseUrl : config.stepfunBaseUrl;
    const requested = await this.fetchWithRateLimit(route, () =>
      this.ctx.http.fetch(`${baseUrl}${endpoint}`, {
        method:'POST',
        headers:{ 'content-type':'application/json', authorization:`Bearer ${apiKey}` },
        body:JSON.stringify(body)
      }));
    if (!requested.response.ok) {
      throw httpError('stepfun_request_failed', 'StepFun', requested.response, requested);
    }
    return {
      payload:await requested.response.json(),
      providerAttempts:requested.providerAttempts,
      rateLimitRejections:requested.rateLimitRejections,
    };
  }

  async fetchWithRateLimit(route, request) {
    let providerAttempts = 0;
    let rateLimitRejections = 0;
    for (let retry = 0; retry <= this.rateLimit.maxRateLimitRetries; retry += 1) {
      await this.acquireRateSlot(route);
      providerAttempts += 1;
      const response = await request();
      if (response.status !== 429) {
        return { response, providerAttempts, rateLimitRejections };
      }
      rateLimitRejections += 1;
      if (retry === this.rateLimit.maxRateLimitRetries) {
        const error = httpError(
          'stepfun_rate_limited',
          'StepFun',
          response,
          { providerAttempts, rateLimitRejections },
        );
        error.retryableWithoutCharge = true;
        throw error;
      }
      await this.rateLimit.sleep(this.rateLimitDelay(response, retry));
    }
    throw coded('stepfun_rate_limited', 'StepFun 限流恢复循环异常终止。');
  }

  async acquireRateSlot(route) {
    const pool = route === 'media' ? 'media' : 'reasoning';
    const previous = this.rateLimit.tails.get(pool) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.rateLimit.tails.set(pool, current);
    await previous;
    try {
      const lastStartedAt = Number(this.rateLimit.lastStartedAt.get(pool) || 0);
      const waitMs = Math.max(
        0,
        lastStartedAt + this.rateLimit.minRequestIntervalMs - this.rateLimit.now(),
      );
      if (waitMs > 0) await this.rateLimit.sleep(waitMs);
      this.rateLimit.lastStartedAt.set(pool, this.rateLimit.now());
    } finally {
      release();
      if (this.rateLimit.tails.get(pool) === current) this.rateLimit.tails.delete(pool);
    }
  }

  rateLimitDelay(response, retry) {
    const hinted = retryAfterMilliseconds(response?.headers?.get?.('retry-after'), this.rateLimit.now());
    const exponential = this.rateLimit.minRequestIntervalMs * (2 ** retry);
    const jitter = Math.floor(Math.max(0, Math.min(1, Number(this.rateLimit.random()))) * 1_000);
    return Math.min(
      this.rateLimit.maxRetryDelayMs,
      Math.max(this.rateLimit.minRequestIntervalMs, hinted, exponential) + jitter,
    );
  }

  async config() {
    const config = await this.ctx.config.get();
    const stepfunBaseUrl = String(config.stepfunBaseUrl || 'https://api.stepfun.com/v1').replace(/\/+$/, '');
    const stepfunMediaBaseUrl = String(
      config.stepfunMediaBaseUrl || config.stepfunBaseUrl || 'https://api.stepfun.com/step_plan/v1'
    ).replace(/\/+$/, '');
    assertOfficialStepFunUrl(stepfunBaseUrl, ['/v1']);
    assertOfficialStepFunUrl(stepfunMediaBaseUrl, ['/v1', '/step_plan/v1']);
    return {
      stepfunSecretRef:requirePaperclipSecretRef(
        config.stepfunSecretRef,
        (message) => coded('stepfun_secret_ref_invalid', message)
      ),
      stepfunBaseUrl,
      stepfunMediaBaseUrl,
      officialTtsVoices:Array.isArray(config.officialTtsVoices) ? config.officialTtsVoices.map(String) : [],
      costRatesCents:config.costRatesCents || {}
    };
  }

  async resolveApiKey(config) {
    try {
      const value = await this.ctx.secrets.resolve(config.stepfunSecretRef);
      if (typeof value !== 'string' || !value.trim()) throw new Error('empty');
      return value;
    } catch {
      throw coded('stepfun_secret_resolve_failed', 'StepFun Secret 解析失败；Provider 未调用。');
    }
  }

  async inputPath(companyId, relativePath) {
    const status = await this.ctx.localFolders.status(companyId, 'content-workspace');
    if (!status.healthy || !status.realPath) throw coded('content_workspace_unavailable', '内容生产工作区尚未正确配置。');
    const root = await fs.realpath(status.realPath);
    const target = path.resolve(root, safeRelativePath(relativePath));
    const absolute = await fs.realpath(target);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw coded('symlink_escape', '素材路径通过符号链接逃逸了工作区。');
    return { root, absolute };
  }

  async writeBinary(companyId, relativePath, bytes) {
    const status = await this.ctx.localFolders.status(companyId, 'content-workspace');
    if (!status.healthy || !status.writable || !status.realPath) throw coded('content_workspace_unavailable', '内容生产工作区不可写。');
    const root = await fs.realpath(status.realPath);
    const relative = safeRelativePath(relativePath);
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(`${root}${path.sep}`)) throw coded('path_escape', '输出路径逃逸了工作区。');
    await fs.mkdir(path.dirname(candidate), { recursive:true });
    const realParent = await fs.realpath(path.dirname(candidate));
    if (!realParent.startsWith(`${root}${path.sep}`) && realParent !== root) {
      throw coded('symlink_escape', '输出目录通过符号链接逃逸了工作区。');
    }
    const absolute = path.join(realParent, path.basename(candidate));
    const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { mode:0o600, flag:'wx' });
      await fs.rename(temporary, absolute);
    } finally {
      await fs.rm(temporary, { force:true });
    }
    return { relativePath:relative, checksum:sha256(bytes), bytes:bytes.length };
  }
}

export async function paperclipResponseBytes(response) {
  const encoding = String(response?.headers?.get?.('x-paperclip-body-encoding') || '').trim().toLowerCase();
  if (!encoding) return Buffer.from(await response.arrayBuffer());
  if (encoding !== 'base64') {
    throw coded('paperclip_body_encoding_invalid', 'Paperclip 返回了未知的HTTP响应体编码。');
  }
  const encoded = await response.text();
  if (
    encoded.length === 0
    || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw coded('paperclip_body_encoding_invalid', 'Paperclip 返回的Base64响应体无效。');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw coded('paperclip_body_encoding_invalid', 'Paperclip 返回的Base64响应体不规范。');
  }
  return bytes;
}

function assertOfficialStepFunUrl(value, allowedPaths) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw coded('stepfun_base_url_denied', 'StepFun Base URL 无效，禁止解析 Secret。');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'api.stepfun.com'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !allowedPaths.includes(parsed.pathname.replace(/\/+$/, '') || '/')
  ) {
    throw coded('stepfun_base_url_denied', 'StepFun Base URL 不在官方域名白名单，禁止解析 Secret。');
  }
}

export function paidActionStateKey(projectId, actionId) {
  return {
    scopeKind:'project',
    scopeId:projectId,
    namespace:'paid-actions',
    stateKey:sha256(Buffer.from(actionId)).slice('sha256:'.length)
  };
}

export function paidParameterChecksum(params) {
  const safe = Object.fromEntries(
    Object.entries(params || {}).filter(([key]) => key !== 'budgetTicket'),
  );
  return sha256(Buffer.from(stableJson(safe)));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function httpError(code, label, response, attempts) {
  const error = coded(code, `${label} 返回 HTTP ${response?.status || 'unknown'}。`);
  error.data = {
    providerAttempts:nonnegativeInteger(attempts?.providerAttempts),
    rateLimitRejections:nonnegativeInteger(attempts?.rateLimitRejections),
    httpStatus:nonnegativeInteger(response?.status),
  };
  return error;
}

function retryAfterMilliseconds(value, now) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1_000));
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function validActionId(value) {
  const actionId = String(value || '');
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)) {
    throw coded('invalid_action_id', '付费工具必须提供稳定、可验证的 actionId。');
  }
  return actionId;
}

function validUuid(value, code, message) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw coded(code, message);
  return id;
}

function assertPaidActionContext(existing, run) {
  assertPaidActionReplayContext(existing, run);
  if (existing.runId !== run.runId) {
    throw coded('cost_run_context_mismatch', '费用事件只能由产生它的 Paperclip Agent Run 确认。');
  }
}

function assertPaidActionReplayContext(existing, run) {
  if (
    existing.agentId !== run.agentId
    || existing.companyId !== run.companyId
    || existing.projectId !== run.projectId
  ) {
    throw coded('cost_run_context_mismatch', '已确认费用只能由同公司、同项目、同岗位的新 Paperclip Agent Run 只读复用。');
  }
  if (existing.runId !== run.runId && run.status !== 'running') {
    throw coded('cost_run_context_mismatch', '跨 Run 复用已确认费用必须使用已核验为 running 的新 Paperclip Agent Run。');
  }
}

function imageMimeFromPath(filePath) {
  return /\.png$/i.test(filePath) ? 'image/png'
    : /\.webp$/i.test(filePath) ? 'image/webp'
      : /\.jpe?g$/i.test(filePath) ? 'image/jpeg'
        : null;
}

function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function assertImageOutputPath(relativePath) {
  if (!imageMimeFromPath(String(relativePath || ''))) {
    throw coded('invalid_image_output', 'StepFun 图片只允许输出 .png、.jpg、.jpeg 或 .webp 文件。');
  }
}

function assertProviderImage(bytes, relativePath) {
  const detectedMime = detectImageMime(bytes);
  const declaredMime = imageMimeFromPath(String(relativePath || ''));
  if (
    !detectedMime
    || detectedMime !== declaredMime
    || bytes.length > MAX_IMAGE_OUTPUT_BYTES
  ) {
    throw coded('stepfun_image_invalid', 'StepFun 返回的图片内容、扩展名不一致或超过 20MB。');
  }
}

function providerBase64Bytes(value, code, message) {
  const encoded = String(value || '');
  if (
    !encoded
    || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw coded(code, message);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) throw coded(code, message);
  return bytes;
}

function isMp3(bytes) {
  return bytes.length >= 3 && (
    bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
}
