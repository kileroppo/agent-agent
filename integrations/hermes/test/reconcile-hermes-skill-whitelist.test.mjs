import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  backupHermesSkillProfile,
  discoverHermesSkillPolicies,
  parseReconcileArgs,
  reconcileHermesSkillWhitelists
} from '../scripts/reconcile-hermes-skill-whitelist.mjs';

test('默认 dry-run 只报告未知和额外启用技能，不写 Profile', async () => {
  let writes = 0;
  const result = await reconcileHermesSkillWhitelists({
    ...singleAgentFixture('xiaod', ['paperclip']),
    inspectSkillState:async () => skillState({
      visible:['paperclip', 'mystery-skill', 'codex'],
      enabled:['paperclip', 'mystery-skill', 'codex']
    }),
    disableSkills:async () => {
      writes += 1;
      throw new Error('dry-run must not write');
    }
  });

  assert.equal(parseReconcileArgs([]).apply, false);
  assert.throws(() => parseReconcileArgs(['--apply', '--dry-run']), /不能同时使用/);
  assert.throws(() => parseReconcileArgs(['--apply']), /显式指定一个 --agent/);
  assert.equal(writes, 0);
  assert.equal(result[0].status, 'drift');
  assert.deepEqual(result[0].extraEnabledSkills, ['codex', 'mystery-skill']);
});

test('声明技能不可见或已禁用也属于漂移，不能被 clean 掩盖', async () => {
  const result = await reconcileHermesSkillWhitelists({
    ...singleAgentFixture('xiaod', ['paperclip', 'pdf']),
    inspectSkillState:async () => skillState({
      visible:['paperclip', 'pdf'],
      enabled:[],
      disabled:['paperclip', 'pdf'],
    }),
  });

  assert.equal(result[0].status, 'drift');
  assert.deepEqual(result[0].declaredDisabledSkills, ['paperclip', 'pdf']);
});

test('apply 只禁用未声明的 enabled skills，不启用创建官或架构师已禁用技能', async () => {
  const disabledCalls = [];
  const fixture = multiAgentFixture([
    ['creator', ['paperclip', 'paperclip-create-agent']],
    ['architect', ['paperclip', 'paperclip-converting-plans-to-tasks']]
  ]);
  const states = new Map([
    ['creator', skillState({
      visible:['paperclip', 'paperclip-create-agent', 'terminal'],
      enabled:['paperclip', 'terminal'],
      disabled:['paperclip-create-agent']
    })],
    ['architect', skillState({
      visible:['paperclip', 'paperclip-converting-plans-to-tasks', 'computer-use'],
      enabled:['paperclip', 'computer-use'],
      disabled:['paperclip-converting-plans-to-tasks']
    })]
  ]);

  const result = await reconcileHermesSkillWhitelists({
    ...fixture,
    apply:true,
    inspectSkillState:async ({ agentId }) => states.get(agentId),
    disableSkills:async ({ agentId }, skills) => {
      disabledCalls.push({ agentId, skills });
      const before = states.get(agentId);
      const disabled = [...new Set([...before.disabledSkills, ...skills])].sort();
      const after = skillState({
        visible:before.visibleSkills,
        enabled:before.enabledSkills.filter((name) => !skills.includes(name)),
        disabled
      });
      states.set(agentId, after);
      return { ...after, newlyDisabled:skills };
    }
  });

  assert.deepEqual(disabledCalls, [
    { agentId:'architect', skills:['computer-use'] },
    { agentId:'creator', skills:['terminal'] }
  ]);
  assert.ok(result.every((item) => item.status === 'remaining-drift'));
  assert.deepEqual(result.find((item) => item.agentId === 'creator').declaredDisabledSkills, ['paperclip-create-agent']);
  assert.deepEqual(result.find((item) => item.agentId === 'architect').declaredDisabledSkills, ['paperclip-converting-plans-to-tasks']);
});

test('自动发现新增 active Hermes Agent，不依赖第二份岗位名单', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-skills-'));
  try {
    await writeManifest(temporaryRoot, 'xiaod', ['paperclip']);
    await writeManifest(temporaryRoot, 'extra-agent', ['extra-skill']);
    await writeManifest(temporaryRoot, 'retired-agent', ['old-skill'], 'retired');
    const policies = await discoverHermesSkillPolicies({
      agentsRoot:temporaryRoot,
      profileHomeFor:(agentId) => `/profiles/${agentId}`
    });
    assert.deepEqual(policies.map((item) => item.agentId), ['extra-agent', 'xiaod']);
  } finally {
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  }
});

