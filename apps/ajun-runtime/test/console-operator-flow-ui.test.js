import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createConsoleNavigation,
  resolveConsoleRoute,
} from '../public/console-navigation.js';
import {
  acceptanceTargetView,
  renderAcceptanceDetail,
  renderAttentionDetail,
  taskAttentionView,
} from '../public/task-record-detail-view.js';
import {
  renderTechnicalDetails,
} from '../public/task-record-workbench.js';
import {
  taskTypeLabel,
  statusLabel,
} from '../public/console-labels.js';
import {
  queryTaskRecordsInMemory,
} from '../src/task-record-query.ts';
import {
  businessDebtPresentation,
  capabilityPresentation,
  capabilitySummaryText,
  countCapabilityTiers,
  isOwnerActionFocus,
  managerFirstEmployees,
  reliabilityPresentation,
} from '../public/overview-presentation.js';

const publicRoot = new URL('../public/', import.meta.url);
const taskId = '11111111-1111-4111-8111-111111111111';

test('四个主导航收敛日常路径，旧 hash 仍打开原页面', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const primaryModules = [...html.matchAll(/class="module-link[^>]*" data-module="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(primaryModules, ['overview', 'records', 'system', 'tools']);
  assert.deepEqual(resolveConsoleRoute('#now'), { page:'overview', group:'overview' });
  assert.deepEqual(resolveConsoleRoute('#runs'), { page:'records', group:'records' });
  assert.deepEqual(resolveConsoleRoute('#employees'), { page:'employees', group:'system' });
  assert.deepEqual(resolveConsoleRoute('#billing'), { page:'billing', group:'system' });
  assert.deepEqual(resolveConsoleRoute('#campaigns'), { page:'campaigns', group:'tools' });
});

test('AI 能力中心按节点分层，并保留状态检查安全说明', async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('app-access-views.js', publicRoot), 'utf8'),
    readFile(new URL('styles.css', publicRoot), 'utf8'),
  ]);

  assert.match(html, /ai-control-hero[\s\S]*LOCAL AI · 运行控制/);
  assert.match(html, /状态检查不会启动模型/);
  assert.match(script, /aiServiceGroups\(payload\.services, payload\.categories\)/);
  assert.match(script, /ai-category-group/);
  assert.match(script, /ai-category-header/);
  assert.match(styles, /\.ai-node-service-list\s*\{[\s\S]*grid-template-columns: repeat\(2/);
});

test('首页把负责人动作、运行、系统可靠性和业务质量债分开，未知观测不冒充正常', async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('app.js', publicRoot), 'utf8'),
    readFile(new URL('styles.css', publicRoot), 'utf8'),
  ]);

  assert.match(html, /负责人下一步/);
  assert.match(html, /id="overview-truth-title">运行与风险</);
  assert.match(script, /statCard\('系统可靠性'/);
  assert.match(script, /statCard\('业务质量债'/);
  assert.deepEqual(reliabilityPresentation({ coreOnline:{ status:'online' }, reliability:{ status:'unknown', observedAt:null } }, (category) => `#${category}`), {
    value:'待核对', note:'核心服务在线；尚无有效稳定性观测，不能把核心在线当作一切正常', icon:'alert', attention:true, href:'',
  });
  assert.equal(businessDebtPresentation({ status:'needs_attention', verificationBacklog:3, unresolvedFailures:2 }, {}, (category) => `#${category}`).value, '3 待复验 · 2 仍失败');
  assert.equal(reliabilityPresentation({ coreOnline:'online', reliability:'healthy' }, (category) => `#${category}`).value, '观测通过');
  assert.doesNotMatch(script, /负责人暂不需处理.*一切正常/);
  assert.match(styles, /\.focus-primary-action,[\s\S]*min-height: 44px/);
  assert.equal(isOwnerActionFocus({ actions:[] }, { taskId:'legacy', status:'waiting_test' }), false);
  assert.equal(isOwnerActionFocus({
    actions:[{ taskId:'acceptance', workflowId:'workflow-1', status:'waiting_acceptance' }],
  }, { taskId:'acceptance', workflowId:'workflow-1', status:'waiting_acceptance' }), true);
});

test('飞书链路诊断默认收起，轮询不重建已展开内容或暴露内部枚举', async () => {
  const script = await readFile(new URL('app.js', publicRoot), 'utf8');

  assert.match(script, /const existing = chainDiagnosis\.querySelector\('\.chain-diagnosis-disclosure'\)/);
  assert.match(script, /if \(existing\.open\)\s*fetchChainDiagnosis\(\)/);
  assert.match(script, /展开看下一步/);
  assert.match(script, /diagnosis_incomplete: '本机信息不足，暂无法确认'/);
  assert.doesNotMatch(script, /<strong>\$\{diagnosis\.verdict\}<\/strong>/);
});

