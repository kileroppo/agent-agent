import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentFixture,
  setupTaskService as setup,
  verifiedHealthReport,
  verifiedIntakeRecord,
} from './support/task-service-fixture.js';

test('相同飞书幂等键并发到达时共享同一次执行结果，不会二次执行 Agent', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let executed = 0;
  const { service, records } = setup({ agents:[operator] });
  service.executors.operator = { async execute(task) {
    executed += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] };
  } };
  const input = { title:'检查系统状态', taskType:'operations.health-review', idempotencyKey:'feishu:message-42', source:{ channel:'feishu', eventRef:'feishu:message-42' } };
  const [first, duplicate] = await Promise.all([service.create(input), service.create(input)]);
  assert.equal(first.taskId, duplicate.taskId);
  assert.equal(first.status, 'succeeded');
  assert.equal(duplicate.status, 'succeeded');
  assert.equal(records.tasks.length, 1);
  assert.equal(executed, 1);
});
test('相同幂等键携带不同任务内容时明确拒绝，不返回旧任务冒充本次结果', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  const { service } = setup({ agents:[operator] });
  service.executors.operator = { async execute(task) {
    return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] };
  } };
  await service.create({ title:'检查系统 A', taskType:'operations.health-review', idempotencyKey:'feishu:drift-42' });
  await assert.rejects(
    service.create({ title:'检查系统 B', taskType:'operations.health-review', idempotencyKey:'feishu:drift-42' }),
    (error) => error.code === 'task_idempotency_conflict',
  );
});
test('小D登记完成后才启动状态跟踪，缺少链接不会调用下游', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  let executes = 0; let observed;
  const executor = { async execute() { executes += 1; return { status:'needs_input', currentStage:'source_url_required' }; }, observe(task) { observed = task; } };
  const { service } = setup({ agents:[xiaod] }); service.executors.xiaod = executor;
  const task = await service.create({ title:'整理视频', taskType:'media.transcribe-and-refine' });
  assert.equal(task.status, 'needs_input'); assert.equal(executes, 0); assert.equal(observed, undefined);
});
test('默认接收高风险描述只生成审核建议，不创建审批或外部动作', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const { service, records } = setup({ agents:[coordinator] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[verifiedIntakeRecord(task, { recommendedTaskType:'governance.approval-review', recommendedAgentId:'reviewer', externalActionStarted:false })] }; } };
  const task = await service.create({ title:'审核发布范围', taskType:'army.intake' });
  assert.equal(task.status, 'succeeded'); assert.equal(records.approvals.length, 0); assert.equal(task.artifactRefs[0].data.recommendedAgentId, 'reviewer');
});
test('默认接收入口会保留用户粘贴在描述中的公开链接', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const { service } = setup({ agents:[coordinator] }); service.executors.ajun = { async execute() { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[] }; } };
  const task = await service.create({ title:'整理这条视频', description:'请处理 https://www.youtube.com/watch?v=example。', taskType:'army.intake' });
  assert.equal(task.input.sourceUrl, 'https://www.youtube.com/watch?v=example');
});
test('任务登记会保留同一请求中的多条公开链接，供公开资料报告员逐条处理', async () => {
  const reporter = agentFixture('public-reporter', '公开资料报告员', ['report.public-material'], {
    runtime:{ kind:'proposal-public-report' },
  });
  const { service } = setup({ agents:[reporter] });
  service.fallbackExecutor = { supports(){ return true; }, async execute(){ return { status:'succeeded', currentStage:'done', artifactRefs:[] }; } };
  const task = await service.create({ title:'对比 https://example.com/a 和 https://example.com/b', taskType:'report.public-material' });
  assert.deepEqual(task.input.sourceUrls, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(task.input.sourceUrl, 'https://example.com/a');
});
test('概览优先呈现待审批任务，并给出不会自动继续的下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-done', status:'succeeded', approvalRefs:[], input:{ title:'已完成', description:'', sourceUrl:null }, updatedAt:'2026-07-20T08:00:00.000Z' },
    { taskId:'task-waiting', status:'waiting_approval', approvalRefs:['approval-1'], input:{ title:'发布周报', description:'', sourceUrl:null }, updatedAt:'2026-07-20T09:00:00.000Z' },
    { taskId:'task-running', status:'running', approvalRefs:[], input:{ title:'本机检查', description:'', sourceUrl:null }, updatedAt:'2026-07-20T10:00:00.000Z' }
  );
  records.approvals.push({ approvalId:'approval-1', taskId:'task-waiting', status:'pending' });
  const overview = await service.overview();
  const waitingAction = { taskId:'task-waiting', title:'发布周报', status:'waiting_approval', action:'请确认任务范围；在你确认前，系统不会继续执行。' };
  assert.deepEqual(overview.taskFocus, {
    total:3, completed:1, inProgress:1, backgroundInProgress:0, paused:0,
    needsInput:0, waitingApproval:1, waitingTest:0, failed:0,
    ownerActionable:1, reviewBacklog:0, verificationBacklog:0, unresolvedFailures:0, historicalArchived:0, validatedByLaterEvidence:0,
    backlog:{ current:1, superseded:0, validated_by_later_evidence:0, expected_acceptance_failure:0, expected_boundary_rejection:0, intentionally_disabled:0, needs_human:1, archived_cancelled:0, needs_reverification:0, unresolved_failure:0, unresolved:0, completed:1 },
    actions:[waitingAction], next:waitingAction,
  });
});
test('概览把等待 Mac工作间的任务列为进行中并说明自动领取', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-waiting-worker', status:'waiting_worker', approvalRefs:[],
    input:{ title:'整理本机视频', description:'', sourceUrl:'https://example.com/video.mp4' },
    updatedAt:'2026-07-26T08:00:00.000Z'
  });
  service.setWorkerStatus(() => ({ status:'waiting', detail:'等待 Mac工作间连接。' }));
  const overview = await service.overview();
  assert.equal(overview.taskFocus.inProgress, 1);
  assert.deepEqual(overview.taskFocus.next, {
    taskId:'task-waiting-worker',
    title:'整理本机视频',
    status:'waiting_worker',
    action:'这项工作需要老板的 Mac；已安全排队，Mac 上线后会自动领取。'
  });
  assert.equal(overview.capabilities.find((item) => item.id === 'mac-worker').status, 'waiting');
});
test('概览把待测试任务明确说明为待测试，不误说成排队', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-waiting-test', status:'waiting_test', approvalRefs:[],
    input:{ title:'核对飞书提醒', description:'', sourceUrl:null },
    error:{ userMessage:'这项检查暂时需要人工确认，已列入待测试，其他工作会继续。' },
    updatedAt:'2026-07-22T08:00:00.000Z'
  });
  const overview = await service.overview();
  assert.equal(overview.taskFocus.waitingTest, 1);
  assert.deepEqual(overview.taskFocus.next, {
    taskId:'task-waiting-test', title:'核对飞书提醒', status:'waiting_test',
    action:'这项检查暂时需要人工确认，已列入待测试，其他工作会继续。'
  });
});
test('概览不把内部 Hermes 历史验收失败当成老板下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'internal-old', status:'needs_input', approvalRefs:[],
      source:{ channel:'army-mission', originChannel:'hermes-native' },
      input:{ title:'内部旧验收', description:'', sourceUrl:null },
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'completed-later', status:'succeeded', approvalRefs:[],
      source:{ channel:'army-mission', originChannel:'hermes-native' },
      input:{ title:'同一能力已完成', description:'', sourceUrl:null },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.needsInput, 1);
  assert.equal(overview.taskFocus.next, null);
});
test('概览不再提示已被后续成功任务替代的旧失败', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'old-mission', taskType:'army.cross-agent-mission', status:'needs_input', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'旧任务', sourceUrl:'https://example.com/video' },
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'recovered-mission', taskType:'army.cross-agent-mission', status:'succeeded', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'恢复后的任务', sourceUrl:'https://example.com/video' },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.needsInput, 1);
  assert.equal(overview.taskFocus.next, null);
});
test('概览保留历史未完成计数，但不把早于后续用户结果的旧问题当成当前下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'old-input', taskType:'research.intel-report', status:'needs_input', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'旧搜索需要补词' },
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'new-result', taskType:'content.video-benchmark-analysis', status:'succeeded', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'后来完成的视频拆解' },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.needsInput, 1);
  assert.equal(overview.taskFocus.next, null);
});
test('概览不把已经完成的接收建议冒充老板待办', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-intake', status:'succeeded', approvalRefs:[], input:{ title:'评估岗位能力', description:'', sourceUrl:null }, artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }], updatedAt:'2026-07-20T10:00:00.000Z' });
  const overview = await service.overview();
  assert.equal(overview.taskFocus.ownerActionable, 0);
  assert.deepEqual(overview.taskFocus.actions, []);
  assert.equal(overview.taskFocus.next, null);
});
test('概览有业务任务运行时不让已完成的接收建议抢占下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'task-running', status:'running', approvalRefs:[],
      input:{ title:'后台巡检', description:'', sourceUrl:null },
      updatedAt:'2026-07-20T11:00:00.000Z'
    },
    {
      taskId:'task-intake', status:'succeeded', approvalRefs:[],
      input:{ title:'评估岗位能力', description:'', sourceUrl:null },
      artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }],
      updatedAt:'2026-07-20T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.inProgress, 1);
  assert.equal(overview.taskFocus.ownerActionable, 0);
  assert.equal(overview.taskFocus.next.taskId, 'task-running');
});
test('概览不把早于后续用户结果的旧接收建议重新顶到当前下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'old-intake', taskType:'army.intake', status:'succeeded', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'旧建议' },
      artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' } }],
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'new-result', taskType:'office.knowledge-summary', status:'succeeded', approvalRefs:[],
      source:{ channel:'hermes-native' },
      input:{ title:'新的归档结果' },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.next, null);
});

