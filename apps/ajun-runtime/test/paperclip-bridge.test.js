import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipBridge } from '../src/paperclip-bridge.js';

test('PaperclipBridge 对 M5 HTTP 控制器核验当前运行中的 active run、agent、issue 和 company 四方绑定', async () => {
  const issueId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const agentId = '33333333-3333-4333-8333-333333333333';
  const companyId = '44444444-4444-4444-8444-444444444444';
  const bridge = new PaperclipBridge();
  bridge.getPaperclipIssue = async () => ({
    id:issueId,
    companyId,
    assigneeAgentId:agentId,
    status:'in_progress',
  });
  bridge.getPaperclipAgent = async () => ({
    id:agentId,
    companyId,
    metadata:{ agentArmySystemRole:'m5-daily-controller' },
  });
  bridge.getPaperclipIssueActiveRun = async () => ({
    id:runId,
    companyId,
    agentId,
    status:'running',
  });
  bridge.getPaperclipHeartbeatRun = async () => ({
    id:runId,
    companyId,
    agentId,
    status:'running',
  });

  const verified = await bridge.verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId:agentId,
    systemRole:'m5-daily-controller',
  });
  assert.equal(verified.issue.id, issueId);
  assert.equal(verified.run.id, runId);
  assert.equal(verified.paperclipAgent.id, agentId);

  bridge.getPaperclipIssueActiveRun = async () => null;
  await assert.rejects(() => bridge.verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId:agentId,
    systemRole:'m5-daily-controller',
  }), /当前活跃运行与 HTTP 系统控制器指派不一致/);
});

test('PaperclipBridge 拒绝历史、排队、终态或身份漂移的 M5 系统控制器 Run', async (t) => {
  const issueId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const agentId = '33333333-3333-4333-8333-333333333333';
  const companyId = '44444444-4444-4444-8444-444444444444';
  const otherAgentId = '55555555-5555-4555-8555-555555555555';
  const otherCompanyId = '66666666-6666-4666-8666-666666666666';

  const setup = ({
    issueStatus = 'in_progress',
    activeRun = { id:runId, status:'running', agentId, companyId },
    heartbeatRun = { id:runId, status:'running', agentId, companyId },
  } = {}) => {
    const bridge = new PaperclipBridge();
    bridge.getPaperclipIssue = async () => ({
      id:issueId,
      companyId,
      assigneeAgentId:agentId,
      status:issueStatus,
    });
    bridge.getPaperclipAgent = async () => ({
      id:agentId,
      companyId,
      metadata:{ agentArmySystemRole:'m5-daily-controller' },
    });
    bridge.getPaperclipIssueActiveRun = async () => activeRun;
    bridge.getPaperclipHeartbeatRun = async () => heartbeatRun;
    return bridge;
  };
  const verify = (bridge) => bridge.verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId:agentId,
    systemRole:'m5-daily-controller',
  });

  await t.test('历史 Run 即使曾属于该 Issue 也不能执行', async () => {
    const bridge = setup({ activeRun:null });
    bridge.getPaperclipIssueRuns = async () => ({
      runs:[{ id:runId, status:'succeeded', agentId, companyId }],
    });
    await assert.rejects(verify(bridge), /当前活跃运行与 HTTP 系统控制器指派不一致/);
  });

  await t.test('queued Run 不能冒充正在执行的 controller', async () => {
    await assert.rejects(
      verify(setup({
        activeRun:{ id:runId, status:'queued', agentId, companyId },
        heartbeatRun:{ id:runId, status:'queued', agentId, companyId },
      })),
      /当前活跃运行与 HTTP 系统控制器指派不一致/,
    );
  });

  await t.test('Issue 已结束时拒绝仍显示 running 的旧 Run', async () => {
    await assert.rejects(
      verify(setup({ issueStatus:'done' })),
      /当前活跃运行与 HTTP 系统控制器指派不一致/,
    );
  });

  await t.test('active-run 与权威 heartbeat 状态不一致时拒绝', async () => {
    await assert.rejects(
      verify(setup({
        heartbeatRun:{ id:runId, status:'succeeded', agentId, companyId },
      })),
      /当前活跃运行身份无效/,
    );
  });

  await t.test('Run 岗位或公司身份漂移时拒绝', async () => {
    await assert.rejects(
      verify(setup({
        heartbeatRun:{ id:runId, status:'running', agentId:otherAgentId, companyId },
      })),
      /当前活跃运行身份无效/,
    );
    await assert.rejects(
      verify(setup({
        heartbeatRun:{ id:runId, status:'running', agentId, companyId:otherCompanyId },
      })),
      /当前活跃运行身份无效/,
    );
  });
});