test('暗色模式把顶栏、侧栏和同步状态与内容区切到同一套主题色', async () => {
  const styles = await readFile(new URL('styles.css', publicRoot), 'utf8');

  assert.match(styles, /@media \(prefers-color-scheme: dark\)[\s\S]*--topbar-background: rgba\(18, 26, 22, \.86\)/);
  assert.match(styles, /html\.night-mode\s*\{[\s\S]*--module-nav-background: rgba\(28, 42, 34, \.78\)/);
  assert.match(styles, /\.topbar\s*\{[\s\S]*background: var\(--topbar-background\)/);
  assert.match(styles, /\.module-nav\s*\{[\s\S]*background: var\(--module-nav-background\)/);
  assert.match(styles, /\.sync-badge\s*\{[\s\S]*background: var\(--sync-badge-background\)/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\)[\s\S]*color-scheme: dark/);
});

test('任务记录读取失败可原地恢复，缺失下一步时不让用户空等或盲重试', async () => {
  const script = await readFile(new URL('task-record-workbench.js', publicRoot), 'utf8');
  const detailLoader = script.match(/async function loadSelectedDetail[\s\S]*?\n    async function selectTask/)?.[0] || '';

  assert.match(script, /event\.target\.closest\('\[data-record-retry\]'\)[\s\S]*await loadRecords\(\)/);
  assert.match(script, /querySelector\('\[data-record-detail-retry\]'\)\?\.addEventListener\('click'[\s\S]*loadSelectedDetail\(\{ revealDetail: false, quiet: false \}\)/);
  assert.match(detailLoader, /catch \(error\)[\s\S]*renderDetailError\(error\)[\s\S]*if \(revealDetail\)[\s\S]*elements\.workbench\.classList\.add\('is-detail-open'\)/);
  assert.match(script, /record-list-error[\s\S]*\$\{error\.message \|\| '本次没有读完。'\}/);
  assert.match(script, /打不开这条记录[\s\S]*\$\{error\.message \|\| '任务没有被更改。'\}/);
  assert.match(script, /class="focus-primary-action" type="button" data-record-retry/);
  assert.match(script, /class="focus-primary-action" type="button" data-record-detail-retry/);
  assert.match(script, /没有可执行动作，去飞书补充信息/);
  assert.match(script, /处理中，有进度会更新/);
});

test('员工与能力默认减噪：业务入口在前，后台和待验收能力折叠并如实标注', async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL('index.html', publicRoot), 'utf8'),
    readFile(new URL('app.js', publicRoot), 'utf8'),
    readFile(new URL('styles.css', publicRoot), 'utf8'),
  ]);

  assert.match(html, /默认只放可直接交付业务结果的入口/);
  assert.match(script, /agent\.agentId === 'ajun' \|\| isDirectEmployee\(agent\) \|\| agent\.capabilityTruth\?\.overall === 'human_accepted'/);
  assert.deepEqual(managerFirstEmployees({ agentId:'ajun', name:'A君' }, [{ agentId:'xiaod', name:'小D' }, { agentId:'ajun', name:'重复的A君' }]).map((item) => item.agentId), ['ajun', 'xiaod']);
  assert.deepEqual(managerFirstEmployees(null, [{ agentId:'xiaod', name:'小D' }]).map((item) => item.agentId), ['xiaod']);
  assert.match(script, /后台岗位与待人工验收/);
  assert.equal(capabilityPresentation({ truth:{ overall:'human_accepted' } }).label, '已人工验收');
  assert.equal(capabilityPresentation({ truth:{ overall:'verified' } }).label, '真实任务已验证');
  assert.equal(capabilityPresentation({ truth:{ overall:'partial' } }).label, '部分完成');
  assert.equal(capabilityPresentation({ truth:{ overall:'planned' } }).label, '待准备');
  assert.equal(capabilitySummaryText(countCapabilityTiers([{ truth:{ overall:'human_accepted' } }, { truth:{ overall:'verified' } }, { truth:{ overall:'partial' } }, { truth:{ overall:'planned' } }])), '1 项人工验收 · 1 项真实验证待人工验收 · 1 项受限 · 1 项待准备');
  assert.match(styles, /\.background-employees-disclosure/);
});

test('版本页用线上、候选和回滚三种真实身份，不把候选叫当前版本', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');

  assert.match(html, /线上运行版本/);
  assert.match(html, /候选版本/);
  assert.match(html, /回滚版本/);
  assert.doesNotMatch(html, /<span>当前版本<\/span>/);
  assert.doesNotMatch(html, /<span>可发布版本<\/span>/);
});