test('概览把 Paperclip 定时巡检留在记录里但不算业务进行中', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'scheduled-health', taskType:'operations.health-review', status:'running', approvalRefs:[],
    source:{ channel:'paperclip' },
    input:{ title:'A君定时本机巡检', description:'agent-army:operations-health-v1\n只读检查。' },
    updatedAt:'2026-08-02T07:00:00.000Z'
  });
  const overview = await service.overview();
  assert.equal(overview.tasks.length, 1);
  assert.equal(overview.taskFocus.inProgress, 0);
  assert.equal(overview.taskFocus.backgroundInProgress, 1);
  assert.equal(overview.taskFocus.next, null);
});

test('概览最多返回五条真正需要老板处理的待办', async () => {
  const { service, records } = setup();
  for (let index = 0; index < 7; index += 1) {
    records.tasks.push({
      taskId:`task-approval-${index}`, status:'waiting_approval', approvalRefs:[],
      source:{ channel:'feishu' }, input:{ title:`待确认 ${index}` },
      updatedAt:`2026-08-02T07:0${index}:00.000Z`
    });
  }
  const overview = await service.overview();
  assert.equal(overview.taskFocus.ownerActionable, 7);
  assert.equal(overview.taskFocus.actions.length, 5);
  assert.equal(overview.taskFocus.next.taskId, overview.taskFocus.actions[0].taskId);
});

