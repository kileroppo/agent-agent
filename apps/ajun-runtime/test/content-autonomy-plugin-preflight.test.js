import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectContentAutonomyPluginReadiness } from '@agent-army/m5-kernel/paperclip-content-autonomy-preflight';

const companyId = 'company-m5';
const plugin = { id:'plugin-content-autonomy', pluginKey:'agent-army.content-autonomy', status:'ready' };
const secretId = '55555555-5555-4555-8555-555555555555';
const roles = [
  'ajun',
  'intel-researcher',
  'xiaod',
  'video-content-analyst',
  'content-creator',
  'reviewer',
  'operator',
  'office-assistant',
];
const agents = roles.map((role) => ({
  id:`agent-${role}`,
  status:'idle',
  metadata:{ agentArmyId:role },
}));
const grants = {
  'agent-ajun':['campaign-preflight'],
  'agent-intel-researcher':[],
  'agent-xiaod':['stepfun-vision', 'media-probe', 'media-validate'],
  'agent-video-content-analyst':['stepfun-vision', 'media-probe', 'media-validate'],
  'agent-content-creator':[
    'stepfun-image-generate',
    'stepfun-image-edit',
    'stepfun-tts',
    'media-probe',
    'media-validate',
    'media-finalize',
    'remotion-props-write',
    'remotion-render',
    'social-card-render',
    'subtitle-layout-validate',
    'artifact-lineage-validate',
  ],
  'agent-reviewer':[
    'campaign-preflight',
    'media-probe',
    'media-validate',
    'subtitle-layout-validate',
    'artifact-package-write',
    'artifact-lineage-validate',
    'publish-preflight',
  ],
  'agent-operator':[],
  'agent-office-assistant':[],
};
const roleBindings = Object.fromEntries(roles.map((role) => [role, `agent-${role}`]));

function readyState() {
  return {
    configRecord:{
      pluginId:plugin.id,
      companyId,
      configJson:{
        stepfunSecretRef:{ type:'secret_ref', secretId, version:'latest' },
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:{
          visionInputPerMillionTokens:100,
          visionOutputPerMillionTokens:200,
          imagePerGeneration:3,
          ttsPerThousandCharacters:4,
        },
        agentRoleBindings:structuredClone(roleBindings),
        agentToolGrants:structuredClone(grants),
      },
    },
    secrets:[{ id:secretId, status:'active', provider:'local_encrypted' }],
    providers:[{ id:'local_encrypted', configured:true }],
    usage:{
      secretId,
      bindings:[{
        targetType:'plugin',
        targetId:plugin.id,
        configPath:'stepfunSecretRef',
        versionSelector:'latest',
      }],
    },
    workspace:{
      folderKey:'content-workspace',
      configured:true,
      healthy:true,
      readable:true,
      writable:true,
    },
  };
}

function adapterFor(state) {
  const calls = [];
  return {
    calls,
    async request(method, path) {
      assert.equal(method, 'GET');
      calls.push(path);
      if (path.startsWith(`/api/plugins/${plugin.id}/config?`)) return state.configRecord;
      if (path === `/api/companies/${companyId}/secrets`) return state.secrets;
      if (path === `/api/companies/${companyId}/secret-providers`) return state.providers;
      if (path === `/api/secrets/${secretId}/usage`) return state.usage;
      if (path.includes('/local-folders/content-workspace/status')) return state.workspace;
      throw new Error(`unexpected GET ${path}`);
    },
  };
}

test('批准/恢复预检只读元数据且完整配置通过', async () => {
  const adapter = adapterFor(readyState());
  const failures = await inspectContentAutonomyPluginReadiness({
    adapter,
    companyId,
    plugin,
    agents,
  });
  assert.deepEqual(failures, []);
  assert.equal(adapter.calls.every((path) => !/resolve|value|access-events/.test(path)), true);
});

