import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalIntelResearcher } from '../src/local-intel-researcher.ts';
import { TaskService } from '../src/task-service.ts';

const IDS = Object.freeze({
  issue:'11111111-1111-4111-8111-111111111111',
  run:'22222222-2222-4222-8222-222222222222',
  agent:'33333333-3333-4333-8333-333333333333',
  project:'44444444-4444-4444-8444-444444444444',
  workspace:'55555555-5555-4555-8555-555555555555',
});

test('Paperclip小R assignment根据真实fetch结果切换PDF Adapter并写Observation Work Product', async () => {
  const adapterCalls = [];
  const workProducts = [];
  let legacyExecutorCalls = 0;
  const manifest = {
    schemaVersion:'agent.army/v1',
    agentId:'intel-researcher',
    status:'active',
    acceptedTaskTypes:['research.open-investigation'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
    runtimeProfileRef:'integrations/hermes/profiles/intel-researcher.profile.json',
    openTaskPolicy:{ domain:'research', qualityGateMode:'manifest-required' },
    toolAllowlist:[
      'content.public.search',
      'content.public.fetch',
      'content.public.pdf.read',
    ],
    toolExecutionPolicy:{
      unknownToolDecision:'deny',
      workspace:{ scope:'paperclip-execution-workspace', pathMode:'relative-only' },
      grants:{
        'content.public.search':{
          adapter:'ajun-public-search',
          access:'read',
          externalSideEffect:'network-read',
        },
        'content.public.fetch':{
          adapter:'ajun-public-fetch',
          access:'read',
          externalSideEffect:'network-read',
        },
        'content.public.pdf.read':{
          adapter:'hermes-pdf',
          access:'read',
          externalSideEffect:'network-read',
        },
      },
    },
  };
  const task = {
    taskId:'task-open-runtime',
    taskType:'research.open-investigation',
    artifactRefs:[],
    assigneeAgentId:'intel-researcher',
    status:'running',
    currentStage:'waiting_paperclip_heartbeat',
    input:{
      title:'核验公开研究报告',
      sourceUrls:['https://example.com/report'],
      goalSpec:{ objective:'形成带来源的公开研究报告' },
      context:{
        openTaskType:'research.open-investigation',
        openResearchBudget:{ remainingUnits:4, estimatedNextStepUnits:1 },
        openResearchObservation:{
          classification:'goal_satisfied',
          nextToolId:'terminal.exec',
          acceptanceSatisfied:true,
        },
      },
    },
    governance:{ paperclipIssueId:IDS.issue },
    execution:{ owner:'paperclip-hermes', paperclipRunId:IDS.run },
  };
  const tasks = [task];
  const store = {
    async list() { return tasks; },
    async createTask(input) {
      const created = { taskId:`task-${tasks.length + 1}`, artifactRefs:[], ...input };
      tasks.push(created);
      return created;
    },
    async updateTask(taskId, patch) {
      const current = tasks.find((item) => item.taskId === taskId);
      Object.assign(current, patch);
      return current;
    },
  };
  const identity = {
    issue:{
      id:IDS.issue,
      projectId:null,
      title:'开放研究',
      description:'仅使用公开来源。',
      executionPolicy:{
        openResearch:{ remainingUnits:4, estimatedNextStepUnits:1 },
      },
    },
    run:{
      id:IDS.run,
      environmentLease:{ executionWorkspaceId:null },
    },
    paperclipAgent:{ id:IDS.agent, name:'小R' },
    agentArmyId:'intel-researcher',
  };
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getExecutionWorkspace() { throw new Error('纯只读公开研究不应读取本地工作区'); },
    async createIssueWorkProduct(issueId, product, { runId } = {}) {
      workProducts.push({ issueId, runId, product });
      return { id:`work-product-${workProducts.length}`, ...product };
    },
    async getIssueWorkProducts() {
      return workProducts.map((item, index) => ({
        id:`work-product-${index + 1}`,
        ...item.product,
      }));
    },
  };
  const registry = {
    async get(agentId) { return agentId === manifest.agentId ? manifest : null; },
    async list() { return [manifest]; },
    async runtimeProfile() {
      return {
        profileId:'intel-researcher',
        agentManifestRef:'agents/intel-researcher/manifest.json',
        toolAllowlist:[...manifest.toolAllowlist],
        localProfile:{ skillsSeeded:false },
      };
    },
  };
  const service = new TaskService({
    registry,
    store,
    governance,
    roleToolAdapters:{
      'ajun-public-fetch':async ({ access }) => {
        adapterCalls.push({ adapter:'fetch', access });
        return {
          contentType:'application/pdf',
          sourceRef:'https://example.com/report',
          fetchedAt:'2026-07-31T03:00:00.000Z',
        };
      },
      'hermes-pdf':async ({ access }) => {
        adapterCalls.push({ adapter:'pdf', access });
        return {
          title:'公开研究报告',
          sourceRef:'https://example.com/report',
          text:'可核验的公开报告正文。',
          contentHash:`sha256:${'a'.repeat(64)}`,
          fetchedAt:'2026-07-31T03:00:01.000Z',
        };
      },
      'ajun-public-search':async ({ access }) => {
        adapterCalls.push({ adapter:'search', access });
        return {
          results:[{
            title:'下一条公开来源',
            url:'https://example.org/source-2',
          }],
          searchedAt:'2026-07-31T03:00:02.000Z',
        };
      },
    },
    executors:{},
  });

  const result = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });

  assert.equal(legacyExecutorCalls, 0);
  assert.deepEqual(adapterCalls.map((item) => item.adapter), ['fetch', 'pdf']);
  assert.equal(result.result.status, 'running');
  assert.equal(result.result.openResearch.decision.action, 'switch_adapter');
  assert.equal(
    result.result.openResearch.decision.selectedToolId,
    'content.public.pdf.read',
  );
  assert.equal(
    result.result.openResearch.nextObservation.classification,
    'source_verified',
  );
  assert.equal(workProducts.length, 1);
  assert.equal(workProducts[0].issueId, IDS.issue);
  assert.equal(workProducts[0].runId, IDS.run);
  assert.equal(workProducts[0].product.type, 'artifact');
  assert.equal(workProducts[0].product.provider, 'agent-army.intel-researcher');
  assert.equal(workProducts[0].product.metadata.kind, 'OpenResearchStep');
  assert.match(workProducts[0].product.metadata.idempotencyKey, /^open-research-step:/);
  assert.equal(
    workProducts[0].product.metadata.observation.classification,
    'pdf_detected',
  );
  assert.equal(
    workProducts[0].product.metadata.observation.error.code,
    'content_type_pdf',
  );
  assert.match(
    workProducts[0].product.metadata.decision.source.observationHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(
    JSON.stringify(workProducts[0]).includes('可核验的公开报告正文'),
    false,
  );

  delete task.execution.openResearch;
  const resumed = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });
  assert.deepEqual(
    adapterCalls.map((item) => item.adapter),
    ['fetch', 'pdf', 'search'],
  );
  assert.equal(resumed.result.openResearch.decision.action, 'continue');
  assert.equal(
    resumed.result.openResearch.decision.selectedToolId,
    'content.public.search',
  );
  assert.equal(
    resumed.result.openResearch.nextObservation.result.sourceUrl,
    'https://example.org/source-2',
  );
  assert.equal(workProducts.length, 2);
});

