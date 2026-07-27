import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnv, PreflightError, validateConfig } from '../preflight.mjs';

const token = '0123456789abcdef0123456789abcdef';

test('云端预检要求回环监听、隔离目录和独立 Hermes Profile', () => {
  const checks = validateConfig('cloud', {
    NODE_ENV:'production',
    PORT:'4321',
    AJUN_HOST:'127.0.0.1',
    AGENT_ARMY_DEPLOYMENT_MODE:'cloud',
    AGENT_ARMY_EMPLOYEE_FEISHU_OWNER:'cloud',
    AGENT_ARMY_DATA_DIR:'/var/lib/agent-army',
    AGENT_ARMY_PRIVATE_DIR:'/var/lib/agent-army/private',
    AGENT_ARMY_WORKER_TOKEN:token,
    AJUN_HERMES_NATIVE_FEISHU:'true',
    AJUN_HERMES_NATIVE_EMPLOYEE_IDS:'intel-researcher,office-assistant',
    AJUN_HERMES_COMMAND:'/usr/local/bin/hermes',
    AJUN_HERMES_HOME:'/var/lib/agent-army/hermes/profiles/ajun',
    AGENT_ARMY_HERMES_PROFILE_ROOT:'/var/lib/agent-army/hermes/profiles',
    PAPERCLIP_URL:'http://127.0.0.1:3100'
  });

  assert.ok(checks.includes('回环监听'));
  assert.ok(checks.includes('员工飞书唯一接管'));
  assert.ok(checks.includes('Hermes Profile 隔离'));
});

test('云端预检拒绝公网监听、宽泛目录和模板令牌', () => {
  const base = {
    NODE_ENV:'production',
    PORT:'4321',
    AJUN_HOST:'127.0.0.1',
    AGENT_ARMY_DEPLOYMENT_MODE:'cloud',
    AGENT_ARMY_EMPLOYEE_FEISHU_OWNER:'cloud',
    AGENT_ARMY_DATA_DIR:'/var/lib/agent-army',
    AGENT_ARMY_PRIVATE_DIR:'/var/lib/agent-army/private',
    AGENT_ARMY_WORKER_TOKEN:token,
    AJUN_HERMES_NATIVE_FEISHU:'true',
    AJUN_HERMES_NATIVE_EMPLOYEE_IDS:'intel-researcher,office-assistant',
    AJUN_HERMES_COMMAND:'/usr/local/bin/hermes',
    AJUN_HERMES_HOME:'/var/lib/agent-army/hermes/profiles/ajun',
    AGENT_ARMY_HERMES_PROFILE_ROOT:'/var/lib/agent-army/hermes/profiles',
    PAPERCLIP_URL:'http://127.0.0.1:3100'
  };
  assert.throws(() => validateConfig('cloud', { ...base, AJUN_HOST:'0.0.0.0' }), PreflightError);
  assert.throws(() => validateConfig('cloud', { ...base, AGENT_ARMY_EMPLOYEE_FEISHU_OWNER:'local' }), PreflightError);
  assert.throws(() => validateConfig('cloud', { ...base, AGENT_ARMY_DATA_DIR:'/' }), PreflightError);
  assert.throws(() => validateConfig('cloud', { ...base, AGENT_ARMY_WORKER_TOKEN:'CHANGE_ME_WITH_A_RANDOM_VALUE_OF_AT_LEAST_32_CHARACTERS' }), PreflightError);
});

test('Mac 预检只接受 IAP 映射的回环云地址和本机小D地址', () => {
  const base = {
    AGENT_ARMY_CLOUD_TRANSPORT:'iap-ssh',
    AGENT_ARMY_CLOUD_URL:'http://127.0.0.1:44321',
    AGENT_ARMY_WORKER_TOKEN:token,
    AGENT_ARMY_WORKER_ID:'boss-mac',
    AGENT_ARMY_NODE_BIN:'/Users/example/.local/bin/node',
    AGENT_ARMY_GCLOUD_BIN:'/opt/homebrew/bin/gcloud',
    AGENT_ARMY_GCP_PROJECT:'agent-army-test-123',
    AGENT_ARMY_GCP_ZONE:'us-central1-a',
    AGENT_ARMY_GCP_INSTANCE:'agent-army-office',
    AGENT_ARMY_IAP_LOCAL_PORT:'44321',
    XIAOD_RUNTIME_URL:'http://127.0.0.1:4318',
    AGENT_ARMY_WORKER_POLL_MS:'5000'
  };
  assert.ok(validateConfig('mac', base).includes('Google IAP SSH 私有隧道'));
  assert.throws(() => validateConfig('mac', { ...base, AGENT_ARMY_CLOUD_URL:'https://army-office.example.ts.net' }), PreflightError);
  assert.throws(() => validateConfig('mac', { ...base, AGENT_ARMY_IAP_LOCAL_PORT:'44322' }), PreflightError);
  assert.throws(() => validateConfig('mac', { ...base, XIAOD_RUNTIME_URL:'http://192.168.1.5:4318' }), PreflightError);
});

test('配置解析不展开变量且错误不会回显令牌', () => {
  const values = parseEnv('A=plain\nB="quoted"\nTOKEN=$DO_NOT_EXPAND\n');
  assert.deepEqual(values, { A:'plain', B:'quoted', TOKEN:'$DO_NOT_EXPAND' });
  const secret = 'sensitive-CHANGE_ME-value-that-must-not-be-printed';
  assert.throws(
    () => validateConfig('mac', {
      AGENT_ARMY_CLOUD_TRANSPORT:'iap-ssh',
      AGENT_ARMY_CLOUD_URL:'http://127.0.0.1:44321',
      AGENT_ARMY_WORKER_TOKEN:secret,
      AGENT_ARMY_WORKER_ID:'boss-mac',
      AGENT_ARMY_NODE_BIN:'/Users/example/.local/bin/node',
      AGENT_ARMY_GCLOUD_BIN:'/opt/homebrew/bin/gcloud',
      AGENT_ARMY_GCP_PROJECT:'agent-army-test-123',
      AGENT_ARMY_GCP_ZONE:'us-central1-a',
      AGENT_ARMY_GCP_INSTANCE:'agent-army-office',
      AGENT_ARMY_IAP_LOCAL_PORT:'44321',
      XIAOD_RUNTIME_URL:'http://127.0.0.1:4318',
      AGENT_ARMY_WORKER_POLL_MS:'5000'
    }),
    (error) => !error.message.includes(secret)
  );
});