test('任务 pathname 是详情真相，切往其他 hash 时清除详情 pathname', () => {
  let pathname = `/tasks/${taskId}`;
  let hash = '';
  const activated = [];
  const replacements = [];
  const navigation = createConsoleNavigation({
    getPathname:() => pathname,
    getHash:() => hash,
    replaceLocation:(value) => replacements.push(value),
    activate:(page, options) => activated.push([page, options.navigationGroup]),
  });

  navigation.initialize();
  assert.deepEqual(activated, [['records', 'records']]);

  hash = '#system';
  navigation.locationChanged();
  assert.deepEqual(replacements, ['/#system']);
  assert.deepEqual(activated.at(-1), ['system', 'system']);

  pathname = '/';
  hash = '#records';
  navigation.locationChanged();
  assert.deepEqual(activated.at(-1), ['records', 'records']);
});

test('attention 只接受安全动作键并保留恢复任务链接', () => {
  const view = taskAttentionView({
    paperclipIssue:{ identifier:'AGE-1462', detailUrl:'http://127.0.0.1:3100/issues/AGE-1462' },
    presentation:{
      attention:{
        kind:'failed',
        headline:'本轮未完成',
        cause:'视觉通道没有接通。',
        impact:'没有产出视觉判断。',
        remainingRisks:null,
        actions:[
          { actionKey:'text-only', label:'仅用转录继续', emphasis:'primary', confirmation:'确认改为仅文本？', endpoint:'https://invalid.example' },
          { actionKey:'text-only', label:'重复动作' },
          { actionKey:'../../escape', label:'危险动作' },
        ],
        verification:{
          status:'verified', message:'只读诊断完成。', taskId, detailPath:`/tasks/${taskId}`,
          diagnosis:{
            conclusion:'Paperclip 执行链结束，但没有形成可验证产物。',
            evidence:'故障代码 paperclip_hermes_failed；阶段 paperclip_hermes。',
            impact:'原任务仍未完成，已有记录保持不变。',
            nextAction:'检查 Paperclip 执行记录，再决定是否修复或重跑。',
          },
        },
        technical:{ code:'controlled_provider_vision_required', stage:'paperclip_hermes' },
      },
    },
  });

  assert.equal(view.remainingRisks, '');
  assert.deepEqual(view.actions, [{ actionKey:'text-only', label:'仅用转录继续', emphasis:'primary', confirmation:'确认改为仅文本？' }]);
  assert.equal(view.verification.status, 'verified');
  assert.equal(view.verification.diagnosis.conclusion, 'Paperclip 执行链结束，但没有形成可验证产物。');
  assert.equal(view.technical.code, 'controlled_provider_vision_required');
  const html = renderAttentionDetail(view, null, escapeHtml);
  assert.match(html, /Paperclip 执行失败[\s\S]*未生成可验证产物，原任务未完成/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:3100\/issues\/AGE-1462"[\s\S]*打开 Paperclip 失败记录/);
  assert.match(html, /诊断依据[\s\S]*诊断记录/);
  assert.doesNotMatch(html, /诊断完成|<strong>影响<\/strong>|<strong>下一步<\/strong>|为什么这样判断/);
  assert.doesNotMatch(html, /发生了什么|剩余风险|还没有执行恢复动作/);
  assert.equal((html.match(/record-attention-primary/g) || []).length, 1);

  const confirmingHtml = renderAttentionDetail(view, {
    status:'confirming',
    actionKey:'text-only',
    message:'确认改为仅文本？',
  }, escapeHtml);
  assert.match(confirmingHtml, /role="alert"/);
  assert.match(confirmingHtml, /data-attention-confirm="text-only"/);
  assert.match(confirmingHtml, /data-attention-cancel/);
  assert.equal((confirmingHtml.match(/确认改为仅文本？/g) || []).length, 1);
});

test('恢复动作固定走本机安全路径并带并发与幂等保护', async () => {
  const script = await readFile(new URL('task-record-workbench.js', publicRoot), 'utf8');

  assert.match(script, /api\('\/api\/owner-action-session'\)/);
  assert.match(script, /\/api\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/recovery-actions\/\$\{encodeURIComponent\(action\.actionKey\)\}/);
  assert.match(script, /'Idempotency-Key':\s*idempotencyKey/);
  assert.match(script, /'X-Ajun-Owner-Action':\s*nonce/);
  assert.match(script, /expectedUpdatedAt:\s*task\.updatedAt \|\| null/);
  assert.doesNotMatch(script, /action\.(?:endpoint|url|method)/);
  assert.doesNotMatch(script, /task\.(?:error|routing|requester)/);
  assert.match(script, /task-record-detail-view\.js/);
  assert.match(script, /data-attention-confirm/);
  assert.match(script, /data-attention-cancel/);
  assert.match(script, /Paperclip 运行/);
  assert.doesNotMatch(script, /window\.confirm\(confirmation\)/);
});

test('业务验收只渲染后端声明的可操作工作流，并明确展示闭环结果', () => {
  const target = acceptanceTargetView({
    input:{ title:'杭州天气调研' },
    acceptanceTarget:{
      workflowId:'workflow:weather-1', title:'杭州天气调研结果', status:'waiting_acceptance',
      decision:null, revision:3, actionable:true,
    },
  });
  assert.deepEqual(target, {
    workflowId:'workflow:weather-1', title:'杭州天气调研结果', status:'waiting_acceptance',
    decision:null, revision:3, actionable:true,
  });
  const html = renderAcceptanceDetail(target, null, escapeHtml);
  assert.match(html, /这次结果需要你验收/);
  assert.match(html, /data-acceptance-decision="accepted"[^>]*>有用</);
  assert.match(html, /data-acceptance-decision="revision_required"[^>]*>需改进</);
  assert.match(html, /data-acceptance-note/);

  const failed = renderAcceptanceDetail(target, {
    status:'failed', decision:'accepted', note:'结果准确', message:'验收结果没有保存。这项待办仍然保留，请稍后重试。',
  }, escapeHtml);
  assert.match(failed, />结果准确<\/textarea>/);
  assert.match(failed, /is-failed[^>]*" role="status"/);
  assert.match(failed, /这项待办仍然保留/);

  const closed = renderAcceptanceDetail({ ...target, actionable:false, decision:'revision_required' }, null, escapeHtml);
  assert.match(closed, /已标记需改进/);
  assert.doesNotMatch(closed, /data-acceptance-decision/);
  assert.equal(renderAcceptanceDetail({ ...target, actionable:false }, null, escapeHtml), '');
});

test('运行台验收复用本机授权并提交版本、幂等键和用户说明', async () => {
  const script = await readFile(new URL('task-record-workbench.js', publicRoot), 'utf8');

  assert.match(script, /\/api\/workflows\/\$\{encodeURIComponent\(target\.workflowId\)\}\/acceptance/);
  assert.match(script, /newIdempotencyKey\(target\.workflowId, decision\)/);
  assert.match(script, /'Idempotency-Key':\s*idempotencyKey/);
  assert.match(script, /previous\?\.status === 'failed'/);
  assert.match(script, /'X-Ajun-Owner-Action':\s*nonce/);
  assert.match(script, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(script, /动作会话\.\*\(\?:无效\|过期\)/);
  assert.match(script, /JSON\.stringify\(\{ decision, note: note \|\| undefined, expectedRevision: target\.revision \}\)/);
  assert.match(script, /payload\?\.task/);
  assert.match(script, /payload\?\.acceptanceTarget/);
  assert.match(script, /这项待办仍然保留/);
});

test('编号与审计正常渲染 HTML 标签并不转义 dl 和 dt，提供复制与 Paperclip 入口', () => {
  const sampleTask = {
    taskId: '02fdc45e-56e6-4fd8-9104-6a97805cbdbf',
    status: 'succeeded',
    currentStage: 'completed',
    paperclipRun: { runId: 'run-998877', status: 'succeeded' },
    paperclipIssue: { identifier: 'AGE-2024', detailUrl: 'http://127.0.0.1:3100/issues/AGE-2024' },
  };
  const presentation = {
    technical: {
      taskId: '02fdc45e-56e6-4fd8-9104-6a97805cbdbf',
      status: 'succeeded',
      currentStage: 'completed',
      errorCode: null,
    },
  };
  const attention = null;
  const html = renderTechnicalDetails(sampleTask, presentation, attention, escapeHtml);

  assert.match(html, /<details class="record-technical"/);
  assert.match(html, /<span>编号与审计<\/span>/);
  assert.match(html, /<svg class="chevron"/);
  assert.match(html, /<dl>[\s\S]*<div><dt>完整编号<\/dt><dd>02fdc45e-56e6-4fd8-9104-6a97805cbdbf<\/dd><\/div>/);
  assert.match(html, /<div><dt>Paperclip 运行<\/dt><dd>succeeded · run-998877<\/dd><\/div>/);
  assert.match(html, /<div><dt>原始状态<\/dt><dd>succeeded<\/dd><\/div>/);
  assert.match(html, /<div><dt>当前阶段<\/dt><dd>completed<\/dd><\/div>/);
  assert.match(html, /<a class="record-paperclip-link" href="http:\/\/127\.0\.0\.1:3100\/issues\/AGE-2024"/);
  assert.match(html, /<button class="text-action record-copy-id" type="button">复制编号<\/button>/);
  assert.doesNotMatch(html, /&lt;div&gt;&lt;dt&gt;/);
  assert.doesNotMatch(html, /&lt;dl&gt;/);
});

test('关注态卡片直接提供 Paperclip 处理入口与技术标签，并剔除通用废话套话', () => {
  const view = taskAttentionView({
    taskId: 'cadc227a-a377-421d-a42c-1dcbd726e1ec',
    paperclipIssue: { identifier: 'AGE-1531', detailUrl: 'http://127.0.0.1:3100/issues/AGE-1531' },
    presentation: {
      attention: {
        kind: 'failed',
        headline: '本轮未完成',
        cause: '技术专家没有完成修复，故障和记录已保留，等待下一轮处理。',
        impact: '本轮任务没有完成；已有产物和审计记录仍会保留。',
        nextAction: '请根据失败原因决定补充信息、调整范围或暂不处理。',
        actions: [],
        technical: { code: 'paperclip_repair_failed', stage: 'technical_repair' },
      },
    },
  });

  const html = renderAttentionDetail(view, null, escapeHtml);
  assert.match(html, /<section class="record-attention"/);
  assert.match(html, /<h3>本轮未完成<\/h3>/);
  assert.match(html, /<p>技术专家没有完成修复，故障和记录已保留，等待下一轮处理。<\/p>/);
  assert.match(html, /<span class="record-attention-tag">错误代码: <code>paperclip_repair_failed<\/code><\/span>/);
  assert.match(html, /<span class="record-attention-tag">阶段: <code>technical_repair<\/code><\/span>/);
  assert.match(html, /<div class="record-attention-actions"><a class="record-paperclip-link" href="http:\/\/127\.0\.0\.1:3100\/issues\/AGE-1531"[^>]*>打开 Paperclip AGE-1531<\/a><\/div>/);
  // Generic template boilerplate must be filtered out
  assert.doesNotMatch(html, /请根据失败原因决定补充信息/);
  assert.doesNotMatch(html, /已有产物和审计记录仍会保留/);
});

test('任务类型标签为每种类型提供清晰中文且同一员工的不同任务类型不重复为员工名', () => {
  const sampleAgents = [
    {
      agentId: 'operator',
      name: '运维官',
      acceptedTaskTypes: ['operations.health-review', 'operations.failure-recovery', 'operations.incident-response'],
    },
    {
      agentId: 'content-creator',
      name: '小创',
      acceptedTaskTypes: ['content.platform-draft', 'content.video-script-package', 'content.article-adaptation'],
    },
  ];

  const labels = [
    taskTypeLabel('operations.health-review', sampleAgents),
    taskTypeLabel('operations.failure-recovery', sampleAgents),
    taskTypeLabel('operations.incident-response', sampleAgents),
    taskTypeLabel('content.platform-draft', sampleAgents),
    taskTypeLabel('content.video-script-package', sampleAgents),
    taskTypeLabel('content.article-adaptation', sampleAgents),
  ];

  // All labels must be unique and descriptive
  const uniqueLabels = new Set(labels);
  assert.equal(uniqueLabels.size, labels.length);
  assert.equal(labels[0], '运维官：本机健康检查');
  assert.equal(labels[1], '运维官：故障恢复');
  assert.equal(labels[2], '运维官：应急响应');
  assert.equal(labels[3], '小创：平台内容草稿');
  assert.equal(labels[4], '小创：可拍视频脚本');
  assert.equal(labels[5], '小创：多平台图文改写');
});

test('任务记录查询支持按状态（包括待验证 waiting_test）进行精确筛选', () => {
  const tasks = [
    {
      taskId: 'task-1',
      status: 'waiting_test',
      updatedAt: '2026-08-24T10:00:00.000Z',
      input: { title: '待验证功能' },
    },
    {
      taskId: 'task-2',
      status: 'running',
      updatedAt: '2026-08-24T11:00:00.000Z',
      input: { title: '运行中任务' },
    },
    {
      taskId: 'task-3',
      status: 'succeeded',
      updatedAt: '2026-08-24T12:00:00.000Z',
      input: { title: '已完成任务' },
    },
  ];

  const result = queryTaskRecordsInMemory(tasks, { status: 'waiting_test', view: 'all' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].taskId, 'task-1');
  assert.equal(result.items[0].status, 'waiting_test');
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[character]);
}