test('A君创建的开放研究使用固定契约预算，任务输入不能扩到999', async () => {
  let adapterCalls = 0;
  const workProducts = [];
  const manifest = {
    schemaVersion:'agent.army/v1',
    agentId:'intel-researcher',
    status:'active',
    acceptedTaskTypes:['research.open-investigation'],
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes',
    runtimeProfileRef:'integrations/hermes/profiles/intel-researcher.profile.json',
    openTaskPolicy:{ domain:'research' },
    toolAllowlist:['content.public.fetch', 'content.public.search'],
    toolExecutionPolicy:{
      unknownToolDecision:'deny',
      workspace:{ scope:'paperclip-execution-workspace', pathMode:'relative-only' },
      grants:{
        'content.public.fetch':{
          adapter:'ajun-public-fetch',
          access:'read',
          externalSideEffect:'network-read',
        },
        'content.public.search':{
          adapter:'ajun-public-search',
          access:'read',
          externalSideEffect:'network-read',
        },
      },
    },
  };
  const task = {
    taskId:'task-open-no-runtime-budget',
    taskType:'research.open-investigation',
    artifactRefs:[],
    assigneeAgentId:'intel-researcher',
    status:'running',
    input:{
      title:'无预算公开研究',
      sourceUrls:['https://example.com/report'],
      context:{
        openTaskType:'research.open-investigation',
        openResearchBudget:{ remainingUnits:999, estimatedNextStepUnits:1 },
      },
    },
    governance:{ paperclipIssueId:IDS.issue },
    execution:{ owner:'paperclip-hermes', paperclipRunId:IDS.run },
  };
  const store = {
    async list() { return [task]; },
    async updateTask(_taskId, patch) { Object.assign(task, patch); return task; },
  };
  const service = new TaskService({
    registry:{
      async get() { return manifest; },
      async list() { return [manifest]; },
      async runtimeProfile() {
        return {
          profileId:'intel-researcher',
          agentManifestRef:'agents/intel-researcher/manifest.json',
          toolAllowlist:['content.public.fetch', 'content.public.search'],
          localProfile:{ skillsSeeded:false },
        };
      },
    },
    store,
    governance:{
      async verifyHermesAssignment() {
        return {
          issue:{ id:IDS.issue, projectId:IDS.project, title:'开放研究', description:'' },
          run:{ id:IDS.run, environmentLease:{ executionWorkspaceId:IDS.workspace } },
          paperclipAgent:{ id:IDS.agent, name:'小R' },
          agentArmyId:'intel-researcher',
        };
      },
      async getExecutionWorkspace() {
        return { id:IDS.workspace, cwd:'/tmp/agent-army-open-research-fixture' };
      },
      async createIssueWorkProduct(_issueId, product) {
        workProducts.push(product);
        return { id:`work-product-${workProducts.length}`, ...product };
      },
      async getIssueWorkProducts() { return workProducts; },
    },
    roleToolAdapters:{
      'ajun-public-fetch':async () => {
        adapterCalls += 1;
        return {
          sourceRef:'https://example.com/report',
          title:'公开来源',
          text:'公开来源正文',
          contentHash:`sha256:${'1'.repeat(64)}`,
          fetchedAt:'2026-07-31T03:00:01.000Z',
        };
      },
      'ajun-public-search':async () => {
        adapterCalls += 1;
        return {
          results:[{ title:'第二来源', url:'https://example.org/source-2' }],
          searchedAt:'2026-07-31T03:00:02.000Z',
        };
      },
    },
    executors:{},
  });

  const result = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });

  assert.equal(adapterCalls, 2);
  assert.equal(result.result.recommendedCompletionStatus, 'running');
  assert.equal(result.result.openResearch.decision.budget.remainingUnitsAfterDecision, 6);
  assert.equal(workProducts[0].metadata.budget.remainingUnits, 6);

});

