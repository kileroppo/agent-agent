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

test('A君控制台只在本机提供员工接线，不把应用凭据写进页面或读取接口', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8')
  ]);
  assert.match(html, /员工模型与飞书入口/);
  assert.match(script, /name="appSecret" type="password"/);
  assert.match(script, /<strong>模型：<\/strong>/);
  assert.match(script, /独立身份已建立，模型授权和真实调用待完成/);
  assert.match(script, /打开模型授权/);
  assert.match(script, /employee-model-setup/);
  assert.match(script, /setupWindow\.opener = null/);
  assert.match(script, /employee-feishu-connections/);
  assert.doesNotMatch(html, /cli_[a-zA-Z0-9]{8,}/);
  assert.doesNotMatch(script, /sessionStorage\.setItem\([^)]*Secret/i);
  assert.doesNotMatch(script, /提交人：\$\{escapeHtml\(task\.requester\?\.ref/);
  assert.match(script, /requester\.kind === 'feishu-user'.*'飞书老板'/);
  assert.match(script, /\/\^ou_\[a-zA-Z0-9\]\+\$\//);
});

test('A君控制台复用通用账号连接状态，只提供脱敏查看和撤销', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8')
  ]);
  assert.match(html, /账号连接状态/);
  assert.match(html, /登录和续期仍在获批的连接器中完成/);
  assert.match(script, /\/api\/access-connections/);
  assert.match(script, /撤销连接/);
  assert.match(script, /受控凭据引用已登记/);
  assert.doesNotMatch(html, /name="(?:cookie|token|password|credential)"/i);
  assert.doesNotMatch(script, /connection\.(?:credentialRef|cookieBridgeClientId|cookie|token)/);
});
