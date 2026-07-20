import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canAccessApi, loadLanShareKey, rotateLanShareKey } from '../src/lan-access.js';

const remote = (key) => ({ socket: { remoteAddress: '192.168.1.22' }, headers: key === undefined ? {} : { 'x-ajun-share-key': key } });

test('局域网请求必须提供正确配对口令，本机请求不需要', () => {
  const access = { enabled: true, key: 'a-very-long-local-share-key' };
  assert.equal(canAccessApi(remote(), access), false);
  assert.equal(canAccessApi(remote('wrong-key'), access), false);
  assert.equal(canAccessApi(remote(access.key), access), true);
  assert.equal(canAccessApi({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }, access), true);
});

test('局域网口令首次生成后可安全复用', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-lan-access-'));
  try {
    const file = path.join(directory, 'lan-share-key');
    const first = await loadLanShareKey(file, true); const second = await loadLanShareKey(file, true);
    assert.equal(first, second); assert.ok(first.length >= 24);
    assert.equal(await loadLanShareKey(file, false), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('轮换局域网口令后旧口令立即失效', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-lan-access-'));
  try {
    const file = path.join(directory, 'lan-share-key');
    const oldKey = await loadLanShareKey(file, true); const newKey = await rotateLanShareKey(file, true);
    assert.notEqual(newKey, oldKey);
    assert.equal(canAccessApi(remote(oldKey), { enabled:true, key:newKey }), false);
    assert.equal(canAccessApi(remote(newKey), { enabled:true, key:newKey }), true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
