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
  renderOriginCard,
  taskAttentionView,
} from '../public/task-record-detail-view.js';
import {
  renderTechnicalDetails,
} from '../public/task-record-workbench.js';
import {
  renderTaskWorkflowTree,
} from '../public/task-tree-view.js';
import {
  renderArtifact,
} from '../public/task-record-presentation.js';
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
    readFile(new URL('overview-view.js', publicRoot), 'utf8'),
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
  const script = await readFile(new URL('overview-view.js', publicRoot), 'utf8');

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
    readFile(new URL('employee-view.js', publicRoot), 'utf8'),
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
  const script = await readFile(new URL('task-record-workbench.js', publicRoot), 'utf8')
    + '\n' + await readFile(new URL('task-record-workbench-filters.js', publicRoot), 'utf8')
    + '\n' + await readFile(new URL('task-record-workbench-interactions.js', publicRoot), 'utf8')
    + '\n' + await readFile(new URL('task-record-workbench-acceptance.js', publicRoot), 'utf8');

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
  assert.match(html, /成果就绪|本次结果满意/);
  assert.match(html, /data-acceptance-decision="accepted"/);
  assert.match(html, /data-acceptance-show-revision/);
  assert.match(html, /acceptance-inline-bar/);

  const failed = renderAcceptanceDetail(target, {
    status:'failed', decision:'accepted', note:'结果准确', message:'验收结果没有保存。这项待办仍然保留，请稍后重试。',
  }, escapeHtml);
  assert.match(failed, /is-failed/);
  assert.match(failed, /这项待办仍然保留/);

  const closed = renderAcceptanceDetail({ ...target, actionable:false, decision:'revision_required' }, null, escapeHtml);
  assert.match(closed, /已标记需改进/);
  assert.doesNotMatch(closed, /data-acceptance-decision/);
  assert.equal(renderAcceptanceDetail({ ...target, actionable:false }, null, escapeHtml), '');
});

