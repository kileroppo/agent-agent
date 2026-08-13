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
import {
  DEFAULT_LEGACY_RATE_LIMIT_ACTIONS,
  PaidProviderActionProtocol,
} from './paid-provider-action-protocol.js';

export { paidActionStateKey, paidParameterChecksum } from './paid-provider-action-protocol.js';

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
    legacyRateLimitActions = DEFAULT_LEGACY_RATE_LIMIT_ACTIONS,
  }) {
    this.ctx = ctx;
    this.paidBudgetChecker = paidBudgetChecker;
    this.inflight = new Map();
    this.legacyRateLimitActions = legacyRateLimitActions;
    this.paidActions = new PaidProviderActionProtocol({
      getContext:() => this.ctx,
      getPaidBudgetChecker:() => this.paidBudgetChecker,
      getLegacyRateLimitActions:() => this.legacyRateLimitActions,
      getInflight:() => this.inflight,
      assertConfirmedOutput:(existing, run) => this.assertConfirmedOutput(existing, run),
      withCostTransition:(run, actionId, execute) => this.withCostTransition(run, actionId, execute),
    });
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
    return this.paidActions.claim(params, run);
  }

  async confirmCostEvent(params, run) {
    return this.paidActions.confirm(params, run);
  }

  async reconcileLegacyRateLimit(params, run) {
    return this.paidActions.reconcileLegacyRateLimit(params, run);
  }

  async paidAction(params, run, operation, maximumCostCents, execute) {
    return this.paidActions.execute(params, run, operation, maximumCostCents, execute);
  }

  async assertConfirmedOutput(existing, run) {
    return this.paidActions.assertConfirmedArtifact(existing, run);
  }

  async withCostTransition(run, actionId, execute) {
    return this.paidActions.withTransition(run, actionId, execute);
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