test('M5 阶段恢复只用 Case 字段和同一 Run 重开或阻塞原 Issue', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return { ok:true }; } };
  } });

  await bridge.getPipelineCaseEvents('case-recovery-1');
  await bridge.patchPipelineCaseFields('case-recovery-1', {
    expectedVersion:7,
    fields:{ m5StageRecovery:{ status:'scheduled' } },
    runId:'run-recovery-1',
  });
  await bridge.reopenM5StageIssue('issue-recovery-1', {
    runId:'run-recovery-1',
    comment:'安排安全重试。',
  });
  await bridge.blockM5StageIssue('issue-recovery-1', {
    runId:'run-recovery-1',
    comment:'恢复上限已达到。',
  });

  assert.equal(
    new URL(requests[0].url).pathname + new URL(requests[0].url).search,
    '/api/cases/case-recovery-1/events?limit=100&order=desc',
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    expectedVersion:7,
    fields:{ m5StageRecovery:{ status:'scheduled' } },
  });
  assert.equal(requests[1].options.headers['x-paperclip-run-id'], 'run-recovery-1');
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    status:'todo',
    comment:'安排安全重试。',
  });
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    status:'blocked',
    comment:'恢复上限已达到。',
  });
});

test('复盘桥接只从当前 Case 的 Pipeline 聚合 Work Product，并沿用原 Run 写回', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload = {};
    if (pathname === '/api/cases/case-1') payload = { id:'case-1', pipelineId:'pipeline-1' };
    else if (pathname === '/api/pipelines/pipeline-1/cases') {
      payload = { items:[{ id:'case-1' }, { id:'case-2' }] };
    } else if (pathname === '/api/cases/case-1/outputs') {
      payload = { items:[{ id:'metric-1' }] };
    } else if (pathname === '/api/cases/case-2/outputs') {
      payload = [{ id:'metric-2' }];
    }
    return { ok:true, status:200, async json(){ return payload; } };
  } });

  assert.deepEqual(await bridge.getRetrospectiveMetricOutputs('case-1'), {
    items:[{ id:'metric-1' }, { id:'metric-2' }],
  });
  await bridge.transitionPipelineCase('case-1', {
    expectedVersion:7,
    toStageKey:'done',
  }, { runId:'run-1' });
  await bridge.completeRetrospectiveIssue('issue-1', {
    runId:'run-1',
    comment:'复盘完成。',
  });

  const transition = requests.find((item) =>
    new URL(item.url).pathname === '/api/cases/case-1/transition');
  assert.equal(transition.options.headers['x-paperclip-run-id'], 'run-1');
  assert.deepEqual(JSON.parse(transition.options.body), {
    expectedVersion:7,
    toStageKey:'done',
  });
  const completion = requests.find((item) =>
    new URL(item.url).pathname === '/api/issues/issue-1');
  assert.equal(completion.options.headers['x-paperclip-run-id'], 'run-1');
  assert.deepEqual(JSON.parse(completion.options.body), {
    status:'done',
    comment:'复盘完成。',
  });
});

