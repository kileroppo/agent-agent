import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskRecovery, TaskRecoveryError, view } from '../src/task-recovery.ts';

test('失败详情只向本机主人提供固定恢复动作和稳定核验视图', () => {
  const tasks = eligibleTasks();
  assert.deepEqual(view(tasks[0], { audience:'local-owner', relatedTasks:tasks }), {
    actions:[
      {
        actionKey:'use_confirmed_transcript_only',
        label:'仅用确认稿继续',
        emphasis:'primary',
        confirmation:'将关闭视觉分析，只使用已核验确认稿创建原 Paperclip 任务的子任务；不会重新抓取素材或调用视觉 Provider。',
      },
      {
        actionKey:'request_read_only_diagnosis',
        label:'只读诊断',
        emphasis:'secondary',
        confirmation:'只在原 Paperclip Issue 下创建诊断子任务；不修改代码、不重跑任务、不扩权。',
      },
    ],
    verification:null,
  });
  assert.deepEqual(view(tasks[0], { audience:'lan', relatedTasks:tasks }), { actions:[], verification:null });
});

test('已批准但未进入规划的多人任务提供继续按钮并只恢复一次', async () => {
  const mission = {
    taskId:'86eea524-eb4a-426c-bcc6-ff6aa9ce5155',
    taskType:'army.cross-agent-mission',
    status:'queued',
    currentStage:'approval_approved',
    updatedAt:'2026-08-15T09:45:47.247Z',
    approvalRefs:['approval-1'],
    artifactRefs:[],
    input:{ title:'爆款候选拆解｜晕肉了' },
  };
  const store = memoryStore([mission]);
  store.listApprovals = async () => [{
    approvalId:'approval-1', taskId:mission.taskId, status:'approved', action:'manual-risk-review',
  }];
  let resumeCalls = 0;
  const recovery = new TaskRecovery({
    store,
    async resumeApprovedMission(task) {
      resumeCalls += 1;
      return store.updateTask(task.taskId, {
        status:'running', currentStage:'mission_planned',
        artifactRefs:[{ type:'cross_agent_mission_plan' }],
      });
    },
  });

  const recoveryView = await recovery.view(mission.taskId, { audience:'local-owner' });
  assert.deepEqual(recoveryView.actions.map((item) => item.label), ['继续处理']);
  const result = await recovery.request(mission.taskId, {
    actionKey:'resume_approved_mission',
    requestId:'resume-approved-mission-0001',
    expectedUpdatedAt:mission.updatedAt,
  }, { kind:'local-owner', ref:'A君' });

  assert.equal(result.status, 'accepted');
  assert.equal(resumeCalls, 1);
  const stored = await store.getTask(mission.taskId);
  assert.equal(stored.status, 'running');
  assert.equal(stored.currentStage, 'mission_planned');
  assert.equal(stored.recovery.coordination.status, 'completed');
  assert.deepEqual(stored.recovery.events.map((event) => event.event), ['requested', 'resumed']);
});

test('仅用确认稿恢复会复核条件并创建原 Paperclip Issue 的文本子任务', async () => {
  const tasks = eligibleTasks();
  const store = memoryStore(tasks);
  const created = [];
  const recovery = new TaskRecovery({
    store,
    async createTask(input) {
      created.push(input);
      return { taskId:'retry-child', ...input };
    },
  });
  const input = {
    actionKey:'use_confirmed_transcript_only',
    requestId:'recovery-request-0001',
    expectedUpdatedAt:tasks[0].updatedAt,
  };
  const first = await recovery.request(tasks[0].taskId, input, { ref:'A君' });
  const duplicate = await recovery.request(tasks[0].taskId, input, { ref:'A君' });
  const duplicateWithNewTransportKey = await recovery.request(tasks[0].taskId, {
    ...input,
    requestId:'recovery-request-0009',
  }, { ref:'A君' });

  assert.equal(first.status, 'accepted');
  assert.equal(duplicate.status, 'existing');
  assert.equal(duplicateWithNewTransportKey.status, 'existing');
  assert.equal(created.length, 1);
  assert.equal(created[0].visualMode, 'off');
  assert.equal(created[0].context.parentPaperclipIssueId, 'paperclip-issue-original');
  assert.equal(created[0].context.confirmedTranscriptTaskId, 'transcript-task');
  assert.equal(created[0].idempotencyKey, `recovery-confirmed-transcript:${tasks[0].taskId}`);
  const stored = await store.getTask(tasks[0].taskId);
  assert.equal(stored.recovery.coordination.status, 'retrying');
  assert.deepEqual(stored.recovery.events.map((event) => event.event), ['requested', 'child_created']);
});

