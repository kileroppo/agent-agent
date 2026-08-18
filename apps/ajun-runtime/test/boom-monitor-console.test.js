import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildBoomImportRequest, parseBoomCsv } from '../public/boom-monitor-console.js';

const publicRoot = new URL('../public/', import.meta.url);

test('A君控制台内建爆款雷达入口并统一使用同源 API', async () => {
  const [html, app, consoleSource] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('app.js', publicRoot), 'utf8'),
    readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8'),
  ]);

  assert.match(html, /href="#boom-monitor" data-context-page="boom-monitor"/);
  assert.doesNotMatch(html, /data-module="boom-monitor"/);
  assert.match(html, /data-module-page="boom-monitor"/);
  assert.match(html, /爆款雷达/);
  assert.match(app, /createBoomMonitorConsole/);
  assert.match(app, /payload\.detail \|\| payload\.error/);
  assert.match(consoleSource, /const API_ROOT = '\/api\/boom-monitor'/);
  assert.doesNotMatch(`${html}\n${app}\n${consoleSource}`, /iframe|localhost:8081|127\.0\.0\.1:8081/i);
});

test('爆款雷达主界面只保留判断、最近作品、需要处理和设置，历史导入仍在高级工具', async () => {
  const [html, consoleSource] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8'),
  ]);

  assert.match(html, /id="boom-collect-form"/);
  assert.match(html, /id="boom-source-url" type="text" inputmode="url"/);
  assert.match(html, /placeholder="粘贴作品链接或整段分享文案"/);
  assert.match(html, /支持小红书、抖音、B站、YouTube/);
  assert.match(html, /value="bilibili">B站/);
  assert.match(html, /value="youtube">YouTube/);
  assert.match(html, /id="boom-work-list"/);
  assert.match(html, /id="boom-analysis-list"/);
  assert.match(html, /id="boom-scan-run"/);
  assert.match(html, /accept="\.json,\.csv/);
  assert.match(html, /id="boom-settings-form"/);
  assert.match(html, /每日最多拆解/);
  assert.match(html, /class="boom-advanced-tools"[\s\S]*高级：历史数据/);
  assert.doesNotMatch(html, /data-boom-view="import"/);
  assert.match(consoleSource, /\/collect\/url/);
  assert.doesNotMatch(consoleSource, /\/scan\/jobs/);
  assert.match(consoleSource, /\/analysis\/run/);
  assert.match(consoleSource, /\/analysis\/queue\//);
  assert.match(consoleSource, /\/works\/\$\{workId\}/);
  assert.match(consoleSource, /\/import/);
  assert.match(consoleSource, /analysis_daily_limit:\s*dailyLimit/);
  assert.match(consoleSource, /bilibili:\s*'B站'/);
  assert.match(consoleSource, /youtube:\s*'YouTube'/);
});

test('自动派发默认关闭，启用和手动派发都需明确确认', async () => {
  const [html, consoleSource] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8'),
  ]);

  assert.match(html, /id="boom-auto-enabled" type="checkbox"/);
  assert.doesNotMatch(html, /id="boom-auto-enabled"[^>]*checked/);
  assert.match(consoleSource, /settings = \{\s*enabled:\s*false/);
  assert.match(consoleSource, /启用后，命中所选等级的作品会在每日上限内自动交给小D和小拆/);
  assert.match(consoleSource, /manual:\s*true/);
  assert.match(consoleSource, /work_id:\s*Number\(workId\)/);
  assert.match(consoleSource, /\['T1', 'T2', 'T3'\]\.includes\(work\.grade\)/);
  assert.match(consoleSource, /交给小D和小拆/);
  assert.doesNotMatch(consoleSource, /setInterval|analysis\/run.*onMounted/);
});

test('单作品操作具有作品上下文、动态详情状态和请求防重入', async () => {
  const consoleSource = await readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8');

  assert.match(consoleSource, /aria-label="查看“\$\{escapeHtml\(workTitle\)\}”的判断依据"/);
  assert.match(consoleSource, /aria-label="开始拆解“\$\{escapeHtml\(workTitle\)\}”"/);
  assert.match(consoleSource, /data-boom-approve=/);
  assert.match(consoleSource, /确认并继续/);
  assert.match(consoleSource, /\/api\/approvals\/\$\{encodeURIComponent\(approvalId\)\}\/approve/);
  assert.match(consoleSource, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}/);
  assert.match(consoleSource, /查看拆解进度/);
  assert.match(consoleSource, /aria-controls="\$\{detailId\}" aria-expanded="false"/);
  assert.match(consoleSource, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(consoleSource, /triggerButton\?\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(consoleSource, /if \(triggerButton\?\.disabled\)\s*return/);
  assert.match(consoleSource, /triggerButton\.disabled = true/);
  assert.match(consoleSource, /if \(triggerButton\?\.isConnected\)/);
});

test('作品卡常驻人话判断和唯一主动作，筛选及技术指标按需查看', async () => {
  const [html, consoleSource, styles] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8'),
    readFile(new URL('styles.css', publicRoot), 'utf8'),
  ]);

  assert.match(html, /class="boom-filter-tools"[\s\S]*<summary>筛选作品<\/summary>/);
  assert.match(html, /id="boom-stats" class="boom-overview-summary"/);
  assert.doesNotMatch(html, /class="boom-stat-grid"/);
  assert.match(consoleSource, /<article class="boom-list-item">/);
  assert.doesNotMatch(consoleSource, /<details class="boom-list-item">/);
  assert.match(consoleSource, /gradeReason\(work\.grade\)/);
  assert.match(consoleSource, /判断可信度/);
  assert.match(styles, /\.boom-item-head\s*\{/);
});