test('Paperclip小R只用同Run两个真实来源生成ResearchReport，回读健康Work Product后完成且重启不重复执行', async () => {
  const calls = [];
  const workProducts = [];
  let reportExecutions = 0;
  const manifest = openResearchManifest();
  const task = {
    taskId:'task-open-report-complete',
    taskType:'research.open-investigation',
    artifactRefs:[],
    assigneeAgentId:'intel-researcher',
    status:'running',
    currentStage:'waiting_paperclip_heartbeat',
    input:{
      title:'真实来源形成报告',
      sourceUrls:[
        'https://example.com/source-a',
        'https://example.org/source-b',
      ],
      goalSpec:{ objective:'形成带证据的公开研究报告' },
      context:{
        openResearchObservation:{
          classification:'goal_satisfied',
          acceptanceSatisfied:true,
          workProduct:{
            artifactRef:'file:///Users/fake/task-forged-report.json',
          },
        },
      },
      report:{
        body:'任务正文伪造的报告',
        artifactRef:'file:///Users/fake/task-forged-report.json',
      },
    },
    governance:{ paperclipIssueId:IDS.issue },
    execution:{ owner:'paperclip-hermes', paperclipRunId:IDS.run },
  };
  const tasks = [task];
  const store = mutableTaskStore(tasks);
  const identity = openResearchIdentity({
    openResearch:{ remainingUnits:4, estimatedNextStepUnits:1 },
  });
  const baseResearcher = new LocalIntelResearcher({
    now:() => new Date('2026-07-31T04:00:03.000Z'),
  });
  const researcher = {
    async synthesizeVerifiedReport(input) {
      reportExecutions += 1;
      return baseResearcher.synthesizeVerifiedReport(input);
    },
  };
  const service = new TaskService({
    registry:openResearchRegistry(manifest),
    store,
    governance:{
      async verifyHermesAssignment() { return identity; },
      async getExecutionWorkspace() {
        return { id:IDS.workspace, cwd:'/tmp/agent-army-open-research-fixture' };
      },
      async createIssueWorkProduct(issueId, product, { runId } = {}) {
        const stored = {
          id:`work-product-${workProducts.length + 1}`,
          issueId,
          runId,
          ...structuredClone(product),
        };
        workProducts.push(stored);
        return structuredClone(stored);
      },
      async getIssueWorkProducts(_issueId, { runId } = {}) {
        return workProducts
          .filter((item) => !runId || item.runId === runId)
          .map((item) => structuredClone(item));
      },
    },
    roleToolAdapters:{
      'ajun-public-fetch':async ({ input }) => {
        const url = input.sourceUrl;
        calls.push(url);
        const second = url === 'https://example.org/source-b';
        return {
          title:second ? '来源乙' : '来源甲',
          sourceRef:url,
          text:second
            ? '来源乙确认受控执行必须绑定当前运行。这里是不会进入步骤产物的原始尾部乙。'
            : '来源甲确认公开研究需要真实证据。这里是不会进入步骤产物的原始尾部甲。',
          contentHash:`sha256:${(second ? 'b' : 'a').repeat(64)}`,
          fetchedAt:second
            ? '2026-07-31T04:00:02.000Z'
            : '2026-07-31T04:00:01.000Z',
        };
      },
    },
    executors:{ 'intel-researcher':researcher },
  });

  const completed = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });

  assert.deepEqual(calls, [
    'https://example.com/source-a',
    'https://example.org/source-b',
  ]);
  assert.equal(reportExecutions, 1);
  assert.equal(completed.result.status, 'succeeded');
  assert.equal(completed.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(completed.result.verified, true);
  assert.equal(completed.result.openResearch.decision.action, 'complete');
  assert.equal(completed.result.artifacts.length, 1);
  const reportProduct = workProducts.find((item) => item.metadata?.kind === 'ResearchReport');
  assert.ok(reportProduct);
  assert.equal(
    reportProduct.metadata.artifactRef,
    'runtime://task-open-report-complete/intel-research-report',
  );
  assert.notEqual(reportProduct.metadata.artifactRef, task.input.report.artifactRef);
  assert.equal(reportProduct.issueId, IDS.issue);
  assert.equal(reportProduct.runId, IDS.run);
  assert.equal(reportProduct.metadata.runId, IDS.run);
  assert.equal(reportProduct.metadata.validation.sourceCount, 2);
  assert.equal(reportProduct.metadata.validation.claimEvidenceBound, true);
  assert.equal(
    JSON.stringify(reportProduct).includes('来源甲确认公开研究需要真实证据。'),
    true,
  );
  assert.equal(JSON.stringify(reportProduct).includes('原始尾部甲'), false);
  assert.equal(JSON.stringify(reportProduct).includes('原始尾部乙'), false);
  assert.deepEqual(
    reportProduct.metadata.sourceObservationIds,
    [
      `${IDS.run}:open-research:1`,
      `${IDS.run}:open-research:2`,
    ],
  );
  const serializedSteps = JSON.stringify(
    workProducts.filter((item) => item.type === 'OpenResearchStep'),
  );
  assert.equal(serializedSteps.includes('原始尾部甲'), false);
  assert.equal(serializedSteps.includes('原始尾部乙'), false);
  assert.equal(JSON.stringify(reportProduct).includes('任务正文伪造的报告'), false);

  task.artifactRefs = [];
  delete task.execution.openResearch;
  task.execution.paperclipEmployee = { state:'running' };
  const resumed = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });
  assert.equal(resumed.result.status, 'succeeded');
  assert.equal(resumed.result.openResearch.reusedReport, true);
  assert.equal(reportExecutions, 1);
  assert.equal(calls.length, 2);
  assert.equal(
    workProducts.filter((item) => item.metadata?.kind === 'ResearchReport').length,
    1,
  );
});

