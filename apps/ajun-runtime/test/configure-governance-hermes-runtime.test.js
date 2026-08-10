import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditApprovedSkillSource,
  configureGovernanceHermesRuntime,
  installAuditedSkillDirectory,
  parseProfileSyncArgs,
  resolveGovernanceMcpServerPath,
  readCurrentProfileState,
  redactHermesCommandError,
  setExactFeishuToolsets,
  syncGovernanceHermesProfiles,
} from '../scripts/configure-governance-hermes-runtime.mjs';

test('legacy full-config 导出入口失败关闭并引导使用 Profile sync', async () => {
  const commands = [];
  const copies = [];
  const installs = [];
  const toolsetWrites = [];
  await assert.rejects(
    configureGovernanceHermesRuntime({
      agentIds:['architect'],
      profileHomeFor:() => '/tmp/agent-army-test-profiles/architect',
      stat:async () => ({ isDirectory:() => true }),
      copyFile:async (source, target) => { copies.push({ source, target }); },
      auditSkillSource:fakeSkillAudit,
      installSkillDirectory:async (input) => { installs.push(input); },
      inspectProfileState:async () => ({ feishuToolsets:[] }),
      writeExactFeishuToolsets:async (input) => { toolsetWrites.push(input); },
      run:async (...input) => { commands.push(input); return { code:0 }; },
      fetchImpl:async () => {
        throw new Error('legacy full-config 必须在任何外部读取前失败');
      },
    }),
    /--dry-run.*--apply/,
  );
  assert.deepEqual(commands, []);
  assert.deepEqual(copies, []);
  assert.deepEqual(installs, []);
  assert.deepEqual(toolsetWrites, []);
});

test('skills-only 安装岗位声明的审计技能且不修改 Gateway', async () => {
  const commands = [];
  const copies = [];
  const installs = [];
  const result = await configureGovernanceHermesRuntime({
    agentIds:['office-assistant'],
    skillsOnly:true,
    profileHomeFor:() => '/tmp/agent-army-test-profiles/office-assistant',
    stat:async () => ({ isDirectory:() => true }),
    copyFile:async (source, target) => { copies.push({ source, target, kind:'file' }); },
    auditSkillSource:fakeSkillAudit,
    installSkillDirectory:async (input) => { installs.push(input); },
    run:async (command, args) => {
      commands.push({ command, args });
      return { code:0 };
    },
    ensureGatewayLoaded:async () => { throw new Error('skills-only 不得启动 Gateway'); },
    ensureGatewayStopped:async () => { throw new Error('skills-only 不得修改 Gateway'); },
    inspectProfileState:async () => { throw new Error('skills-only 不得读取运行时配置'); },
    writeExactFeishuToolsets:async () => { throw new Error('skills-only 不得写工具白名单'); },
    fetchImpl:async (url) => ({ ok:true, async json() {
      return new URL(url).pathname === '/api/companies'
        ? [{ id:'company-1', name:'Agent军团' }]
        : [{ slug:'paperclip', sourceLocator:'/opt/paperclip/skills/paperclip' }];
    } }),
  });

  assert.equal(result[0].executionMode, 'skills-only');
  assert.deepEqual(result[0].skills, ['paperclip', 'docx', 'xlsx', 'pdf', 'yichen-summary']);
  assert.equal(commands.length, 0);
  assert.equal(copies.filter((item) => item.kind === 'file').length, 0);
  assert.equal(installs.length, 5);
  assert.equal(installs.some((item) => item.sourceLocator.endsWith('/skills-lib/yichen-summary')), true);
  assert.equal(installs.some((item) => item.sourceLocator.endsWith('/skills/productivity/docx')), true);
  assert.equal(installs.some((item) => item.sourceLocator.endsWith('/skills/productivity/xlsx')), true);
  assert.equal(installs.some((item) => item.sourceLocator.endsWith('/skills/productivity/pdf')), true);
});

test('未进入审计清单的技能和越界目标在删除前失败关闭', async () => {
  await assert.rejects(
    auditApprovedSkillSource({
      slug:'unreviewed-skill',
      sourceLocator:'/tmp',
    }),
    /没有已批准的审计清单/,
  );
  await assert.rejects(
    installAuditedSkillDirectory({
      slug:'paperclip',
      sourceLocator:'/tmp/source',
      target:'/tmp/profile/skills/../escape',
      expectedHash:`${'a'.repeat(64)}`,
    }),
    /目标路径不匹配/,
  );
});

