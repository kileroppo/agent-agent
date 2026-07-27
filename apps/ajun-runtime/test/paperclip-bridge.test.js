import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipBridge } from '../src/paperclip-bridge.js';

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
    return { ok:true, status:200, async json(){ return { id:'child-1', identifier:'AGE-201' }; } };
  } });
  const projection = await bridge.projectChild({ taskId:'child-local-1', priority:'normal', taskType:'operations.health-review', assigneeAgentId:'operator', status:'queued', input:{ title:'检查军团本机运行状态', description:'来自军团盘点。' } }, 'parent-1');
  assert.equal(new URL(requests[0].url).pathname, '/api/issues/parent-1/children');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.blockParentUntilDone, true);
  assert.equal(projection.paperclipParentIssueId, 'parent-1');
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