test('ResearchReport写回后若当前Run回读不健康，employee_assignment保持未完成', async () => {
  const calls = [];
  const workProducts = [];
  let exposeHealthyReport = false;
  const manifest = openResearchManifest();
  const task = {
    taskId:'task-open-report-unhealthy',
    taskType:'research.open-investigation',
    artifactRefs:[],
    assigneeAgentId:'intel-researcher',
    status:'running',
    currentStage:'waiting_paperclip_heartbeat',
    input:{
      title:'不健康报告不得完成',
      sourceUrls:[
        'https://example.com/source-a',
        'https://example.org/source-b',
      ],
      report:{
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          claimEvidenceBound:true,
        },
      },
    },
    governance:{ paperclipIssueId:IDS.issue },
    execution:{ owner:'paperclip-hermes', paperclipRunId:IDS.run },
  };
  const service = new TaskService({
    registry:openResearchRegistry(manifest),
    store:mutableTaskStore([task]),
    governance:{
      async verifyHermesAssignment() {
        return openResearchIdentity({
          openResearch:{ remainingUnits:4, estimatedNextStepUnits:1 },
        });
      },
      async getExecutionWorkspace() {
        return { id:IDS.workspace, cwd:'/tmp/agent-army-open-research-fixture' };
      },
      async createIssueWorkProduct(issueId, product, { runId } = {}) {
        const stored = {
          id:`work-product-${workProducts.length + 1}`,
          issueId,
          runId,
          ...structuredClone(product),
        };
        workProducts.push(stored);
        return structuredClone(stored);
      },
      async getIssueWorkProducts() {
        return workProducts.map((item) => ({
          ...structuredClone(item),
          ...(item.metadata?.kind === 'ResearchReport' && !exposeHealthyReport
            ? { healthStatus:'unhealthy' }
            : {}),
        }));
      },
    },
    roleToolAdapters:{
      'ajun-public-fetch':async ({ input }) => {
        calls.push(input.sourceUrl);
        const second = input.sourceUrl === 'https://example.org/source-b';
        return {
          title:second ? '来源乙' : '来源甲',
          sourceRef:input.sourceUrl,
          text:second ? '第二条真实公开正文。' : '第一条真实公开正文。',
          contentHash:`sha256:${(second ? 'd' : 'c').repeat(64)}`,
          fetchedAt:second
            ? '2026-07-31T04:10:02.000Z'
            : '2026-07-31T04:10:01.000Z',
        };
      },
    },
    executors:{
      'intel-researcher':new LocalIntelResearcher({
        now:() => new Date('2026-07-31T04:10:03.000Z'),
      }),
    },
  });

  const result = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });

  assert.equal(calls.length, 2);
  assert.equal(result.result.status, 'waiting_test');
  assert.equal(result.result.recommendedCompletionStatus, 'waiting_test');
  assert.equal(result.result.verified, false);
  assert.match(result.result.error.message, /当前 Run 回读健康 Work Product/);
  assert.equal(task.artifactRefs.length, 0);
  assert.equal(
    workProducts.filter((item) => item.metadata?.kind === 'ResearchReport').length,
    1,
  );

  exposeHealthyReport = true;
  task.execution.paperclipEmployee = { state:'running' };
  const recovered = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });
  assert.equal(recovered.result.status, 'succeeded');
  assert.equal(recovered.result.openResearch.reusedReport, true);
  assert.equal(calls.length, 2);
  assert.equal(
    workProducts.filter((item) => item.metadata?.kind === 'ResearchReport').length,
    1,
  );
});