test('原子安装拒绝含符号链接的复制清单且不破坏旧技能', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-skill-atomic-'));
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'profile', 'skills', 'paperclip');
    await fs.mkdir(source, { recursive:true });
    await fs.mkdir(target, { recursive:true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'old-approved');
    await fs.symlink('/tmp', path.join(source, 'escape'));
    await assert.rejects(
      installAuditedSkillDirectory({
        slug:'paperclip',
        sourceLocator:source,
        target,
        expectedHash:`${'a'.repeat(64)}`,
      }),
      /符号链接/,
    );
    assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), 'old-approved');
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('Profile 最小同步 dry-run 对指定岗位零写入、零 MCP 和零 Gateway 动作', async (t) => {
  const root = await profileSyncFixture(['content-creator', 'reviewer']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  let commands = 0;
  const results = await syncGovernanceHermesProfiles({
    agentIds:['content-creator', 'reviewer'],
    mode:'dry-run',
    profileHomeFor:(agentId) => path.join(root, agentId),
    profileRootFor:() => root,
    readProfileState:async (profileHome) =>
      legacyProfileState(path.basename(profileHome)),
    run:async () => {
      commands += 1;
      throw new Error('dry-run 不得执行 Hermes 命令');
    },
  });

  assert.equal(commands, 0);
  assert.equal(results.length, 2);
  assert.equal(results.every((item) => item.gatewayActions === 0), true);
  assert.equal(results.every((item) => item.writesPerformed === false), true);
  assert.deepEqual(
    results[0].mcp.scope.mcpTools.added,
    ['agent_manual', 'local_ai_invoke', 'm5_stage_execute'],
  );
  assert.deepEqual(
    results[0].mcp.scope.taskTypes.added,
    [
      'content.campaign-image-generation',
      'content.campaign-render',
      'content.campaign-voice',
      'content.creation-program',
    ],
  );
  assert.deepEqual(
    results[1].mcp.scope.taskTypes.added,
    [
      'content.campaign-machine-review',
      'content.campaign-publish-approval',
      'content.campaign-verify',
    ],
  );
  assert.deepEqual(results[0].toolsets.removed, [
    'feishu_doc',
    'feishu_drive',
    'kanban',
  ]);
  for (const agentId of ['content-creator', 'reviewer']) {
    const profileHome = path.join(root, agentId);
    assert.equal(await fs.readFile(path.join(profileHome, 'SOUL.md'), 'utf8'), '旧 SOUL');
    assert.equal(await fs.readFile(path.join(profileHome, '.env'), 'utf8'), 'SECRET=fixture');
    assert.equal(
      await fs.stat(path.join(profileHome, '.agent-army-profile-sync-backups'))
        .then(() => true)
        .catch(() => false),
      false,
    );
  }
});

test('Profile 最小同步拒绝批准根或父链通过符号链接逃逸', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-profile-scope-')),
  );
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const escapedRoot = path.join(root, 'outside');
  const profileHome = path.join(escapedRoot, 'content-creator');
  const approvedRoot = path.join(root, 'approved-profiles');
  await fs.mkdir(profileHome, { recursive:true });
  await fs.writeFile(path.join(profileHome, 'config.yaml'), 'profile: fixture\n');
  await fs.writeFile(path.join(profileHome, 'SOUL.md'), '旧 SOUL');
  await fs.symlink(escapedRoot, approvedRoot);

  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator'],
      mode:'dry-run',
      profileHomeFor:(agentId) => path.join(approvedRoot, agentId),
      profileRootFor:() => approvedRoot,
      readProfileState:async () => legacyProfileState('content-creator'),
    }),
    /父链不存在或包含符号链接/,
  );
});

