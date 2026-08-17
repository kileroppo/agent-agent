import fs from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_RELIABILITY_SNAPSHOT_FILE = 'runtime-reliability.json';
const RELEASE_KIND = 'agent-army/ajun-immutable-runtime-release';

/** Read only the deliberately small, local stability conclusion. */
export async function readRuntimeReliabilitySnapshot(dataDir: string | null | undefined) {
  const filePath = runtimeReliabilitySnapshotPath(dataDir);
  if (!filePath) return null;
  try {
    return normalizeSnapshot(JSON.parse(await fs.readFile(filePath, 'utf8')));
  }
  catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

/** The immutable release manifest, not the mutable source checkout, defines live identity. */
export async function readRuntimeReleaseIdentity(runtimeRoot: string | null | undefined) {
  const root = String(runtimeRoot || '').trim();
  if (!root) return null;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'release-manifest.json'), 'utf8'));
    if (manifest?.kind !== RELEASE_KIND) return null;
    const gitHead = normalizeGitHead(manifest?.git?.gitHead);
    const releaseHash = normalizeReleaseHash(manifest?.releaseHash);
    return gitHead || releaseHash ? Object.freeze({ gitHead, releaseHash }) : null;
  }
  catch {
    return null;
  }
}

export function runtimeReliabilitySnapshotPath(dataDir: string | null | undefined) {
  const directory = String(dataDir || '').trim();
  return directory ? path.join(directory, RUNTIME_RELIABILITY_SNAPSHOT_FILE) : null;
}

function normalizeSnapshot(value: any) {
  const status = ['healthy', 'degraded', 'unavailable', 'unknown'].includes(String(value?.status || ''))
    ? String(value.status)
    : 'unknown';
  const runtimeIdentity = {
    gitHead:normalizeGitHead(value?.runtimeIdentity?.gitHead),
    releaseHash:normalizeReleaseHash(value?.runtimeIdentity?.releaseHash),
  };
  return Object.freeze({
    status,
    detail:safeText(value?.detail, 240) || '当前版本的稳定性观测没有有效结论。',
    observedAt:validTime(value?.observedAt),
    runtimeIdentity:Object.freeze(runtimeIdentity),
  });
}

function normalizeGitHead(value: unknown) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : null;
}

function normalizeReleaseHash(value: unknown) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function validTime(value: unknown) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function safeText(value: unknown, limit: number) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
