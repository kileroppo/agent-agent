import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('M5 控制台显示负责人和恢复步骤，并按服务端预检禁用批准动作', async () => {
  const source = (await Promise.all([
    '../public/app.js',
    '../public/app-access-views.js',
    '../public/app-interactions.js',
  ].map((path) => fs.readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');

  assert.match(source, /<strong>当前负责人<\/strong>/);
  assert.match(source, /<strong>当前恢复步骤<\/strong>/);
  assert.match(source, /campaign\.status === 'draft' && campaign\.approval\?\.allowed === true/);
  assert.match(source, /data-campaign-action="approve"\$\{approvalAllowed \? '' : ' disabled'\}/);
  assert.match(source, /card\.dataset\.campaignApprovalAllowed !== 'true'/);
  assert.match(source, /failedClosed = action === 'approve'/);
  assert.match(source, /button\.disabled = failedClosed/);
});