test('Profile apply 在任何写入前拒绝规划后发生的 SOUL 并发修改', async (t) => {
  const root = await profileSyncFixture(['content-creator']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const profileHome = path.join(root, 'content-creator');
  let replacedAfterPlanningRead = false;
  const fileSystem = {
    ...fs,
    readFile:async (candidate, ...args) => {
      const value = await fs.readFile(candidate, ...args);
      if (
        candidate === path.join(profileHome, 'SOUL.md')
        && !replacedAfterPlanningRead
      ) {
        replacedAfterPlanningRead = true;
        await fs.writeFile(candidate, '并发更新的 SOUL');
      }
      return value;
    },
  };

  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator'],
      mode:'apply',
      confirmed:true,
      profileHomeFor:() => profileHome,
      profileRootFor:() => root,
      readProfileState:async () => legacyProfileState('content-creator'),
      fileSystem,
      run:async (_command, args, options) =>
        applyFakeHermesConfig(legacyProfileState('content-creator'), args, options),
    }),
    /规划后已变化/,
  );
  assert.equal(await fs.readFile(path.join(profileHome, 'SOUL.md'), 'utf8'), '并发更新的 SOUL');
  assert.equal(
    await fs.stat(path.join(profileHome, '.agent-army-profile-sync-backups'))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test('Profile apply 在任何写入前拒绝规划后发生的 MCP 并发修改', async (t) => {
  const root = await profileSyncFixture(['content-creator']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const profileHome = path.join(root, 'content-creator');
  const state = legacyProfileState('content-creator');
  let reads = 0;

  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator'],
      mode:'apply',
      confirmed:true,
      profileHomeFor:() => profileHome,
      profileRootFor:() => root,
      readProfileState:async () => {
        reads += 1;
        const snapshot = structuredClone(state);
        if (reads === 1) state.mcp.timeout = 17;
        return snapshot;
      },
      run:async (_command, args, options) => applyFakeHermesConfig(state, args, options),
    }),
    /规划后已变化/,
  );
  assert.ok(reads >= 2);
  assert.equal(
    await fs.stat(path.join(profileHome, '.agent-army-profile-sync-backups'))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test('Profile apply 检出 backup 后的并发漂移并从该 backup 回滚', async (t) => {
  const root = await profileSyncFixture(['content-creator']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const profileHome = path.join(root, 'content-creator');
  const state = legacyProfileState('content-creator');
  let soulReads = 0;
  const fileSystem = {
    ...fs,
    readFile:async (candidate, ...args) => {
      const value = await fs.readFile(candidate, ...args);
      if (candidate === path.join(profileHome, 'SOUL.md')) {
        soulReads += 1;
        if (soulReads === 4) {
          await fs.writeFile(candidate, 'backup 后的并发 SOUL');
        }
      }
      return value;
    },
  };

  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator'],
      mode:'apply',
      confirmed:true,
      profileHomeFor:() => profileHome,
      profileRootFor:() => root,
      readProfileState:async () => structuredClone(state),
      fileSystem,
      run:async (_command, args, options) => applyFakeHermesConfig(state, args, options),
    }),
    /规划后已变化.*已从逐 Profile 备份恢复/,
  );
  assert.ok(soulReads >= 5);
  assert.equal(await fs.readFile(path.join(profileHome, 'SOUL.md'), 'utf8'), '旧 SOUL');
  assert.equal(
    await fs.stat(path.join(profileHome, '.agent-army-profile-sync-transaction.json'))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test('Profile 最小同步 apply 必须显式确认并在写入前备份非 secret 配置', async (t) => {
  const root = await profileSyncFixture(['content-creator']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator'],
      mode:'apply',
      profileHomeFor:(agentId) => path.join(root, agentId),
      profileRootFor:() => root,
      readProfileState:async () => legacyProfileState('content-creator'),
    }),
    /必须显式传入 --confirm-profile-sync/,
  );

  const state = legacyProfileState('content-creator');
  const commands = [];
  const markerModes = [];
  const results = await syncGovernanceHermesProfiles({
    agentIds:['content-creator'],
    mode:'apply',
    confirmed:true,
    profileHomeFor:(agentId) => path.join(root, agentId),
    profileRootFor:() => root,
    readProfileState:async () => structuredClone(state),
    now:() => new Date('2026-07-31T08:00:00.000Z'),
    run:async (_command, args, options) => {
      commands.push(args);
      if (args[0] === 'mcp' && args[1] === 'remove') {
        const markerState = await fs.stat(path.join(
          root,
          'content-creator',
          '.agent-army-profile-sync-transaction.json',
        ));
        markerModes.push(markerState.mode & 0o777);
      }
      return applyFakeHermesConfig(state, args, options);
    },
  });

  assert.equal(results[0].writesPerformed, true);
  assert.equal(results[0].gatewayActions, 0);
  assert.match(results[0].backupPath, /\.agent-army-profile-sync-backups/);
  assert.equal(
    await fs.readFile(path.join(results[0].backupPath, 'SOUL.md'), 'utf8'),
    '旧 SOUL',
  );
  assert.equal(
    await fs.readFile(path.join(results[0].backupPath, 'config.yaml'), 'utf8'),
    'profile: fixture\n',
  );
  const backupNames = await fs.readdir(results[0].backupPath);
  assert.deepEqual(backupNames.sort(), ['SOUL.md', 'config.yaml', 'manifest.json']);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(results[0].backupPath, 'manifest.json'), 'utf8'))
      .excludes.includes('.env'),
    true,
  );
  assert.ok(commands.some((args) => args[0] === 'mcp' && args[1] === 'add'));
  assert.ok(commands.some((args) => args.includes('agent-army:m5_stage_execute')));
  assert.ok(commands.some(
    (args) => String(args[0] || '').endsWith('set-feishu-toolsets.py')
      && args[1] === 'apply-toolsets',
  ));
  assert.equal(
    commands.some((args) => args[0] === 'tools' && args[1] === 'disable'),
    false,
  );
  assert.equal(commands.some((args) => args.includes('gateway')), false);
  assert.equal(await fs.readFile(path.join(root, 'content-creator', '.env'), 'utf8'), 'SECRET=fixture');
  assert.deepEqual(markerModes, [0o600]);
  assert.equal(
    await fs.stat(path.join(
      root,
      'content-creator',
      '.agent-army-profile-sync-transaction.json',
    )).then(() => true).catch(() => false),
    false,
  );
});

