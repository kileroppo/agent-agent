import crypto from 'node:crypto';
import { config } from './config.js';

const UNCERTAIN_STATES = new Set([
  'creating_document',
  'document_created',
  'writing',
  'permission_pending',
  'uncertain'
]);

export class LarkDeliveryCoordinator {
  constructor({ store, transport = deliverToLark } = {}) {
    this.store = store;
    this.transport = transport;
    this.inflight = new Map();
  }

  async deliver({ jobId, title, markdown }) {
    const checksum = deliveryChecksum(title, markdown);
    const active = this.inflight.get(jobId);
    if (active) {
      if (active.checksum !== checksum) throw deliveryConflict('同一任务已有另一份飞书交付正在进行。');
      return active.promise;
    }
    const promise = this.#deliver({ jobId, title, markdown, checksum })
      .finally(() => this.inflight.delete(jobId));
    this.inflight.set(jobId, { checksum, promise });
    return promise;
  }

  async resolve({ jobId, decision, documentId = null, permissionGranted = false, confirmation = '' }) {
    const job = this.store.get(jobId);
    if (!job) throw resolutionError('飞书交付对应的任务不存在。', 404);
    if (confirmation !== jobId) throw resolutionError('必须用完整任务编号确认本次人工仲裁。', 422);
    const delivery = job.output?.larkDelivery;
    if (!isLarkDeliveryUncertain(delivery)) throw resolutionError('这条任务当前没有待仲裁的飞书交付。', 409);

    if (decision === 'confirmed_delivered') {
      const resolvedDocumentId = delivery.documentId || String(documentId || '').trim();
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(resolvedDocumentId)) throw resolutionError('确认已交付时必须提供有效的飞书文档标识。', 422);
      if (delivery.documentId && documentId && delivery.documentId !== documentId) throw resolutionError('提供的文档标识与已落账标识不一致。', 409);
      if (permissionGranted !== true) throw resolutionError('必须核实目标用户确实可访问文档，才能确认交付完成。', 422);
      const resolved = {
        ...delivery,
        state:'delivered',
        configured:true,
        documentId:resolvedDocumentId,
        url:`https://feishu.cn/docx/${resolvedDocumentId}`,
        permissionGranted:true,
        safeToRetry:false,
        completedAt:new Date().toISOString(),
        resolvedAt:new Date().toISOString(),
        resolution:'confirmed_delivered',
        lastError:null,
        updatedAt:new Date().toISOString()
      };
      await this.#persist(jobId, resolved);
      return deliveryResult(resolved);
    }

