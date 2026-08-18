import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  assertFleetProfileList,
  classifyProfileRoute,
  replaceEnvValues,
  requireAll,
  resolvePrepareProfile,
  rewriteStepfunProvidersForDirect,
  rewriteSstefunProvider,
  rewriteStepfunProviders,
  setModelMaxTokens,
  validateDirectBackupManifest,
  verifyDirectBackupContents,
} from './manage.mjs';

test('prepare profile defaults safely and accepts an explicit profile', () => {
  assert.equal(resolvePrepareProfile([]), 'default');
  assert.equal(resolvePrepareProfile(['--profile', 'xiaod']), 'xiaod');
  assert.throws(() => resolvePrepareProfile(['xiaod']), /必须使用 --profile/);
});

test('full fleet direct migration requires an explicit --all acknowledgement', () => {
  assert.equal(requireAll(['--all']), true);
  assert.throws(() => requireAll([]), /direct --all/);
  assert.throws(() => requireAll(['--profile', 'ajun']), /direct --all/);
});

test('fleet-only safety gate rejects a partial Profile set', () => {
  const allProfiles = [
    'default', 'ajun', 'architect', 'content-creator', 'creator', 'intel-researcher',
    'office-assistant', 'operator', 'reviewer', 'technical-expert', 'video-content-analyst', 'xiaod',
  ];
  assert.doesNotThrow(() => assertFleetProfileList(allProfiles, 'test'));
  assert.throws(() => assertFleetProfileList(allProfiles.slice(1), 'test'), /精确包含 12/);
});

test('replaceEnvValues only replaces scoped values', () => {
  const result = replaceEnvValues('KEEP=yes\nSTEPFUN_API_KEY=old\n', {
    STEPFUN_API_KEY:'sk-virtual-key-1234567890',
    STEPFUN_BASE_URL:'http://127.0.0.1:4000',
  });
  assert.match(result, /^KEEP=yes$/m);
  assert.match(result, /^STEPFUN_API_KEY='sk-virtual-key-1234567890'$/m);
  assert.match(result, /^STEPFUN_BASE_URL='http:\/\/127\.0\.0\.1:4000'$/m);
  assert.doesNotMatch(result, /old/);
});

test('replaceEnvValues rejects duplicate keys', () => {
  assert.throws(
    () => replaceEnvValues('STEPFUN_API_KEY=one\nSTEPFUN_API_KEY=two\n', { STEPFUN_API_KEY:'three' }),
    /重复/,
  );
});

test('rewriteSstefunProvider changes only chat provider', () => {
  const source = `custom_providers:
  - name: sstefun
    base_url: https://api.stepfun.com/step_plan/v1
    api_key: \${STEPFUN_API_KEY}
    api_mode: chat_completions
  - name: stepfun
    base_url: https://api.stepfun.com/step_plan
    api_mode: anthropic_messages
platforms:
  feishu: {}
`;
  const result = rewriteSstefunProvider(source, 'http://127.0.0.1:4000');
  assert.match(result, /- name: sstefun\n    base_url: http:\/\/127\.0\.0\.1:4000/);
  assert.match(result, /api_key: \$\{STEPFUN_API_KEY\}/);
  assert.match(result, /- name: stepfun\n    base_url: https:\/\/api\.stepfun\.com\/step_plan/);
});

test('rewriteSstefunProvider rejects an unexpected upstream', () => {
  assert.throws(() => rewriteSstefunProvider(`custom_providers:
  - name: sstefun
    base_url: https://evil.example/v1
    api_key: \${STEPFUN_API_KEY}
`, 'http://127.0.0.1:4000'), /不是已知官方地址/);
});

test('rewriteStepfunProviders also routes the official anthropic fallback', () => {
  const source = `custom_providers:
  - name: sstefun
    base_url: https://api.stepfun.com/step_plan/v1
    api_key: \${STEPFUN_API_KEY}
  - name: stepfun
    base_url: https://api.stepfun.com/step_plan
    api_mode: anthropic_messages
`;
  const result = rewriteStepfunProviders(source, 'http://127.0.0.1:4000');
  assert.equal((result.match(/base_url: http:\/\/127\.0\.0\.1:4000/g) || []).length, 2);
  assert.match(result, /- name: stepfun\n    base_url: http:\/\/127\.0\.0\.1:4000\n    api_key: \$\{STEPFUN_API_KEY\}/);
});

test('rewriteStepfunProviders leaves a non-StepFun provider with the same name alone', () => {
  const source = `custom_providers:
  - name: stepfun
    base_url: https://token.sensenova.cn
    api_key: \${SENSENOVA_API_KEY}
  - name: sstefun
    base_url: https://api.stepfun.com/step_plan/v1
    api_key: \${STEPFUN_API_KEY}
`;
  const result = rewriteStepfunProviders(source, 'http://127.0.0.1:4000');
  assert.match(result, /- name: stepfun\n    base_url: https:\/\/token\.sensenova\.cn/);
});