test('概览如实区分已能收发飞书与尚未接入的外部账号写入动作', async () => {
  const { service } = setup();
  const overview = await service.overview();
  const feishu = overview.capabilities.find((item) => item.id === 'feishu-channel');
  const external = overview.capabilities.find((item) => item.id === 'external-execution');
  assert.equal(feishu.status, 'partial');
  assert.match(feishu.detail, /私聊与审批卡已可用/);
  assert.match(feishu.detail, /默认关闭/);
  assert.equal(external.status, 'planned');
  assert.match(external.detail, /尚未接入/);
  const authorizedRead = overview.capabilities.find((item) => item.id === 'authorized-content-read');
  assert.equal(authorizedRead.status, 'partial');
  assert.match(authorizedRead.detail, /具体任务验证/);
});

test('能力验证返回证据任务、时间与相对最近失败的新鲜度', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'public-web-success', taskType:'research.intel-report', status:'succeeded',
      updatedAt:'2026-08-09T08:00:00.000Z', artifactRefs:[{
        artifactId:'research-report', validation:{ exists:true, readable:true, nonEmpty:true },
      }],
    },
    {
      taskId:'public-web-failure', taskType:'research.intel-report', status:'failed',
      updatedAt:'2026-08-10T08:00:00.000Z', artifactRefs:[],
    },
  );
  const overview = await service.overview();
  const capability = overview.capabilities.find((item) => item.id === 'content-public-web-fetch');
  assert.equal(capability.truth.overall, 'verified');
  assert.equal(capability.truth.evidenceTaskId, 'public-web-success');
  assert.equal(capability.truth.verifiedAt, '2026-08-09T08:00:00.000Z');
  assert.equal(capability.truth.latestFailureTaskId, 'public-web-failure');
  assert.equal(capability.truth.latestFailureAt, '2026-08-10T08:00:00.000Z');
  assert.equal(capability.truth.freshness, 'predates_latest_failure');
});

test('概览如实显示小办 PPTD 与本地 PPTX 均可用', async () => {
  const skillExecutionRegistry = {
    async overview() {
      return [{
        slug:'open-kimi-ppt',
        status:'ready',
        modes:{
          compose:{ status:'ready' },
          visualQa:{ status:'ready' },
          export:{ status:'ready' },
        },
        recovery:null,
      }];
    },
  };
  const { service } = setup({ skillExecutionRegistry });
  const overview = await service.overview();
  const presentation = overview.capabilities.find((item) => item.id === 'office-presentation');
  assert.equal(presentation.status, 'ready');
  assert.match(presentation.detail, /PPTD 可用/);
  assert.match(presentation.detail, /PPTX 可用/);
});

for (const [name, channelStatus, expectedStatus, expectedDetail] of [
  ['概览会如实显示官方飞书入口已经连接，不把等待状态冒充成已连接', { status:'connected', message:'已连接' }, 'ready', /已连接/],
  ['概览把 Hermes 原生飞书入口显示为已就绪', { status:'external', message:'A君飞书入口已交由 Hermes 原生 Gateway。' }, 'ready', /Hermes 原生 Gateway/],
  ['概览不会把飞书投递结果不确定显示成入口完全正常', { status:'delivery_uncertain', message:'有 1 条飞书完成跟进的投递结果不确定。' }, 'partial', /投递结果不确定/],
]) {
  test(name, async () => {
    const { service } = setup();
    service.setFeishuChannelStatus(() => channelStatus);
    const overview = await service.overview();
    const feishu = overview.capabilities.find((item) => item.id === 'feishu-channel');
    assert.equal(feishu.status, expectedStatus);
    assert.match(feishu.detail, expectedDetail);
  });
}

test('概览优先显示独立飞书应用的实时连接状态，不把静态 Profile 当成入口真相', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review'], {
    independentRuntime:{ state:'channel_pending' },
  });
  const { service } = setup({
    agents:[operator],
    agentChannelStates:() => ({ operator:{ agentId:'operator', status:'connected', message:'运维官飞书智能体应用已连接。' } })
  });
  const overview = await service.overview();
  assert.deepEqual(overview.agents[0].feishuChannel, {
    status:'connected', message:'运维官飞书智能体应用已连接。'
  });
  assert.equal(overview.agents[0].independentRuntime.state, 'channel_pending');
});

