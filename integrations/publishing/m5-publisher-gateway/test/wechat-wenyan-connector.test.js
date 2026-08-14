import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WenyanCliRunner,
  WechatWenyanConnector,
} from '../src/index.ts';

test('Wenyan runner 只执行版本核验和公众号草稿命令，临时文件随后清除', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wenyan-runner-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive:true, force:true }));
  const calls = [];
  let observedArticle = null;
  const runner = new WenyanCliRunner({
    executablePath:'/opt/local/bin/wenyan',
    temporaryRoot,
    execFile:async (executable, args, options) => {
      calls.push({ executable, args:[...args], env:{ ...options.env }, cwd:options.cwd });
      if (args[0] === '--version') return { stdout:'wenyan 2.0.11\n', stderr:'' };
      observedArticle = await fs.readFile(path.join(options.cwd, 'article.md'), 'utf8');
      assert.equal(await fs.readFile(path.join(options.cwd, 'images/cover.png'), 'utf8'), 'image');
      return { stdout:'发布成功，Media ID: draft-media-123\n', stderr:'' };
    },
  });
  const connector = new WechatWenyanConnector({
    runner,
    credentialResolver:async ({ secretRef, accountRef }) => ({
      secretRef,
      accountRef,
      appId:'wx-app-id',
      appSecret:'wx-app-secret',
    }),
    clock:() => new Date('2026-08-05T03:00:00.000Z'),
  });

  const result = await connector.createDraft({
    secretRef:'paperclip:secret:wechat-main',
    accountRef:'paperclip:account:wechat-main',
    articlePath:'article.md',
    files:[
      { relativePath:'article.md', createReadStream:() => Readable.from(['---\ntitle: Test\n---\nBody']) },
      { relativePath:'images/cover.png', createReadStream:() => Readable.from(['image']) },
    ],
    theme:'default',
    highlight:'solarized-light',
  });

  assert.equal(observedArticle.includes('title: Test'), true);
  assert.deepEqual(result, {
    state:'draft_created',
    externalDraftId:'draft-media-123',
    evidence:'wenyan:draft:draft-media-123',
    accountRef:'paperclip:account:wechat-main',
    draftCreatedAt:'2026-08-05T03:00:00.000Z',
  });
  assert.deepEqual(calls[0].args, ['--version']);
  assert.deepEqual(calls[1].args, [
    'publish', '-f', 'article.md', '-t', 'default',
    '--highlight', 'solarized-light', '--app-id', 'wx-app-id',
  ]);
  assert.equal(calls[1].env.WECHAT_APP_SECRET, 'wx-app-secret');
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
  assert.equal(runner.contract.groupSend, false);
  assert.equal(runner.contract.credentialsPersisted, false);
});

test('Wenyan runner 对白名单和凭据错误只返回脱敏错误', async () => {
  const runner = new WenyanCliRunner({
    execFile:async () => {
      const error = new Error('transport failed');
      error.stderr = 'invalid secret wx-sensitive-value';
      throw error;
    },
  });
  await assert.rejects(() => runner.preflight(), (error) => {
    assert.equal(error.code, 'wenyan_credential_rejected');
    assert.equal(error.message.includes('wx-sensitive-value'), false);
    return true;
  });
});
