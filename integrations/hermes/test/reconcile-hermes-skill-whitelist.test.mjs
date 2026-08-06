import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
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

function multiAgentFixture(definitions) {
  const manifests = new Map(definitions.map(([agentId, skills]) => [
    path.posix.join('/agents', agentId, 'manifest.json'),
    JSON.stringify({
      agentId,
      status:'active',
      interaction:{ runtime:'hermes-profile' },
      runtimeCapabilities:{ skills }
    })
  ]));
  return {
    agentsRoot:'/agents',
    readDirectory:async () => definitions.map(([agentId]) => ({
      name:agentId,
      isDirectory:() => true
    })),
    readFile:async (filePath) => manifests.get(filePath),
    profileHomeFor:(agentId) => `/profiles/${agentId}`
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
