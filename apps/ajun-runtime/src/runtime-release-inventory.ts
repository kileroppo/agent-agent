import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RELEASE_DIR_PATTERN = /^(ajun|xiaod)-runtime-release-v1-([0-9a-f]{64})$/;

export type ReleaseProtection = 'live' | 'rollback' | 'xiaod-live' | null;

export function runtimeReleasesRoot(): string {
  if (process.env.AGENT_ARMY_RELEASES_DIR)
    return path.resolve(process.env.AGENT_ARMY_RELEASES_DIR);
  // 与发布助手的部署目录保持一致（install.mjs 固定为 ~/.agent-army/runtime-releases）。
  // 不跟随 AGENT_ARMY_PRIVATE_DIR：线上进程的私有目录是另一处子目录，会导致清单读空。
  return path.join(os.homedir(), '.agent-army', 'runtime-releases');
}

/** 汇总发布助手状态与 launchd 现状，得到所有不可删除的版本号。 */
export function releaseProtectionMap(helperStatus: any, xiaodLiveHash: string | null): Map<string, Exclude<ReleaseProtection, null>> {
  const protectedHashes = new Map<string, 'live' | 'rollback' | 'xiaod-live'>();
  const live = String(helperStatus?.current?.releaseHash || '').trim();
  if (live) protectedHashes.set(live, 'live');
  const rollback = String(helperStatus?.rollback?.releaseHash || '').trim();
  if (rollback) protectedHashes.set(rollback, 'rollback');
  if (xiaodLiveHash) protectedHashes.set(xiaodLiveHash, 'xiaod-live');
  return protectedHashes;
}

/** 读取小D服务的 launchd 配置，得到小D当前运行的版本号；读不到时返回 null（删除端应按保守策略处理）。 */
export async function readXiaodLiveReleaseHash(): Promise<string | null> {
  try {
    const plist = await fs.readFile(path.join(os.homedir(), 'Library/LaunchAgents/ai.agent-army.xiaod.plist'), 'utf8');
    const match = plist.match(/xiaod-runtime-release-v1-([0-9a-f]{64})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function listReleaseSnapshots(protectedHashes: Map<string, string>): Promise<any[]> {
  const root = runtimeReleasesRoot();
  let entries: any[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const releases: any[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(RELEASE_DIR_PATTERN);
    if (!match) continue;
    const [, product, releaseHash] = match;
    let gitHead = '';
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, entry.name, 'release-manifest.json'), 'utf8'));
      gitHead = String(manifest?.git?.gitHead || '');
    } catch {
      // 清单缺失时仍展示目录本身。
    }
    let createdAt = '';
    try {
      const stat = await fs.stat(path.join(root, entry.name));
      createdAt = stat.mtime.toISOString();
    } catch {
      createdAt = '';
    }
    releases.push({ releaseHash, product, gitHead, createdAt, protection: protectedHashes.get(releaseHash) || null });
  }
  releases.sort((a: any, b: any): number => String(b.createdAt).localeCompare(String(a.createdAt)));
  return releases;
}

export async function deleteReleaseSnapshot(releaseHash: string, protectedHashes: Map<string, string>): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(releaseHash))
    throw new Error('版本号格式不正确。');
  if (protectedHashes.has(releaseHash))
    throw new Error('该版本正在运行或是回滚目标，不能删除。');
  const root = runtimeReleasesRoot();
  const names = await fs.readdir(root);
  const dirName = names.find((name) => RELEASE_DIR_PATTERN.test(name) && name.endsWith(`-${releaseHash}`));
  if (!dirName)
    throw new Error('版本库中已没有这个版本。');
  const target = path.join(root, dirName);
  if (path.resolve(target, '..') !== path.resolve(root))
    throw new Error('版本路径校验失败。');
  // 发布快照整体只读且使用 APFS clone，先恢复可写再删除。
  await execFileAsync('chmod', ['-R', 'u+w', target]);
  await fs.rm(target, { recursive: true, force: true });
  return dirName;
}