test('两个来源已核验但Issue预算不含报告步骤时不生成报告，任务伪造高预算无效', async () => {
  const workProducts = [];
  let reportExecutions = 0;
  const manifest = openResearchManifest();
  const task = {
    taskId:'task-open-report-budget-stop',
    taskType:'research.open-investigation',
    artifactRefs:[],
    assigneeAgentId:'intel-researcher',
    status:'running',
    input:{
      title:'报告步骤预算硬停',
      sourceUrls:[
        'https://example.com/source-a',
        'https://example.org/source-b',
      ],
      context:{
        openResearchBudget:{ remainingUnits:999, estimatedNextStepUnits:1 },
      },
    },
    governance:{ paperclipIssueId:IDS.issue },
    execution:{ owner:'paperclip-hermes', paperclipRunId:IDS.run },
  };
  const baseResearcher = new LocalIntelResearcher();
  const service = new TaskService({
    registry:openResearchRegistry(manifest),
    store:mutableTaskStore([task]),
    governance:{
      async verifyHermesAssignment() {
        return openResearchIdentity({
          openResearch:{ remainingUnits:2, estimatedNextStepUnits:1 },
        });
      },
      async getExecutionWorkspace() {
        return { id:IDS.workspace, cwd:'/tmp/agent-army-open-research-fixture' };
      },
      async createIssueWorkProduct(issueId, product, { runId } = {}) {
        const stored = {
          id:`work-product-${workProducts.length + 1}`,
          issueId,
          runId,
          ...structuredClone(product),
        };
        workProducts.push(stored);
        return structuredClone(stored);
      },
      async getIssueWorkProducts() {
        return workProducts.map((item) => structuredClone(item));
      },
    },
    roleToolAdapters:{
      'ajun-public-fetch':async ({ input }) => {
        const second = input.sourceUrl === 'https://example.org/source-b';
        return {
          title:second ? '来源乙' : '来源甲',
          sourceRef:input.sourceUrl,
          text:second ? '第二条真实公开正文。' : '第一条真实公开正文。',
          contentHash:`sha256:${(second ? 'f' : 'e').repeat(64)}`,
          fetchedAt:second
            ? '2026-07-31T04:20:02.000Z'
            : '2026-07-31T04:20:01.000Z',
        };
      },
    },
    executors:{
      'intel-researcher':{
        async synthesizeVerifiedReport(input) {
          reportExecutions += 1;
          return baseResearcher.synthesizeVerifiedReport(input);
        },
      },
    },
  });

  const result = await service.executeEmployeeAssignment({
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  });

  assert.equal(result.result.status, 'running');
  assert.equal(result.result.recommendedCompletionStatus, 'running');
  assert.equal(reportExecutions, 0);
  assert.equal(
    workProducts.filter((item) => item.type === 'ResearchReport').length,
    0,
  );
  assert.equal(
    workProducts.find((item) => item.metadata?.kind === 'OpenResearchStep')
      .metadata.budget.remainingUnits,
    0,
  );
});

