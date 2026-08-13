import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ValidationError } from '../src/task-service.js';
import {
  agentFixture,
  coordinator,
  hermesAgentFixture,
  openResearchAgentFixture,
  paperclipGovernanceFixture,
  paperclipIdentityFixture,
  setupTaskService as setup,
  verifiedHealthReport,
} from './support/task-service-fixture.js';


test('A君补正小D字幕后立即替换源任务确认稿且不创建新任务', async () => {
  const revision = {
    jobId:'xiaod-job-1', transcript:'AI 初稿（已补正）', version:2,
    confirmationMode:'automatic', completeListen:false, correctionApplied:true, canRevise:true,
  };
  const xiaod = {
    baseUrl:'http://127.0.0.1:4318',
    async getTranscriptRevision(task) {
      assert.equal(task.execution.xiaodJobId, 'xiaod-job-1');
      return revision;
    },
    async reviseTranscript(task, input) {
      assert.equal(task.taskId, 'task-transcript');
      assert.deepEqual(input, {
        expectedVersion:1,
        correctedTranscript:'AI 初稿（已补正）',
        correctionSummary:'修正专有名词',
        editorRef:'A君',
      });
      return {
        duplicate:false,
        revision,
        job:{
          id:'xiaod-job-1', title:'公开视频', status:'completed', quality:{ passed:true },
          output:{
            confirmedTranscriptPath:'/tmp/confirmed-transcript-v2.md',
            confirmedTranscriptVersion:2,
            confirmedTranscriptChecksum:'sha256:v2',
            confirmationMode:'automatic',
            confirmationAttestationPath:'/tmp/automatic-confirmation-v2.json',
            evidenceLevel:'untimed_machine_transcript',
            transcriptCorrection:{ applied:true, basedOnVersion:1 },
            markdownPath:'/tmp/share-v2.md',
            larkUrl:'https://example.feishu.cn/docx/old-version',
            larkPermissionGranted:true,
            larkRevisionStatus:'stale',
          },
        },
      };
    },
  };
  const { service, records } = setup({ executors:{ xiaod } });
  records.tasks.push({
    taskId:'task-transcript', taskType:'media.transcribe-and-refine', status:'succeeded',
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' },
    artifactRefs:[
      { artifactId:'source-1', type:'source_evidence_record' },
      { artifactId:'xiaod-job:xiaod-job-1', type:'xiaod_media_delivery', validation:{ exists:true, readable:true, nonEmpty:true }, data:{ larkUrl:'https://example.feishu.cn/docx/old-version', larkPermissionGranted:true } },
      { artifactId:'old-attestation', type:'automatic_transcript_attestation' },
      { artifactId:'confirmed-transcript:xiaod-job-1:v1', type:'confirmed_transcript' },
    ],
  });

  assert.deepEqual(await service.getTranscriptRevision('task-transcript'), revision);
  const result = await service.reviseTranscript('task-transcript', {
    expectedVersion:1,
    correctedTranscript:'AI 初稿（已补正）',
    correctionSummary:'修正专有名词',
    editorRef:'A君',
  });
  assert.equal(records.tasks.length, 1);
  assert.equal(result.revision.version, 2);
  assert.equal(result.task.status, 'succeeded');
  assert.equal(result.task.artifactRefs.some((artifact) => artifact.artifactId === 'source-1'), true);
  assert.equal(result.task.artifactRefs.some((artifact) => artifact.artifactId === 'confirmed-transcript:xiaod-job-1:v1'), false);
  const confirmed = result.task.artifactRefs.find((artifact) => artifact.type === 'confirmed_transcript');
  assert.equal(confirmed.artifactId, 'confirmed-transcript:xiaod-job-1:v2');
  assert.equal(confirmed.validation.confirmationMode, 'automatic');
  assert.equal(confirmed.validation.humanConfirmed, false);
  assert.equal(confirmed.validation.correctionApplied, true);
  assert.equal(confirmed.validation.transcriptVersion, 2);
  const delivery = result.task.artifactRefs.find((artifact) => artifact.type === 'xiaod_media_delivery');
  assert.equal(delivery.data.currentTranscriptDelivered, false);
  assert.equal(delivery.data.larkRevisionStatus, 'stale');
  assert.equal(result.task.execution.transcriptRevision.version, 2);
  const notification = await service.notificationStatus('task-transcript');
  assert.equal(notification.status, 'revision_pending_delivery');
  assert.match(notification.message, /原飞书文档仍是旧版/);
  assert.doesNotMatch(notification.message, /交付文档：/);
});
test('结构化 PPT 由 A君受控本地执行并把三类引用写回 Paperclip', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-presentation-task-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const office = hermesAgentFixture('office-assistant', '小办', ['office.presentation-package']);
  const workProducts = [];
  const toolCalls = [];
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:'issue-1', paperclipIssueIdentifier:'AGE-1' };
    },
    async update(task) {
      return { ...task.governance, status:'synced' };
    },
    async getIssueWorkProducts() {
      return workProducts;
    },
    async createIssueWorkProduct(_issueId, product) {
      workProducts.push(product);
      return product;
    },
  };
  const roleToolAdapters = {
    'ajun-task-store':async () => [],
    'open-kimi-pptd':async ({ access, workspaceRoot }) => {
      toolCalls.push({ toolId:access.toolId, workspaceRoot });
      return { ok:true };
    },
    'local-pptx':async ({ access, workspaceRoot }) => {
      toolCalls.push({ toolId:access.toolId, workspaceRoot });
      return { ok:true };
    },
  };
  const artifacts = ['office_presentation_source', 'office_presentation_qa', 'office_pptx_document'].map((type, index) => ({
    artifactId:`artifact-${index + 1}`,
    taskId:'task-1',
    type,
    title:type,
    location:`workspace://artifact-${index + 1}`,
    checksum:String(index + 1).repeat(64),
    validation:{ exists:true, readable:true, nonEmpty:true },
  }));
  const executors = {
    'office-assistant':{
      async execute(_task, { roleToolContext }) {
        await roleToolContext.execute({ toolId:'army.task.read', input:{} });
        await roleToolContext.execute({ toolId:'office.pptd.write', relativePath:'work-products/task-1/presentation/deck.pptd', input:{} });
        await roleToolContext.execute({ toolId:'office.pptx.export', relativePath:'work-products/task-1/presentation/deck.pptx', input:{} });
        return { status:'succeeded', currentStage:'office_presentation_ready', artifactRefs:artifacts };
      },
    },
  };
  const { service } = setup({
    agents:[office], governance, executors, roleToolAdapters,
    officePresentationWorkspaceRoot:root,
  });
  const task = await service.create({
    title:'公开固定样例',
    taskType:'office.presentation-package',
    slides:[{ title:'结论', bullets:['本地导出'] }],
    outputs:['pptd', 'pptx'],
    dataClassification:'public',
  });
  assert.equal(task.status, 'running', JSON.stringify(task.error));
  assert.equal(task.currentStage, 'delivery_quality_review_pending');
  assert.equal(task.execution.owner, 'ajun-controlled-local');
  assert.equal(task.execution.toolAccesses.length, 3);
  assert.equal(toolCalls.length, 2);
  assert.ok(toolCalls.every((item) => item.workspaceRoot.startsWith(root)));
  assert.deepEqual(workProducts.map((item) => item.metadata.artifactType).sort(), [
    'office_pptx_document',
    'office_presentation_qa',
    'office_presentation_source',
  ]);
  assert.ok(workProducts.every((item) => !('body' in item) && !('content' in item)));
});
test('本地 PPT 特殊通道并发恢复同一任务时只执行一次', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-presentation-claim-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const office = agentFixture('office-assistant', '小办', ['office.presentation-package']);
  let executions = 0;
  const { service, records } = setup({
    agents:[office],
    officePresentationWorkspaceRoot:root,
    executors:{
      'office-assistant':{
        async execute() {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { status:'needs_input', currentStage:'presentation_input_required' };
        },
      },
    },
  });
  const task = {
    taskId:'presentation-race-1',
    taskType:'office.presentation-package',
    status:'queued',
    artifactRefs:[],
    approvalRefs:[],
    input:{ title:'并发 PPT' },
  };
  records.tasks.push(task);

  const results = await Promise.all([
    service.executeTask(task, office),
    service.executeTask(task, office),
  ]);

  assert.equal(executions, 1);
  assert.equal(results.every((item) => ['running', 'needs_input'].includes(item.status)), true);
  assert.equal(task.status, 'needs_input');
});
test('开放复杂任务直接复用岗位专有执行器且不生成DAG或能力授权产物', async () => {
  const intel = openResearchAgentFixture({ manifestVersion:'0.6.0' });
  const { service } = setup({ agents:[intel] });
  service.executors['intel-researcher'] = {
    async execute(task) {
      assert.equal(task.taskType, 'research.intel-report');
      assert.equal(task.input.context.openTaskType, 'research.open-investigation');
      assert.equal(task.input.context.controlPlane, 'paperclip');
      assert.equal(task.input.context.autonomousWorkPlan, undefined);
      return {
        status:'succeeded',
        currentStage:'intel_research_ready',
        artifactRefs:[{
          artifactId:'intel-open-report',
          type:'intel_research_report',
          validation:{ exists:true, readable:true, nonEmpty:true }
        }]
      };
    }
  };

  const task = await service.create({
    title:'比较三种智能体治理方式',
    taskType:'research.open-investigation',
    agentId:'intel-researcher',
    goalSpec:{
      outcome:'形成有证据的治理方式比较报告',
      deliverables:['比较报告'],
      acceptanceCriteria:['至少比较三种方式并区分事实和判断'],
      capabilityRequests:[{
        capabilityId:'content.public.fetch',
        purpose:'读取公开资料'
      }]
    }
  });

  assert.equal(task.status, 'running');
  assert.equal(task.currentStage, 'delivery_quality_review_pending');
  assert.deepEqual(task.artifactRefs.map((item) => item.type), ['intel_research_report']);
  assert.equal(task.artifactRefs.some((item) => item.type === 'autonomous_work_plan'), false);
  assert.equal(task.artifactRefs.some((item) => item.type === 'capability_discovery_report'), false);
});
test('开放任务请求Manifest外能力时直接闭锁且不产生临时授权产物', async () => {
  const intel = openResearchAgentFixture();
  const { service } = setup({ agents:[intel] });

  const task = await service.create({
    title:'登录私有账号并研究',
    taskType:'research.open-investigation',
    agentId:'intel-researcher',
    goalSpec:{
      capabilityRequests:[{
        capabilityId:'private.account.login',
        purpose:'读取私有账号'
      }]
    }
  });

  assert.equal(task.status, 'needs_input');
  assert.equal(task.currentStage, 'manifest_capability_required');
  assert.equal(task.error.code, 'manifest_capability_required');
  assert.deepEqual(task.artifactRefs || [], []);
});
test('Paperclip投影收到开放任务的无状态岗位委托而不是本地DAG', async () => {
  const intel = openResearchAgentFixture({
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes',
  });
  let projectedTask = null;
  const governance = {
    async project(task) {
      projectedTask = task;
      return { status:'synced', paperclipIssueId:'issue-open-research' };
    },
    async update(task) { return task.governance; }
  };
  const { service } = setup({ agents:[intel], governance });

  const task = await service.create({
    title:'比较三种智能体治理方式',
    taskType:'research.open-investigation',
    agentId:'intel-researcher',
    goalSpec:{
      capabilityRequests:[{
        capabilityId:'content.public.fetch',
        purpose:'读取公开资料'
      }]
    }
  });

  assert.equal(projectedTask.taskType, 'research.open-investigation');
  assert.equal(projectedTask.input.context.openTaskType, 'research.open-investigation');
  assert.equal(projectedTask.input.context.delegatedTaskType, 'research.intel-report');
  assert.equal(projectedTask.artifactRefs?.some((item) => item.type === 'autonomous_work_plan') || false, false);
  assert.equal(task.execution.owner, 'paperclip-hermes');
  assert.equal(task.currentStage, 'waiting_paperclip_heartbeat');
});
test('一次性外发审批留在 A君，批准后只恢复原任务一次', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let executed = 0; let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced' }; }, async health() { return { status:'ready' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute(task) { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  const task = await service.create({ title:'外发本次健康摘要', taskType:'operations.health-review' });
  assert.equal(task.status, 'waiting_approval'); assert.equal(records.approvals[0].governanceMode, 'local'); assert.equal(projected, 0); assert.equal(executed, 0);
  const resumed = await service.approveApproval(records.approvals[0].approvalId, { decisionBy:'A君' });
  assert.equal(resumed.status, 'succeeded'); assert.equal(records.approvals[0].status, 'approved'); assert.equal(executed, 1);
  await assert.rejects(() => service.approveApproval(records.approvals[0].approvalId), /已经处理/);
  assert.equal(executed, 1);
});
test('运行总览展示微信 Vault 真实健康状态而不是只看岗位 active', async () => {
  const wechat = { agentId:'wechat-chat-retriever', name:'微信聊天取件员', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'], interaction:{ directFeishu:'disabled' } };
  const { service } = setup({ agents:[wechat] });
  service.executors['wechat-chat-retriever'] = {
    async health() {
      return {
        status:'degraded',
        checkedAt:'2026-07-30T06:30:00.000Z',
        requiredDatabases:{ contact:true, session:true, message:false },
        safeMessage:'本机微信只读库缺少消息库，请先安全刷新。'
      };
    }
  };

  const overview = await service.overview();
  const employee = overview.agents.find((item) => item.agentId === 'wechat-chat-retriever');
  const capability = overview.capabilities.find((item) => item.id === 'wechat-private-read');

  assert.equal(employee.runtimeHealth.status, 'degraded');
  assert.equal(capability.status, 'partial');
  assert.match(capability.detail, /缺少消息库/);
});
test('小D听审确认只生成确认稿并交回状态跟踪，不把审批点击冒充任务完成', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-review-1',
    taskType:'media.transcribe-and-refine',
    status:'waiting_approval',
    currentStage:'xiaod_awaiting_review',
    approvalRefs:['approval-review-1'],
    assigneeAgentId:'xiaod',
    input:{ title:'完整听审公开视频' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-job-1', polling:{ state:'settled', consecutiveFailures:0, nextPollAt:null } }
  });
  records.approvals.push({
    approvalId:'approval-review-1',
    taskId:'media-review-1',
    status:'pending',
    governanceMode:'local',
    action:'confirm-transcript-after-complete-listen',
    requestedScope:{ taskType:'media.transcribe-and-refine', title:'完整听审公开视频', assigneeAgentId:'xiaod' },
    validUntil:'2099-01-01T00:00:00.000Z'
  });
  const confirmed = [];
  service.executors.xiaod = {
    async confirmTranscript(task, input) { confirmed.push({ taskId:task.taskId, ...input }); return { status:'completed' }; }
  };
  const updated = await service.approveApproval('approval-review-1', { decisionBy:'A君' });
  assert.deepEqual(confirmed, [{ taskId:'media-review-1', reviewerRef:'A君' }]);
  assert.equal(records.approvals[0].status, 'approved');
  assert.equal(updated.status, 'running');
  assert.equal(updated.currentStage, 'xiaod_review_confirmed');
  assert.equal(updated.execution.polling.state, 'pending');
});

