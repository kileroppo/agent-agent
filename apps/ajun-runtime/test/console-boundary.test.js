import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../public/', import.meta.url);
const handlerPath = new URL('../src/runtime-http-handler.ts', import.meta.url);

async function readConsoleScripts() {
  return (await Promise.all([
    'app.js',
    'app-access-views.js',
    'app-interactions.js',
    'billing-entry-filter.js',
    'console-labels.js',
    'task-record-detail-view.js',
    'task-record-workbench.js',
    'overview-view.js',
    'employee-view.js',
    'billing-view.js',
    'night-mode.js',
    'format-utils.js',
    'context-nav-injection.js',
    'interactions/access-gate-interactions.js',
    'interactions/ai-control-interactions.js',
    'interactions/employee-interactions.js',
    'interactions/access-connection-interactions.js',
    'interactions/campaign-interactions.js',
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
  assert.match(html, /军团模型策略/);
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
  assert.doesNotMatch(script, /task\.requester(?:\?|\.)/);
  assert.match(script, /attentionTechnical\(source\.technical\)/);
});

test('员工页后台自动同步保留已展开的员工卡片', async () => {
  const script = (await Promise.all([
    'app.js',
    'overview-view.js',
    'employee-view.js',
  ].map((name) => readFile(new URL(name, root), 'utf8')))).join('\n');

  assert.match(script, /replaceChildrenPreservingDisclosureState\(agentList/);
  assert.match(script, /data-disclosure-key="agent:\$\{agent\.agentId\}"/);
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
  assert.match(html, /id="overview-title">现在/);
  assert.match(html, /下一步/);
  assert.match(html, /待处理/);
  assert.match(html, /capabilities-disclosure/);
  assert.match(script, /需要你/);
  assert.match(script, /没有待处理/);
  assert.match(script, /对外发布关闭/);
  assert.match(script, /今日费用未上报/);
  assert.match(script, /正式岗位 Hermes 用量/);
  assert.match(script, /例行巡检已自动归档/);
  assert.match(script, /focus\.inProgress/);
  assert.match(script, /默认账号已明确/);
  assert.match(script, /真实读取成功/);
  assert.match(script, /设为.*默认账号/);
  assert.match(script, /深度采集/);
  assert.match(script, /历史连接/);
});

test('控制台收敛为四个主导航，并保留旧 hash 深链兼容边界', async () => {
  const [html, navigation] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('console-navigation.js', root), 'utf8'),
  ]);

  assert.equal(html.match(/class="module-link(?: [^"]*)?"/g)?.length, 4);
  assert.match(html, /href="#now"[^>]*data-module="overview"[\s\S]*?<span>现在<\/span>/);
  assert.match(html, /href="#runs"[^>]*data-module="records"[\s\S]*?<span>运行<\/span>/);
  assert.match(html, /href="#system"[^>]*data-module="system"[\s\S]*?<span>系统<\/span>/);
  assert.match(html, /href="#tools"[^>]*data-module="tools"[^>]*data-owner-only[\s\S]*?<span>工具<\/span>/);

  assert.match(navigation, /overview:\s*\{\s*page:\s*'overview',\s*group:\s*'overview'\s*\}/);
  assert.match(navigation, /records:\s*\{\s*page:\s*'records',\s*group:\s*'records'\s*\}/);
  assert.match(navigation, /employees:\s*\{\s*page:\s*'employees',\s*group:\s*'system'\s*\}/);
  assert.match(navigation, /connections:\s*\{\s*page:\s*'connections',\s*group:\s*'system'\s*\}/);
  assert.match(navigation, /billing:\s*\{\s*page:\s*'billing',\s*group:\s*'system'\s*\}/);
  assert.match(navigation, /campaigns:\s*\{\s*page:\s*'campaigns',\s*group:\s*'tools'\s*\}/);
  assert.match(navigation, /'boom-monitor':\s*\{\s*page:\s*'boom-monitor',\s*group:\s*'tools'\s*\}/);
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
  assert.match(script, /limit:\s*'24'/);
  assert.match(script, /params\.set\('cursor', cursor\)/);
  assert.match(script, /setTimeout\(async \(\) =>/);
  assert.doesNotMatch(script, /state\.overview\.tasks/);
});

test('记录页后台自动同步不重排当前列表，并单独刷新选中详情', async () => {
  const script = await readConsoleScripts();

  assert.match(script, /if \(page\.revision !== state\.revision\)/);
  assert.match(script, /有更新/);
  assert.match(script, /if \(state\.selectedTaskId\)\s*await loadSelectedDetail/);
  assert.match(script, /if \(quiet && state\.selectedDetailLoaded && nextTask\.updatedAt === state\.selectedTask\?\.updatedAt/);
  assert.match(script, /acceptanceRevision\(nextTask\) === acceptanceRevision\(state\.selectedTask\)/);
  assert.match(script, /if \(!quiet\)\s*renderList\(\)/);
  assert.match(script, /history\.replaceState\(null, '', `\/tasks\//);
  assert.match(script, /record-detail-back/);
  assert.match(script, /data-task-timeline-shell/);
  assert.match(script, /addEventListener\('toggle'/);
});

test('控制台刷新由可测试 scheduler 管理，生产间隔保持十五秒', async () => {
  const script = await readFile(new URL('app-interactions.js', root), 'utf8');

  assert.match(script, /import \{ canRefreshConsole, startRefreshScheduler \} from '\.\/refresh-scheduler\.js'/);
  assert.match(script, /startRefreshScheduler\(\{[\s\S]*refresh:\s*load,[\s\S]*canRefresh:\s*\(\) => canRefreshConsole\(\{[\s\S]*page:\s*document,[\s\S]*accessGate,[\s\S]*forms:\s*\[accessForm, accessLoginForm\][\s\S]*intervalMs:\s*15_?000/);
  assert.doesNotMatch(script, /setInterval\(/);
});

test('控制台首页依赖的本地模块都能被运行时静态路由提供', async () => {
  const [appScript, handler] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(handlerPath, 'utf8'),
  ]);
  const moduleImports = [...appScript.matchAll(/from '(\.\/[^']+\.js)'/g)]
    .map((match) => match[1].replace('./', '/'));
  for (const modulePath of moduleImports) {
    const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      handler,
      new RegExp(`publicPath === '${escaped}'`),
      `缺少静态路由：${modulePath}`,
    );
  }
});

test('首页不提前读取已关闭的发布活动，只有打开活动页才按需加载', async () => {
  const [app, accessViews] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('app-access-views.js', root), 'utf8'),
  ]);
  const ownerBootstrap = accessViews.match(/async function renderLocalShare\(\)[\s\S]*?async function renderAiControl/)?.[0] || '';

  assert.doesNotMatch(ownerBootstrap, /renderContentCampaigns\(\)/);
  assert.match(app, /if \(selected === 'campaigns'\)\s*accessViews\?\.renderContentCampaigns\(\)/);
});