test('后台按需岗位即使残留外部 Gateway 状态也不显示独立飞书入口', async () => {
  const architect = agentFixture('architect', '架构师', ['governance.architecture-review'], {
    interaction:{ directFeishu:'disabled', visibility:'on-demand' },
  });
  const { service } = setup({
    agents:[architect],
    agentChannelStates:() => ({
      architect:{ status:'external', message:'旧 Gateway 环境仍有残留。' }
    })
  });
  const overview = await service.overview();
  assert.equal(overview.agents[0].feishuChannel, undefined);
  assert.equal(overview.onDemandAgents[0].agentId, 'architect');
});

test('概览只在独立飞书入口已有终态任务证据时标记为已验证', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  const { service, records } = setup({
    agents:[operator],
    agentChannelStates:() => ({ operator:{ status:'connected', message:'运维官飞书智能体应用已连接。' } })
  });
  records.tasks.push({ taskId:'operator-feishu-1', status:'succeeded', source:{ channel:'feishu', targetAgentId:'operator' }, input:{ title:'检查军团状态' } });
  const overview = await service.overview();
  assert.equal(overview.agents[0].feishuChannel.verified, true);
});

test('Hermes 接管的独立员工已有飞书终态任务时也标记为已验证', async () => {
  const employee = agentFixture('intel-researcher', '小R', ['research.intel-report']);
  const { service, records } = setup({
    agents:[employee],
    agentChannelStates:() => ({ 'intel-researcher':{ status:'external', message:'已由独立 Hermes Profile Gateway 接管。' } })
  });
  records.tasks.push({ taskId:'intel-feishu-1', status:'succeeded', source:{ channel:'feishu', targetAgentId:'intel-researcher' }, input:{ title:'研究公开资料' } });
  const overview = await service.overview();
  assert.equal(overview.agents[0].feishuChannel.status, 'external');
  assert.equal(overview.agents[0].feishuChannel.verified, true);
});

test('飞书跟进在小D完成并确认文档权限后返回真实交付链接', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-21T10:00:00.000Z', artifactRefs:[{ type:'xiaod_media_delivery', validation:{ exists:true, readable:true, nonEmpty:true }, data:{ larkUrl:'https://example.feishu.cn/docx/example', larkPermissionGranted:true } }] });
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'succeeded');
  assert.match(result.message, /交付文档/);
  assert.match(result.message, /example\.feishu\.cn/);
});

test('终态任务缺少专用可验证产物时返回待测试而不冒充成功', async () => {
  const { service, records } = setup();
  const cases = [
    { taskId:'invalid-health', taskType:'operations.health-review', artifactRefs:[{ type:'health_report', data:{} }] },
    { taskId:'invalid-web', taskType:'report.public-material', artifactRefs:[{ type:'public_web_report', data:{} }] },
    { taskId:'invalid-github', taskType:'research.github-search', artifactRefs:[{ type:'employee_role_report', validation:{ exists:true, readable:true, nonEmpty:true }, data:{ summary:'泛化回报' } }] },
    { taskId:'invalid-intel', taskType:'research.intel-report', artifactRefs:[{ type:'intel_research_report', data:{ conclusion:'缺少来源' } }] },
    { taskId:'invalid-briefing', taskType:'office.briefing-package', artifactRefs:[{ type:'office_briefing_package', data:{ summary:'缺少正文' } }] },
    { taskId:'invalid-presentation', taskType:'office.presentation-package', artifactRefs:[{ type:'office_presentation_source', location:'work/output.pptd', validation:{ structuralQaPassed:false } }] },
    { taskId:'invalid-note', taskType:'office.knowledge-summary', artifactRefs:[{ type:'knowledge_summary_note', location:'work/note.md', validation:{ readable:false } }] },
    { taskId:'invalid-analysis', taskType:'content.video-benchmark-analysis', input:{ analysisIntent:'deep', depth:'full' }, artifactRefs:[{ type:'video_content_analysis_report', validation:{ exists:true, readable:true, nonEmpty:true, modeStructurePassed:true, semanticValidationPassed:true, analysisIntent:'digest', reportVersion:'video-analysis/v2' }, data:{ analysisIntent:'digest', reportVersion:'video-analysis/v2', modules:[{ name:'泛化模块' }] } }] },
    { taskId:'invalid-draft', taskType:'content.platform-draft', artifactRefs:[{ type:'platform_content_draft', data:{ drafts:[] } }] },
    { taskId:'invalid-script', taskType:'content.video-script-package', artifactRefs:[{ type:'video_script_package', data:{} }] },
    { taskId:'invalid-review', taskType:'content.performance-review', artifactRefs:[{ type:'content_performance_report', data:{} }] },
    { taskId:'invalid-media', taskType:'media.transcribe-and-refine', artifactRefs:[{ type:'xiaod_media_delivery', data:{ larkUrl:'https://example.feishu.cn/docx/unverified', larkPermissionGranted:false } }] },
    { taskId:'invalid-generic', taskType:'governance.approval-review', artifactRefs:[] },
  ];
  records.tasks.push(...cases.map((item, index) => ({
    ...item,
    status:'succeeded',
    source:{ chatRef:'chat-a' },
    input:{ title:item.taskId, ...(item.input || {}) },
    updatedAt:`2026-08-07T10:${String(index).padStart(2, '0')}:00.000Z`,
  })));

  for (const item of cases) {
    const result = await service.notificationStatus(item.taskId, 'chat-a');
    assert.equal(result.terminal, true, item.taskId);
    assert.equal(result.status, 'waiting_test', item.taskId);
    assert.match(result.message, /不会|没有找到/, item.taskId);
  }
});