test('学习控制器只能把 Issue 更新为运行、审核或完成状态', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return { ok:true }; } };
  } });
  await bridge.updateLearningIssue('issue-learning-1', {
    runId:'run-learning-1',
    status:'in_review',
    comment:'等待审核官。',
  });
  const request = requests[0];
  assert.equal(request.options.headers['x-paperclip-run-id'], 'run-learning-1');
  assert.deepEqual(JSON.parse(request.options.body), {
    status:'in_review',
    comment:'等待审核官。',
  });
  await assert.rejects(
    bridge.updateLearningIssue('issue-learning-1', {
      status:'blocked',
      comment:'伪造状态',
    }),
    /学习任务状态无效/,
  );
});

test('技术修复任务会分配给 Paperclip 中受控 Codex 技术专家', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{ id:'paperclip-tech-1', name:'技术专家', status:'idle', metadata:{ agentArmyId:'technical-expert', paperclipProjectId:'project-repair-1' } }];
    else if (pathname === '/api/companies/company-1/issues') payload = { id:'issue-1', identifier:'AGE-100' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.project({ taskId:'task-tech', taskType:'operations.technical-repair', status:'queued', priority:'normal', assigneeAgentId:'technical-expert', input:{ title:'修复执行器故障', description:'自动恢复无法完成。', context:{ failure:{ code:'executor_failed', stage:'execution', category:'manual', retryable:false } } } });
  const issueRequest = requests.find((item) => new URL(item.url).pathname === '/api/companies/company-1/issues');
  const body = JSON.parse(issueRequest.options.body);
  assert.equal(body.assigneeAgentId, 'paperclip-tech-1');
  assert.equal(body.status, 'todo');
  assert.match(body.description, /脱敏故障信息/);
  assert.match(body.description, /必须运行相关测试/);
  assert.equal(result.paperclipAssigneeAgentId, 'paperclip-tech-1');
  assert.equal(body.projectId, 'project-repair-1');
});

test('已交给 Paperclip Codex 的修复任务不会被 A君本地状态提前关闭', async () => {
  let patches = 0;
  const bridge = new PaperclipBridge({ fetchImpl:async () => { patches += 1; throw new Error('should not patch'); } });
  const projection = await bridge.update({ taskType:'operations.technical-repair', status:'running', governance:{ paperclipIssueId:'issue-1', paperclipAssigneeAgentId:'agent-1' } });
  assert.equal(projection.status, 'delegated');
  assert.equal(patches, 0);
});

test('技术修复转为待测试时，A君会同步 Paperclip 为阻塞而不是继续显示待开始', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  const projection = await bridge.update({ taskType:'operations.technical-repair', status:'waiting_test', currentStage:'repair_waiting_for_test', governance:{ paperclipIssueId:'issue-1', paperclipAssigneeAgentId:'agent-1' } });
  assert.equal(projection.status, 'synced');
  const request = requests.find((item) => new URL(item.url).pathname === '/api/issues/issue-1');
  assert.equal(JSON.parse(request.options.body).status, 'blocked');
});

test('任务因过期确认关闭时，Paperclip 也显示为阻塞', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  await bridge.update({ taskType:'army.route-task', status:'cancelled', governance:{ paperclipIssueId:'issue-1' } });
  const request = requests.find((item) => new URL(item.url).pathname === '/api/issues/issue-1');
  assert.equal(JSON.parse(request.options.body).status, 'blocked');
});

test('Hermes heartbeat 回写沿用 Paperclip run 身份，不触发重复唤醒', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  await bridge.completePaperclipIssue('issue-1', {
    runId:'run-1234',
    agentId:'architect',
    result:{
      status:'succeeded',
      currentStage:'paperclip_hermes_completed',
      execution:{ owner:'paperclip-hermes' },
      artifactRefs:[{ type:'employee_role_report', data:{ summary:'复用评估完成' } }]
    }
  });
  assert.equal(requests[0].options.headers['x-paperclip-run-id'], 'run-1234');
  assert.equal(JSON.parse(requests[0].options.body).status, 'done');
});

