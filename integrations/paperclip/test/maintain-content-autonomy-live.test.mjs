import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertLiveConfirmation,
  LiveMaintenanceError,
  runLiveMaintenance,
} from '../scripts/maintain-content-autonomy-live.mjs';

const ids = {
  company:'11111111-1111-4111-8111-111111111111',
  plugin:'22222222-2222-4222-8222-222222222222',
  campaign:'33333333-3333-4333-8333-333333333333',
  routine:'44444444-4444-4444-8444-444444444444',
  secret:'55555555-5555-4555-8555-555555555555',
};

test('默认dry-run完成全部只读门禁且不卸载、不打补丁、不kickstart', async () => {
  const harness = createHarness();
  const result = await runLiveMaintenance({
    input:harness.input,
    api:harness.api,
    processControl:harness.processControl,
    compat:harness.compat,
    inspectBundle:harness.inspectBundle,
  });
  assert.equal(result.status, 'dry_run_ready');
  assert.equal(result.preflight.pluginVersion, '0.4.7');
  assert.equal(result.preflight.campaignDraft, true);
  assert.equal(result.preflight.cronOff, true);
  assert.equal(result.preflight.backupHealthy, true);
  assert.deepEqual(harness.mutations, []);
});

test('execute按软卸载→同ID重装→配置保留→compat→kickstart→复核执行', async () => {
  const harness = createHarness();
  const result = await runLiveMaintenance({
    mode:'execute',
    input:harness.input,
    api:harness.api,
    processControl:harness.processControl,
    compat:harness.compat,
    inspectBundle:harness.inspectBundle,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.pluginId, ids.plugin);
  assert.equal(result.pluginVersion, '0.4.9');
  assert.equal(result.pidBefore, 100);
  assert.equal(result.pidAfter, 200);
  assert.equal(result.configPreserved, true);
  assert.equal(result.stateScopePreserved, true);
  assert.deepEqual(harness.mutations, [
    'delete:no-purge',
    'install:0.4.9',
    'compat:apply',
    'kickstart',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
});

test('变更后任一步失败只返回一个可执行rollback恢复动作', async () => {
  const harness = createHarness({ failInstall:true });
  await assert.rejects(
    runLiveMaintenance({
      mode:'execute',
      input:harness.input,
      api:harness.api,
      processControl:harness.processControl,
      compat:harness.compat,
      inspectBundle:harness.inspectBundle,
    }),
    (error) => {
      assert.equal(error instanceof LiveMaintenanceError, true);
      assert.equal(error.stage, 'install_0_4_9');
      assert.deepEqual(Object.keys(error.recoveryAction).sort(), ['args', 'command']);
      assert.equal(error.recoveryAction.args.includes('rollback'), true);
      return true;
    },
  );
  assert.deepEqual(harness.mutations, ['delete:no-purge', 'install:failed']);
});

test('rollback先幂等保留binary-RPC host补丁再软装0.4.7并只kickstart Paperclip', async () => {
  const harness = createHarness({ pluginVersion:'0.4.9' });
  const result = await runLiveMaintenance({
    mode:'rollback',
    input:harness.input,
    api:harness.api,
    processControl:harness.processControl,
    compat:harness.compat,
    inspectBundle:harness.inspectBundle,
  });
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.pluginVersion, '0.4.7');
  assert.deepEqual(harness.mutations, [
    'compat:apply',
    'delete:no-purge',
    'install:0.4.7',
    'kickstart',
  ]);
});

test('版本、draft、Cron或备份门禁失败时Provider与live状态均不变', async () => {
  for (const override of [
    { healthVersion:'2026.999.0' },
    { campaignStatus:'active' },
    { cronEnabled:true },
    { backupStatus:'degraded' },
  ]) {
    const harness = createHarness(override);
    await assert.rejects(runLiveMaintenance({
      mode:'execute',
      input:harness.input,
      api:harness.api,
      processControl:harness.processControl,
      compat:harness.compat,
      inspectBundle:harness.inspectBundle,
    }), LiveMaintenanceError);
    assert.deepEqual(harness.mutations, []);
  }
});

test('CLI只接受0.4.9 execute确认串和0.4.7 rollback确认串，旧候选确认串失败关闭', () => {
  assert.doesNotThrow(() => assertLiveConfirmation(
    'execute',
    'I_ACCEPT_CONTENT_AUTONOMY_0_4_9_LIVE_MAINTENANCE',
  ));
  assert.doesNotThrow(() => assertLiveConfirmation(
    'rollback',
    'I_ACCEPT_CONTENT_AUTONOMY_0_4_7_ROLLBACK',
  ));
  for (const [mode, confirmation] of [
    ['execute', 'I_ACCEPT_CONTENT_AUTONOMY_0_4_7_LIVE_MAINTENANCE'],
    ['execute', 'I_ACCEPT_CONTENT_AUTONOMY_0_4_8_LIVE_MAINTENANCE'],
    ['execute', 'I_ACCEPT_CONTENT_AUTONOMY_0_4_9_ROLLBACK'],
    ['rollback', 'I_ACCEPT_CONTENT_AUTONOMY_0_4_6_ROLLBACK'],
    ['rollback', 'I_ACCEPT_CONTENT_AUTONOMY_0_4_9_ROLLBACK'],
    ['rollback', ''],
  ]) {
    assert.throws(
      () => assertLiveConfirmation(mode, confirmation),
      /缺少对应显式确认短语/,
    );
  }
});

function createHarness({
  pluginVersion = '0.4.7',
  failInstall = false,
  healthVersion = '2026.722.0',
  campaignStatus = 'draft',
  cronEnabled = false,
  backupStatus = 'ok',
} = {}) {
  const mutations = [];
  const config = {
    stepfunSecretRef:{ type:'secret_ref', secretId:ids.secret, version:'latest' },
    marker:'preserved',
  };
  const state = {
    plugin:{
      id:ids.plugin,
      pluginKey:'agent-army.content-autonomy',
      status:'ready',
      version:pluginVersion,
      packagePath:`/immutable/content-autonomy-${pluginVersion}`,
    },
    pid:100,
  };
  const input = {
    scriptPath:'/repo/integrations/paperclip/scripts/maintain-content-autonomy-live.mjs',
    apiBase:'http://127.0.0.1:3100',
    companyId:ids.company,
    pluginId:ids.plugin,
    campaignId:ids.campaign,
    routineId:ids.routine,
    newPluginPath:'/immutable/content-autonomy-0.4.9',
    oldPluginPath:'/immutable/content-autonomy-0.4.7',
    paperclipEntry:'/immutable/paperclip/index.js',
  };
  const health = () => ({
    status:'ok',
    version:healthVersion,
    databaseBackup:{
      enabled:true,
      status:backupStatus,
      latestBackup:{ name:'paperclip.sql.gz', sizeBytes:1024 },
      warnings:[],
    },
  });
  const api = {
    async get(route) {
      if (route === '/api/health') return health();
      if (route === `/api/plugins/${ids.plugin}`) return structuredClone(state.plugin);
      if (route.startsWith(`/api/plugins/${ids.plugin}/config?`)) {
        return { configJson:structuredClone(config) };
      }
      if (route === `/api/cases/${ids.campaign}`) {
        return {
          id:ids.campaign,
          companyId:ids.company,
          fields:{ campaignGrant:{ status:campaignStatus } },
        };
      }
      if (route === `/api/routines/${ids.routine}`) {
        return {
          id:ids.routine,
          companyId:ids.company,
          triggers:[{ kind:'schedule', enabled:cronEnabled }],
        };
      }
      if (route === `/api/plugins/${ids.plugin}/health`) {
        return { pluginId:ids.plugin, status:'ready', healthy:true };
      }
      throw new Error(`unexpected GET ${route}`);
    },
    async delete(route) {
      assert.equal(route, `/api/plugins/${ids.plugin}`);
      mutations.push('delete:no-purge');
      state.plugin.status = 'uninstalled';
      return structuredClone(state.plugin);
    },
    async post(route, body) {
      assert.equal(route, '/api/plugins/install');
      if (failInstall) {
        mutations.push('install:failed');
        throw new Error('injected install failure');
      }
      const version = body.packageName.endsWith('0.4.9') ? '0.4.9' : '0.4.7';
      mutations.push(`install:${version}`);
      state.plugin = {
        ...state.plugin,
        status:'ready',
        version,
        packagePath:body.packageName,
      };
      return structuredClone(state.plugin);
    },
  };
  const processControl = {
    pid:async () => state.pid,
    kickstart:async () => {
      mutations.push('kickstart');
      state.pid = 200;
    },
    waitForHealth:async () => health(),
  };
  const compat = {
    apply:async ({ pluginEntry, expectedPluginVersion } = {}) => {
      if (expectedPluginVersion) {
        assert.equal(expectedPluginVersion, '0.4.7');
        assert.equal(pluginEntry, '/immutable/content-autonomy-0.4.7/src/worker.js');
      } else {
        assert.equal(pluginEntry, '/immutable/content-autonomy-0.4.9/src/worker.js');
      }
      mutations.push('compat:apply');
    },
    rollback:async () => { mutations.push('compat:rollback'); },
  };
  const inspectBundle = async (root, version) => ({
    root,
    summary:{ version, immutable:true, stepfunSha:`sha-${version}` },
  });
  return { input, api, processControl, compat, inspectBundle, mutations };
}