test('小D听审确认失败时审批保持待处理，允许安全重试幂等确认', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-review-failure', taskType:'media.transcribe-and-refine', status:'waiting_approval',
    currentStage:'xiaod_awaiting_review', approvalRefs:['approval-review-failure'], assigneeAgentId:'xiaod',
    input:{ title:'听审失败重试' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-failure' }
  });
  records.approvals.push({
    approvalId:'approval-review-failure', taskId:'media-review-failure', status:'pending', governanceMode:'local',
    action:'confirm-transcript-after-complete-listen',
    requestedScope:{ taskType:'media.transcribe-and-refine', title:'听审失败重试', assigneeAgentId:'xiaod' },
    validUntil:'2099-01-01T00:00:00.000Z'
  });
  service.executors.xiaod = { async confirmTranscript() { throw new Error('小D响应暂时丢失'); } };
  await assert.rejects(service.approveApproval('approval-review-failure'), /响应暂时丢失/);
  assert.equal(records.approvals[0].status, 'pending');
  assert.equal(records.tasks[0].status, 'waiting_approval');
});

test('继续飞书交付立即返回受理状态，并在后台单飞调用小D后恢复跟踪', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-delivery-pending', taskType:'media.transcribe-and-refine', status:'needs_input',
    currentStage:'xiaod_awaiting_delivery', approvalRefs:[], assigneeAgentId:'xiaod',
    source:{ channel:'feishu', chatRef:'chat-delivery' }, input:{ title:'继续交付确认稿' },
    error:{ code:'xiaod_delivery_pending', userMessage:'请继续飞书交付。' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-delivery-1', polling:{ state:'settled', nextPollAt:null } }
  });
  let release;
  let calls = 0;
  const observed = [];
  service.executors.xiaod = {
    async redeliver() { calls += 1; await new Promise((resolve) => { release = resolve; }); return { id:'xiaod-delivery-1', status:'completed', progress:100 }; },
    observe(task) { observed.push(task.taskId); }
  };
  const [first, second] = await Promise.all([
    service.continueXiaodDelivery('media-delivery-pending', { chatRef:'chat-delivery' }),
    service.continueXiaodDelivery('media-delivery-pending', { chatRef:'chat-delivery' })
  ]);
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.tasks[0].status, 'running');
  assert.equal(records.tasks[0].currentStage, 'xiaod_completed');
  assert.deepEqual(observed, ['media-delivery-pending']);
});

