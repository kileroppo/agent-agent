import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../public/', import.meta.url);

async function readConsoleScripts() {
  return (await Promise.all([
    'app.js',
    'app-access-views.js',
    'app-interactions.js',
    'task-record-workbench.js',
  ].map((name) => readFile(new URL(name, root), 'utf8')))).join('\n');
}

test('A君控制台不提供日常派活或审批按钮', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readConsoleScripts()
  ]);
  assert.match(html, /派活和审批去飞书/);
  assert.doesNotMatch(html, /id="task-form"/);
  assert.doesNotMatch(html, /交给 A君处理/);
  assert.doesNotMatch(script, /api\('\/api\/tasks'/);
  assert.doesNotMatch(script, /approve-approval/);
  assert.doesNotMatch(script, /reject-approval/);
});

test('A君控制台只在本机提供员工接线，不把应用凭据写进页面或读取接口', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readConsoleScripts()
  ]);
  assert.match(html, /员工模型与飞书入口/);
  assert.match(script, /name="appSecret" type="password"/);
  assert.match(script, /<strong>模型：<\/strong>/);
  assert.match(script, /独立身份已建立，模型授权和真实调用待完成/);
  assert.match(html, /A君模型与 API/);
  assert.match(html, /data-model-setup-agent-id="ajun"/);
  assert.match(html, /设置 API 与 Key/);
  assert.match(script, /管理模型/);
  assert.match(script, /data-model-setup-target="models"/);
  assert.match(script, /data-model-setup-target="keys"/);
  assert.match(script, /payload\.setup\.modelUrl/);
  assert.match(script, /employee-model-setup/);
  assert.match(script, /setupWindow\.opener = null/);
  assert.match(script, /employee-feishu-connections/);
  assert.doesNotMatch(html, /cli_[a-zA-Z0-9]{8,}/);
  assert.doesNotMatch(script, /sessionStorage\.setItem\([^)]*Secret/i);
  assert.doesNotMatch(script, /提交人：\$\{escapeHtml\(task\.requester\?\.ref/);
  assert.match(script, /kind === 'feishu-user'.*'飞书老板'/);
  assert.match(script, /\/\^ou_\[a-zA-Z0-9\]\+\$\//);
});

test('员工页后台自动同步保留已展开的员工卡片', async () => {
  const script = await readFile(new URL('app.js', root), 'utf8');

  assert.match(script, /replaceChildrenPreservingDisclosureState\(agentList/);
  assert.match(script, /data-disclosure-key="agent:\$\{escapeHtml\(agent\.agentId\)\}"/);
});

test('A君控制台提供受控登录、续期、禁用和撤销，但不接收原始凭据', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readConsoleScripts()
  ]);
  assert.match(html, /网站账号与采集/);
  assert.match(html, /打开 Chrome 登录页/);
  assert.match(html, /不填写、显示或复制 Cookie、Token 和密码/);
  assert.match(script, /\/api\/access-connections/);
  assert.match(script, /\/api\/access-login\/open/);
  assert.match(script, /续期并恢复连接/);
  assert.match(script, /暂时禁用/);
  assert.match(script, /永久撤销/);
  assert.match(script, /受控凭据引用已登记/);
  assert.doesNotMatch(html, /name="(?:cookie|token|password|credential)"/i);
  assert.doesNotMatch(script, /connection\.(?:credentialRef|cookieBridgeClientId|cookie|token)/);
});

test('A君控制台先说明当前状态和唯一下一步，并把历史噪音与能力详情降级展示', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readConsoleScripts()
  ]);
  assert.match(html, /军团状态/);
  assert.match(html, /下一步/);
  assert.match(html, /需要我处理/);
  assert.match(html, /capabilities-disclosure/);
  assert.match(script, /需要你/);
  assert.match(script, /无需处理/);
  assert.match(script, /对外发布关闭/);
  assert.match(script, /今日费用未上报/);
  assert.match(script, /正式岗位，不含系统控制器/);
  assert.match(script, /例行巡检已自动归档/);
  assert.match(script, /focus\.inProgress/);
  assert.match(script, /默认账号已明确/);
  assert.match(script, /真实读取成功/);
  assert.match(script, /设为.*默认账号/);
  assert.match(script, /深度采集/);
  assert.match(script, /历史连接/);
});

test('任务记录使用服务端用户意图查询、游标分页、搜索和低频筛选', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readConsoleScripts()
  ]);
  assert.match(html, /id="task-search"/);
  assert.match(html, /id="task-load-more"/);
  assert.match(html, /data-record-view="needs_action"/);
  assert.match(html, /id="record-filter-panel"/);
  assert.match(html, /id="record-detail"/);
  assert.match(script, /api\('\/api\/console-overview'\)/);
  assert.match(script, /\/api\/task-records\?/);
  assert.match(script, /limit:'24'/);
  assert.match(script, /params\.set\('cursor', cursor\)/);
  assert.match(script, /setTimeout\(async \(\) =>/);
  assert.doesNotMatch(script, /state\.overview\.tasks/);
});

test('记录页后台自动同步不重排当前列表，并单独刷新选中详情', async () => {
  const script = await readConsoleScripts();

  assert.match(script, /if \(page\.revision !== state\.revision\)/);
  assert.match(script, /有新的记录，点击更新/);
  assert.match(script, /if \(state\.selectedTaskId\) await loadSelectedDetail/);
  assert.match(script, /if \(quiet && state\.selectedDetailLoaded && payload\.task\.updatedAt === state\.selectedTask\?\.updatedAt/);
  assert.match(script, /if \(!quiet\) renderList\(\)/);
  assert.match(script, /history\.replaceState\(null, '', `\/tasks\//);
  assert.match(script, /record-detail-back/);
});