test('需要处理收纳异常、等待确认和卡死状态，正常过程留在作品状态', async () => {
  const [html, consoleSource] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8'),
  ]);

  assert.match(html, /data-boom-view="queue"[^>]*hidden>需要处理/);
  assert.doesNotMatch(html, /id="boom-dispatch-run"/);
  assert.match(consoleSource, /\['waiting_source', 'dispatch_failed', 'waiting_approval', 'needs_input', 'failed'\]\.includes\(status\)/);
  assert.match(consoleSource, /status === 'queued'[\s\S]*remaining_today/);
  assert.match(consoleSource, /acquiring: ' · 小D取证中'/);
  assert.match(consoleSource, /analyzing: ' · 小拆分析中'/);
  assert.match(consoleSource, /needs_input: ' · 需要处理'/);
  assert.match(consoleSource, /completed: ' · 已完成'/);
  assert.match(consoleSource, /return ' · 等你确认'/);
  assert.match(consoleSource, /data-boom-focus-intake/);
  assert.match(consoleSource, /data-boom-open-settings/);
  assert.match(consoleSource, /查看并处理/);
});

test('作品评分只展示当前评分，并用中文解释表现指标', async () => {
  const consoleSource = await readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8');

  assert.match(consoleSource, /相对历史表现/);
  assert.match(consoleSource, /粉丝互动率/);
  assert.match(consoleSource, /当前核心互动 ÷ 作者历史作品中位数/);
  assert.match(consoleSource, /点赞数 ÷ 粉丝数/);
  assert.doesNotMatch(consoleSource, /旧 v1 对照|legacy_score/);
  assert.doesNotMatch(consoleSource, /R \+|M \+/);
});

test('判断依据失败会写回当前作品卡片，同时保留全局错误提示', async () => {
  const consoleSource = await readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8');

  assert.match(consoleSource, /output\.classList\.add\('is-error'\)/);
  assert.match(consoleSource, /output\.textContent = `判断依据读取失败：\$\{error\.message\}`/);
  assert.match(consoleSource, /throw error/);
  assert.match(consoleSource, /showWorkDetail\(detail\.dataset\.boomDetail, detail\)\.catch\(showError\)/);
});

test('爆款雷达页内切换使用普通按钮组语义', async () => {
  const [html, consoleSource] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('boom-monitor-console.js', publicRoot), 'utf8'),
  ]);

  assert.match(html, /class="boom-view-tabs" role="group" aria-label="爆款雷达内容"/);
  assert.match(html, /data-boom-view="works" aria-pressed="true"/);
  assert.doesNotMatch(html, /role="(?:tab|tabpanel|tablist)"/);
  assert.doesNotMatch(html, /aria-selected=/);
  assert.match(consoleSource, /tab\.setAttribute\('aria-pressed', String\(active\)\)/);
  assert.doesNotMatch(consoleSource, /aria-selected/);
});

test('CSV 导入支持引号和数字字段，转换为统一导入请求', () => {
  const rows = parseBoomCsv([
    'work_id,title,platform,creator_id,follower_count,likes',
    'w1,"标题,含逗号",douyin,c1,120000,3500',
    'w2,"带""引号""",xiaohongshu,c2,8000,220',
  ].join('\n'));

  assert.deepEqual(rows, [
    { work_id:'w1', title:'标题,含逗号', platform:'douyin', creator_id:'c1', follower_count:120000, likes:3500 },
    { work_id:'w2', title:'带"引号"', platform:'xiaohongshu', creator_id:'c2', follower_count:8000, likes:220 },
  ]);
  assert.deepEqual(buildBoomImportRequest(rows), { source_type:'manual', works:rows });
});

test('对象导入保留创作者基线并把单条作品规范为数组', () => {
  const request = buildBoomImportRequest({
    platform:'douyin',
    creator_id:'creator-1',
    creator_name:'测试创作者',
    follower_count:1200,
    work_id:'work-1',
    likes:50,
  });

  assert.equal(request.creator, 'creator-1');
  assert.equal(request.follower_count, 1200);
  assert.equal(request.works.length, 1);
  assert.equal(request.works[0].work_id, 'work-1');
});

test('爆款雷达在窄屏改为单列工作区', async () => {
  const styles = await readFile(new URL('styles.css', publicRoot), 'utf8');
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*\.boom-inline-form,[\s\S]*\.boom-queue-columns,[\s\S]*\.boom-facts[\s\S]*grid-template-columns: 1fr/);
});
