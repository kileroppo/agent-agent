import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('A君运行台提供全军默认、岗位覆盖、能力专用模型和 Hermes 高级入口', async () => {
  const [html, app, consoleSource] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/stepfun-model-policy-console.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /军团模型策略/);
  assert.match(html, /应用到全部岗位/);
  assert.match(html, /保存岗位配置/);
  assert.match(html, /能力专用模型/);
  assert.match(html, /刷新账号模型/);
  assert.match(html, /查看官方说明/);
  assert.match(app, /createStepFunModelPolicyConsole/);
  assert.match(consoleSource, /\/api\/model-policy/);
  assert.match(consoleSource, /\/api\/model-policy\/refresh/);
  assert.match(consoleSource, /账号模型已刷新/);
  assert.match(consoleSource, /正在执行的会话不变/);
  assert.doesNotMatch(consoleSource, /api[_-]?key/i);
});