test('飞书交付结果不确定时继续口令也不能绕过人工仲裁', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-delivery-uncertain', taskType:'media.transcribe-and-refine', status:'needs_input',
    currentStage:'xiaod_awaiting_delivery', source:{ channel:'feishu', chatRef:'chat-delivery' }, input:{ title:'不确定交付' },
    error:{ code:'xiaod_delivery_uncertain', userMessage:'请先人工仲裁。' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-uncertain' }
  });
  let calls = 0;
  service.executors.xiaod = { async redeliver() { calls += 1; } };
  await assert.rejects(
    service.continueXiaodDelivery('media-delivery-uncertain', { chatRef:'chat-delivery' }),
    /人工仲裁/
  );
  assert.equal(calls, 0);
  assert.equal(records.tasks[0].status, 'needs_input');
});

test('小D听审确认被并发重复点击时只调用一次下游确认', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-review-race',
    taskType:'media.transcribe-and-refine',
    status:'waiting_approval',
    currentStage:'xiaod_awaiting_review',
    approvalRefs:['approval-review-race'],
    assigneeAgentId:'xiaod',
    input:{ title:'并发完整听审' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-race' },
  });
  records.approvals.push({
    approvalId:'approval-review-race',
    taskId:'media-review-race',
    status:'pending',
    governanceMode:'local',
    action:'confirm-transcript-after-complete-listen',
    requestedScope:{ taskType:'media.transcribe-and-refine', title:'并发完整听审', assigneeAgentId:'xiaod' },
    validUntil:'2099-01-01T00:00:00.000Z',
  });
  let confirmations = 0;
  service.executors.xiaod = {
    async confirmTranscript() {
      confirmations += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };

  const results = await Promise.all([
    service.approveApproval('approval-review-race', { decisionBy:'A君' }),
    service.approveApproval('approval-review-race', { decisionBy:'A君' }),
  ]);

  assert.equal(confirmations, 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[0].status, 'running');
});