function openResearchManifest() {
  return {
    schemaVersion:'agent.army/v1',
    agentId:'intel-researcher',
    status:'active',
    acceptedTaskTypes:['research.open-investigation'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
    runtimeProfileRef:'integrations/hermes/profiles/intel-researcher.profile.json',
    openTaskPolicy:{ domain:'research', qualityGateMode:'manifest-required' },
    toolAllowlist:['content.public.fetch'],
    toolExecutionPolicy:{
      unknownToolDecision:'deny',
      workspace:{ scope:'paperclip-execution-workspace', pathMode:'relative-only' },
      grants:{
        'content.public.fetch':{
          adapter:'ajun-public-fetch',
          access:'read',
          externalSideEffect:'network-read',
        },
      },
    },
  };
}

function openResearchIdentity({ openResearch } = {}) {
  return {
    issue:{
      id:IDS.issue,
      projectId:IDS.project,
      title:'开放研究',
      description:'仅使用公开来源。',
      executionPolicy:{ openResearch },
    },
    run:{
      id:IDS.run,
      environmentLease:{ executionWorkspaceId:IDS.workspace },
    },
    paperclipAgent:{ id:IDS.agent, name:'小R' },
    agentArmyId:'intel-researcher',
  };
}

function openResearchRegistry(manifest) {
  return {
    async get(agentId) { return agentId === manifest.agentId ? manifest : null; },
    async list() { return [manifest]; },
    async runtimeProfile() {
      return {
        profileId:'intel-researcher',
        agentManifestRef:'agents/intel-researcher/manifest.json',
        toolAllowlist:[...manifest.toolAllowlist],
        localProfile:{ skillsSeeded:false },
      };
    },
  };
}

function mutableTaskStore(tasks) {
  return {
    async list() { return tasks; },
    async createTask(input) {
      const created = { taskId:`task-${tasks.length + 1}`, artifactRefs:[], ...input };
      tasks.push(created);
      return created;
    },
    async updateTask(taskId, patch) {
      const current = tasks.find((item) => item.taskId === taskId);
      Object.assign(current, patch);
      return current;
    },
  };
}