    if (decision === 'confirmed_not_created') {
      if (delivery.documentId) throw resolutionError('系统已取得飞书文档标识，不能确认“未创建”；请核对该文档并确认完成或人工修复。', 409);
      const resolved = {
        ...delivery,
        state:'failed_before_create',
        documentId:null,
        url:null,
        permissionGranted:false,
        safeToRetry:true,
        resolvedAt:new Date().toISOString(),
        resolution:'confirmed_not_created',
        lastError:null,
        updatedAt:new Date().toISOString()
      };
      await this.#persist(jobId, resolved);
      return deliveryResult(resolved);
    }
    throw resolutionError('人工仲裁只支持 confirmed_delivered 或 confirmed_not_created。', 422);
  }

  async #deliver({ jobId, title, markdown, checksum }) {
    const job = this.store.get(jobId);
    if (!job) throw new Error('飞书交付对应的任务不存在。');
    const existing = job.output?.larkDelivery || null;
    if (existing && isLarkDeliveryUncertain(existing)) {
      throw deliveryConflict('上一次飞书交付结果不确定；为避免重复创建文档，已停止自动重试。请先人工核对飞书与任务编号。', existing);
    }
    if (existing?.checksum === checksum && existing.state === 'delivered') return deliveryResult(existing);

    const resumeDocumentId = existing?.checksum === checksum && existing.state === 'document_ready'
      ? existing.documentId
      : null;
    const previous = existing && existing.checksum !== checksum ? existing : null;
    const prepared = {
      deliveryId: crypto.randomUUID(),
      checksum,
      state: resumeDocumentId ? 'document_ready' : 'prepared',
      title,
      documentId: resumeDocumentId,
      url: resumeDocumentId ? existing.url : null,
      permissionGranted: false,
      safeToRetry: true,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.#persist(jobId, prepared, previous);

    try {
      const result = await this.transport(title, markdown, {
        existingDocumentId: resumeDocumentId,
        onProgress: async (progress) => {
          const current = this.store.get(jobId)?.output?.larkDelivery || prepared;
          await this.#persist(jobId, {
            ...current,
            ...progress,
            checksum,
            title,
            updatedAt: new Date().toISOString()
          });
        }
      });
      const state = result.configured === false
        ? 'failed_before_create'
        : result.permissionGranted
          ? 'delivered'
          : 'document_ready';
      const final = {
        ...(this.store.get(jobId)?.output?.larkDelivery || prepared),
        state,
        configured: result.configured !== false,
        documentId: result.documentId || resumeDocumentId || null,
        url: result.url || null,
        permissionGranted: result.permissionGranted === true,
        safeToRetry: state === 'failed_before_create' || state === 'document_ready',
        completedAt: state === 'delivered' ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString()
      };
      await this.#persist(jobId, final);
      return deliveryResult(final);
    } catch (error) {
      const current = this.store.get(jobId)?.output?.larkDelivery || prepared;
      const state = error?.ambiguous === false && !current.documentId ? 'failed_before_create' : 'uncertain';
      const failed = {
        ...current,
        state,
        documentId: error?.documentId || current.documentId || null,
        url: (error?.documentId || current.documentId) ? `https://feishu.cn/docx/${error?.documentId || current.documentId}` : current.url || null,
        safeToRetry: state === 'failed_before_create',
        lastError: safeErrorMessage(error),
        updatedAt: new Date().toISOString()
      };
      try {
        await this.#persist(jobId, failed);
      } catch {
        // The durable pre-send/progress marker is intentionally left in place.
        // Restart recovery treats any side-effecting marker as uncertain.
      }
      if (state === 'uncertain') throw deliveryConflict('飞书可能已接收本次交付；为避免重复创建文档，已停止自动重试。请按任务编号人工核对。', failed, error);
      throw error;
    }
  }

  async #persist(jobId, delivery, previous = null) {
    const job = this.store.get(jobId);
    const history = previous
      ? [...(job.output?.larkDeliveryHistory || []), previous]
      : job.output?.larkDeliveryHistory || [];
    await this.store.update(jobId, {
      output: {
        ...(job.output || {}),
        larkDelivery: delivery,
        ...(history.length ? { larkDeliveryHistory: history } : {})
      }
    }, { stage: 'delivering', message: deliveryLogMessage(delivery.state) });
  }
}

export async function deliverToLark(title, markdown, {
  fetchImpl = globalThis.fetch,
  lark = config.lark,
  timeoutMs = 15_000,
  existingDocumentId = null,
  onProgress = async () => {}
} = {}) {
  if (!lark.appId || !lark.appSecret) return { configured: false };
  const tokenPayload = await requestJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: lark.appId, app_secret: lark.appSecret })
  }, { fetchImpl, timeoutMs, phase: 'authorizing', ambiguous: false });
  if (tokenPayload.code) throw transportError(tokenPayload.msg || '无法获取飞书访问凭证', { phase: 'authorizing', ambiguous: false });
  if (!tokenPayload.tenant_access_token) throw transportError('飞书未返回访问凭证', { phase:'authorizing', ambiguous:false });
  const headers = { Authorization: `Bearer ${tokenPayload.tenant_access_token}`, 'Content-Type': 'application/json' };

  let documentId = existingDocumentId;
  if (!documentId) {
    await onProgress({ state: 'creating_document', safeToRetry: false });
    const created = await requestJson('https://open.feishu.cn/open-apis/docx/v1/documents', {
      method: 'POST', headers, body: JSON.stringify({ title })
    }, { fetchImpl, timeoutMs, phase: 'creating_document', ambiguous: true });
    if (created.code) throw transportError(created.msg || '无法创建飞书文档', { phase: 'creating_document', ambiguous: true });
    const document = created.data?.document || created.data;
    documentId = document?.document_id;
    if (!documentId) throw transportError('飞书未返回文档标识。', { phase: 'creating_document', ambiguous: true });
    await onProgress({
      state: 'document_created', documentId,
      url: `https://feishu.cn/docx/${documentId}`, safeToRetry: false
    });

    const children = markdownToBlocks(markdown);
    const batches = chunk(children, 50);
    for (let index = 0; index < batches.length; index += 1) {
      await onProgress({ state: 'writing', documentId, batchIndex: index, batchCount: batches.length, safeToRetry: false });
      const written = await requestJson(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
        method: 'POST', headers, body: JSON.stringify({ index: -1, children: batches[index] })
      }, { fetchImpl, timeoutMs, phase: 'writing', ambiguous: true, documentId });
      if (written.code) throw transportError(written.msg || '飞书文档已创建，但写入正文失败', { phase: 'writing', ambiguous: true, documentId });
      await onProgress({ state: 'document_created', documentId, writtenBatches: index + 1, batchCount: batches.length, safeToRetry: false });
      if (batches.length > 1 && index < batches.length - 1) await delay(360);
    }
  }

  let permissionGranted = false;
  if (lark.userOpenId) {
    await onProgress({ state: 'permission_pending', documentId, safeToRetry: false });
    const permissionResult = await requestJson(`https://open.feishu.cn/open-apis/drive/v1/permissions/${documentId}/members?type=docx&need_notification=false`, {
      method: 'POST', headers,
      body: JSON.stringify({ member_type: 'openid', member_id: lark.userOpenId, perm: 'full_access' })
    }, { fetchImpl, timeoutMs, phase: 'permission_pending', ambiguous: true, documentId });
    if (permissionResult.code) throw transportError(permissionResult.msg || '飞书文档已创建，但授权失败', { phase: 'permission_pending', ambiguous: true, documentId });
    permissionGranted = true;
  }
  return { configured: true, documentId, url: `https://feishu.cn/docx/${documentId}`, permissionGranted };
}