test('后台按需员工运行中和完成时按真实岗位回话，不误报为小D', async () => {
  const reviewer = { agentId:'reviewer', name:'审核官', status:'active', acceptedTaskTypes:['governance.approval-review'] };
  const { service, records } = setup({ agents:[reviewer] });
  records.tasks.push({
    taskId:'task-review', taskType:'governance.approval-review', assigneeAgentId:'reviewer',
    status:'running', source:{ chatRef:'chat-a' }, input:{ title:'核对实施边界' },
    updatedAt:'2026-07-27T09:00:00.000Z', artifactRefs:[]
  });
  const running = await service.notificationStatus('task-review', 'chat-a');
  assert.match(running.message, /正在由审核官处理/);
  assert.doesNotMatch(running.message, /小D/);

  records.tasks[0].status = 'succeeded';
  records.tasks[0].artifactRefs = [{ type:'employee_role_report', validation:{ exists:true, readable:true, nonEmpty:true }, data:{ summary:'边界符合本轮只读审核要求。' } }];
  const completed = await service.notificationStatus('task-review', 'chat-a');
  assert.match(completed.message, /审核官已完成/);
  assert.match(completed.message, /边界符合/);
  assert.doesNotMatch(completed.message, /小D/);
});

test('飞书跟进会返回运维官的结构化健康报告，不误报成小D文档交付', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-health', taskType:'operations.health-review', status:'succeeded',
    source:{ chatRef:'chat-a' }, input:{ title:'军团健康检查' }, updatedAt:'2026-07-26T02:29:51.710Z',
    artifactRefs:[{ type:'health_report', validation:{ exists:true, readable:true, nonEmpty:true }, data:{
      overall:'healthy',
      components:[{ id:'ajun-runtime', name:'A君运行台', status:'healthy', detail:'运行正常。' }],
      recommendedAction:'无需恢复动作。'
    } }]
  });
  const result = await service.notificationStatus('task-health', 'chat-a');
  assert.equal(result.terminal, true);
  assert.match(result.message, /【运维官健康检查】/);
  assert.match(result.message, /整体：正常/);
  assert.match(result.message, /A君运行台：正常/);
  assert.doesNotMatch(result.message, /小D|飞书文档权限/);
});

test('飞书跟进会按公开资料报告员的真实摘要回话，不冒充是小D完成', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-web', taskType:'report.public-material', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'整理公开网页' }, updatedAt:'2026-07-22T10:00:00.000Z', artifactRefs:[{ type:'public_web_report', validation:{ exists:true, readable:true, nonEmpty:true }, data:{ summary:'这是一份可读的公开网页摘要。' } }] });
  const result = await service.notificationStatus('task-web', 'chat-a');
  assert.equal(result.terminal, true);
  assert.match(result.message, /公开资料报告员/);
  assert.match(result.message, /内容概览/);
  assert.match(result.message, /来源/);
  assert.doesNotMatch(result.message, /小D/);
});

test('飞书跟进会把小R的 GitHub 和主题研究产物回到原会话', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'github-result', taskType:'research.github-search', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'找开源项目' }, updatedAt:'2026-07-23T10:00:00.000Z', artifactRefs:[{ type:'research_github_report', validation:{ exists:true, readable:true, nonEmpty:true }, data:{ query:'agent', results:[{ fullName:'openai/example', stars:100, language:'JavaScript', assessment:'近三个月仍有更新。', url:'https://github.com/openai/example' }] } }] },
    { taskId:'intel-result', taskType:'research.intel-report', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'研究主题' }, updatedAt:'2026-07-23T10:01:00.000Z', artifactRefs:[{ type:'intel_research_report', validation:{ exists:true, readable:true, nonEmpty:true }, data:{ topic:'Agent 运行时', background:'公开背景', findings:['公开发现'], conclusion:'公开结论', recommendations:['先验证'], openQuestions:['还需来源'], sources:[{ title:'资料', source:'https://example.com/a' }] } }] }
  );
  const github = await service.notificationStatus('github-result', 'chat-a');
  assert.match(github.message, /小R/);
  assert.match(github.message, /https:\/\/github\.com\/openai\/example/);
  const intel = await service.notificationStatus('intel-result', 'chat-a');
  assert.match(intel.message, /【小R 研究报告】/);
  assert.match(intel.message, /公开结论/);
  assert.match(intel.message, /https:\/\/example\.com\/a/);
});