test('旧任务可用已验证自动确认凭证证明确认稿，不要求迁移历史 artifact data', () => {
  const tasks = eligibleTasks();
  tasks[1] = {
    taskId:'transcript-task',
    taskType:'media.transcribe-and-refine',
    status:'succeeded',
    artifactRefs:[
      {
        artifactId:'automatic-confirmation-legacy',
        type:'automatic_transcript_attestation',
        validation:{ exists:true, readable:true, nonEmpty:true },
      },
      {
        artifactId:'confirmed-transcript-legacy',
        type:'confirmed_transcript',
        validation:{ exists:true, readable:true, nonEmpty:true },
      },
    ],
  };

  assert.deepEqual(
    view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions.map((item) => item.actionKey),
    ['use_confirmed_transcript_only', 'request_read_only_diagnosis'],
  );

  tasks[1].artifactRefs.shift();
  assert.deepEqual(
    view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions.map((item) => item.actionKey),
    ['request_read_only_diagnosis'],
  );
});

test('恢复请求要求 expectedUpdatedAt 并只将本机失败交给安全恢复协调器', async () => {
  const tasks = localFailureTasks();
  const store = memoryStore(tasks);
  const calls = [];
  const recovery = new TaskRecovery({ store, async recover(task, input) { calls.push([task.taskId, input.actionKey]); return { status:'diagnosed' }; } });

  await assert.rejects(
    recovery.request(tasks[0].taskId, {
      actionKey:'request_safe_recovery',
      requestId:'recovery-request-0002',
      expectedUpdatedAt:'stale-value',
    }),
    (error) => error instanceof TaskRecoveryError && error.code === 'task_recovery_stale' && error.httpStatus === 409,
  );
  await recovery.request(tasks[0].taskId, {
    actionKey:'request_safe_recovery',
    requestId:'recovery-request-0003',
    expectedUpdatedAt:tasks[0].updatedAt,
  });
  assert.deepEqual(calls, [[tasks[0].taskId, 'request_safe_recovery']]);
});

test('只读诊断创建原 Paperclip Issue 子任务，并显式禁止重试、写代码和扩权', async () => {
  const tasks = eligibleTasks();
  const store = memoryStore(tasks);
  const created = [];
  const recovery = new TaskRecovery({
    store,
    async createTask(input) { created.push(input); return { taskId:'diagnosis-child', ...input }; },
  });
  const result = await recovery.request(tasks[0].taskId, {
    actionKey:'request_read_only_diagnosis',
    requestId:'recovery-request-0005',
    expectedUpdatedAt:tasks[0].updatedAt,
  }, { ref:'A君' });
  assert.equal(result.status, 'accepted');
  assert.equal(created[0].context.parentPaperclipIssueId, 'paperclip-issue-original');
  assert.equal(created[0].context.diagnosisOnly, true);
  assert.deepEqual(created[0].context.failure, {
    code:'provider_http_402',
    category:null,
    stage:null,
    retryable:false,
    occurredAt:null,
    userMessage:null,
  });
  assert.deepEqual(created[0].context.prohibitedActions, ['retry', 'code_write', 'permission_expansion', 'external_publish']);
  assert.equal(created[0].idempotencyKey, `recovery-read-only-diagnosis-v2:${tasks[0].taskId}`);
  assert.deepEqual((await recovery.view(tasks[0].taskId, { audience:'local-owner' })).actions, []);
});

