import { PaperclipHttpError } from '@agent-army/paperclip-client';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function createPaperclipLoopbackClient({
  apiBase,
  fetchImpl = fetch,
  operation = '此操作',
} = {}) {
  const origin = loopbackOrigin(apiBase, operation);
  return {
    origin,
    async request(method, path, { body } = {}) {
      const normalizedMethod = String(method || 'GET').toUpperCase();
      const target = new URL(path, origin);
      if (target.origin !== origin) {
        throw new Error(`${operation}拒绝请求已核验 Paperclip origin 之外的地址`);
      }
      const response = await fetchImpl(target.href, {
        method:normalizedMethod,
        redirect:'error',
        headers:body === undefined
          ? { accept:'application/json' }
          : { accept:'application/json', 'content-type':'application/json' },
        body:body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        const payload = parseErrorPayload(text);
        const detail = String(payload?.error || payload?.message || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        const error = new PaperclipHttpError({
          method:normalizedMethod,
          path:`${target.pathname}${target.search}`,
          status:response.status,
          detail,
        });
        error.url = target.href;
        throw error;
      }
      return text ? JSON.parse(text) : null;
    },
  };
}

export function asPaperclipList(value, envelopeKeys = ['items']) {
  if (Array.isArray(value)) return value;
  for (const key of envelopeKeys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

export function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function loopbackOrigin(apiBase, operation) {
  const url = new URL(apiBase);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${operation}只允许连接 loopback Paperclip`);
  }
  return url.origin;
}

function parseErrorPayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
