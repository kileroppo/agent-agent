import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaperclipHttpError,
  PaperclipHttpTransport,
  PaperclipM5Client,
  PaperclipOrganizationClient,
  normalizePaperclipBaseUrl,
} from '../src/index.js';

test('默认拒绝远程 Paperclip，显式授权后只保留 origin', () => {
  assert.throws(() => normalizePaperclipBaseUrl('https://paperclip.example/api'), /loopback/);
  assert.equal(normalizePaperclipBaseUrl('https://paperclip.example/api', { allowRemote:true }), 'https://paperclip.example');
});

test('组织级客户端集中构造公司、员工、任务和审批端点', async () => {
  const calls = [];
  const client = new PaperclipOrganizationClient({
    endpoint:{
      async request(method, path, options) {
        calls.push({ method, path, options });
        return null;
      },
    },
  });
  await client.listCompanies();
  await client.listAgents('company/1');
  await client.createIssue('company/1', { title:'issue' });
  await client.createChildIssue('issue/1', { title:'child' });
  await client.createApproval('company/1', { type:'approval' });
  assert.deepEqual(calls, [
    { method:'GET', path:'/api/companies', options:{ body:undefined } },
    { method:'GET', path:'/api/companies/company%2F1/agents', options:{ body:undefined } },
    { method:'POST', path:'/api/companies/company%2F1/issues', options:{ body:{ title:'issue' } } },
    { method:'POST', path:'/api/issues/issue%2F1/children', options:{ body:{ title:'child' } } },
    { method:'POST', path:'/api/companies/company%2F1/approvals', options:{ body:{ type:'approval' } } },
  ]);
});

test('统一传输注入 run 身份并规范化 JSON 响应', async () => {
  let captured;
  const transport = new PaperclipHttpTransport({
    baseUrl:'http://127.0.0.1:3100',
    apiKey:'default-key',
    timeoutMs:0,
    fetchImpl:async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id:'issue-1' }), { status:200 });
    },
  });
  const result = await transport.request('patch', '/api/issues/issue-1', {
    body:{ status:'done' }, runId:'run-1', apiKey:'run-key',
  });
  assert.deepEqual(result, { id:'issue-1' });
  assert.equal(captured.init.headers.authorization, 'Bearer run-key');
  assert.equal(captured.init.headers['x-paperclip-run-id'], 'run-1');
  assert.equal(captured.init.body, JSON.stringify({ status:'done' }));
});

test('统一传输输出不含响应中的多余敏感文本', async () => {
  const transport = new PaperclipHttpTransport({
    baseUrl:'http://127.0.0.1:3100', timeoutMs:0,
    fetchImpl:async () => new Response(JSON.stringify({ error:'denied\n'.repeat(200) }), { status:403 }),
  });
  await assert.rejects(
    () => transport.request('GET', '/api/issues/private'),
    (error) => error instanceof PaperclipHttpError && error.status === 403 && error.message.length < 400,
  );
});

test('M5 高层客户端集中构造 Case、Pipeline 和 Issue 端点', async () => {
  const calls = [];
  const client = new PaperclipM5Client({
    endpoint:{
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { method, path, body };
      },
    },
  });

  await client.listPipelineCases('pipeline/1');
  await client.getPipeline('pipeline/1');
  await client.getCase('case/1');
  await client.updateCase('case/1', { expectedVersion:2 });
  await client.getCaseChildrenTree('case/1');
  await client.listCaseEvents('case/1', { limit:100, order:'desc' });
  await client.listCaseOutputs('case/1');
  await client.listIssueRuns('issue/1');

  assert.deepEqual(calls, [
    { method:'GET', path:'/api/pipelines/pipeline%2F1/cases', body:undefined },
    { method:'GET', path:'/api/pipelines/pipeline%2F1', body:undefined },
    { method:'GET', path:'/api/cases/case%2F1', body:undefined },
    { method:'PATCH', path:'/api/cases/case%2F1', body:{ expectedVersion:2 } },
    { method:'GET', path:'/api/cases/case%2F1/children/tree', body:undefined },
    { method:'GET', path:'/api/cases/case%2F1/events?limit=100&order=desc', body:undefined },
    { method:'GET', path:'/api/cases/case%2F1/outputs', body:undefined },
    { method:'GET', path:'/api/issues/issue%2F1/runs', body:undefined },
  ]);
});

test('M5 高层客户端集中构造 Plugin、公司治理和 Routine 端点', async () => {
  const calls = [];
  const client = new PaperclipM5Client({
    endpoint:{
      async request(method, path, body) {
        calls.push({ method, path, body });
        return null;
      },
    },
  });

  await client.listPlugins();
  await client.getPluginConfig('plugin/1', 'company/1');
  await client.executePluginAction('plugin/key', 'verify/action', { params:{ actionId:'action-1' } });
  await client.listCompanyActivity('company/1', {
    entityType:'cost_event', entityId:'cost/1', limit:500,
  });
  await client.getCompanyBudgetOverview('company/1');
  await client.listCompanyRoutines('company/1');
  await client.listCompanyAgents('company/1');
  await client.getRoutine('routine/1');
  await client.updateRoutineTrigger('trigger/1', { enabled:true });

  assert.deepEqual(calls, [
    { method:'GET', path:'/api/plugins', body:undefined },
    { method:'GET', path:'/api/plugins/plugin%2F1/config?companyId=company%2F1', body:undefined },
    { method:'POST', path:'/api/plugins/plugin%2Fkey/actions/verify%2Faction', body:{ params:{ actionId:'action-1' } } },
    { method:'GET', path:'/api/companies/company%2F1/activity?entityType=cost_event&entityId=cost%2F1&limit=500', body:undefined },
    { method:'GET', path:'/api/companies/company%2F1/budgets/overview', body:undefined },
    { method:'GET', path:'/api/companies/company%2F1/routines', body:undefined },
    { method:'GET', path:'/api/companies/company%2F1/agents', body:undefined },
    { method:'GET', path:'/api/routines/routine%2F1', body:undefined },
    { method:'PATCH', path:'/api/routine-triggers/trigger%2F1', body:{ enabled:true } },
  ]);
});