test('Profile apply 发现 stale transaction marker 时整批拒绝并只提示备份路径', async (t) => {
  const root = await profileSyncFixture(['content-creator', 'reviewer']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const profileHome = path.join(root, 'reviewer');
  const backupPath = path.join(
    profileHome,
    '.agent-army-profile-sync-backups',
    '2026-07-31T00-00-00-000Z',
  );
  const markerPath = path.join(
    profileHome,
    '.agent-army-profile-sync-transaction.json',
  );
  await fs.writeFile(
    markerPath,
    JSON.stringify({
      schemaVersion:'agent.army/hermes-profile-sync-transaction/v1',
      agentId:'reviewer',
      backupPath,
      sensitiveMarker:'must-not-echo',
    }),
    { mode:0o600 },
  );
  let commands = 0;

  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator', 'reviewer'],
      mode:'apply',
      confirmed:true,
      profileHomeFor:(agentId) => path.join(root, agentId),
      profileRootFor:() => root,
      readProfileState:async (candidate) =>
        legacyProfileState(path.basename(candidate)),
      run:async () => {
        commands += 1;
        return { code:0 };
      },
    }),
    (error) => {
      assert.match(error.message, new RegExp(backupPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(error.message.includes('must-not-echo'), false);
      return true;
    },
  );
  assert.equal(commands, 0);
  assert.equal(
    await fs.stat(path.join(root, 'content-creator', '.agent-army-profile-sync-backups'))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test('Profile 检查器把缺失 MCP 和 Feishu toolsets 安全归一为空状态', async () => {
  const state = await readCurrentProfileState('/tmp/fixture-profile', {
    run:async (_command, args, options) => {
      assert.equal(args[1], 'inspect');
      assert.equal(options.env.HERMES_HOME, '/tmp/fixture-profile');
      return {
        code:0,
        stdout:JSON.stringify({
          schemaVersion:1,
          status:'inspected',
          code:'ok',
          changed:false,
          state:{
            mcp:null,
            feishuToolsets:[],
          },
        }),
      };
    },
    pythonCommand:'/fixture/hermes-python',
    helperPath:'/fixture/set-feishu-toolsets.py',
  });
  assert.deepEqual(state, {
    mcp:null,
    feishuToolsets:[],
  });
});

test('Feishu 精确白名单写入拒绝未知 target 且不会启动 helper', async () => {
  let calls = 0;
  await assert.rejects(
    setExactFeishuToolsets({
      profileHome:'/tmp/fixture-profile',
      expectedCurrent:['legacy-toolset'],
      target:['skills', 'unknown-toolset'],
      run:async () => {
        calls += 1;
        return { code:0, stdout:'' };
      },
      pythonCommand:'/fixture/hermes-python',
      helperPath:'/fixture/set-feishu-toolsets.py',
    }),
    /必须是无重复的字符串列表/,
  );
  assert.equal(calls, 0);
});

test('Hermes helper 只在临时 Profile 精确写 Feishu 白名单并阻止 TOCTOU', async (t) => {
  const pythonCommand = process.env.AJUN_HERMES_PYTHON
    || path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/python');
  if (!await fs.access(pythonCommand).then(() => true).catch(() => false)) {
    t.skip('当前环境未安装 Hermes Python 解释器');
    return;
  }
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-helper-')),
  );
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const helperPath = fileURLToPath(new URL(
    '../../../integrations/hermes/scripts/set-feishu-toolsets.py',
    import.meta.url,
  ));
  const sensitiveMarker = 'fixture-sensitive-marker-never-print';
  const environment = { ...process.env, HERMES_HOME:root, NO_COLOR:'1' };
  await fs.writeFile(path.join(root, 'config.yaml'), '{}\n');
  const missingState = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'inspect'],
    { env:environment },
  );
  assert.equal(missingState.code, 0);
  assert.deepEqual(JSON.parse(missingState.stdout).state, {
    feishuToolsets:[],
    mcp:null,
  });

  await fs.writeFile(
    path.join(root, 'config.yaml'),
    [
      'platform_toolsets:',
      '  feishu:',
      '    - clarify',
      '    - legacy-toolset',
      'mcp_servers:',
      '  agent-army:',
      `    command: /tmp/${sensitiveMarker}`,
      '    args:',
      `      - /tmp/${sensitiveMarker}`,
      '    timeout: 290',
      '    env:',
      '      AGENT_ARMY_AGENT_ID: content-creator',
      `      PAPERCLIP_API_KEY: ${sensitiveMarker}`,
      '',
    ].join('\n'),
  );

  const inspected = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'inspect'],
    { env:environment },
  );
  assert.equal(inspected.code, 0);
  assert.equal(inspected.stdout.includes(sensitiveMarker), false);
  assert.equal(inspected.stderr.includes(sensitiveMarker), false);
  assert.deepEqual(JSON.parse(inspected.stdout).state.feishuToolsets, [
    'clarify',
    'legacy-toolset',
  ]);

  const target = ['clarify', 'memory', 'session_search', 'skills'];
  const applied = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'apply-toolsets'],
    {
      env:environment,
      input:JSON.stringify({
        schemaVersion:1,
        expectedCurrent:['clarify', 'legacy-toolset'],
        target,
      }),
    },
  );
  assert.equal(applied.code, 0);
  assert.deepEqual(JSON.parse(applied.stdout), {
    changed:true,
    code:'ok',
    schemaVersion:1,
    status:'updated',
  });

  const staleApply = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'apply-toolsets'],
    {
      env:environment,
      input:JSON.stringify({
        schemaVersion:1,
        expectedCurrent:['clarify', 'legacy-toolset'],
        target:[],
      }),
    },
  );
  assert.equal(staleApply.code, 3);
  assert.equal(JSON.parse(staleApply.stdout).code, 'expected_current_mismatch');

  const unapproved = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'apply-toolsets'],
    {
      env:environment,
      input:JSON.stringify({
        schemaVersion:1,
        expectedCurrent:target,
        target:['skills', 'unknown-toolset'],
      }),
    },
  );
  assert.equal(unapproved.code, 2);
  assert.equal(JSON.parse(unapproved.stdout).code, 'target_contains_unapproved_name');

  const verified = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'inspect'],
    { env:environment },
  );
  assert.equal(verified.code, 0);
  assert.deepEqual(JSON.parse(verified.stdout).state.feishuToolsets, target);
  assert.equal(verified.stdout.includes(sensitiveMarker), false);
});