test('飞书跟进会把办公执行助理的真实汇报包摘要回到原会话', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-office',
    taskType:'office.briefing-package',
    status:'succeeded',
    source:{ chatRef:'chat-office' },
    input:{ title:'整理三项员工结果' },
    artifactRefs:[{
      type:'office_briefing_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ title:'三项员工结果｜办公汇报包', summary:'已核对三项工作。', sourceTasks:[{ taskId:'a' }, { taskId:'b' }, { taskId:'c' }], openItems:['小D还缺链接'], nextAction:'补充链接后生成最终版。', markdown:'# 汇报包' }
    }]
  });
  const result = await service.notificationStatus('task-office', 'chat-office');
  assert.equal(result.status, 'succeeded');
  assert.match(result.message, /办公执行助理已完成/);
  assert.match(result.message, /已核对 3 项关联工作/);
  assert.match(result.message, /小D还缺链接/);
});

test('飞书跟进会把老板多人任务作为一个总任务汇报，而不是误报成小D交付', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'mission-business',
    taskType:'army.cross-agent-mission',
    status:'succeeded',
    source:{ chatRef:'chat-boss' },
    input:{ title:'完成老板本周内容任务' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:true },
      data:{
        kind:'business',
        summary:'完成老板本周内容任务',
        completed:true,
        terminal:true,
        statuses:[
          { title:'整理公开视频', employeeId:'xiaod', status:'succeeded' },
          { title:'研究公开资料', employeeId:'intel-researcher', status:'succeeded' },
          { title:'整理老板汇报', employeeId:'office-assistant', status:'succeeded' }
        ],
        decision:{ briefing:{ summary:'三项工作已核对并汇总。', openItems:[], nextAction:'请老板审阅最终汇报。' } }
      }
    }]
  });
  const result = await service.notificationStatus('mission-business', 'chat-boss');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'succeeded');
  assert.match(result.message, /【A君总任务】/);
  assert.match(result.message, /3\/3 项完成/);
  assert.match(result.message, /小D：已完成/);
  assert.match(result.message, /小R：已完成/);
  assert.match(result.message, /办公执行助理：已完成/);
  assert.match(result.message, /三项工作已核对并汇总/);
  assert.doesNotMatch(result.message, /飞书文档权限/);
});

test('老板多人任务仍在推进时只回真实阶段，不提前宣布完成', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'mission-running',
    taskType:'army.cross-agent-mission',
    status:'running',
    source:{ chatRef:'chat-boss' },
    input:{ title:'完成老板本周内容任务' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:false },
      data:{
        kind:'business',
        summary:'完成老板本周内容任务',
        completed:false,
        terminal:false,
        statuses:[
          { title:'整理公开视频', employeeId:'xiaod', status:'running' },
          { title:'研究公开资料', employeeId:'intel-researcher', status:'succeeded' },
          { title:'整理老板汇报', employeeId:'office-assistant', status:'planned' }
        ]
      }
    }]
  });
  const result = await service.notificationStatus('mission-running', 'chat-boss');
  assert.equal(result.terminal, false);
  assert.match(result.message, /1\/3 项完成/);
  assert.match(result.message, /不需要你分别追问/);
});

test('老板多人任务状态虽成功但业务产物缺失或分工未完成时返回待测试', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'mission-missing-delivery', taskType:'army.cross-agent-mission', status:'succeeded',
      source:{ chatRef:'chat-boss' }, input:{ title:'完成视频拆解' },
      artifactRefs:[{ type:'cross_agent_mission_summary', validation:{ exists:true, readable:true, nonEmpty:true }, data:{
        summary:'完成视频拆解', statuses:[
          { title:'获取并完整听审', employeeId:'xiaod', status:'succeeded' },
          { title:'正式拆解', employeeId:'video-content-analyst', taskId:'missing-analysis', status:'succeeded' }
        ]
      } }]
    },
    {
      taskId:'mission-incomplete-child', taskType:'army.cross-agent-mission', status:'succeeded',
      source:{ chatRef:'chat-boss' }, input:{ title:'完成多人任务' },
      artifactRefs:[{ type:'cross_agent_mission_summary', validation:{ exists:true, readable:true, nonEmpty:true }, data:{
        summary:'完成多人任务', statuses:[
          { title:'研究公开资料', employeeId:'intel-researcher', status:'succeeded' },
          { title:'整理汇报', employeeId:'office-assistant', status:'failed' }
        ]
      } }]
    }
  );

  const missing = await service.notificationStatus('mission-missing-delivery', 'chat-boss');
  assert.equal(missing.status, 'waiting_test');
  assert.match(missing.message, /最终业务产物未通过读取确认/);

  const incomplete = await service.notificationStatus('mission-incomplete-child', 'chat-boss');
  assert.equal(incomplete.status, 'waiting_test');
  assert.match(incomplete.message, /未完成部分已如实保留/);
});