test('同一审批正在批准时拒绝并发拒绝决定，不覆盖下游动作', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-review-conflict',
    taskType:'media.transcribe-and-refine',
    status:'waiting_approval',
    currentStage:'xiaod_awaiting_review',
    approvalRefs:['approval-review-conflict'],
    assigneeAgentId:'xiaod',
    input:{ title:'冲突听审' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-conflict' },
  });
  records.approvals.push({
    approvalId:'approval-review-conflict',
    taskId:'media-review-conflict',
    status:'pending',
    governanceMode:'local',
    action:'confirm-transcript-after-complete-listen',
    requestedScope:{ taskType:'media.transcribe-and-refine', title:'冲突听审', assigneeAgentId:'xiaod' },
    validUntil:'2099-01-01T00:00:00.000Z',
  });
  let rejected = 0;
  service.executors.xiaod = {
    async confirmTranscript() { await new Promise((resolve) => setTimeout(resolve, 20)); },
    async rejectTranscript() { rejected += 1; },
  };

  const approving = service.approveApproval('approval-review-conflict');
  await assert.rejects(
    service.rejectApproval('approval-review-conflict'),
    (error) => error?.code === 'approval_resolution_conflict',
  );
  await approving;

  assert.equal(rejected, 0);
  assert.equal(records.approvals[0].status, 'approved');
});