export function isLarkDeliveryUncertain(delivery) {
  return Boolean(delivery && UNCERTAIN_STATES.has(delivery.state));
}

export function deliveryChecksum(title, markdown) {
  return crypto.createHash('sha256').update(JSON.stringify({ title, markdown })).digest('hex');
}

export function markdownToBlocks(markdown) {
  let firstMeaningfulLine = true;
  return markdown.split('\n').flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line || line === '---' || line.startsWith('>')) return [];
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (firstMeaningfulLine && heading?.[1].length === 1) {
      firstMeaningfulLine = false;
      return [];
    }
    firstMeaningfulLine = false;
    if (heading) {
      const level = heading[1].length;
      const blockType = level === 1 ? 3 : level === 2 ? 4 : 5;
      const key = level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
      return [{ block_type: blockType, [key]: { elements: inlineElements(heading[2]) } }];
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) return [{ block_type: 12, bullet: { elements: inlineElements(bullet[1]) } }];
    return [{ block_type: 2, text: { elements: inlineElements(line) } }];
  });
}

function inlineElements(value) {
  const elements = [];
  const parts = String(value).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  for (const part of parts) {
    const bold = part.startsWith('**') && part.endsWith('**');
    const content = bold ? part.slice(2, -2) : part;
    if (content) elements.push({ text_run: { content, ...(bold ? { text_element_style: { bold: true } } : {}) } });
  }
  return elements.length ? elements : [{ text_run: { content: String(value) } }];
}

async function requestJson(url, options, { fetchImpl, timeoutMs, phase, ambiguous, documentId = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw transportError(payload.msg || `飞书接口返回 HTTP ${response.status}`, { phase, ambiguous, documentId });
    }
    return payload;
  } catch (error) {
    if (error instanceof LarkTransportError) throw error;
    const message = error?.name === 'AbortError' ? '飞书接口请求超时' : '飞书接口请求失败';
    throw transportError(message, { phase, ambiguous, documentId, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

class LarkTransportError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'LarkTransportError';
    this.phase = options.phase;
    this.ambiguous = options.ambiguous;
    this.documentId = options.documentId || null;
  }
}

function transportError(message, options) {
  return new LarkTransportError(String(message).slice(0, 300), options);
}

function deliveryConflict(message, delivery = null, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'LarkDeliveryConflictError';
  error.code = 'lark_delivery_uncertain';
  error.status = 409;
  error.delivery = delivery;
  return error;
}

function resolutionError(message, status) {
  const error = new Error(message);
  error.name = 'LarkDeliveryResolutionError';
  error.code = 'lark_delivery_resolution_invalid';
  error.status = status;
  return error;
}

function deliveryResult(delivery) {
  return {
    configured: delivery.configured !== false,
    documentId: delivery.documentId || null,
    url: delivery.url || null,
    permissionGranted: delivery.permissionGranted === true,
    state: delivery.state,
    duplicate: delivery.state === 'delivered'
  };
}

function deliveryLogMessage(state) {
  return ({
    prepared: '飞书交付意图已落账',
    creating_document: '正在创建飞书文档',
    document_created: '飞书文档标识已落账',
    writing: '正在写入飞书文档正文',
    permission_pending: '正在授予飞书文档权限',
    document_ready: '飞书文档已创建，等待权限确认',
    delivered: '飞书文档交付凭据已落账',
    failed_before_create: '飞书文档尚未创建'
  })[state] || '飞书交付状态已更新';
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 300);
}

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