test('Hermes helper 解析 raw YAML 并递归拒绝内联 credential/auth/private_key', async (t) => {
  const pythonCommand = process.env.AJUN_HERMES_PYTHON
    || path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/python');
  if (!await fs.access(pythonCommand).then(() => true).catch(() => false)) {
    t.skip('当前环境未安装 Hermes Python 解释器');
    return;
  }
  const helperPath = fileURLToPath(new URL(
    '../../../integrations/hermes/scripts/set-feishu-toolsets.py',
    import.meta.url,
  ));
  const sensitiveMarker = 'fixture-inline-secret-never-print';
  const unsafe = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'audit-config-secrets'],
    {
      env:{ ...process.env, NO_COLOR:'1' },
      input:[
        `provider: {auth: {credential: ${sensitiveMarker}}}`,
        `signing: {private_key: ${sensitiveMarker}}`,
      ].join('\n'),
    },
  );
  assert.equal(unsafe.code, 5);
  assert.equal(JSON.parse(unsafe.stdout).code, 'embedded_secret_detected');
  assert.equal(unsafe.stdout.includes(sensitiveMarker), false);
  assert.equal(unsafe.stderr.includes(sensitiveMarker), false);

  const unsafeInlineEnv = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'audit-config-secrets'],
    {
      env:{ ...process.env, NO_COLOR:'1' },
      input:`runtime: {env: ["STEPFUN_API_KEY=${sensitiveMarker}"]}`,
    },
  );
  assert.equal(unsafeInlineEnv.code, 5);
  assert.equal(JSON.parse(unsafeInlineEnv.stdout).code, 'embedded_secret_detected');
  assert.equal(unsafeInlineEnv.stdout.includes(sensitiveMarker), false);

  const safe = await runFixtureProcess(
    pythonCommand,
    [helperPath, 'audit-config-secrets'],
    {
      env:{ ...process.env, NO_COLOR:'1' },
      input:[
        'provider:',
        '  auth:',
        '    type: bearer',
        '    credential: env://STEPFUN_API_KEY',
        'signing: {private_key: secret://publisher/signing-key}',
        'runtime: {env: ["STEPFUN_API_KEY=${STEPFUN_API_KEY}"]}',
      ].join('\n'),
    },
  );
  assert.equal(safe.code, 0);
  assert.equal(JSON.parse(safe.stdout).status, 'safe');
});