test('默认运行中的 A君检查 Hermes default Profile，不拿隔离回退 Profile 冒充线上', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-ajun-'));
  try {
    await writeManifest(temporaryRoot, 'ajun', ['paperclip']);
    const [policy] = await discoverHermesSkillPolicies({ agentsRoot:temporaryRoot, agentIds:['ajun'] });
    assert.equal(policy.profileHome, path.join(os.homedir(), '.hermes'));
  } finally {
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  }
});

test('岗位可为常驻 Gateway 显式声明比任务 Profile 更窄的技能白名单', async () => {
  const fixture = multiAgentFixture([['ajun', ['paperclip']]], {
    manifestOverrides:{ ajun:{ runtimeCapabilities:{ skills:['paperclip'], gatewaySkills:[] } } },
  });
  const [policy] = await discoverHermesSkillPolicies(fixture);
  assert.deepEqual(policy.allowedSkills, []);
});

test('A君本机执行且 Profile 尚未创建的隐私岗位不进入 Hermes 技能白名单检查', async () => {
  const fixture = multiAgentFixture([
    ['xiaod', ['paperclip']],
    ['wechat-chat-retriever', ['yichen-wechat-local-vault']]
  ], {
    manifestOverrides:{
      'wechat-chat-retriever':{ executionOwner:'ajun-local' }
    }
  });
  const policies = await discoverHermesSkillPolicies(fixture);
  assert.deepEqual(policies.map((item) => item.agentId), ['xiaod']);
  await assert.rejects(
    () => discoverHermesSkillPolicies({ ...fixture, agentIds:['wechat-chat-retriever'] }),
    /不是独立管理的 active Hermes Profile 岗位/
  );
});

test('apply 可重复运行：首次收敛，第二次不再写入', async () => {
  let state = skillState({
    visible:['paperclip', 'unknown-skill'],
    enabled:['paperclip', 'unknown-skill']
  });
  let writes = 0;
  const options = {
    ...singleAgentFixture('xiaod', ['paperclip']),
    apply:true,
    inspectSkillState:async () => state,
    disableSkills:async (_policy, skills) => {
      writes += 1;
      state = skillState({
        visible:state.visibleSkills,
        enabled:state.enabledSkills.filter((name) => !skills.includes(name)),
        disabled:[...state.disabledSkills, ...skills]
      });
      return { ...state, newlyDisabled:skills };
    }
  };

  const first = await reconcileHermesSkillWhitelists(options);
  const second = await reconcileHermesSkillWhitelists(options);
  assert.equal(writes, 1);
  assert.equal(first[0].status, 'applied');
  assert.equal(second[0].status, 'clean');
  assert.deepEqual(second[0].newlyDisabledSkills, []);
});

test('apply 先建立 config.yaml 的精确备份，成功后移除事务标记', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-skills-'));
  const profileHome = path.join(temporaryRoot, 'profile');
  const configPath = path.join(profileHome, 'config.yaml');
  const original = 'model:\n  provider: fixture\nskills:\n  disabled: []\n';
  try {
    await writeManifest(temporaryRoot, 'xiaod', ['paperclip']);
    await fs.mkdir(profileHome);
    await fs.writeFile(configPath, original, { mode:0o640 });
    let state = skillState({
      visible:['paperclip', 'newly-installed-skill'],
      enabled:['paperclip', 'newly-installed-skill']
    });
    const [result] = await reconcileHermesSkillWhitelists({
      agentsRoot:temporaryRoot,
      agentIds:['xiaod'],
      apply:true,
      profileHomeFor:() => profileHome,
      inspectSkillState:async () => state,
      disableSkills:async (_policy, skills) => {
        state = skillState({
          visible:state.visibleSkills,
          enabled:state.enabledSkills.filter((name) => !skills.includes(name)),
          disabled:[...state.disabledSkills, ...skills]
        });
        return { ...state, newlyDisabled:skills };
      }
    });

    assert.equal(result.status, 'applied');
    assert.equal(result.bundledSkillSeedingOptOut, true);
    assert.match(result.backupPath, /\.agent-army-skill-whitelist-backups/);
    assert.equal(await fs.readFile(path.join(result.backupPath, 'config.yaml'), 'utf8'), original);
    await fs.stat(path.join(profileHome, '.no-bundled-skills'));
    await assert.rejects(fs.stat(path.join(profileHome, '.agent-army-skill-whitelist-transaction.json')));
  } finally {
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  }
});

