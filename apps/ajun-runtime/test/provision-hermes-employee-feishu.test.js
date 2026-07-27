import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeEnv, provisionHermesEmployeeFeishu, ProvisionError } from '../scripts/provision-hermes-employee-feishu.mjs';

test('员工飞书资料只写入对应 Hermes Profile 且保留非托管配置', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'employee-hermes-feishu-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const privateDir = path.join(root, 'private');
  const profileRoot = path.join(root, 'profiles');
  await fs.mkdir(privateDir, { recursive:true });
  await fs.mkdir(path.join(profileRoot, 'intel-researcher'), { recursive:true });
  await fs.writeFile(path.join(privateDir, 'feishu-agent-apps.json'), JSON.stringify({
    apps:[{ agentId:'intel-researcher', appId:'cli_researcher123', allowedUserIds:['ou_owner123'] }]
  }));
  await fs.writeFile(path.join(privateDir, 'feishu-agent-secrets.json'), JSON.stringify({
    secrets:{ 'intel-researcher':'secret-value-that-is-long-enough' }
  }));
  await fs.writeFile(path.join(profileRoot, 'intel-researcher', '.env'), 'UNRELATED_SETTING=\"keep-me\"\nFEISHU_APP_ID=\"old\"\n');

  const result = await provisionHermesEmployeeFeishu({
    agentIds:['intel-researcher'],
    privateDir,
    profileRoot
  });
  const envPath = path.join(profileRoot, 'intel-researcher', '.env');
  const text = await fs.readFile(envPath, 'utf8');
  const stat = await fs.stat(envPath);

  assert.equal(result[0].configured, true);
  assert.match(text, /UNRELATED_SETTING="keep-me"/);
  assert.match(text, /FEISHU_APP_ID="cli_researcher123"/);
  assert.match(text, /FEISHU_APP_SECRET="secret-value-that-is-long-enough"/);
  assert.match(text, /FEISHU_ALLOWED_USERS="ou_owner123"/);
  assert.equal(stat.mode & 0o077, 0);
});

test('A君飞书资料迁移到默认 Hermes Home 而不是顾问 Profile', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-hermes-feishu-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const privateDir = path.join(root, 'private');
  const profileRoot = path.join(root, 'profiles');
  const defaultHermesHome = path.join(root, 'default-hermes');
  await fs.mkdir(privateDir, { recursive:true });
  await fs.mkdir(path.join(profileRoot, 'ajun'), { recursive:true });
  await fs.mkdir(defaultHermesHome, { recursive:true });
  await fs.writeFile(path.join(privateDir, 'feishu-agent-apps.json'), JSON.stringify({
    apps:[{ agentId:'ajun', appId:'cli_ajun12345678', allowedUserIds:['ou_owner123'] }]
  }));
  await fs.writeFile(path.join(privateDir, 'feishu-agent-secrets.json'), JSON.stringify({
    secrets:{ ajun:'secret-value-that-is-long-enough' }
  }));
  await fs.writeFile(path.join(defaultHermesHome, '.env'), 'KEEP=\"yes\"\n');

  const result = await provisionHermesEmployeeFeishu({
    agentIds:['ajun'],
    privateDir,
    profileRoot,
    defaultHermesHome
  });

  const defaultText = await fs.readFile(path.join(defaultHermesHome, '.env'), 'utf8');
  const advisorEnv = await fs.readFile(path.join(profileRoot, 'ajun', '.env'), 'utf8').catch(() => '');
  assert.equal(result[0].profileDir, defaultHermesHome);
  assert.match(defaultText, /KEEP="yes"/);
  assert.match(defaultText, /FEISHU_APP_ID="cli_ajun12345678"/);
  assert.equal(advisorEnv, '');
});

test('迁移器拒绝不在首批名单中的员工和不完整资料', async () => {
  await assert.rejects(
    () => provisionHermesEmployeeFeishu({ agentIds:['unknown-agent'] }),
    ProvisionError
  );
  assert.match(
    mergeEnv('FEISHU_APP_ID="old"\nKEEP="yes"\n', {
      FEISHU_APP_ID:'cli_new',
      FEISHU_APP_SECRET:'safe-secret',
      FEISHU_ALLOWED_USERS:'ou_owner',
      FEISHU_CONNECTION_MODE:'websocket',
      FEISHU_GROUP_POLICY:'allowlist',
      FEISHU_REQUIRE_MENTION:'true',
      FEISHU_ALLOW_BOTS:'none',
      FEISHU_ALLOW_ALL_USERS:'false'
    }),
    /^KEEP="yes"\nFEISHU_APP_ID="cli_new"/
  );
});