test('运行台验收复用本机授权并提交版本、幂等键和用户说明', async () => {
  const script = await readFile(new URL('task-record-workbench.js', publicRoot), 'utf8')
    + '\n' + await readFile(new URL('task-record-workbench-acceptance.js', publicRoot), 'utf8');

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

test('关注态卡片直接提供 Paperclip 处理入口与人话说明，剔除内部错误代码标签与通用废话套话', () => {
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

  const html = renderAttentionDetail(view, null, escapeHtml, { task: view });
  assert.match(html, /<section class="record-attention"/);
  assert.match(html, /<h3>本轮未完成<\/h3>/);
  assert.match(html, /<p class="record-attention-cause">技术专家没有完成修复，故障和记录已保留，等待下一轮处理。<\/p>/);
  assert.doesNotMatch(html, /<span class="record-attention-tag">错误代码/);
  assert.doesNotMatch(html, /<span class="record-attention-tag">阶段/);
  assert.match(html, /AGE-1531/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3100\/issues\/AGE-1531/);
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

test('renderOriginCard 正确渲染有效外链为 <a> 标签，脱敏占位符或非法链接渲染为纯文本防相对路径跳转', () => {
  const validTask = {
    taskId: 'valid-1',
    input: {
      sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      description: '1. 获取并整理：素材获取\n2. 拆解爆款：分析逻辑',
    },
  };
  const validHtml = renderOriginCard(validTask);
  assert.match(validHtml, /<a href="https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD"/);
  assert.match(validHtml, /class="external-icon"/);

  const maskedTask = {
    taskId: 'masked-1',
    input: {
      sourceUrl: '[链接已脱敏]',
      description: '1. 获取并整理：素材获取\n2. 拆解爆款：分析逻辑',
    },
  };
  const maskedHtml = renderOriginCard(maskedTask);
  assert.doesNotMatch(maskedHtml, /<a href="\[链接已脱敏\]"/);
  assert.match(maskedHtml, /class="origin-link-text is-plain"/);
  assert.match(maskedHtml, /\[链接已脱敏\]/);
});

test('renderTaskWorkflowTree 产物仅在存在真实正文时提供复制内容，无独立正文或仅重复标题时提供查看详情', () => {
  const task = {
    taskId: 'main-task-1',
    workflowBreadcrumb: {
      workflowId: 'wf-test-1',
      siblings: [
        {
          taskId: 'sub-task-1',
          title: '分工与规划',
          status: 'succeeded',
          assigneeAgentId: 'ajun',
          artifactRefs: [
            {
              title: '多人协作分工',
              summary: '多人协作分工', // 与标题重复，无正文
            },
            {
              title: '完整方案报告',
              summary: '这是方案概览',
              data: {
                markdown: '# 协作规划\n\n1. 明确各角色分工\n2. 阶段性产物核验标准与交付检查点。',
              },
            },
          ],
        },
      ],
    },
  };

  const html = renderTaskWorkflowTree(task, { agentName: () => 'A君' });
  
  // 对于仅重复标题的产物，不应渲染复制内容，而应渲染查看详情
  assert.doesNotMatch(html, /data-copy-text="多人协作分工"/);
  assert.match(html, /data-subtask-preview="sub-task-1">查看详情 ↗<\/button>/);

  // 对于包含真实 markdown/结构化正文的产物，正确渲染复制内容
  assert.match(html, /data-copy-text="# 协作规划/);
});

test('renderArtifact 对多人协作计划与汇总产物生成人话摘要并复制完整结构化报告，不回显父任务标题', () => {
  const parentTask = {
    taskId: '0ff744a6-7780-4cfe-8210-305dbb70b40e',
    input: {
      title: '爆款候选拆解 | 花41元从中国坐火车去蒙古国，曾经的蒙古帝国现在怎么样了，当地人真实生活又如何',
    },
  };

  const planArtifact = {
    artifactId: 'mission-plan:1',
    type: 'cross_agent_mission_plan',
    title: '多人协作分工',
    data: {
      summary: parentTask.input.title,
      subtasks: [
        {
          agentId: 'xiaod',
          taskType: 'media.transcribe-and-refine',
          title: '获取并整理：花41元从中国坐火车去蒙古国',
          description: '视频转录与音频提取',
          acceptance: '交付有效转录稿',
        },
        {
          agentId: 'video-content-analyst',
          taskType: 'content.analyze-video-benchmark',
          title: '拆解爆款候选：花41元从中国坐火车去蒙古国',
          description: '深度拆解爆款结构',
          acceptance: '交付拆解报告',
        },
      ],
    },
  };

  const planHtml = renderArtifact(planArtifact, { task: parentTask });
  // 产物卡片摘要应展示环节明细，而不是盲目展示父任务标题
  assert.match(planHtml, /共 2 个分工环节：小D \(素材采集\/转录\)/);
  // 复制内容应复制完整结构化执行清单，而非只复制标题
  assert.match(planHtml, /data-copy-text="【总任务协同目标】[\s\S]*【多人协同分工执行清单】/);
  assert.doesNotMatch(planHtml, /data-copy-text="多人协作分工"/);
  assert.doesNotMatch(planHtml, /data-copy-text="爆款候选拆解 \| 花41元从中国坐火车去蒙古国，曾经的蒙古帝国现在怎么样了，当地人真实生活又如何"/);

  const summaryArtifact = {
    artifactId: 'mission-summary:1',
    type: 'cross_agent_mission_summary',
    title: '老板任务协作汇总',
    data: {
      summary: parentTask.input.title,
      completed: false,
      statuses: [
        {
          key: 'acquire-transcript',
          title: '获取并整理：花41元从中国坐火车去蒙古国',
          employeeId: 'xiaod',
          status: 'failed',
        },
        {
          key: 'analyze-video',
          title: '拆解爆款候选：花41元从中国坐火车去蒙古国',
          employeeId: 'video-content-analyst',
          status: 'planned',
        },
      ],
      decision: {
        outcome: 'partially_completed',
        completedCount: 0,
        totalCount: 2,
      },
    },
  };

  const summaryHtml = renderArtifact(summaryArtifact, { task: parentTask });
  assert.match(summaryHtml, /交付达成概况：已完成 0 \/ 共 2 项（部分完成 \/ 存在异常）/);
  assert.match(summaryHtml, /data-copy-text="【协同汇总结论】[\s\S]*【各岗位交付状态明细】/);
});

test('parseOriginDescription 剥离嵌套的视频标题、清理尾部冒号与指标冗余，并还原纯净分步计划', async () => {
  const { parseOriginDescription } = await import('../public/task-record-origin-view.js');
  const task = {
    taskId: 'test-denoise-1',
    input: {
      title: '爆款候选拆解 | 2018年许家印出差比古代皇帝出游还要隆重！',
      description: '1. 获取并整理：2018年许家印出差比古代皇帝出游还要隆重！：通过内容获取中心获取公开或已授权素材，生成来源证据、质量报告、确认稿和可用的关键帧证据。\n2. 拆解爆款候选：2018年许家印出差比古代皇帝出游还要隆重！：命中 T1，R=391.0000，M=0.1256；点赞=1173，收藏=464，播放=223000，粉丝快照=9339；基线为该作品之前最近 20/20 条作品核心指标中位数 300；指标证据：formal，来源 bilibili，观察时间 2026-08-27 19:05:38；该评分只用于筛选和排序，不构成传播因果判断。',
      focus: '解释开场钩子、内容结构、受众触发点、可复制要素和不可复制上下文。',
    },
  };

  const parsed = parseOriginDescription(task.input.description, task);
  assert.equal(parsed.steps.length, 2);

  // Step 1: 小D素材获取与转录
  assert.equal(parsed.steps[0].title, '获取并整理素材与证据');
  assert.equal(parsed.steps[0].agentName, '小D (素材采集/转录)');
  assert.equal(parsed.steps[0].desc, '通过内容获取中心获取公开或已授权素材，生成来源证据、质量报告、确认稿和可用的关键帧证据。');
  assert.doesNotMatch(parsed.steps[0].desc, /2018年许家印出差/);

  // Step 2: 小拆爆款拆解
  assert.equal(parsed.steps[1].title, '拆解爆款候选逻辑与结构');
  assert.equal(parsed.steps[1].agentName, '小拆 (爆款拆解专家)');
  assert.equal(parsed.steps[1].desc, '解释开场钩子、内容结构、受众触发点、可复制要素和不可复制上下文。');
  assert.doesNotMatch(parsed.steps[1].desc, /2018年许家印出差/);
  assert.doesNotMatch(parsed.steps[1].desc, /[:：]$/); // 无悬挂冒号
  assert.doesNotMatch(parsed.steps[1].desc, /命中 T1/);

  // 原始卡片渲染不包含冗余的“登记于”绝对时间
  const cardHtml = renderOriginCard(task);
  assert.doesNotMatch(cardHtml, /origin-time-tag/);
  assert.doesNotMatch(cardHtml, /登记于/);
});

test('compactAttentionReason 过滤长视频标题并直出精炼行动指引', async () => {
  const { compactAttentionReason } = await import('../public/task-record-workbench-helpers.js');
  const task = {
    taskId: 'test-reason-1',
    input: {
      title: '爆款候选拆解 | 2018年许家印出差比古代皇帝出游还要隆重！',
    },
    presentation: {
      attention: {
        headline: '任务未完成',
        cause: '获取并整理：2018年许家印出差比古代皇帝出游还要隆重！ 未完成：可在飞书回复“重试小D任务”从安全断点继续，无需重复上传。',
      },
    },
  };

  const reason = compactAttentionReason(task);
  assert.equal(reason, '小D素材转录未完成 · 可在飞书回复“重试小D任务”');
  assert.doesNotMatch(reason, /2018年许家印出差/);
});

test('task-progress-bar 在任务失败/中断时不展示误导性的秒级耗时，并清理 popover 中断原因', async () => {
  const { renderTaskProgressBar } = await import('../public/task-progress-bar.js');
  const failedTask = {
    taskId: 'failed-task-1',
    status: 'failed',
    createdAt: '2026-08-27T19:05:38.000Z',
    updatedAt: '2026-08-27T19:05:39.000Z',
    input: {
      title: '爆款候选拆解 | 2018年许家印出差比古代皇帝出游还要隆重！',
    },
  };
  const attention = {
    cause: '获取并整理：2018年许家印出差比古代皇帝出游还要隆重！ 未完成：可在飞书回复“重试小D任务”从安全断点继续，无需重复上传。',
    actions: [{ actionKey: 'request_safe_recovery', label: '请求安全恢复' }],
  };

  const html = renderTaskProgressBar(failedTask, { attention });
  assert.match(html, /data-pipeline-action="recovery"/);
  assert.match(html, /data-pipeline-action-key="request_safe_recovery"/);
  assert.match(html, /data-pipeline-action-label="请求安全恢复"/);
  assert.match(html, /素材获取与转录未完成：可在飞书回复“重试小D任务”从安全断点继续/);
  assert.doesNotMatch(html, /2018年许家印出差/);
  assert.doesNotMatch(html, /title="1\.0 秒"/);
  assert.match(html, /title="分析执行中断"/);
});

test('renderStructuredEvidence 将生硬技术参数解析为结构化标签并收拢底层日志', async () => {
  const { renderStructuredEvidence } = await import('../public/task-record-detail-view.js');
  const rawEvidence = '执行结果：video_content_analyze_execute 返回 status=succeeded、recommendedCompletionStatus=succeeded、currentStage=full_analysis_ready。产物为正式深度拆解报告，证据模式 formal，分析意图 deep，报告版本 video-analysis/v2，完整性 complete。转录校验已关联 sourceTranscriptArtifactId=confirmed-transcript:0f452316-3600-4786-9cdd-6e743ca45862:v1，视觉执行回执 receipt:e3dcdef16998ec60cf54e9b29bfbfd4a 有效。本次只完成拆解与交付，未产生模板或策略层面的直接修改。';
  
  const html = renderStructuredEvidence(rawEvidence);
  assert.match(html, /class="record-evidence-card record-judgment-card"/);
  assert.match(html, /class="record-evidence-tag is-success">✓ 执行成功<\/span>/);
  assert.match(html, /class="record-evidence-tag is-success">✓ 推荐完成<\/span>/);
  assert.match(html, /class="record-evidence-tag">阶段: full_analysis_ready<\/span>/);
  assert.match(html, /class="record-evidence-tag">版本: video-analysis\/v2<\/span>/);
  assert.match(html, /class="record-evidence-tag is-success">✓ 完整性校验通过<\/span>/);
  assert.match(html, /class="record-evidence-tag is-success">✓ 视觉回执有效<\/span>/);
  assert.match(html, /class="record-evidence-tag is-success">✓ 转录校验已关联<\/span>/);
  assert.match(html, /本次只完成拆解与交付，未产生模板或策略层面的直接修改/);
  assert.match(html, /class="record-evidence-trace"/);
  assert.match(html, /底层技术追踪与凭证 \(Trace\)/);
});

test('renderAttentionDetail 在 waiting_test 状态下过滤重复确认采纳按钮并渲染优雅工单与判断卡片', async () => {
  const waitingTask = {
    taskId: 'waiting-task-1',
    status: 'waiting_test',
    paperclipIssue: {
      identifier: 'AGE-1619',
      detailUrl: 'http://127.0.0.1:3100/issues/AGE-1619',
    },
    input: {
      description: '只基于小D确认稿分析选题、开场钩子、叙事结构、节奏、证据与可复用方法',
    },
  };
  const attention = {
    kind: 'waiting_test',
    headline: '等待验证',
    cause: '小拆已完成基于小D确认稿的深度爆款拆解。',
    evidence: '执行结果：video_content_analyze_execute 返回 status=succeeded、recommendedCompletionStatus=succeeded。视觉执行回执 receipt:e3dcdef16998 有效。',
    actions: [{
      actionKey: 'accept_reviewed_artifact',
      label: '确认采纳',
      emphasis: 'primary',
      confirmation: '核对本次产物无误后，将直接标记为已完成并完成业务闭环。',
    }],
  };

  const html = renderAttentionDetail(attention, null, escapeHtml, { task: waitingTask });
  assert.match(html, /class="record-evidence-card record-governance-card"/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:3100\/issues\/AGE-1619"/);
  assert.match(html, /class="record-issue-badge"/);
  assert.match(html, /工单 #AGE-1619 ↗/);
  assert.doesNotMatch(html, /&lt;a href=/); // Must not escape raw HTML string
  assert.doesNotMatch(html, /\[object Object\]/);
  // Duplicate accept button and confirmation help note must be filtered out
  assert.doesNotMatch(html, /<button[^>]*>确认采纳<\/button>/);
  assert.doesNotMatch(html, /💡 动作说明：/);
  // Judgment card must be structured
  assert.match(html, /class="record-evidence-card record-judgment-card"/);
  assert.match(html, /✓ 执行成功/);
  assert.match(html, /✓ 推荐完成/);
});

test('renderAttentionDetail 恢复状态展示：同任务完成不展示自跳转链接，异任务完成展示查看已恢复任务', () => {
  const currentTask = {
    taskId: '6043a407-1234-5678-9abc-def012345678',
    status: 'failed',
  };

  // Case 1: Recovery completed on the same task -> no redundant link
  const selfCompletedAttention = {
    kind: 'failed',
    headline: '本轮未完成',
    verification: {
      status: 'completed',
      message: '恢复已经完成。',
      taskId: '6043a407-1234-5678-9abc-def012345678',
      detailPath: '/tasks/6043a407-1234-5678-9abc-def012345678',
    },
  };
  const html1 = renderAttentionDetail(selfCompletedAttention, null, escapeHtml, { task: currentTask });
  assert.match(html1, /恢复已经完成。/);
  assert.doesNotMatch(html1, /class="record-recovery-link"/);
  assert.doesNotMatch(html1, /恢复进度/);

  // Case 2: Recovery completed on a child task -> link with "查看已恢复任务"
  const childCompletedAttention = {
    kind: 'failed',
    headline: '本轮未完成',
    verification: {
      status: 'completed',
      message: '恢复已经完成。',
      taskId: '88888888-1234-5678-9abc-def012345678',
      detailPath: '/tasks/88888888-1234-5678-9abc-def012345678',
    },
  };
  const html2 = renderAttentionDetail(childCompletedAttention, null, escapeHtml, { task: currentTask });
  assert.match(html2, /恢复已经完成。/);
  assert.match(html2, /class="record-recovery-link"[^>]*>查看已恢复任务<\/a>/);
  assert.match(html2, /href="\/tasks\/88888888-1234-5678-9abc-def012345678"/);
  assert.doesNotMatch(html2, /恢复进度/);

  // Case 3: Recovery in progress on a child task -> link with "查看恢复进度"
  const childRunningAttention = {
    kind: 'failed',
    headline: '本轮未完成',
    verification: {
      status: 'running',
      message: '恢复任务正在执行，尚未完成验证。',
      taskId: '88888888-1234-5678-9abc-def012345678',
      detailPath: '/tasks/88888888-1234-5678-9abc-def012345678',
    },
  };
  const html3 = renderAttentionDetail(childRunningAttention, null, escapeHtml, { task: currentTask });
  assert.match(html3, /恢复任务正在执行/);
  assert.match(html3, /class="record-recovery-link"[^>]*>查看恢复进度<\/a>/);
});

test('task-progress-bar 在任务失败时不将交付成果标为已完成(绿色)，并支持阶段点击跳转', async () => {
  const { renderTaskProgressBar } = await import('../public/task-progress-bar.js');
  const failedTaskWithArtifacts = {
    taskId: 'failed-with-artifacts-1',
    status: 'failed',
    artifactRefs: [{ type: 'source_evidence_record', title: '来源存证' }, { type: 'raw_asr', title: '粗转录' }],
  };
  const barHtml = renderTaskProgressBar(failedTaskWithArtifacts);
  assert.match(barHtml, /progress-stage is-danger/);
  // Stage 4 (交付成果) must be muted (not completed) when previous stage failed
  assert.match(barHtml, /<div class="progress-stage is-muted"[^>]*data-pipeline-nav="deliverables"[^>]*aria-label="交付成果"/);
  assert.match(barHtml, /任务中断（已暂存 2 份阶段存证）/);
  assert.match(barHtml, /data-pipeline-nav="origin"/);
});

test('renderArtifact 支持所有结构化产物点击展开预览与正文复制', async () => {
  const { renderArtifact } = await import('../public/task-record-presentation.js');
  const structuredArtifact = {
    type: 'source_evidence_record',
    title: '来源存证记录',
    data: {
      url: 'https://example.com/video/123',
      author: '创作者A',
      platform: '小红书',
      status: 'extracted',
    },
  };
  const html = renderArtifact(structuredArtifact);
  assert.match(html, /class="record-artifact-item is-expandable is-collapsed"/);
  assert.match(html, /data-copy-text/);
  assert.match(html, /【链接】https:\/\/example\.com\/video\/123/);
  assert.match(html, /【平台】小红书/);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[character]);
}