test('内容总任务完成时直接交付小拆的真实 13 模块报告而不是只报 2/2', async () => {
  const { service, records } = setup();
  const modules = Array.from({ length:13 }, (_, index) => ({
    name:`模块${index + 1}`,
    finding:`判断${index + 1}`,
    evidence:{ timestamp:`00:${String(index).padStart(2, '0')}`, fragment:`原文片段${index + 1}` }
  }));
  records.tasks.push({
    taskId:'mission-content-done',
    taskType:'army.cross-agent-mission',
    status:'succeeded',
    source:{ channel:'feishu', chatRef:'chat-content' },
    input:{ title:'完整拆解公开视频' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:true },
      data:{
        summary:'完整拆解公开视频',
        statuses:[
          { title:'获取并完整听审', employeeId:'xiaod', taskId:'content-done-xiaod', status:'succeeded' },
          { title:'正式拆解', employeeId:'video-content-analyst', taskId:'content-done-analysis', status:'succeeded' }
        ]
      }
    }]
  });
  records.tasks.push({
    taskId:'content-done-analysis',
    parentTaskId:'mission-content-done',
    taskType:'content.video-benchmark-analysis',
    assigneeAgentId:'video-content-analyst',
    status:'succeeded',
    artifactRefs:[{
      type:'video_content_analysis_report',
      validation:{ exists:true, readable:true,nonEmpty:true },
      data:{ evidenceLabel:'人工确认稿', summary:'已完成深度拆解。', generationMode:'hermes_advisor', modules, actionItems:['先验证开头。'] }
    }]
  });
  const result = await service.notificationStatus('mission-content-done', 'chat-content');
  assert.equal(result.terminal, true);
  assert.match(result.message, /小拆：已完成/);
  assert.match(result.message, /Hermes 深度分析/);
  assert.match(result.message, /13\. 模块13/);
  assert.match(result.message, /行动清单/);
  assert.doesNotMatch(result.message, /只用“完成”状态/);
});

test('内容总任务等待小D完整听审时向原飞书会话暴露审批阶段', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'mission-content-review',
    taskType:'army.cross-agent-mission',
    status:'running',
    source:{ channel:'feishu', chatRef:'chat-content' },
    input:{ title:'拆解公开视频' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:false },
      data:{
        kind:'business',
        summary:'拆解公开视频',
        completed:false,
        terminal:false,
        statuses:[
          { title:'获取并完整听审', employeeId:'xiaod', status:'waiting_approval' },
          { title:'正式拆解', employeeId:'video-content-analyst', status:'planned' }
        ]
      }
    }]
  });
  records.tasks.push({
    taskId:'content-review-child',
    parentTaskId:'mission-content-review',
    taskType:'media.transcribe-and-refine',
    assigneeAgentId:'xiaod',
    status:'waiting_approval',
    source:{ channel:'army-mission' },
    input:{ title:'获取并完整听审' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-job' },
    approvalRefs:['approval-content-review'],
    artifactRefs:[]
  });
  records.approvals.push({
    approvalId:'approval-content-review',
    taskId:'content-review-child',
    status:'pending',
    action:'confirm-transcript-after-complete-listen'
  });
  service.executors.xiaod = {
    async getJob(jobId) {
      assert.equal(jobId, 'xiaod-review-job');
      return {
        output:{
          larkUrl:'https://example.feishu.cn/docx/review',
          larkPermissionGranted:true
        }
      };
    }
  };
  const result = await service.notificationStatus('mission-content-review', 'chat-content');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'waiting_approval');
  assert.match(result.message, /小D：等待批准/);
  assert.match(result.message, /正式拆解/);
  assert.match(result.message, /https:\/\/example\.feishu\.cn\/docx\/review/);
  assert.match(result.message, /我已完整听审并确认/);
  assert.match(result.message, /未确认前不会启动小拆/);
});

test('飞书跟进会越过第一次失败，继续等待运维官发起的重试', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, recovery:{ coordination:{ status:'retrying' } }, updatedAt:'2026-07-21T10:00:00.000Z' },
    { taskId:'task-retry', parentTaskId:'task-media', taskType:'media.transcribe-and-refine', status:'running', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, recovery:{ rootTaskId:'task-media', attempt:1 }, updatedAt:'2026-07-21T10:01:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'running');
  assert.match(result.message, /运维官已自动重试/);
});

test('飞书跟进不会在运维官接手前过早宣布任务失败', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, error:{ retryable:true }, updatedAt:'2026-07-21T10:00:00.000Z' });
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'recovery_pending');
});

test('飞书跟进会原样给出小D待交付的可操作指令并结束本轮监听', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-delivery-pending', taskType:'media.transcribe-and-refine', status:'needs_input', currentStage:'xiaod_awaiting_delivery',
    source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' },
    error:{ code:'xiaod_delivery_pending', userMessage:'本地确认稿已保留。请修复飞书配置后回复“继续飞书交付”。' },
    updatedAt:'2026-08-08T10:00:00.000Z'
  });
  const result = await service.notificationStatus('task-delivery-pending', 'chat-a');
  assert.deepEqual(result, {
    terminal:true,
    status:'needs_input',
    taskId:'task-delivery-pending',
    message:'本地确认稿已保留。请修复飞书配置后回复“继续飞书交付”。'
  });
});

test('飞书跟进遇到交付结果不确定时只要求人工仲裁，不会诱导重试', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-delivery-uncertain', taskType:'media.transcribe-and-refine', status:'needs_input', currentStage:'xiaod_awaiting_delivery',
    source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' },
    error:{ code:'xiaod_delivery_uncertain', userMessage:'飞书交付结果不确定，请先在本机核对并仲裁；确认前不要重试。' },
    updatedAt:'2026-08-08T10:00:00.000Z'
  });
  const result = await service.notificationStatus('task-delivery-uncertain', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'needs_input');
  assert.match(result.message, /本机核对并仲裁/);
  assert.doesNotMatch(result.message, /继续飞书交付/);
});