test('小D听审拒绝会通知小D并关闭正式下游链路', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-review-2',
    taskType:'media.transcribe-and-refine',
    status:'waiting_approval',
    currentStage:'xiaod_awaiting_review',
    approvalRefs:['approval-review-2'],
    assigneeAgentId:'xiaod',
    input:{ title:'拒绝错误机器稿' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-job-2' }
  });
  records.approvals.push({
    approvalId:'approval-review-2',
    taskId:'media-review-2',
    status:'pending',
    governanceMode:'local',
    action:'confirm-transcript-after-complete-listen',
    validUntil:'2099-01-01T00:00:00.000Z'
  });
  let rejected = 0;
  service.executors.xiaod = {
    async rejectTranscript(task, input) {
      rejected += 1;
      assert.equal(task.taskId, 'media-review-2');
      assert.equal(input.reviewerRef, 'A君');
    }
  };
  const updated = await service.rejectApproval('approval-review-2', { decisionBy:'A君', decisionReason:'听审发现缺漏。' });
  assert.equal(rejected, 1);
  assert.equal(records.approvals[0].status, 'rejected');
  assert.equal(updated.status, 'cancelled');
});
test('公开发布等组织级审批投影 Paperclip，不能由本机直接放行', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced', paperclipIssueId:'issue-1' }; }, async health() { return { status:'ready' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  const task = await service.create({ title:'公开发布系统摘要', taskType:'operations.health-review' });
  assert.equal(task.status, 'waiting_approval'); assert.equal(records.approvals[0].governanceMode, 'paperclip'); assert.equal(projected, 1);
  await assert.rejects(() => service.approveApproval(records.approvals[0].approvalId), /Paperclip/);
  await assert.rejects(() => service.rejectApproval(records.approvals[0].approvalId), /Paperclip/);
  assert.equal(records.approvals[0].status, 'pending');
});
test('组织级飞书决定必须先回写 Paperclip，批准后才恢复原任务', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let resolved = 0; let executed = 0;
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'issue-1', paperclipApprovalId:'paperclip-approval-1' }; },
    async resolveApproval(id, decision) { resolved += 1; assert.equal(id, 'paperclip-approval-1'); assert.equal(decision, 'approve'); await new Promise((resolve) => setTimeout(resolve, 20)); return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute(task) { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  const task = await service.create({ title:'公开发布系统摘要', taskType:'operations.health-review', source:{ channel:'feishu', chatRef:'chat-a' } });
  const results = await Promise.all([
    service.resolvePaperclipApproval(records.approvals[0].approvalId, 'approve', { decisionBy:'feishu-user', chatRef:'chat-a' }),
    service.resolvePaperclipApproval(records.approvals[0].approvalId, 'approve', { decisionBy:'feishu-user', chatRef:'chat-a' }),
  ]);
  assert.equal(resolved, 1); assert.equal(executed, 1); assert.equal(records.approvals[0].status, 'approved'); assert.equal(results[0].status, 'succeeded'); assert.equal(results[0], results[1]);
});
test('Paperclip 已落决定但响应丢失时通过只读回查收口，不重复决定或执行', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let paperclipStatus = 'pending'; let resolved = 0; let executed = 0;
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'issue-lost', paperclipApprovalId:'approval-lost' }; },
    async getApproval() { return { status:paperclipStatus }; },
    async resolveApproval() { resolved += 1; paperclipStatus = 'approved'; throw new Error('response lost'); },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; },
  };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute(task) { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  await service.create({ title:'公开发布响应丢失验证', taskType:'operations.health-review' });
  const result = await service.resolvePaperclipApproval(records.approvals[0].approvalId, 'approve');
  assert.equal(result.status, 'succeeded');
  assert.equal(resolved, 1);
  assert.equal(executed, 1);
  assert.equal(records.approvals[0].externalDecision.state, 'confirmed');
  assert.equal(records.approvals[0].status, 'approved');
});
test('旧飞书卡的相反点击不能覆盖 Paperclip 已决事实，本地按权威决定收口', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let resolved = 0; let executed = 0;
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'issue-authority', paperclipApprovalId:'approval-authority' }; },
    async getApproval() { return { status:'approved' }; },
    async resolveApproval() { resolved += 1; return { status:'rejected' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; },
  };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute(task) { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  await service.create({ title:'公开发布 Paperclip 权威决定验证', taskType:'operations.health-review' });
  const result = await service.resolvePaperclipApproval(records.approvals[0].approvalId, 'reject');
  assert.equal(result.status, 'succeeded');
  assert.equal(resolved, 0);
  assert.equal(executed, 1);
  assert.equal(records.approvals[0].status, 'approved');
  assert.equal(records.approvals[0].decisionBy, 'Paperclip 已决事实');
  assert.equal(records.approvals[0].externalDecision.requestedDecision, 'reject');
  assert.equal(records.approvals[0].externalDecision.decision, 'approve');
});
test('重启整理器会续接已开始的 Paperclip 决定，不等待再次点击审批卡', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let resolved = 0; let executed = 0;
  const governance = {
    async getApproval() { return { status:'approved' }; },
    async resolveApproval() { resolved += 1; return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; },
  };
  const { service, records } = setup({ agents:[operator], governance });
  records.tasks.push({
    taskId:'restart-task', taskType:'operations.health-review', status:'waiting_approval', approvalRefs:['restart-approval'], assigneeAgentId:'operator',
    input:{ title:'重启后续接审批' }, governance:{ paperclipIssueId:'restart-issue', paperclipApprovalId:'restart-paperclip-approval' },
  });
  records.approvals.push({
    approvalId:'restart-approval', taskId:'restart-task', status:'pending', governanceMode:'paperclip',
    requestedScope:{ taskType:'operations.health-review', title:'重启后续接审批', assigneeAgentId:'operator' },
    externalDecision:{ decision:'approve', state:'resolving', paperclipApprovalId:'restart-paperclip-approval', decisionBy:'feishu-user', decisionReason:'已确认' },
  });
  service.executors.operator = { async execute(task) { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  const reconciled = await service.reconcilePendingPaperclipApprovals();
  assert.equal(reconciled[0].status, 'reconciled');
  assert.equal(resolved, 0);
  assert.equal(executed, 1);
  assert.equal(records.approvals[0].status, 'approved');
  assert.equal(records.tasks[0].status, 'succeeded');
});
test('组织级拒绝先回写 Paperclip，关闭任务且不执行', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  let resolved = 0;
  const governance = { async project() { return { status:'synced', paperclipIssueId:'issue-1', paperclipApprovalId:'paperclip-approval-1' }; }, async resolveApproval(_id, decision) { resolved += 1; assert.equal(decision, 'reject'); return { status:'rejected' }; }, async update(task) { return task.governance; }, async health() { return { status:'ready' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute() { throw new Error('must not run'); } };
  await service.create({ title:'公开发布系统摘要', taskType:'operations.health-review' });
  const result = await service.resolvePaperclipApproval(records.approvals[0].approvalId, 'reject');
  assert.equal(resolved, 1); assert.equal(records.approvals[0].status, 'rejected'); assert.equal(result.status, 'cancelled'); assert.equal(result.currentStage, 'governance_rejected');
});
test('暂停小D任务必须先走 Paperclip 确认，确认前不伪装成已经暂停', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  let projected = 0; let resolved = 0; let paused = 0;
  const governance = {
    async project() { projected += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { status:'synced', paperclipIssueId:'pause-issue-1', paperclipApprovalId:'pause-approval-1' }; },
    async resolveApproval(id, decision) { resolved += 1; assert.equal(id, 'pause-approval-1'); assert.equal(decision, 'approve'); return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[xiaod], governance });
  records.tasks.push({ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'running', approvalRefs:[], assigneeAgentId:'xiaod', input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' } });
  service.executors.xiaod = { async pause() { paused += 1; return { id:'xiaod-job-1', status:'pausing', progress:45 }; } };
  const requests = await Promise.all([
    service.requestPause('media-1'),
    service.requestPause('media-1'),
  ]);
  const requested = requests[0];
  assert.equal(requests[0], requests[1]);
  assert.equal(projected, 1);
  assert.equal(records.approvals.length, 1);
  assert.equal(requested.task.status, 'running');
  assert.equal(requested.approval.governanceMode, 'paperclip');
  assert.equal(records.approvals[0].action, 'pause-task');
  const updated = await service.resolvePaperclipApproval(requested.approval.approvalId, 'approve');
  assert.equal(resolved, 1); assert.equal(paused, 1); assert.equal(updated.status, 'pausing');
});
test('小D暂停已生效但本地原子提交失败时可安全续接，不重复暂停或 Paperclip 决定', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  let paperclipStatus = 'pending'; let resolved = 0; let paused = 0; let jobStatus = 'transcribing';
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'pause-issue-retry', paperclipApprovalId:'pause-approval-retry' }; },
    async getApproval() { return { status:paperclipStatus }; },
    async resolveApproval() { resolved += 1; paperclipStatus = 'approved'; return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; },
  };
  const { service, records } = setup({ agents:[xiaod], governance });
  records.tasks.push({ taskId:'media-retry', taskType:'media.transcribe-and-refine', status:'running', approvalRefs:[], assigneeAgentId:'xiaod', input:{ title:'暂停响应丢失' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-retry' } });
  service.executors.xiaod = {
    async getJob() { return { id:'xiaod-job-retry', status:jobStatus, progress:40 }; },
    async pause() { paused += 1; jobStatus = 'pausing'; return { id:'xiaod-job-retry', status:jobStatus, progress:40 }; },
  };
  const requested = await service.requestPause('media-retry');
  const atomicCommit = service.store.resolveApprovalAndUpdateTask.bind(service.store);
  let failCommit = true;
  service.store.resolveApprovalAndUpdateTask = async (...args) => {
    if (failCommit) { failCommit = false; throw new Error('disk unavailable'); }
    return atomicCommit(...args);
  };
  await assert.rejects(
    service.resolvePaperclipApproval(requested.approval.approvalId, 'approve'),
    /disk unavailable/,
  );
  assert.equal(records.approvals[0].status, 'pending');
  assert.equal(records.approvals[0].externalDecision.state, 'confirmed');
  assert.equal(records.approvals[0].localEffect.state, 'resolving');
  const updated = await service.resolvePaperclipApproval(requested.approval.approvalId, 'approve');
  assert.equal(updated.status, 'pausing');
  assert.equal(records.approvals[0].status, 'approved');
  assert.equal(resolved, 1);
  assert.equal(paused, 1);
});

test('拒绝暂停小D任务不会关闭或打断原任务', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'pause-issue-1', paperclipApprovalId:'pause-approval-1' }; },
    async resolveApproval(_id, decision) { assert.equal(decision, 'reject'); return { status:'rejected' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[xiaod], governance });
  records.tasks.push({ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'running', approvalRefs:[], assigneeAgentId:'xiaod', input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' } });
  const requested = await service.requestPause('media-1');
  const updated = await service.resolvePaperclipApproval(requested.approval.approvalId, 'reject');
  assert.equal(updated.status, 'running');
  assert.equal(records.approvals[0].status, 'rejected');
  assert.equal(updated.execution.control.status, 'rejected');
});
test('继续小D任务经确认后会重新进入总管跟进，不会只改显示状态', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'resume-issue-1', paperclipApprovalId:'resume-approval-1' }; },
    async resolveApproval(_id, decision) { assert.equal(decision, 'approve'); return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[xiaod], governance });
  records.tasks.push({ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'paused', approvalRefs:[], assigneeAgentId:'xiaod', input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' } });
  const observed = [];
  service.executors.xiaod = { async resume() { return { id:'xiaod-job-1', status:'queued', progress:45 }; }, observe(task) { observed.push(task); } };
  const requested = await service.requestResume('media-1');
  const updated = await service.resolvePaperclipApproval(requested.approval.approvalId, 'approve');
  assert.equal(updated.status, 'running');
  assert.deepEqual(observed.map((task) => task.taskId), ['media-1']);
});
test('飞书审批卡不能跨会话批准原任务', async () => {
  const operator = agentFixture('operator', '运维官', ['operations.health-review']);
  const { service, records } = setup({ agents:[operator] });
  const task = await service.create({ title:'外发本次健康摘要', taskType:'operations.health-review', source:{ channel:'feishu', chatRef:'chat-a' } });
  await assert.rejects(() => service.approveApproval(records.approvals[0].approvalId, { chatRef:'chat-b' }), /会话与原任务不一致/);
  assert.equal(task.status, 'waiting_approval');
});
test('本机主人拒绝审批会关闭任务，不会执行任务', async () => {
  const { service, records } = setup({ agents:[coordinator] }); const task = await service.create({ title:'向外发布周报', taskType:'army.route-task' });
  const closed = await service.rejectApproval(records.approvals[0].approvalId);
  assert.equal(records.approvals[0].status, 'rejected'); assert.equal(closed.status, 'cancelled'); assert.equal(closed.currentStage, 'approval_rejected'); assert.equal(closed.error.code, 'approval_rejected');
});
test('缺少标题拒绝创建', async () => {
  const { service } = setup({ agents:[coordinator] }); await assert.rejects(() => service.create({ taskType:'army.route-task' }), ValidationError);
});