test('只读诊断完成后在原任务恢复区直接给出结论、依据、影响和下一步', () => {
  const tasks = eligibleTasks();
  const diagnosisTask = {
    taskId:'33333333-3333-4333-a333-333333333333',
    taskType:'operations.failure-recovery',
    status:'succeeded',
    parentTaskId:tasks[0].taskId,
    requester:{ kind:'local-owner' },
    source:{ channel:'internal-recovery' },
    recovery:{ mode:'read_only_diagnosis' },
    input:{ context:{
      failedTaskId:tasks[0].taskId,
      parentPaperclipIssueId:'paperclip-issue-original',
      diagnosisOnly:true,
      prohibitedActions:['retry', 'code_write', 'permission_expansion', 'external_publish'],
    } },
    artifactRefs:[{
      type:'recovery_decision',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ diagnosis:{
        conclusion:'Paperclip 执行链结束，但没有形成可验证产物。',
        evidence:'故障代码 provider_http_402；阶段 paperclip_hermes。',
        impact:'原任务仍未完成，已有记录保持不变。',
        nextAction:'先核对 Paperclip 失败记录，再决定是否修复。',
      } },
    }],
  };
  tasks[0].recovery = { coordination:{
    status:'verified',
    actionKey:'request_read_only_diagnosis',
    operatorTaskId:diagnosisTask.taskId,
    attempt:1,
  } };

  assert.deepEqual(view(tasks[0], { audience:'local-owner', relatedTasks:[...tasks, diagnosisTask] }).verification, {
    state:'verified',
    taskId:diagnosisTask.taskId,
    detailPath:`/tasks/${diagnosisTask.taskId}`,
    message:'只读诊断完成。',
    diagnosis:{
      conclusion:'Paperclip 执行链结束，但没有形成可验证产物。',
      evidence:'故障代码 provider_http_402；阶段 paperclip_hermes。',
      impact:'原任务仍未完成，已有记录保持不变。',
      nextAction:'先核对 Paperclip 失败记录，再决定是否修复。',
    },
  });
});

test('旧版只读诊断被误卡二次审批时允许一次性替换执行', async () => {
  const tasks = eligibleTasks();
  const parent = tasks[0];
  const oldChild = {
    taskId:'44444444-4444-4444-a444-444444444444',
    taskType:'operations.failure-recovery',
    status:'waiting_approval',
    parentTaskId:parent.taskId,
    requester:{ kind:'local-owner' },
    source:{ channel:'internal-recovery' },
    recovery:{ mode:'read_only_diagnosis' },
    input:{ context:{
      failedTaskId:parent.taskId,
      parentPaperclipIssueId:'paperclip-issue-original',
      diagnosisOnly:true,
      prohibitedActions:['retry', 'code_write', 'permission_expansion', 'external_publish'],
    } },
    artifactRefs:[],
    approvalRefs:['legacy-approval'],
  };
  parent.recovery = {
    coordination:{
      status:'diagnosed',
      actionKey:'request_read_only_diagnosis',
      operatorTaskId:oldChild.taskId,
      attempt:1,
    },
    events:[{
      event:'diagnosed',
      actionKey:'request_read_only_diagnosis',
      requestId:'legacy-request',
      attempt:1,
    }],
  };
  const store = memoryStore([...tasks, oldChild]);
  const approvals = [{ approvalId:'legacy-approval', taskId:oldChild.taskId, status:'pending' }];
  store.listApprovals = async () => structuredClone(approvals);
  store.updateApproval = async (approvalId, patch) => {
    const approval = approvals.find((item) => item.approvalId === approvalId);
    Object.assign(approval, structuredClone(patch));
    return structuredClone(approval);
  };
  const created = [];
  const recovery = new TaskRecovery({
    store,
    async createTask(input) {
      created.push(input);
      return { taskId:'replacement-diagnosis', status:'succeeded', artifactRefs:[], ...input };
    },
  });

  const recoveryView = await recovery.view(parent.taskId, { audience:'local-owner' });
  assert.equal(recoveryView.verification.state, 'blocked');
  assert.deepEqual(recoveryView.actions.map((item) => item.label), ['重新执行只读诊断']);

  const current = await store.getTask(parent.taskId);
  const result = await recovery.request(parent.taskId, {
    actionKey:'request_read_only_diagnosis',
    requestId:'replacement-request',
    expectedUpdatedAt:current.updatedAt,
  }, { kind:'local-owner', ref:'A君' });

  assert.equal(result.status, 'accepted');
  assert.equal(created.length, 1);
  assert.equal(created[0].idempotencyKey, `recovery-read-only-diagnosis-v2:${parent.taskId}`);
  assert.equal((await store.getTask(oldChild.taskId)).status, 'cancelled');
  assert.equal(approvals[0].status, 'rejected');
});

test('Paperclip Hermes 失败请求本机安全恢复时只返回 requires_external', async () => {
  const tasks = eligibleTasks();
  const recovery = new TaskRecovery({ store:memoryStore(tasks) });
  const result = await recovery.request(tasks[0].taskId, {
    actionKey:'request_safe_recovery',
    requestId:'recovery-request-0010',
    expectedUpdatedAt:tasks[0].updatedAt,
  });
  assert.equal(result.status, 'requires_external');
  assert.equal(result.actionKey, 'request_safe_recovery');
});

