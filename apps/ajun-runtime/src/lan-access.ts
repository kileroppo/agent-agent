import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';

export function isLoopbackHost(host: unknown) { return ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()); }
export function isLocalAddress(address: unknown) { return isLoopbackHost(String(address).replace(/^::ffff:/, '')); }

export async function loadLanShareKey(filePath: string, enabled: boolean) {
  if (!enabled) return null;
  try {
    const existing = (await fs.readFile(filePath, 'utf8')).trim();
    if (existing.length >= 24) return existing;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return writeLanShareKey(filePath);
}

export async function rotateLanShareKey(filePath: string, enabled: boolean) { return enabled ? writeLanShareKey(filePath) : null; }

async function writeLanShareKey(filePath: string) {
  const key = crypto.randomBytes(24).toString('base64url');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${key}\n`, { mode: 0o600 });
  return key;
}

export function canAccessApi(
  request: IncomingMessage,
  { enabled, key }: Readonly<{ enabled: boolean; key: string | null }>,
) {
  if (!enabled || isLocalAddress(request.socket?.remoteAddress)) return true;
  const supplied = String(request.headers?.['x-ajun-share-key'] || '');
  if (!key || supplied.length !== key.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(key));
}

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item): item is os.NetworkInterfaceInfo => Boolean(item && item.family === 'IPv4' && !item.internal))
    .map((item) => item.address);
}