test('交付简报缺少必需素材时只追问一次且不启动执行器', async () => {
  let calls = 0;
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  const { service } = setup({ agents:[xiaod], executors:{ xiaod:{ async execute() { calls += 1; } } } });
  const task = await service.create({ title:'整理这段素材', taskType:'media.transcribe-and-refine', agentId:'xiaod' });
  assert.equal(task.status, 'needs_input');
  assert.equal(task.currentStage, 'delivery_brief_needs_clarification');
  assert.match(task.error.userMessage, /素材|文件|来源链接/);
  assert.equal(calls, 0);
});
test('治理台不可用不阻断任务登记，留下待同步记录', async () => {
  const governance = { async project() { return { status: 'sync_pending', reason: 'Paperclip 暂不可用。' }; }, async health() { return { status: 'offline' }; } };
  const { service } = setup({ agents:[coordinator], governance }); const task = await service.create({ title:'登记治理任务', taskType:'army.route-task' });
  assert.equal(task.governance.status, 'sync_pending');
});
test('简单小D业务任务不重复投影到 Paperclip，治理任务才进入组织总控', async () => {
  const xiaod = agentFixture('xiaod', '小D', ['media.transcribe-and-refine']);
  let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced' }; }, async health() { return { status:'ready' }; } };
  const { service } = setup({ agents:[xiaod], governance });
  service.executors.xiaod = { async execute() { return { status:'needs_input', currentStage:'source_url_required' }; } };
  const task = await service.create({ title:'整理公开视频', taskType:'media.transcribe-and-refine' });
  assert.equal(projected, 0); assert.equal(task.governance, undefined);
});
test('技术修复任务自动登记到 Paperclip', async () => {
  const expert = { agentId:'technical-expert', name:'技术专家', status:'draft', acceptedTaskTypes:['operations.technical-repair'] };
  let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced', paperclipIssueId:'issue-1' }; }, async health() { return { status:'ready' }; } };
  const { service } = setup({ agents:[expert], governance });
  const task = await service.create({ title:'修复运行时故障', taskType:'operations.technical-repair' });
  assert.equal(projected, 1); assert.equal(task.governance.paperclipIssueId, 'issue-1');
});