test('视觉能力失败会提供由本机主人显式触发的恢复后重跑动作', () => {
  const tasks = visionFailureTasks();
  const actions = view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions;

  assert.equal(actions.some((item) => item.actionKey === 'retry_visual_analysis_after_recovery'), true);
  assert.equal(
    actions.find((item) => item.actionKey === 'retry_visual_analysis_after_recovery').confirmation,
    '只有本机主人点击后才会先核验 vision.analyze 已配置、健康且通过端到端验证；余额或额度错误还必须有晚于本次失败的新端到端验证。能力未恢复时不创建任务、不消耗重跑次数。恢复后仅创建一次保留原视觉模式的子任务，子任务会调用识图能力，可能产生一次 Provider 费用。',
  );

  for (const status of ['needs_input', 'waiting_test']) {
    tasks[0].status = status;
    assert.equal(
      view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions
        .some((item) => item.actionKey === 'retry_visual_analysis_after_recovery'),
      true,
    );
  }
});

test('视觉能力未恢复时不记恢复次数、不写原失败任务、不创建子任务', async () => {
  const tasks = visionFailureTasks();
  const store = memoryStore(tasks);
  let capabilityChecks = 0;
  let createCalls = 0;
  const recovery = new TaskRecovery({
    store,
    async capabilityStatus() {
      capabilityChecks += 1;
      return {
        capabilities:[{
          capability:'vision.analyze', configured:true, healthy:false, e2eVerified:false,
        }],
      };
    },
    async createTask() { createCalls += 1; return { taskId:'must-not-be-created' }; },
  });

  const result = await recovery.request(tasks[0].taskId, {
    actionKey:'retry_visual_analysis_after_recovery',
    requestId:'vision-recovery-waiting-0001',
    expectedUpdatedAt:tasks[0].updatedAt,
  }, { kind:'local-owner', ref:'A君' });

  assert.equal(result.status, 'waiting_capability');
  assert.deepEqual(result.capability, {
    capability:'vision.analyze', configured:true, healthy:false, e2eVerified:false, ready:false,
  });
  assert.equal(capabilityChecks, 1);
  assert.equal(createCalls, 0);
  assert.equal((await store.getTask(tasks[0].taskId)).recovery, undefined);
  assert.equal((await store.getTask(tasks[0].taskId)).status, 'failed');
});

test('视觉能力恢复后仅创建一次子任务，保留 visualMode、sourceTaskIds 和 Paperclip 审计关联', async () => {
  const tasks = visionFailureTasks();
  const store = memoryStore(tasks);
  const created = [];
  const recovery = new TaskRecovery({
    store,
    capabilityStatus:async () => ({
      capabilities:[{
        capability:'vision.analyze', configured:true, healthy:true, e2eVerified:true,
      }],
    }),
    async createTask(input) {
      created.push(input);
      return { taskId:'vision-retry-child', ...input };
    },
  });
  const input = {
    actionKey:'retry_visual_analysis_after_recovery',
    requestId:'vision-recovery-ready-0001',
    expectedUpdatedAt:tasks[0].updatedAt,
  };

  const first = await recovery.request(tasks[0].taskId, input, { kind:'local-owner', ref:'A君' });
  const duplicate = await recovery.request(tasks[0].taskId, input, { kind:'local-owner', ref:'A君' });
  const duplicateWithNewTransportKey = await recovery.request(tasks[0].taskId, {
    ...input,
    requestId:'vision-recovery-ready-0002',
  }, { kind:'local-owner', ref:'A君' });

  assert.equal(first.status, 'accepted');
  assert.equal(duplicate.status, 'existing');
  assert.equal(duplicateWithNewTransportKey.status, 'existing');
  assert.equal(created.length, 1);
  assert.equal(created[0].visualMode, 'auto');
  assert.deepEqual(created[0].context.sourceTaskIds, ['transcript-task', 'visual-evidence-task']);
  assert.equal(created[0].context.parentPaperclipIssueId, 'paperclip-issue-original');
  assert.equal(created[0].context.recoveryFromTaskId, tasks[0].taskId);
  assert.equal(created[0].parentTaskId, tasks[0].taskId);
  assert.equal(created[0].idempotencyKey, `recovery-vision-capability:${tasks[0].taskId}`);
  assert.deepEqual(created[0].recovery, {
    rootTaskId:tasks[0].taskId,
    attempt:1,
    triggeredByTaskId:tasks[0].taskId,
    mode:'vision_capability_restored',
    requestId:input.requestId,
  });
  const stored = await store.getTask(tasks[0].taskId);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.recovery.coordination.status, 'retrying');
  assert.equal(stored.recovery.coordination.retryTaskId, 'vision-retry-child');
  assert.deepEqual(stored.recovery.events.map((event) => event.event), ['requested', 'child_created']);
});