test('多人协作的子工作会挂在同一张 Paperclip 总任务下', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{
      id:'paperclip-operator',
      name:'运维官',
      status:'idle',
      metadata:{ agentArmyId:'operator' }
    }];
    else if (pathname === '/api/issues/parent-1/children') payload = { id:'child-1', identifier:'AGE-201' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  } });
  const projection = await bridge.projectChild({ taskId:'child-local-1', priority:'normal', taskType:'operations.health-review', assigneeAgentId:'operator', status:'queued', input:{ title:'检查军团本机运行状态', description:'来自军团盘点。' } }, 'parent-1');
  const create = requests.find((item) => new URL(item.url).pathname === '/api/issues/parent-1/children');
  const body = JSON.parse(create.options.body);
  assert.equal(body.blockParentUntilDone, true);
  assert.equal(body.assigneeAgentId, 'paperclip-operator');
  assert.equal(projection.paperclipParentIssueId, 'parent-1');
  assert.equal(projection.paperclipAssigneeAgentId, 'paperclip-operator');
});

test('Paperclip 会登记已有军团岗位，但不会把本机岗位变成可自行启动的重复执行器', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') {
      payload = options.method === 'POST'
        ? { id:`created-${body.metadata.agentArmyId}`, name:body.name, status:'idle' }
        : [{ id:'operator-runtime', name:'A君本机健康官', adapterType:'http', status:'idle', metadata:null }, { id:'technical-runtime', name:'技术专家', adapterType:'codex_local', status:'paused', metadata:{ agentArmyId:'technical-expert' } }];
    } else if (pathname === '/api/agents/operator-runtime') payload = { id:'operator-runtime', name:'A君本机健康官', status:'idle' };
    else if (pathname.startsWith('/api/agents/created-')) payload = { id:pathname.split('/').at(-1), name:'同步岗位', status:'paused' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([
    { agentId:'operator', name:'运维官', role:'安全恢复', status:'active', responsibilities:['检查本机状态'] },
    { agentId:'technical-expert', name:'技术专家', role:'受控修复', status:'active', responsibilities:['修复故障'] },
    { agentId:'reviewer', name:'审核官', role:'范围审查', status:'active', responsibilities:['审查风险'] }
  ]);
  assert.equal(result.status, 'synced');
  assert.equal(result.agents.length, 3);
  assert.equal(result.agents.find((item) => item.agentArmyId === 'operator').created, false);
  assert.equal(result.agents.find((item) => item.agentArmyId === 'technical-expert').created, false);
  assert.equal(result.agents.find((item) => item.agentArmyId === 'reviewer').created, true);
  const operatorPatch = requests.find((item) => new URL(item.url).pathname === '/api/agents/operator-runtime');
  assert.equal(JSON.parse(operatorPatch.options.body).metadata.agentArmyId, 'operator');
  const reviewerCreate = requests.find((item) => new URL(item.url).pathname === '/api/companies/company-1/agents' && item.options.method === 'POST');
  const reviewerBody = JSON.parse(reviewerCreate.options.body);
  assert.equal(reviewerBody.adapterType, 'http');
  assert.equal(reviewerBody.metadata.agentArmyManagedOnly, true);
  const reviewerPause = requests.find((item) => new URL(item.url).pathname === '/api/agents/created-reviewer');
  assert.equal(JSON.parse(reviewerPause.options.body).status, 'paused');
});

