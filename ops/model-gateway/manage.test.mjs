import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceEnvValues, rewriteSstefunProvider } from './manage.mjs';

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
