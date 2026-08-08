import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuMediaJob, validateFeishuMediaInput } from '../src/feishu-media-intake.js';
import { JobStore } from '../src/store.js';

test('Feishu intake validates a media attachment and deduplicates by message and attachment index', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-intake-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uploadsDir = path.join(root, 'uploads');
  await fs.mkdir(uploadsDir);
  const incoming = path.join(root, 'meeting.mp3');
  await fs.writeFile(incoming, 'small test media');
  const store = new JobStore(root);
  await store.init();
  const body = { mediaPath: incoming, originalName: 'meeting.mp3', messageId: 'om_test_1', attachmentIndex: 0 };

  const first = await createFeishuMediaJob({ store, uploadsDir, body, maxBytes: 1024, allowedRoots: [root] });
  const second = await createFeishuMediaJob({ store, uploadsDir, body, maxBytes: 1024, allowedRoots: [root] });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(await fs.readFile(first.job.sourcePath, 'utf8'), 'small test media');
  assert.equal((await fs.stat(first.job.sourcePath)).mode & 0o777, 0o600);
});

test('Feishu intake rejects non-media names before touching the file system', () => {
  assert.equal(validateFeishuMediaInput({ mediaPath: '/tmp/a.txt', originalName: 'a.txt', messageId: 'om_test_1' }, 1024).status, 415);
});