test('Hermes 命令错误在截断前脱敏 secret、token、cookie、bearer 与本机路径', () => {
  const redacted = redactHermesCommandError([
    'api_key=fixture-api-key',
    'token: fixture-token',
    'cookie fixture-cookie',
    'Authorization: Bearer fixture-bearer',
    '/Users/example/private/config.yaml',
    '/home/example/private/config.yaml',
  ].join(' '));
  for (const secret of [
    'fixture-api-key',
    'fixture-token',
    'fixture-cookie',
    'fixture-bearer',
    '/Users/example',
    '/home/example',
  ]) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[LOCAL_PATH\]/);
  assert.ok(redacted.length <= 240);
});

test('默认 Hermes inspect/apply 在缺键临时 Profile 上一次收敛且二次 dry-run 无漂移', async (t) => {
  const hermesCommand = process.env.AJUN_HERMES_COMMAND
    || path.join(os.homedir(), '.local/bin/hermes');
  if (!await fs.access(hermesCommand).then(() => true).catch(() => false)) {
    t.skip('当前环境未安装 Hermes CLI');
    return;
  }
  const root = await profileSyncFixture(['content-creator']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const profileHome = path.join(root, 'content-creator');
  await fs.writeFile(path.join(profileHome, 'config.yaml'), '{}\n');

  const applied = await syncGovernanceHermesProfiles({
    agentIds:['content-creator'],
    mode:'apply',
    confirmed:true,
    profileHomeFor:() => profileHome,
    profileRootFor:() => root,
    now:() => new Date('2026-07-31T09:00:00.000Z'),
  });
  assert.equal(applied[0].writesPerformed, true);
  assert.deepEqual(
    (await readCurrentProfileState(profileHome)).feishuToolsets,
    ['clarify', 'memory', 'session_search', 'skills'],
  );

  const verified = await syncGovernanceHermesProfiles({
    agentIds:['content-creator'],
    mode:'dry-run',
    profileHomeFor:() => profileHome,
    profileRootFor:() => root,
  });
  assert.equal(verified[0].changed, false);
  assert.deepEqual(verified[0].changedSections, []);
});

test('Profile 最小同步在任何备份或 Hermes 命令前拒绝 config 明文凭据', async (t) => {
  const root = await profileSyncFixture(['content-creator']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const profileHome = path.join(root, 'content-creator');
  await fs.writeFile(path.join(profileHome, 'config.yaml'), 'provider_api_key: fixture-plaintext\n');
  let commands = 0;

  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator'],
      mode:'apply',
      confirmed:true,
      profileHomeFor:() => profileHome,
      profileRootFor:() => root,
      readProfileState:async () => legacyProfileState('content-creator'),
      run:async (_command, args) => {
        if (String(args[0] || '').endsWith('set-feishu-toolsets.py')
          && args[1] === 'audit-config-secrets') {
          return {
            code:5,
            stdout:JSON.stringify({
              schemaVersion:1,
              status:'error',
              code:'embedded_secret_detected',
              changed:false,
            }),
          };
        }
        commands += 1;
        return { code:0 };
      },
    }),
    /包含疑似明文凭据/,
  );
  assert.equal(commands, 0);
  assert.equal(
    await fs.stat(path.join(profileHome, '.agent-army-profile-sync-backups'))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test('Profile 最小同步失败后从逐岗位备份恢复 config 和 SOUL', async (t) => {
  const root = await profileSyncFixture(['content-creator']);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const profileHome = path.join(root, 'content-creator');
  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds:['content-creator'],
      mode:'apply',
      confirmed:true,
      profileHomeFor:() => profileHome,
      profileRootFor:() => root,
      readProfileState:async () => legacyProfileState('content-creator'),
      now:() => new Date('2026-07-31T08:10:00.000Z'),
      run:async (_command, args, options) => {
        const configAudit = fakeConfigAuditResult(args);
        if (configAudit) return configAudit;
        if (args[0] === 'mcp' && args[1] === 'remove') {
          await fs.writeFile(path.join(profileHome, 'config.yaml'), 'mutated: true\n');
        }
        if (args[0] === 'mcp' && args[1] === 'add') throw new Error('fixture apply failure');
        return applyFakeHermesConfig(legacyProfileState('content-creator'), args, options);
      },
    }),
    /已从逐 Profile 备份恢复非敏感配置/,
  );
  assert.equal(await fs.readFile(path.join(profileHome, 'SOUL.md'), 'utf8'), '旧 SOUL');
  assert.equal(await fs.readFile(path.join(profileHome, 'config.yaml'), 'utf8'), 'profile: fixture\n');
  assert.equal(await fs.readFile(path.join(profileHome, '.env'), 'utf8'), 'SECRET=fixture');
  assert.equal(
    await fs.stat(path.join(profileHome, '.agent-army-profile-sync-transaction.json'))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test('Profile 多岗位同步失败时按逆序恢复所有已写岗位', async (t) => {
  const agentIds = ['content-creator', 'reviewer'];
  const root = await profileSyncFixture(agentIds);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const states = Object.fromEntries(agentIds.map((agentId) => [agentId, legacyProfileState(agentId)]));
  const restoreOrder = [];
  const fileSystem = {
    ...fs,
    copyFile:async (source, target) => {
      if (String(source).includes('.agent-army-profile-sync-backups')) {
        restoreOrder.push(path.basename(path.dirname(target)));
      }
      return fs.copyFile(source, target);
    },
  };

  await assert.rejects(
    syncGovernanceHermesProfiles({
      agentIds,
      mode:'apply',
      confirmed:true,
      profileHomeFor:(agentId) => path.join(root, agentId),
      profileRootFor:() => root,
      readProfileState:async (profileHome) =>
        structuredClone(states[path.basename(profileHome)]),
      now:() => new Date('2026-07-31T08:20:00.000Z'),
      fileSystem,
      run:async (_command, args, options) => {
        const agentId = path.basename(options.env.HERMES_HOME);
        if (args[0] === 'mcp' && args[1] === 'remove') {
          await fs.writeFile(
            path.join(options.env.HERMES_HOME, 'config.yaml'),
            'mutated: true\n',
          );
        }
        if (agentId === 'reviewer' && args[0] === 'mcp' && args[1] === 'add') {
          throw new Error('fixture second profile failure');
        }
        return applyFakeHermesConfig(states[agentId], args, options);
      },
    }),
    /已从逐 Profile 备份恢复非敏感配置/,
  );

  assert.deepEqual([...new Set(restoreOrder)], ['reviewer', 'content-creator']);
  for (const agentId of agentIds) {
    const profileHome = path.join(root, agentId);
    assert.equal(await fs.readFile(path.join(profileHome, 'config.yaml'), 'utf8'), 'profile: fixture\n');
    assert.equal(await fs.readFile(path.join(profileHome, 'SOUL.md'), 'utf8'), '旧 SOUL');
  }
});

test('Profile 最小同步 CLI 强制 only、唯一模式和 apply 确认', () => {
  assert.deepEqual(
    parseProfileSyncArgs([
      '--dry-run',
      '--only',
      'content-creator,reviewer',
    ]),
    {
      mode:'dry-run',
      confirmed:false,
      agentIds:['content-creator', 'reviewer'],
    },
  );
  assert.deepEqual(
    parseProfileSyncArgs([
      '--apply',
      '--confirm-profile-sync',
      '--only',
      'content-creator,reviewer',
    ]),
    {
      mode:'apply',
      confirmed:true,
      agentIds:['content-creator', 'reviewer'],
    },
  );
  assert.throws(
    () => parseProfileSyncArgs(['--apply', '--only', 'content-creator']),
    /必须显式传入 --confirm-profile-sync/,
  );
  assert.throws(
    () => parseProfileSyncArgs(['--dry-run', '--apply', '--only', 'reviewer']),
    /必须且只能选择/,
  );
  assert.throws(
    () => parseProfileSyncArgs(['--dry-run', '--only', 'unknown-agent']),
    /未知或无效岗位/,
  );
});

test('Profile 同步可把 MCP 固定到仓库内的不可变 release，拒绝仓库外路径', () => {
  const repositoryRoot = '/fixture/agent-agent';
  const immutableServer = path.join(
    repositoryRoot,
    'work/runtime-releases-final/release-1/apps/ajun-runtime/src/agent-army-mcp-server.js',
  );
  assert.equal(resolveGovernanceMcpServerPath({
    override:immutableServer,
    currentScriptPath:path.join(repositoryRoot, 'apps/ajun-runtime/scripts/configure.mjs'),
    repositoryRoot,
  }), immutableServer);
  assert.throws(
    () => resolveGovernanceMcpServerPath({
      override:'/tmp/agent-army-mcp-server.js',
      repositoryRoot,
    }),
    /必须指向仓库内/,
  );
});

function fakeSkillAudit({ slug, sourceLocator }) {
  return {
    slug,
    realPath:sourceLocator,
    sha256:`fixture-${slug}`,
  };
}

async function profileSyncFixture(agentIds) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-profile-sync-')),
  );
  for (const agentId of agentIds) {
    const profileHome = path.join(root, agentId);
    await fs.mkdir(profileHome, { recursive:true });
    await fs.writeFile(path.join(profileHome, 'config.yaml'), 'profile: fixture\n');
    await fs.writeFile(path.join(profileHome, 'SOUL.md'), '旧 SOUL');
    await fs.writeFile(path.join(profileHome, '.env'), 'SECRET=fixture');
  }
  return root;
}