test('Paperclip Hermes 员工只等待同一张 heartbeat 任务，不再调用 A君本地执行器', async () => {
  const architect = hermesAgentFixture('architect', '架构师', ['governance.architecture-review'], {
    interaction:{ directFeishu:'required' },
  });
  let localExecutions = 0;
  const governance = {
    async project() {
      return {
        status:'synced',
        paperclipIssueId:'paperclip-issue-1',
        paperclipAssigneeAgentId:'paperclip-agent-1'
      };
    }
  };
  const { service } = setup({ agents:[architect], governance });
  service.executors.architect = { async execute() { localExecutions += 1; return { status:'succeeded' }; } };

  const task = await service.create({
    title:'评估六员工运行时边界',
    taskType:'governance.architecture-review',
    agentId:'architect'
  });

  assert.equal(task.status, 'running');
  assert.equal(task.currentStage, 'waiting_paperclip_heartbeat');
  assert.equal(task.execution.owner, 'paperclip-hermes');
  assert.equal(localExecutions, 0);
});

test('Paperclip Hermes heartbeat 会关联原 A君任务并幂等回写同一终态', async () => {
  const architect = hermesAgentFixture('architect', '架构师', ['governance.architecture-review'], {
    interaction:{ directFeishu:'required' },
  });
  const completions = [];
  const identity = paperclipIdentityFixture('architecture', 'architect', '架构师', {
    title:'评估架构', description:'检查复用边界。',
  });
  const governance = paperclipGovernanceFixture(identity, {
    async completePaperclipIssue(issueId, input) { completions.push({ issueId, input }); }
  });
  const { service } = setup({ agents:[architect], governance });
  const original = await service.create({
    title:'评估架构',
    taskType:'governance.architecture-review',
    agentId:'architect'
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'architect',
    status:'succeeded',
    summary:'复用 Hermes Profile Distribution 与 Paperclip hermes_local。',
    evidence:'未新增第二套运行时。',
    remainingRisks:'飞书真人回归待完成。',
    factClaims:[{
      claim:'架构师当前登记为治理评估岗位。',
      evidenceRefs:['agent:architect']
    }],
    architectureJudgments:[{
      judgment:'应优先复用现有 Paperclip/Hermes 执行链，而不是再建一套调度系统。',
      basisRefs:['agent:architect'],
      assumptions:['现有执行链的任务审计仍满足本轮目标。'],
      confidence:'medium'
    }],
    candidateProposals:[{
      proposal:'候选新增 architecture.experiment 任务类型',
      problem:'复杂架构建议缺少最小试验载体。',
      validationPlan:'先用一条不改生产配置的本机任务验证输入、产物和失败恢复。',
      risks:['可能与现有治理任务重复。'],
      nonGoals:['本轮不注册该任务类型。']
    }],
    currentStateUnknowns:['飞书真人回归待完成。']
  };
  await assert.rejects(
    service.completePaperclipAssignment({
      ...input,
      factClaims:[{
        claim:'假设存在统一能力注册表。',
        evidenceRefs:['repo:agents/capability-registry.md']
      }]
    }),
    /引用了快照中不存在的对象/
  );
  await assert.rejects(
    service.completePaperclipAssignment({
      ...input,
      architectureJudgments:[{
        judgment:'判断建立在不存在的仓库路径上。',
        basisRefs:['repo:agents/capability-registry.md'],
        assumptions:[],
        confidence:'high'
      }]
    }),
    /引用了快照中不存在的对象/
  );
  const completed = await service.completePaperclipAssignment(input);
  const duplicate = await service.completePaperclipAssignment(input);

  assert.equal(completed.task.taskId, original.taskId);
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(completed.task.currentStage, 'paperclip_hermes_completed');
  assert.equal(completed.task.artifactRefs[0].type, 'employee_role_report');
  assert.equal(completed.task.artifactRefs[0].data.evidenceValidation.valid, true);
  assert.equal(completed.task.artifactRefs[0].data.factClaims[0].evidenceRefs[0], 'agent:architect');
  assert.equal(completed.task.artifactRefs[0].data.architectureJudgments[0].confidence, 'medium');
  assert.match(completed.task.artifactRefs[0].data.candidateProposals[0].proposal, /architecture\.experiment/);
  assert.deepEqual(completed.task.artifactRefs[0].data.currentStateUnknowns, ['飞书真人回归待完成。']);
  assert.equal(completions.length, 1);
  assert.equal(duplicate.duplicate, true);
});