test('apply 发生写入或复查错误时，从精确备份回滚 config.yaml', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-skills-'));
  const profileHome = path.join(temporaryRoot, 'profile');
  const configPath = path.join(profileHome, 'config.yaml');
  const original = 'skills:\n  disabled: []\nmodel:\n  provider: fixture\n';
  try {
    await writeManifest(temporaryRoot, 'xiaod', ['paperclip']);
    await fs.mkdir(profileHome);
    await fs.writeFile(configPath, original, { mode:0o640 });
    await assert.rejects(
      () => reconcileHermesSkillWhitelists({
        agentsRoot:temporaryRoot,
        agentIds:['xiaod'],
        apply:true,
        profileHomeFor:() => profileHome,
        inspectSkillState:async () => skillState({
          visible:['paperclip', 'newly-installed-skill'],
          enabled:['paperclip', 'newly-installed-skill']
        }),
        disableSkills:async () => {
          await fs.writeFile(configPath, 'partially-written: true\n');
          throw new Error('simulated write failure');
        }
      }),
      /已从精确 config\.yaml 备份回滚/
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
    await assert.rejects(fs.stat(path.join(profileHome, '.agent-army-skill-whitelist-transaction.json')));
  } finally {
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  }
});

test('disable 命令静默成功但越权技能仍启用时，复查失败并回滚全部候选', async () => {
  const restored = [];
  const completed = [];
  const state = skillState({ visible:['paperclip', 'unknown-skill'], enabled:['paperclip', 'unknown-skill'] });
  await assert.rejects(
    () => reconcileHermesSkillWhitelists({
      ...singleAgentFixture('xiaod', ['paperclip']),
      apply:true,
      inspectSkillState:async () => state,
      disableSkills:async () => ({ ...state, newlyDisabled:['unknown-skill'] }),
      restoreProfileBackup:async (backup) => { restored.push(backup.agentId); },
      completeProfileBackup:async (backup) => { completed.push(backup.agentId); },
    }),
    /精确 config\.yaml 备份回滚/,
  );
  assert.deepEqual(restored, ['xiaod']);
  assert.deepEqual(completed, []);
});

test('备份拒绝符号链接 Profile 或 config，避免越界覆盖', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-skills-'));
  try {
    const target = path.join(temporaryRoot, 'target');
    const linked = path.join(temporaryRoot, 'linked-profile');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'config.yaml'), 'skills: {}\n');
    await fs.symlink(target, linked);
    await assert.rejects(
      () => backupHermesSkillProfile({ agentId:'xiaod', profileHome:linked }),
      /不是安全目录/
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  }
});

test('额外 Agent 的 Profile 不可检查时 apply 整体失败关闭，不产生部分写入', async () => {
  let writes = 0;
  const result = await reconcileHermesSkillWhitelists({
    ...multiAgentFixture([
      ['xiaod', ['paperclip']],
      ['extra-agent', ['extra-skill']]
    ]),
    apply:true,
    inspectSkillState:async ({ agentId }) => {
      if (agentId === 'extra-agent') throw new Error('fixture profile missing');
      return skillState({
        visible:['paperclip', 'unknown-skill'],
        enabled:['paperclip', 'unknown-skill']
      });
    },
    disableSkills:async () => {
      writes += 1;
    }
  });

  assert.equal(writes, 0);
  assert.equal(result.find((item) => item.agentId === 'extra-agent').status, 'inspection-error');
  assert.equal(result.find((item) => item.agentId === 'xiaod').status, 'apply-blocked');
});

function singleAgentFixture(agentId, skills) {
  return multiAgentFixture([[agentId, skills]]);
}

function multiAgentFixture(definitions, { manifestOverrides = {} } = {}) {
  const manifests = new Map(definitions.map(([agentId, skills]) => [
    path.posix.join('/agents', agentId, 'manifest.json'),
    JSON.stringify({
      agentId,
      status:'active',
      interaction:{ runtime:'hermes-profile' },
      runtimeCapabilities:{ skills },
      ...(manifestOverrides[agentId] || {})
    })
  ]));
  return {
    agentsRoot:'/agents',
    readDirectory:async () => definitions.map(([agentId]) => ({
      name:agentId,
      isDirectory:() => true
    })),
    readFile:async (filePath) => manifests.get(filePath),
    profileHomeFor:(agentId) => `/profiles/${agentId}`,
    inspectProfileSafeguards:async () => ({ bundledSkillSeedingOptOut:true }),
    enableBundledSkillOptOut:async () => true,
    backupProfile:async (policy) => ({
      agentId:policy.agentId,
      profileHome:policy.profileHome,
      root:`/backups/${policy.agentId}`,
      markerPath:`/markers/${policy.agentId}`
    }),
    restoreProfileBackup:async () => {},
    completeProfileBackup:async () => {}
  };
}

function skillState({ visible, enabled, disabled = [] }) {
  return {
    visibleSkills:[...visible].sort(),
    enabledSkills:[...enabled].sort(),
    disabledSkills:[...disabled].sort()
  };
}

async function writeManifest(root, agentId, skills, status = 'active') {
  const directory = path.join(root, agentId);
  await fs.mkdir(directory, { recursive:true });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    agentId,
    status,
    interaction:{ runtime:'hermes-profile' },
    runtimeCapabilities:{ skills }
  }));
}