test('direct rewrite restores chat and Anthropic StepFun endpoints from the gateway only', () => {
  const source = `custom_providers:
  - name: sstefun
    base_url: http://127.0.0.1:4000
    api_key: \${STEPFUN_API_KEY}
  - name: stepfun
    base_url: http://127.0.0.1:4000
    api_key: \${STEPFUN_API_KEY}
    api_mode: anthropic_messages
  - name: stepfun
    base_url: https://token.sensenova.cn
    api_key: \${SENSENOVA_API_KEY}
`;
  const result = rewriteStepfunProvidersForDirect(source);
  assert.match(result, /- name: sstefun\n    base_url: https:\/\/api\.stepfun\.com\/step_plan\/v1/);
  assert.match(result, /- name: stepfun\n    base_url: https:\/\/api\.stepfun\.com\/step_plan\n    api_key: \$\{STEPFUN_API_KEY\}/);
  assert.match(result, /- name: stepfun\n    base_url: https:\/\/token\.sensenova\.cn\n    api_key: \$\{SENSENOVA_API_KEY\}/);
});

test('direct migration sets only top-level model.max_tokens to 8192', () => {
  const source = `model:
  provider: custom:sstefun
  default: step-3.7-flash
custom_providers:
  - name: sstefun
    base_url: http://127.0.0.1:4000
`;
  const result = setModelMaxTokens(source, 8192);
  assert.match(result, /^model:\n  max_tokens: 8192\n  provider:/);
  assert.doesNotMatch(result, /max_tokens: 8192\n.*max_tokens:/s);
  assert.throws(() => setModelMaxTokens('model:\n  max_tokens: 1\n  max_tokens: 2\n', 8192), /重复/);
});

test('route status is direct, gateway, or mixed without returning credentials', () => {
  const direct = classifyProfileRoute({
    envBaseUrl:'https://api.stepfun.com/step_plan/v1',
    sstefunBaseUrl:'https://api.stepfun.com/step_plan/v1',
    stepfunBaseUrl:'https://api.stepfun.com/step_plan',
    observedKey:'upstream-key',
    expectedVirtualKey:'sk-virtual-key-1234567890',
    upstreamKey:'upstream-key',
  });
  assert.equal(direct, 'direct');
  const gateway = classifyProfileRoute({
    envBaseUrl:'http://127.0.0.1:4000',
    sstefunBaseUrl:'http://127.0.0.1:4000',
    stepfunBaseUrl:null,
    observedKey:'sk-virtual-key-1234567890',
    expectedVirtualKey:'sk-virtual-key-1234567890',
    upstreamKey:'upstream-key',
  });
  assert.equal(gateway, 'gateway');
  assert.equal(classifyProfileRoute({
    envBaseUrl:'https://api.stepfun.com/step_plan/v1',
    sstefunBaseUrl:'http://127.0.0.1:4000',
    stepfunBaseUrl:null,
    observedKey:'upstream-key',
    expectedVirtualKey:'sk-virtual-key-1234567890',
    upstreamKey:'upstream-key',
  }), 'mixed');
});

test('gateway restore rejects a malformed, partial, or tampered direct backup', () => {
  const profiles = ['one', 'two'];
  const envOne = 'STEPFUN_API_KEY=one\n';
  const configOne = 'model:\n';
  const envTwo = 'STEPFUN_API_KEY=two\n';
  const configTwo = 'model:\n  default: step-3.7-flash\n';
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const manifest = {
    schemaVersion:'agent.army/model-gateway-direct-backup/v1',
    profiles:{
      one:{ '.env':digest(envOne), 'config.yaml':digest(configOne) },
      two:{ '.env':digest(envTwo), 'config.yaml':digest(configTwo) },
    },
  };
  assert.equal(validateDirectBackupManifest(manifest, profiles, profiles), true);
  const backups = new Map([
    ['one', { envContent:envOne, configContent:configOne }],
    ['two', { envContent:envTwo, configContent:configTwo }],
  ]);
  assert.equal(verifyDirectBackupContents(manifest, backups, profiles), true);
  assert.throws(
    () => validateDirectBackupManifest({ ...manifest, schemaVersion:'wrong' }, profiles, profiles),
    /schema/,
  );
  assert.throws(
    () => validateDirectBackupManifest({ ...manifest, profiles:{ one:manifest.profiles.one } }, profiles, profiles),
    /集合/,
  );
  backups.set('two', { envContent:'tampered', configContent:configTwo });
  assert.throws(() => verifyDirectBackupContents(manifest, backups, profiles), /内容校验失败/);
});