test('余额不足只在失败后的新端到端视觉验证出现后才允许重跑', async () => {
  const tasks = visionFailureTasks();
  tasks[0].status = 'needs_input';
  tasks[0].error = {
    code:'provider_http_402',
    stage:'content_growth_input',
    occurredAt:'2026-08-11T08:00:00.000Z',
  };
  const store = memoryStore(tasks);
  let verifiedAt = '2026-08-11T07:59:00.000Z';
  const created = [];
  const recovery = new TaskRecovery({
    store,
    capabilityStatus:async () => ({ capabilities:[{
      capability:'vision.analyze', configured:true, healthy:true, e2eVerified:true, verifiedAt,
    }] }),
    createTask:async (input) => {
      created.push(input);
      return { taskId:'billing-recovery-child', ...input };
    },
  });

  const waiting = await recovery.request(tasks[0].taskId, {
    actionKey:'retry_visual_analysis_after_recovery',
    requestId:'vision-billing-waiting-0001',
    expectedUpdatedAt:tasks[0].updatedAt,
  }, { kind:'local-owner', ref:'A君' });
  assert.equal(waiting.status, 'waiting_capability');
  assert.equal(waiting.capability.requiresBillingRecovery, true);
  assert.equal(waiting.capability.billingRecoveryVerified, false);
  assert.match(waiting.message, /余额或额度尚未出现/);
  assert.equal(created.length, 0);

  verifiedAt = '2026-08-11T08:01:00.000Z';
  const accepted = await recovery.request(tasks[0].taskId, {
    actionKey:'retry_visual_analysis_after_recovery',
    requestId:'vision-billing-ready-0001',
    expectedUpdatedAt:tasks[0].updatedAt,
  }, { kind:'local-owner', ref:'A君' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(created.length, 1);
});

test('视觉恢复重跑拒绝非本机主人请求，且不查能力、不创建任务', async () => {
  const tasks = visionFailureTasks();
  let capabilityChecks = 0;
  let createCalls = 0;
  const recovery = new TaskRecovery({
    store:memoryStore(tasks),
    capabilityStatus:async () => {
      capabilityChecks += 1;
      return { capabilities:[{ capability:'vision.analyze', configured:true, healthy:true, e2eVerified:true }] };
    },
    createTask:async () => { createCalls += 1; return { taskId:'must-not-be-created' }; },
  });

  await assert.rejects(
    recovery.request(tasks[0].taskId, {
      actionKey:'retry_visual_analysis_after_recovery',
      requestId:'vision-recovery-owner-0001',
      expectedUpdatedAt:tasks[0].updatedAt,
    }, { kind:'lan', ref:'browser' }),
    (error) => error instanceof TaskRecoveryError
      && error.code === 'task_recovery_local_owner_required'
      && error.httpStatus === 403,
  );
  assert.equal(capabilityChecks, 0);
  assert.equal(createCalls, 0);
});

test('非视觉能力失败不提供视觉恢复重跑', () => {
  const tasks = visionFailureTasks();
  tasks[0].status = 'needs_input';
  tasks[0].error = { code:'visual_evidence_required', stage:'content_growth_input', retryable:false };

  assert.equal(
    view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions
      .some((item) => item.actionKey === 'retry_visual_analysis_after_recovery'),
    false,
  );

  tasks[0].status = 'failed';
  tasks[0].error = { code:'provider_http_402', stage:'unknown', retryable:false };
  assert.equal(
    view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions
      .some((item) => item.actionKey === 'retry_visual_analysis_after_recovery'),
    false,
  );

  tasks[0].status = 'needs_input';
  tasks[0].error = { code:'provider_http_402', stage:'content_growth_input', retryable:false };
  assert.equal(
    view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions
      .some((item) => item.actionKey === 'retry_visual_analysis_after_recovery'),
    true,
  );

  tasks[0].recovery = { attempt:1, mode:'vision_capability_restored' };
  assert.equal(
    view(tasks[0], { audience:'local-owner', relatedTasks:tasks }).actions
      .some((item) => item.actionKey === 'retry_visual_analysis_after_recovery'),
    false,
  );
});

test('待验证且保留可读产物的任务提供确认采纳动作，执行后直接标记为已完成', async () => {
  const tasks = [{
    taskId: '33333333-3333-4333-a333-333333333333',
    taskType: 'office.briefing-package',
    status: 'waiting_test',
    updatedAt: '2026-08-17T12:00:00.000Z',
    assigneeAgentId: 'office-assistant',
    execution: { owner: 'paperclip-hermes' },
    governance: { paperclipIssueId: 'paperclip-issue-briefing' },
    input: { title: '小办汇总形成老板可读的本地简报' },
    artifactRefs: [{
      artifactId: 'briefing-package-1',
      type: 'office_briefing_package',
      title: '小办汇总形成老板可读的本地简报 | 办公汇报包',
      validation: { exists: true, readable: true, nonEmpty: true },
    }],
    error: { code: 'paperclip_hermes_requires_review', userMessage: 'Paperclip 已结束本次运行，但本机保留了可读产物；需要人工核对后再决定是否采用。' },
  }];

  const store = memoryStore(tasks);
  const recovery = new TaskRecovery({ store });
  const recoveryView = await recovery.view(tasks[0].taskId, { audience: 'local-owner' });

  assert.deepEqual(recoveryView.actions.map((item) => item.actionKey), ['accept_reviewed_artifact']);
  assert.equal(recoveryView.actions[0].label, '确认采纳');

  const current = await store.getTask(tasks[0].taskId);
  const result = await recovery.request(tasks[0].taskId, {
    actionKey: 'accept_reviewed_artifact',
    requestId: 'accept-req-1',
    expectedUpdatedAt: current.updatedAt,
  }, { kind: 'local-owner', ref: 'A君' });

  assert.equal(result.status, 'accepted');
  assert.equal(result.task.status, 'succeeded');
  assert.equal(result.task.currentStage, 'paperclip_hermes_completed');
  assert.equal(result.task.error, null);

  const updated = await store.getTask(tasks[0].taskId);
  assert.equal(updated.status, 'succeeded');
});


function eligibleTasks() {
  return [
    {
      taskId:'11111111-1111-4111-a111-111111111111',
      taskType:'content.video-benchmark-analysis',
      status:'failed',
      updatedAt:'2026-08-08T08:00:00.000Z',
      assigneeAgentId:'video-content-analyst',
      requester:{ kind:'local-owner', ref:'A君' },
      source:{ channel:'feishu', chatRef:'chat-1' },
      execution:{ owner:'paperclip-hermes' },
      governance:{ paperclipIssueId:'paperclip-issue-original' },
      input:{
        title:'拆解公开视频',
        sourceUrl:'https://example.com/video',
        visualMode:'required',
        context:{ sourceTaskIds:['transcript-task'] },
      },
      error:{ code:'provider_http_402', retryable:false },
    },
    {
      taskId:'transcript-task',
      status:'succeeded',
      artifactRefs:[{
        artifactId:'confirmed-transcript-1',
        type:'confirmed_transcript',
        data:{ confirmationMode:'human' },
        validation:{ exists:true, readable:true, nonEmpty:true },
      }],
    },
  ];
}

function localFailureTasks() {
  return [{
    taskId:'22222222-2222-4222-a222-222222222222',
    taskType:'media.transcribe-and-refine',
    status:'failed',
    updatedAt:'2026-08-08T08:00:00.000Z',
    assigneeAgentId:'xiaod',
    execution:{ owner:'ajun-local' },
    input:{ title:'整理公开视频', sourceUrl:'https://example.com/video' },
    error:{ code:'xiaod_job_failed', retryable:true },
  }];
}

function visionFailureTasks() {
  const tasks = eligibleTasks();
  tasks[0] = {
    ...tasks[0],
    input:{
      ...tasks[0].input,
      visualMode:'auto',
      context:{ sourceTaskIds:['transcript-task', 'visual-evidence-task'] },
    },
    error:{
      code:'controlled_vision_capability_unavailable',
      category:'provider',
      stage:'vision.analyze',
      retryable:false,
    },
  };
  return tasks;
}

function memoryStore(initial) {
  let tasks = structuredClone(initial);
  let revision = 0;
  return {
    async list() { return structuredClone(tasks); },
    async getTask(taskId) { return structuredClone(tasks.find((task) => task.taskId === taskId) || null); },
    async updateTask(taskId, patch) {
      const index = tasks.findIndex((task) => task.taskId === taskId);
      tasks[index] = { ...tasks[index], ...structuredClone(patch), updatedAt:`2026-08-08T08:00:0${++revision}.000Z` };
      return structuredClone(tasks[index]);
    },
  };
}
