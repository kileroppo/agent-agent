import assert from 'node:assert/strict';
import test from 'node:test';
import { EmployeeFeishuConnectionError, EmployeeFeishuConnectionService } from '../src/employee-feishu-connection-service.ts';

function fixture() {
  const apps = [];
  const secrets = new Map();
  const started = [];
  const service = new EmployeeFeishuConnectionService({
    registry:{ async list() { return [
      { agentId:'intel-researcher', name:'小R', role:'研究公开资料', status:'active', independentRuntime:{ state:'model_transport_pending' } },
      { agentId:'office-assistant', name:'办公执行助理', role:'整理汇报', status:'active', independentRuntime:{ state:'channel_pending' } },
      { agentId:'operator', name:'运维官', role:'后台保障', status:'active' }
    ]; } },
    store:{
      async listApps() { return apps; },
      async getSecret(id) { return secrets.get(id) || null; },
      async upsertApp(app) { apps.push(app); return app; },
      async saveSecret(id, secret) { secrets.set(id, secret); }
    },
    fleet:{
      snapshot() { return {}; },
      async startApp(app) { started.push(app); return { status:'connected', message:'已连接。', agentId:app.agentId }; }
    }
  });
  return { service, apps, secrets, started };
}

test('本机接线页只保存首批员工最小飞书资料且不回显凭据', async () => {
  const { service, apps, secrets, started } = fixture();
  const result = await service.connect('intel-researcher', {
    appId:'cli_1234567890',
    appSecret:'employee-secret-value',
    allowedUserId:'ou_owner123456'
  });
  assert.equal(apps.length, 1);
  assert.equal(secrets.get('intel-researcher'), 'employee-secret-value');
  assert.equal(started.length, 1);
  assert.equal(result.channel.status, 'connected');
  assert.equal('appId' in result, false);
  assert.equal('appSecret' in result, false);
  assert.equal('allowedUserId' in result, false);
});

test('本机接线页拒绝后台岗位、错误 App ID 和会话 ID', async () => {
  const { service } = fixture();
  await assert.rejects(
    () => service.connect('operator', { appId:'cli_1234567890', appSecret:'employee-secret-value', allowedUserId:'ou_owner123456' }),
    EmployeeFeishuConnectionError
  );
  await assert.rejects(
    () => service.connect('office-assistant', { appId:'wrong', appSecret:'employee-secret-value', allowedUserId:'ou_owner123456' }),
    /App ID/
  );
  await assert.rejects(
    () => service.connect('office-assistant', { appId:'cli_1234567890', appSecret:'employee-secret-value', allowedUserId:'oc_chat123456' }),
    /open_id/
  );
});

test('接线状态显示独立模型和飞书是否就绪，但不返回应用资料', async () => {
  const { service, apps, secrets } = fixture();
  apps.push({ agentId:'office-assistant', appId:'cli_1234567890', allowedUserIds:['ou_owner123456'], allowedGroupIds:[] });
  secrets.set('office-assistant', 'employee-secret-value');
  const list = await service.list();
  const office = list.find((item) => item.agentId === 'office-assistant');
  const intel = list.find((item) => item.agentId === 'intel-researcher');
  assert.equal(office.configured, true);
  assert.deepEqual(office.model, { status:'verified', message:'模型调用已验证。' });
  assert.deepEqual(intel.model, { status:'pending_authorization', message:'独立身份已建立，模型授权和真实调用仍待完成。' });
  assert.deepEqual(office.requiredEvents, ['im.message.receive_v1']);
  assert.equal(JSON.stringify(list).includes('cli_1234567890'), false);
  assert.equal(JSON.stringify(list).includes('employee-secret-value'), false);
  assert.equal(JSON.stringify(list).includes('ou_owner123456'), false);
});
