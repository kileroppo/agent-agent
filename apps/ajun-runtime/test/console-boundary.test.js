import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../public/', import.meta.url);

test('A君控制台不提供日常派活或审批按钮', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8')
  ]);
  assert.match(html, /请在飞书交办与审批/);
  assert.doesNotMatch(html, /id="task-form"/);
  assert.doesNotMatch(html, /交给 A君处理/);
  assert.doesNotMatch(script, /api\('\/api\/tasks'/);
  assert.doesNotMatch(script, /approve-approval/);
  assert.doesNotMatch(script, /reject-approval/);
});