test('旧字符串Secret配置失败关闭且不回显字符串内容', async () => {
  const state = readyState();
  state.configRecord.configJson.stepfunSecretRef = 'legacy-secret-ref-do-not-print';
  const adapter = adapterFor(state);
  const failures = await inspectContentAutonomyPluginReadiness({
    adapter,
    companyId,
    plugin,
    agents,
  });
  assert.match(failures.join('\n'), /secret_ref 对象/);
  assert.doesNotMatch(failures.join('\n'), /legacy-secret-ref-do-not-print/);
  assert.equal(adapter.calls.some((path) => path.includes('/usage')), false);
});

test('缺Secret绑定、岗位grant、费率、官方音色或工作区时均给出中文恢复动作', async () => {
  const state = readyState();
  state.usage.bindings = [];
  state.configRecord.configJson.agentToolGrants['agent-content-creator'] = [];
  state.configRecord.configJson.costRatesCents.imagePerGeneration = 0;
  state.configRecord.configJson.officialTtsVoices = [];
  state.workspace.healthy = false;
  const failures = await inspectContentAutonomyPluginReadiness({
    adapter:adapterFor(state),
    companyId,
    plugin,
    agents,
  });
  const message = failures.join('\n');
  assert.match(message, /重新保存插件配置/);
  assert.match(message, /content-creator.*grant/);
  assert.match(message, /费率必须全部为正数/);
  assert.match(message, /官方 TTS 音色/);
  assert.match(message, /content-workspace/);
});

test('岗位grant必须与M5最小bundle完全相等，额外工具和额外Agent都失败关闭', async (t) => {
  await t.test('A君不能额外取得审核或发布前置工具', async () => {
    const state = readyState();
    state.configRecord.configJson.agentToolGrants['agent-ajun'].push('publish-preflight');
    const failures = await inspectContentAutonomyPluginReadiness({
      adapter:adapterFor(state),
      companyId,
      plugin,
      agents,
    });
    assert.match(failures.join('\n'), /ajun.*完全一致/);
  });

  await t.test('未知工具不能混入已知岗位', async () => {
    const state = readyState();
    state.configRecord.configJson.agentToolGrants['agent-content-creator'].push('shell-exec');
    const failures = await inspectContentAutonomyPluginReadiness({
      adapter:adapterFor(state),
      companyId,
      plugin,
      agents,
    });
    assert.match(failures.join('\n'), /content-creator.*完全一致/);
  });

  await t.test('其他岗位UUID不能出现在内容插件授权中', async () => {
    const state = readyState();
    state.configRecord.configJson.agentToolGrants['agent-architect'] = [];
    const failures = await inspectContentAutonomyPluginReadiness({
      adapter:adapterFor(state),
      companyId,
      plugin,
      agents:[...agents, {
        id:'agent-architect',
        status:'idle',
        metadata:{ agentArmyId:'architect' },
      }],
    });
    assert.match(failures.join('\n'), /M5 内容岗位范围之外/);
  });

  await t.test('配置中的岗位UUID绑定必须与Paperclip当前岗位一致', async () => {
    const state = readyState();
    state.configRecord.configJson.agentRoleBindings.ajun = 'agent-reviewer';
    const failures = await inspectContentAutonomyPluginReadiness({
      adapter:adapterFor(state),
      companyId,
      plugin,
      agents,
    });
    assert.match(failures.join('\n'), /ajun.*UUID绑定/);
  });
});

test('Secret元数据不可用时不尝试解析值', async () => {
  const state = readyState();
  state.secrets[0].status = 'disabled';
  const adapter = adapterFor(state);
  const failures = await inspectContentAutonomyPluginReadiness({
    adapter,
    companyId,
    plugin,
    agents,
  });
  assert.match(failures.join('\n'), /Secret 元数据不存在或未启用/);
  assert.equal(adapter.calls.some((path) => path.includes('/usage')), false);
  assert.equal(adapter.calls.every((path) => !/resolve|value/.test(path)), true);
});
