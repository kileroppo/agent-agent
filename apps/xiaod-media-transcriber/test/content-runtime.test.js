import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/recovery.ts';
import { ContentAcquisitionError } from '../../../integrations/access/content-acquisition-center.ts';
import { ConnectionSelectionError, createContentRuntime } from '../src/content-runtime.ts';

test('a missing account connection becomes a recoverable user-input failure without credential instructions', () => {
  const error = new ContentAcquisitionError({
    code: 'connection_required', category: 'needs_input', safeMessage: '该来源需要先在 A君中连接账号。', recommendedAction: 'reauthorize'
  });
  const failure = classifyFailure(error);
  assert.equal(failure.category, 'needs_input');
  assert.equal(failure.retryable, false);
  assert.match(failure.recovery, /连接账号/);
  assert.doesNotMatch(failure.recovery, /Cookie|token|密码/i);
});

test('多个同平台账号没有默认值时停止选择，设置默认后稳定返回同一绑定', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-content-runtime-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const runtime = await createContentRuntime(root);
  const definition = (accountAlias, clientId) => ({
    provider:'xhs', accountAlias, clientId,
    grantedOperations:['read_media_metadata', 'read_content_images', 'download_authorized_media'],
    dataScope:['content:read'], allowedAgentIds:['xiaod']
  });
  const first = await runtime.connectionStore.createCookieBridgeConnection(definition('工作号', 'xhs_work'));
  const second = await runtime.connectionStore.createCookieBridgeConnection(definition('测试号', 'xhs_test'));
  runtime.connectionStore.get(first.connectionId).isDefault = false;
  await runtime.connectionStore.persist();
  await assert.rejects(
    () => runtime.resolveConnectionBindingForSource('https://www.xiaohongshu.com/explore/example'),
    (error) => error instanceof ConnectionSelectionError
      && error.provider === 'xhs'
      && error.candidates.length === 2
  );
  await runtime.connectionStore.setDefault(second.connectionId);
  const resolved = await runtime.resolveConnectionBindingForSource('https://www.xiaohongshu.com/explore/example');
  assert.deepEqual(resolved, {
    connectionId:second.connectionId,
    provider:'xhs',
    accountAlias:'测试号',
    selectionSource:'default'
  });
});
