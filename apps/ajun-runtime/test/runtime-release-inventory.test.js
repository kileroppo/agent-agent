import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  deleteReleaseSnapshot,
  listReleaseSnapshots,
  releaseProtectionMap,
  runtimeReleasesRoot,
} from '../src/runtime-release-inventory.ts';

const LIVE_HASH = 'a'.repeat(64);
const ROLLBACK_HASH = 'b'.repeat(64);
const OLD_HASH = 'c'.repeat(64);
const XIAOD_HASH = 'd'.repeat(64);

test('保护集合来自发布助手状态与小D运行版本', () => {
  const map = releaseProtectionMap(
    { current:{ releaseHash:LIVE_HASH }, rollback:{ releaseHash:ROLLBACK_HASH } },
    XIAOD_HASH,
  );
  assert.equal(map.get(LIVE_HASH), 'live');
  assert.equal(map.get(ROLLBACK_HASH), 'rollback');
  assert.equal(map.get(XIAOD_HASH), 'xiaod-live');
  assert.equal(releaseProtectionMap(null, null).size, 0);
});

test('清单只收录合法版本目录，按创建时间倒序并带保护标记', async (context) => {
  const root = await setupReleases(context);
  const releases = await listReleaseSnapshots(releaseProtectionMap({ current:{ releaseHash:LIVE_HASH }, rollback:{ releaseHash:ROLLBACK_HASH } }, XIAOD_HASH));

  assert.deepEqual(releases.map((item) => [item.releaseHash, item.product, item.protection]), [
    [XIAOD_HASH, 'xiaod', 'xiaod-live'],
    [OLD_HASH, 'ajun', null],
    [ROLLBACK_HASH, 'ajun', 'rollback'],
    [LIVE_HASH, 'ajun', 'live'],
  ]);
  assert.equal(releases[3].gitHead, 'f'.repeat(40));
});

test('删除拒绝非法版本号和受保护版本', async (context) => {
  const root = await setupReleases(context);
  const protectedHashes = releaseProtectionMap({ current:{ releaseHash:LIVE_HASH }, rollback:{ releaseHash:ROLLBACK_HASH } }, XIAOD_HASH);

  await assert.rejects(() => deleteReleaseSnapshot('not-a-hash', protectedHashes), /版本号格式不正确/);
  await assert.rejects(() => deleteReleaseSnapshot(LIVE_HASH, protectedHashes), /正在运行或是回滚目标/);
  await assert.rejects(() => deleteReleaseSnapshot('e'.repeat(64), protectedHashes), /已没有这个版本/);
  assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('ajun-runtime-release')).length, 3);
});

test('删除可清理只读快照目录本身', async (context) => {
  const root = await setupReleases(context);
  const target = path.join(root, `ajun-runtime-release-v1-${OLD_HASH}`);
  await fs.chmod(target, 0o555);

  const removed = await deleteReleaseSnapshot(OLD_HASH, new Map());
  assert.equal(removed, `ajun-runtime-release-v1-${OLD_HASH}`);
  await assert.rejects(() => fs.access(target), /ENOENT/);
});

async function setupReleases(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-release-inventory-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  context.after(() => { delete process.env.AGENT_ARMY_RELEASES_DIR; });
  process.env.AGENT_ARMY_RELEASES_DIR = root;
  assert.equal(runtimeReleasesRoot(), path.resolve(root));

  const birth = Date.now();
  await makeRelease(root, 'ajun', LIVE_HASH, { gitHead:'f'.repeat(40) }, birth - 4_000);
  await makeRelease(root, 'ajun', ROLLBACK_HASH, {}, birth - 3_000);
  await makeRelease(root, 'ajun', OLD_HASH, {}, birth - 2_000);
  await makeRelease(root, 'xiaod', XIAOD_HASH, {}, birth - 1_000);
  await fs.mkdir(path.join(root, 'not-a-release'));
  return root;
}

async function makeRelease(root, product, hash, manifest, mtime) {
  const dir = path.join(root, `${product}-runtime-release-v1-${hash}`);
  await fs.mkdir(dir, { recursive:true });
  await fs.writeFile(path.join(dir, 'release-manifest.json'), JSON.stringify({ kind:'agent-army/ajun-immutable-runtime-release', git:manifest.gitHead ? { gitHead:manifest.gitHead } : {} }));
  await fs.utimes(dir, new Date(mtime), new Date(mtime));
}
