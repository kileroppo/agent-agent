import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertContentAutonomyApprovalSnapshot,
  buildContentAutonomyApprovalSnapshot,
  readContentAutonomyApprovalSnapshot,
} from '../src/content-autonomy-plugin-snapshot.ts';

const plugin = {
  id:'11111111-1111-4111-8111-111111111111',
  pluginKey:'agent-army.content-autonomy',
  version:'0.2.0',
  status:'ready',
  manifestJson:{
    id:'agent-army.content-autonomy',
    version:'0.2.0',
    tools:[{ name:'media-probe' }],
  },
};
const configRecord = {
  configJson:{
    stepfunSecretRef:{
      type:'secret_ref',
      secretId:'22222222-2222-4222-8222-222222222222',
      version:'latest',
    },
    officialTtsVoices:['official-voice'],
  },
};

test('内容插件批准快照固定版本、manifest和公司配置且不保存Secret值', async () => {
  const adapter = {
    async request(method, path) {
      if (method === 'GET' && path === '/api/plugins') return [plugin];
      if (method === 'GET' && path.includes('/config?companyId=')) return configRecord;
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const snapshot = await readContentAutonomyApprovalSnapshot({
    adapter,
    companyId:'33333333-3333-4333-8333-333333333333',
  });
  assert.equal(snapshot.version, '0.2.0');
  assert.match(snapshot.manifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(snapshot.configHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(snapshot).includes('secretId'), false);
  await assert.doesNotReject(() => assertContentAutonomyApprovalSnapshot({
    adapter,
    companyId:'33333333-3333-4333-8333-333333333333',
    approved:snapshot,
  }));
});

test('配置或manifest漂移会使原批准快照失效', async () => {
  const approved = buildContentAutonomyApprovalSnapshot({ plugin, configRecord });
  const adapter = {
    async request(method, path) {
      if (method === 'GET' && path === '/api/plugins') return [{
        ...plugin,
        manifestJson:{ ...plugin.manifestJson, tools:[{ name:'media-probe' }, { name:'extra-tool' }] },
      }];
      if (method === 'GET' && path.includes('/config?companyId=')) return configRecord;
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  await assert.rejects(
    () => assertContentAutonomyApprovalSnapshot({
      adapter,
      companyId:'33333333-3333-4333-8333-333333333333',
      approved,
    }),
    /偏离活动批准快照/,
  );
});
