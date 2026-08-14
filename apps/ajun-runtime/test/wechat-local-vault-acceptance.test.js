import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WeChatLocalVaultAcceptance } from '../src/wechat-local-vault-acceptance.ts';

test('微信 Vault 合成验收只保存检查结果，不保存聊天原文或真实数据', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-vault-acceptance-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const acceptance = new WeChatLocalVaultAcceptance({
    artifactsDir:root,
    now:() => new Date('2026-07-29T06:00:00.000Z')
  });
  const result = await acceptance.run({
    proposal:{
      proposalId:'proposal-wechat-1',
      candidateManifest:{ agentId:'wechat-chat-retriever' }
    },
    testInstance:{ testInstanceId:'test-wechat-1' }
  });

  const artifact = result.artifactRefs[0];
  const reportText = await fs.readFile(fileURLToPath(artifact.location), 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(result.status, 'succeeded');
  assert.equal(report.mode, 'synthetic-only');
  assert.equal(report.realChatRead, false);
  assert.equal(report.checks.returnedMessageCount, 3);
  assert.equal(report.checks.externalSideEffects, 0);
  assert.equal(artifact.validation.noRawChatPersisted, true);
  assert.doesNotMatch(reportText, /SYNTHETIC_CHAT_(ALPHA|BETA|GAMMA)/);
  assert.doesNotMatch(reportText, /wxid_|salt|key=/i);
});