test('安全重试已登记但子任务尚未读到时，飞书先回执运维官接手', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, recovery:{ coordination:{ status:'retrying' } }, updatedAt:'2026-07-21T10:00:00.000Z' });
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'recovery_pending');
  assert.match(result.message, /运维官已接手/);
});

test('飞书跟进在技术专家接手后给出明确结论', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-21T10:00:00.000Z' },
    { taskId:'task-tech', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'succeeded', input:{ title:'修复内容获取故障' }, updatedAt:'2026-07-21T10:02:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'technical_repair');
  assert.match(result.message, /技术专家/);
});

test('技术专家仍在处理时，飞书跟进会继续等待最终结果', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-22T10:00:00.000Z' },
    { taskId:'task-tech', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'running', input:{ title:'修复内容获取故障' }, updatedAt:'2026-07-22T10:01:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'technical_repair');
  assert.match(result.message, /技术专家/);
});

test('技术专家自动检查卡住时，飞书会明确通知待测试并停止重复等待', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-22T10:00:00.000Z' },
    { taskId:'task-tech', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'waiting_test', input:{ title:'修复内容获取故障' }, artifactRefs:[{ type:'technical_repair_evidence', data:{ nextAction:'等待下一轮受控检查。' } }], updatedAt:'2026-07-22T10:01:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'waiting_test');
  assert.match(result.message, /待测试/);
  assert.match(result.message, /其他工作会继续推进/);
  assert.match(result.message, /等待下一轮受控检查/);
  assert.deepEqual(result.projectionTruth, {
    taskId:'task-tech',
    status:'waiting_test',
    updatedAt:'2026-07-22T10:01:00.000Z',
    revision:'0',
  });
});

test('同一件事多次交给技术专家时，飞书只报告最新一次的真实状态', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-22T10:00:00.000Z' },
    { taskId:'task-tech-old', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'succeeded', artifactRefs:[{ type:'technical_repair_evidence', validation:{ testsPassed:true, recoveryVerified:true } }], updatedAt:'2026-07-22T10:01:00.000Z' },
    { taskId:'task-tech-new', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'waiting_test', artifactRefs:[{ type:'technical_repair_evidence', data:{ nextAction:'等待新的受控检查。' } }], updatedAt:'2026-07-22T10:02:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.status, 'waiting_test');
  assert.match(result.message, /等待新的受控检查/);
  assert.doesNotMatch(result.message, /已经修复/);
});

test('普通任务被标为待测试时，飞书不会无限轮询或误报完成', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-web', taskType:'report.public-material', status:'waiting_test', source:{ chatRef:'chat-a' }, input:{ title:'核对网页摘要验收' }, updatedAt:'2026-07-22T10:00:00.000Z' });
  const result = await service.notificationStatus('task-web', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'waiting_test');
  assert.match(result.message, /待测试/);
  assert.doesNotMatch(result.message, /已经完成/);
});

test('技术专家有完整修复证据后，飞书跟进如实返回已经验证', async () => {
  const root = { taskId:'root-repair-ok', taskType:'media.transcribe-and-refine', status:'failed', input:{ title:'整理视频' }, source:{ chatRef:'chat-1' }, createdAt:'2026-07-21T10:00:00.000Z', updatedAt:'2026-07-21T10:00:00.000Z' };
  const repair = { taskId:'repair-ok', parentTaskId:'root-repair-ok', taskType:'operations.technical-repair', status:'succeeded', artifactRefs:[{ type:'technical_repair_evidence', validation:{ testsPassed:true, recoveryVerified:true } }], createdAt:'2026-07-21T10:01:00.000Z', updatedAt:'2026-07-21T10:02:00.000Z' };
  const { service, records } = setup();
  records.tasks.push(repair, root);
  const result = await service.notificationStatus('root-repair-ok', 'chat-1');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'repair_verified');
  assert.match(result.message, /修复/);
  assert.match(result.message, /测试/);
});

test('飞书跟进拒绝其他会话读取任务', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'running', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' } });
  await assert.rejects(() => service.notificationStatus('task-media', 'chat-b'), /当前会话不能读取/);
});

test('任务执行会保存实际报告的使用记录，概览只汇总当天已记录部分', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  const { service } = setup({ agents:[operator] });
  service.executors.operator = { async execute() { return { status:'succeeded', currentStage:'done', execution:{ executor:'operator', outcome:'done' }, usage:{ tools:[{ id:'local-check', name:'本机检查', calls:1 }] }, artifactRefs:[] }; } };
  const task = await service.create({ title:'检查本机状态', taskType:'operations.health-review' });
  assert.equal(task.usage.schemaVersion, 'agent.army/task-usage/v1');
  assert.equal(task.usage.tools[0].calls, 1);
  const usage = await service.usageOverview();
  assert.equal(usage.trackedTaskCount, 1);
  assert.equal(usage.actualToolCalls, 1);
  assert.equal(usage.cost.reportedTaskCount, 0);
});