test('已登记的新员工会按真实职责刷新岗位标签，但保持暂停不自行运行', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{
      id:'public-reporter', name:'公开资料报告员', role:'general', title:'公开资料报告', icon:'bot', capabilities:'整理公开网页', status:'paused',
      metadata:{ agentArmyId:'public-reporter', agentArmyRole:'公开资料报告', agentArmyManagedOnly:true }
    }];
    else if (pathname === '/api/agents/public-reporter') payload = { id:'public-reporter', status:'paused' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([{
    agentId:'public-reporter', name:'公开资料报告员', role:'只读公开网页中文摘要', status:'active',
    acceptedTaskTypes:['report.public-material'], responsibilities:['读取公开网页并交付中文重点']
  }]);
  assert.equal(result.status, 'synced');
  const refresh = requests.find((item) => new URL(item.url).pathname === '/api/agents/public-reporter');
  const body = JSON.parse(refresh.options.body);
  assert.equal(body.role, 'researcher');
  assert.equal(body.icon, 'search');
  assert.equal(body.metadata.agentArmyManagedOnly, true);
  assert.equal(Object.hasOwn(body, 'status'), false);
});

test('受管 Hermes 岗位修正模型配置后会从 error 恢复为 idle', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{
      id:'video-agent', name:'小拆·视频内容拆解师', role:'general', title:'旧职责', icon:'bot',
      capabilities:'旧能力', adapterType:'hermes_local', adapterConfig:{ model:'auto' }, status:'error',
      metadata:{ agentArmyId:'video-content-analyst', agentArmyManagedOnly:true, executionOwner:'paperclip-hermes' }
    }];
    else if (pathname === '/api/agents/video-agent') payload = { id:'video-agent', status:'idle' };
    else if (pathname === '/api/agents/video-agent/skills/sync') payload = { status:'synced' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([{
    agentId:'video-content-analyst',
    name:'小拆·视频内容拆解师',
    role:'受控拆解',
    status:'active',
    promptRef:'agents/video-content-analyst/prompts/system.md',
    executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile', directFeishu:'disabled' },
    acceptedTaskTypes:[
      'content.video-benchmark-analysis',
      'content.campaign-visual-analysis'
    ],
    responsibilities:['拆解视频'],
    runtimeCapabilities:{
      modelSelection:{ provider:'openai-codex', model:'gpt-5.6-terra' },
      skills:['paperclip'],
      paperclipToolsets:['agent-army'],
      mcpTools:['video_content_analyze_execute']
    }
  }]);
  assert.equal(result.status, 'synced');
  const refresh = requests.find((item) => new URL(item.url).pathname === '/api/agents/video-agent' && item.options.method === 'PATCH');
  const body = JSON.parse(refresh.options.body);
  assert.equal(body.status, 'idle');
  assert.equal(body.adapterConfig.provider, 'openai-codex');
  assert.equal(body.adapterConfig.model, 'gpt-5.6-terra');
});

test('正式 Manifest 已移除的军团员工会终止，测试实例和历史记录不受影响', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [
      { id:'active-reviewer', name:'审核官', status:'idle', metadata:{ agentArmyId:'reviewer', agentArmyManagedOnly:true } },
      { id:'retired-coordinator', name:'任务协调官', status:'paused', metadata:{ agentArmyId:'task-coordinator', agentArmyManagedOnly:true } },
      { id:'sandbox', name:'技术专家练习实例', status:'idle', metadata:{ agentArmyId:'technical-expert-sandbox', testOnly:true } }
    ];
    else if (pathname === '/api/agents/active-reviewer') payload = { id:'active-reviewer', name:'审核官', status:'idle' };
    else if (pathname === '/api/agents/retired-coordinator/terminate') payload = { id:'retired-coordinator', status:'terminated' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([{
    agentId:'reviewer', name:'审核官', role:'范围审查', status:'active',
    runtime:{ kind:'paperclip-hermes' }, interaction:{ directFeishu:'disabled' },
    acceptedTaskTypes:['governance.approval-review'], responsibilities:['审查风险']
  }]);

  assert.deepEqual(result.retired.map((item) => item.agentArmyId), ['task-coordinator']);
  assert.equal(requests.filter((item) => new URL(item.url).pathname.endsWith('/terminate')).length, 1);
  assert.equal(requests.some((item) => new URL(item.url).pathname.includes('/sandbox/terminate')), false);
});