function legacyProfileState(agentId) {
  const isCreator = agentId === 'content-creator';
  const taskTypes = isCreator
    ? ['content.platform-draft', 'content.video-script-package']
    : ['governance.approval-review', 'governance.assurance-review'];
  const mcpTools = isCreator
    ? [
        'paperclip_assignment_get',
        'platform_content_draft_execute',
        'video_script_package_execute',
        'paperclip_assignment_complete',
      ]
    : [
        'capabilities',
        'task_list',
        'task_get',
        'task_create',
        'approval_list',
        'paperclip_assignment_get',
        'paperclip_assignment_complete',
      ];
  return {
    mcp:{
      enabled:true,
      command:process.execPath,
      args:[path.resolve('src/agent-army-mcp-server.js')],
      timeout:290,
      env:[
        `AGENT_ARMY_AGENT_ID=${agentId}`,
        `AGENT_ARMY_ALLOWED_AGENT_IDS=${agentId}`,
        `AGENT_ARMY_ALLOWED_TASK_TYPES=${taskTypes.join(',')}`,
        `AGENT_ARMY_ALLOWED_MCP_TOOLS=${mcpTools.join(',')}`,
        'AGENT_ARMY_ALLOW_MISSIONS=false',
        'PAPERCLIP_TASK_ID=${PAPERCLIP_TASK_ID}',
        'PAPERCLIP_RUN_ID=${PAPERCLIP_RUN_ID}',
        'PAPERCLIP_AGENT_ID=${PAPERCLIP_AGENT_ID}',
        'PAPERCLIP_API_KEY=${PAPERCLIP_API_KEY}',
      ],
    },
    feishuToolsets:[
      'clarify',
      'feishu_doc',
      'feishu_drive',
      'kanban',
      'memory',
      'session_search',
      'skills',
    ],
  };
}

