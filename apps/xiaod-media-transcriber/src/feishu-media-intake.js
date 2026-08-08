import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeIngressKey, makeJob } from './domain.js';

const ALLOWED_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mov', '.oga', '.ogg', '.opus', '.wav', '.webm'
]);

export async function createFeishuMediaJob({ store, uploadsDir, body, maxBytes, allowedRoots }) {
  const input = validateFeishuMediaInput(body, maxBytes);
  if (!input.ok) return input;

  const sourceEventId = input.messageId || `cache-${crypto.createHash('sha256').update(input.mediaPath).digest('hex').slice(0, 24)}`;
  const ingressKey = makeIngressKey({
    platform: 'feishu', messageId: sourceEventId, attachmentIndex: input.attachmentIndex
  });
  const existing = store.findByIngressKey(ingressKey);
  if (existing) return { ok: true, created: false, job: existing };

  const sourcePath = await copyInboundFile({ sourcePath: input.mediaPath, uploadsDir, originalName: input.originalName, maxBytes: input.maxBytes, allowedRoots });
  const job = makeJob({
    sourceType: 'upload',
    originalName: input.originalName,
    sourcePath,
    ingress: {
      platform: 'feishu',
      messageId: sourceEventId,
      attachmentIndex: input.attachmentIndex,
      idempotencyKey: ingressKey,
      receivedAt: new Date().toISOString()
    }
  });
  const saved = await store.createOrGetByIngressKey(job);
  if (!saved.created) await fs.rm(sourcePath, { force: true });
  return { ok: true, ...saved };
}

export function validateFeishuMediaInput(body, maxBytes) {
  const mediaPath = typeof body?.mediaPath === 'string' ? body.mediaPath.trim() : '';
  const originalName = typeof body?.originalName === 'string' ? body.originalName.trim() : '';
  const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : '';
  const attachmentIndex = Number(body?.attachmentIndex ?? 0);
  if (!mediaPath || !path.isAbsolute(mediaPath)) return { ok: false, status: 422, error: '媒体路径必须是绝对本地路径。' };
  if (!originalName || path.basename(originalName) !== originalName) return { ok: false, status: 422, error: '媒体文件名无效。' };
  if (messageId.length > 256) return { ok: false, status: 422, error: '飞书消息标识无效。' };
  if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex > 20) return { ok: false, status: 422, error: '附件序号无效。' };
  if (!ALLOWED_EXTENSIONS.has(path.extname(originalName).toLowerCase())) return { ok: false, status: 415, error: '当前只接收音频或视频文件。' };
  return { ok: true, mediaPath, originalName, messageId, attachmentIndex, maxBytes };
}

async function copyInboundFile({ sourcePath, uploadsDir, originalName, maxBytes, allowedRoots = [] }) {
  const source = await fs.realpath(sourcePath).catch(() => null);
  if (!source) throw new IntakeError(404, '媒体缓存文件不存在或已过期。');
  const trustedRoots = (await Promise.all(allowedRoots.map((root) => fs.realpath(root).catch(() => null)))).filter(Boolean);
  if (!trustedRoots.some((root) => source === root || source.startsWith(`${root}${path.sep}`))) {
    throw new IntakeError(403, '媒体路径不在受信任的 Hermes 缓存目录中。');
  }
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new IntakeError(422, '媒体路径不是普通文件。');
  if (stat.size > maxBytes) throw new IntakeError(413, '媒体文件超过当前 M1 的 1GB 上限。');
  const target = path.join(uploadsDir, `${crypto.randomUUID()}-${safeFilename(originalName)}`);
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  await fs.chmod(target, 0o600);
  return target;
}

function safeFilename(name) {
  return name.replace(/[^\w.\-() ]/g, '_').slice(-160) || 'media';
}

export class IntakeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