function applyFakeHermesConfig(state, args, options = {}) {
  const configAudit = fakeConfigAuditResult(args);
  if (configAudit) return configAudit;
  if (String(args[0] || '').endsWith('set-feishu-toolsets.py')) {
    const payload = JSON.parse(options.input);
    if (JSON.stringify([...state.feishuToolsets].sort()) !== JSON.stringify(payload.expectedCurrent)) {
      return {
        code:3,
        stdout:JSON.stringify({
          schemaVersion:1,
          status:'error',
          code:'expected_current_mismatch',
          changed:false,
        }),
      };
    }
    const changed = JSON.stringify(payload.expectedCurrent) !== JSON.stringify(payload.target);
    state.feishuToolsets = [...payload.target];
    return {
      code:0,
      stdout:JSON.stringify({
        schemaVersion:1,
        status:changed ? 'updated' : 'unchanged',
        code:'ok',
        changed,
      }),
    };
  }
  if (args[0] === 'mcp' && args[1] === 'add') {
    const commandIndex = args.indexOf('--command');
    const envIndex = args.indexOf('--env');
    const argsIndex = args.indexOf('--args');
    state.mcp = {
      enabled:true,
      command:args[commandIndex + 1],
      args:args.slice(argsIndex + 1),
      timeout:state.mcp.timeout,
      env:args.slice(envIndex + 1, argsIndex),
    };
  }
  if (args[0] === 'config' && args.includes('mcp_servers.agent-army.timeout')) {
    state.mcp.timeout = Number(args.at(-1));
  }
  if (args[0] === 'tools' && args[1] === 'disable') {
    state.feishuToolsets = [];
  }
  if (args[0] === 'tools' && args[1] === 'enable') {
    const values = args.slice(args.indexOf('feishu') + 1)
      .filter((item) => !item.startsWith('agent-army:'));
    if (values.length) state.feishuToolsets = values;
  }
  return { code:0, stdout:'' };
}

function fakeConfigAuditResult(args) {
  if (
    String(args[0] || '').endsWith('set-feishu-toolsets.py')
    && args[1] === 'audit-config-secrets'
  ) {
    return {
      code:0,
      stdout:JSON.stringify({
        schemaVersion:1,
        status:'safe',
        code:'ok',
        changed:false,
      }),
    };
  }
  return null;
}

function runFixtureProcess(command, args, { env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio:['pipe', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout:stdout.trim(),
      stderr:stderr.trim(),
    }));
    child.stdin.end(input);
  });
}
