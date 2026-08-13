import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hermesAgentFixture,
  paperclipAssignmentGovernanceFixture,
  paperclipGovernanceFixture,
  paperclipIdentityFixture,
  setupTaskService as setup,
  verifiedArtifact,
} from './support/task-service-fixture.js';

test('Paperclip 本机 AI 事件核验任务、身份和岗位能力后只写脱敏白名单', async () => {
  const xiaod = hermesAgentFixture('xiaod', '小D', ['media.transcribe-and-refine'], {
    runtimeCapabilities:{ localAiCapabilities:['audio.transcribe'] },
  });
  const identity = paperclipIdentityFixture('local-ai', 'xiaod', '小D', {
    title:'转录素材', description:'受控转录。',
  });
  const saved = [];
  const taskRunEvents = {
    appendTaskRunEvent(event) {
      saved.push(event);
      return { eventId:`event-${saved.length}`, ...event };
    },
  };
  const { service } = setup({
    agents:[xiaod],
    taskRunEvents,
    governance:paperclipAssignmentGovernanceFixture(identity),
  });
  const verified = await service.getPaperclipAssignment(identity);
  const input = {
    ...identity,
    taskId:verified.task.taskId,
    event:{
      eventType:'capability_call_started', capabilityId:'audio.transcribe',
      provider:'local-whisper', status:'running', startedAt:'2026-08-13T01:00:00.000Z',
      input:{ prompt:'不得落库' }, path:'/private/source.wav',
    },
  };
  const result = await service.recordPaperclipLocalAiRunEvent(input);
  assert.equal(result.recorded, true);
  assert.equal(saved[0].taskId, verified.task.taskId);
  assert.equal(saved[0].agentId, 'xiaod');
  assert.equal(saved[0].routeId, 'local-ai-gateway');
  assert.equal(JSON.stringify(saved[0]).includes('不得落库'), false);
  assert.equal(JSON.stringify(saved[0]).includes('/private/source.wav'), false);
  await assert.rejects(
    service.recordPaperclipLocalAiRunEvent({ ...input, taskId:'task-not-current' }),
    /没有绑定当前真实指派任务/,
  );
  await assert.rejects(
    service.recordPaperclipLocalAiRunEvent({
      ...input,
      event:{ ...input.event, capabilityId:'image.generate' },
    }),
    /没有这项本机 AI 能力/,
  );
  assert.equal(saved.length, 1);
});

test('Paperclip 终态同步明确失败后可重放，failed 与 waiting_test 不会永久卡在两套真相', async (t) => {
  for (const { label, reportedStatus, preciseError } of [
    { label:'failed-precise-error', reportedStatus:'failed', preciseError:true },
    { label:'failed-report-summary', reportedStatus:'failed', preciseError:false },
    { label:'waiting_test', reportedStatus:'waiting_test', preciseError:false },
  ]) {
    await t.test(label, async () => {
      const reviewer = hermesAgentFixture('reviewer', '审核官', ['governance.approval-review']);
      const identity = paperclipIdentityFixture(label, 'reviewer', '审核官', {
        title:'审查任务', description:'只读审查。',
      });
      let issueStatus = 'in_progress';
      let completionAttempts = 0;
      const governance = paperclipGovernanceFixture(identity, {
        async getPaperclipIssue() { return { ...identity.issue, status:issueStatus }; },
        async completePaperclipIssue() {
          completionAttempts += 1;
          if (completionAttempts === 1) throw new Error('definite connection failure');
          issueStatus = 'blocked';
        }
      });
      const { service, records } = setup({ agents:[reviewer], governance });
      await service.create({ title:'审查任务', taskType:'governance.approval-review', agentId:'reviewer' });
      if (preciseError) {
        records.tasks[0].recovery = { attempt:3 };
        records.tasks[0].error = {
          code:'controlled_provider_vision_required',
          message:'当前任务要求受控视觉 Provider，但该能力没有返回可验证结果。',
          userMessage:'当前任务需要受控视觉能力；能力恢复前不会降级为无画面分析。',
          category:'capability',
          stage:'visual_analysis',
          retryable:true,
          occurredAt:'2026-08-08T01:00:00.000Z',
        };
      }
      const input = {
        issueId:identity.issue.id, runId:identity.run.id,
        paperclipAgentId:identity.paperclipAgent.id, agentArmyId:'reviewer',
        status:reportedStatus,
        summary:'本轮未形成可采用结论。',
        evidence:'没有产生可验证的审核结论。',
        remainingRisks:'原样采用可能误判。',
      };

      await assert.rejects(service.completePaperclipAssignment(input), /definite connection failure/);
      assert.equal(records.tasks[0].status, reportedStatus);
      assert.equal(records.tasks[0].governance.completionSync.status, 'pending');
      const report = records.tasks[0].artifactRefs.find((artifact) => artifact.type === 'employee_role_report');
      assert.equal(report.artifactId, `employee-role-report:${identity.issue.id}:${identity.run.id}`);
      assert.equal(report.title, '员工岗位回报');
      assert.ok(Number.isFinite(Date.parse(report.createdAt)));
      assert.equal(report.data.schemaVersion, 'agent.army/employee-role-report/v1');
      assert.equal(report.data.reportedStatus, reportedStatus);
      assert.equal(report.data.attempt, preciseError ? 3 : 1);
      assert.equal(report.data.evidence, '没有产生可验证的审核结论。');
      assert.equal(report.data.remainingRisks, '原样采用可能误判。');
      if (preciseError) {
        assert.deepEqual(records.tasks[0].error, {
          code:'controlled_provider_vision_required',
          message:'当前任务要求受控视觉 Provider，但该能力没有返回可验证结果。',
          userMessage:'当前任务需要受控视觉能力；能力恢复前不会降级为无画面分析。',
          category:'capability',
          stage:'visual_analysis',
          retryable:true,
          occurredAt:'2026-08-08T01:00:00.000Z',
        });
      } else if (reportedStatus === 'failed') {
        assert.equal(records.tasks[0].error.code, 'paperclip_hermes_reported_failure');
        assert.equal(records.tasks[0].error.message, input.summary);
        assert.equal(records.tasks[0].error.userMessage, input.summary);
        assert.doesNotMatch(JSON.stringify(records.tasks[0].error), /员工已如实回报任务失败/);
      }

      const replay = await service.completePaperclipAssignment(input);
      assert.equal(replay.duplicate, true);
      assert.equal(completionAttempts, 2);
      assert.equal(issueStatus, 'blocked');
      assert.equal(replay.task.governance.completionSync.status, 'confirmed');
    });
  }
});

test('Paperclip 终态响应丢失时先读回外部状态，不重复追加完成动作', async () => {
  const reviewer = hermesAgentFixture('reviewer', '审核官', ['governance.approval-review']);
  const identity = paperclipIdentityFixture('response-lost', 'reviewer', '审核官', {
    title:'审查任务', description:'只读审查。',
  });
  let issueStatus = 'in_progress';
  let completionAttempts = 0;
  const governance = paperclipGovernanceFixture(identity, {
    async getPaperclipIssue() { return { ...identity.issue, status:issueStatus }; },
    async completePaperclipIssue() {
      completionAttempts += 1;
      issueStatus = 'blocked';
      throw new Error('response lost after apply');
    }
  });
  const { service, records } = setup({ agents:[reviewer], governance });
  await service.create({ title:'审查任务', taskType:'governance.approval-review', agentId:'reviewer' });
  const input = {
    issueId:identity.issue.id, runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id, agentArmyId:'reviewer',
    status:'waiting_test', summary:'已有局部结果，等待人工验证。'
  };

  await assert.rejects(service.completePaperclipAssignment(input), /response lost after apply/);
  assert.equal(records.tasks[0].governance.completionSync.status, 'pending');
  const replay = await service.completePaperclipAssignment(input);
  assert.equal(replay.task.governance.completionSync.status, 'confirmed');
  assert.equal(completionAttempts, 1);
});

test('同一 Paperclip Run 的并发完成回报单飞，冲突终态不会覆盖已开始的结果', async () => {
  const reviewer = hermesAgentFixture('reviewer', '审核官', ['governance.approval-review']);
  const identity = paperclipIdentityFixture('concurrent-complete', 'reviewer', '审核官', {
    title:'审查任务', description:'只读审查。',
  });
  let releaseCompletion;
  const blocked = new Promise((resolve) => { releaseCompletion = resolve; });
  let completionAttempts = 0;
  const governance = paperclipGovernanceFixture(identity, {
    async completePaperclipIssue() { completionAttempts += 1; await blocked; }
  });
  const { service, records } = setup({ agents:[reviewer], governance });
  await service.create({ title:'审查任务', taskType:'governance.approval-review', agentId:'reviewer' });
  const input = {
    issueId:identity.issue.id, runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id, agentArmyId:'reviewer',
    status:'waiting_test', summary:'已有局部结果，等待人工验证。'
  };

  const first = service.completePaperclipAssignment(input);
  const duplicate = service.completePaperclipAssignment(input);
  await assert.rejects(
    Promise.resolve().then(() => service.completePaperclipAssignment({ ...input, status:'failed' })),
    /正在回报不同的完成结果/
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completionAttempts, 1);
  releaseCompletion();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.equal(one.task.taskId, two.task.taskId);
  assert.equal(records.tasks[0].artifactRefs.filter((item) => item.type === 'employee_role_report').length, 1);
  assert.equal(records.tasks[0].governance.completionSync.status, 'confirmed');
});

test('Paperclip Hermes 不能用文字岗位回报替代小R专用研究产物', async () => {
  const researcher = hermesAgentFixture('intel-researcher', '小R', ['research.intel-report']);
  const identity = paperclipIdentityFixture('intel', 'intel-researcher', '小R', {
    title:'研究 Agent 稳定性', description:'形成有来源的研究报告。',
  });
  const completions = [];
  const governance = paperclipGovernanceFixture(identity, {
    async completePaperclipIssue(issueId) { completions.push(issueId); },
  });
  const { service, records } = setup({ agents:[researcher], governance });
  const task = await service.create({
    title:'研究 Agent 稳定性',
    taskType:'research.intel-report',
    agentId:'intel-researcher',
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'intel-researcher',
    status:'succeeded',
    summary:'研究已经完成。',
  };

  await assert.rejects(
    () => service.completePaperclipAssignment(input),
    /intel_research_report.*文字回报不能替代/,
  );
  assert.equal(records.tasks[0].status, 'running');
  assert.equal(completions.length, 0);

  records.tasks[0].artifactRefs = [verifiedArtifact(task, 'intel_research_report', {
    conclusion:'稳定性依赖完成契约。',
    sources:[{ source:'https://example.com/stability' }],
  })];
  const completed = await service.completePaperclipAssignment(input);
  assert.equal(completed.task.status, 'running');
  assert.equal(completed.task.currentStage, 'delivery_quality_review_pending');
  assert.equal(completed.task.artifactRefs.some((item) => item.type === 'intel_research_report'), true);
  assert.equal(completions.length, 0);
});

test('创建官 heartbeat 真实写入一次岗位草案并保持任务等待最终回报', async () => {
  const creator = hermesAgentFixture('creator', '创建官', ['governance.agent-proposal'], {
    interaction:{ directFeishu:'disabled' },
  });
  const identity = paperclipIdentityFixture('creator', 'creator', '创建官', {
    title:'创建微信聊天取件员', description:'复用本机 yichen skill。',
  });
  const governance = paperclipGovernanceFixture(identity);
  const { service } = setup({ agents:[creator], governance });
  let executions = 0;
  service.executors.creator = {
    async execute(task, { proposalInput }) {
      executions += 1;
      assert.equal(proposalInput.agentId, 'wechat-chat-reader');
      assert.deepEqual(proposalInput.requestedCapabilities, ['wechat.local-vault.chat.read']);
      return {
        status:'succeeded',
        currentStage:'agent_proposal_submitted',
        artifactRefs:[{
          artifactId:'agent-proposal:proposal-wechat',
          taskId:task.taskId,
          type:'agent_proposal',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ proposalId:'proposal-wechat', status:'pending_approval', reviewSubmission:{ status:'submitted' }, nextAction:'needs_capability' }
        }]
      };
    }
  };
  const original = await service.create({
    title:'创建微信聊天取件员',
    taskType:'governance.agent-proposal',
    agentId:'creator'
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'creator',
    requestedOutcome:'按批准范围获取本机微信聊天',
    candidateName:'微信聊天取件员',
    agentId:'wechat-chat-reader',
    department:'信息服务部',
    responsibilities:['按批准范围导出聊天'],
    nonResponsibilities:['不读取密钥'],
    acceptedTaskTypes:['wechat.chat.export'],
    desiredSkills:['yichen-wechat-local-vault'],
    requestedCapabilities:['wechat.local-vault.chat.read'],
    acceptanceTitle:'使用脱敏夹具验证单会话导出'
  };
  const first = await service.executeAgentProposalAssignment(input);
  const duplicate = await service.executeAgentProposalAssignment(input);

  assert.equal(first.task.taskId, original.taskId);
  assert.equal(first.task.status, 'running');
  assert.equal(first.task.currentStage, 'agent_proposal_submitted');
  assert.equal(first.result.proposal.proposalId, 'proposal-wechat');
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
});

test('技术专家 heartbeat 把 A君已验证并带回的修复明确建议为 succeeded', async () => {
  const technicalExpert = hermesAgentFixture('technical-expert', '技术专家', ['operations.technical-repair'], {
    interaction:{ directFeishu:'required' },
  });
  const identity = paperclipIdentityFixture('tech', 'technical-expert', '技术专家', {
    title:'修复受控故障', description:'只修改允许文件。',
  });
  const governance = paperclipGovernanceFixture(identity);
  const { service } = setup({ agents:[technicalExpert], governance });
  let executions = 0;
  service.executors['technical-expert'] = {
    async execute(task) {
      executions += 1;
      assert.equal(task.taskId, 'task-1');
      return {
        status:'running',
        currentStage:'repair_promoted_awaiting_record',
        execution:{
          executor:'technical-expert',
          outcome:'promoted',
          verification:{ testsPassed:true, recoveryVerified:true }
        },
        artifactRefs:[{
          type:'technical_repair_case',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ nextAction:'已安全带回主工程。' }
        }]
      };
    }
  };
  const original = await service.create({
    title:'修复受控故障',
    taskType:'operations.technical-repair',
    agentId:'technical-expert'
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'technical-expert'
  };
  const first = await service.executeTechnicalRepairAssignment(input);
  const duplicate = await service.executeTechnicalRepairAssignment(input);

  assert.equal(first.task.taskId, original.taskId);
  assert.equal(first.task.status, 'running');
  assert.equal(first.result.currentStage, 'repair_promoted_awaiting_record');
  assert.equal(first.result.verified, true);
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
});

test('技术专家 heartbeat 不把外置源码候选误报为当前 release 已修复', async () => {
  const technicalExpert = hermesAgentFixture('technical-expert', '技术专家', ['operations.technical-repair'], {
    interaction:{ directFeishu:'required' },
  });
  const identity = paperclipIdentityFixture('candidate', 'technical-expert', '技术专家', {
    title:'修复候选源码', description:'只修改允许文件。',
  });
  const governance = paperclipGovernanceFixture(identity);
  const { service } = setup({ agents:[technicalExpert], governance });
  service.executors['technical-expert'] = {
    async execute() {
      return {
        status:'waiting_test',
        currentStage:'repair_candidate_awaiting_release',
        execution:{
          executor:'technical-expert',
          outcome:'candidate_promoted',
          verification:{
            testsPassed:true,
            recoveryVerified:true,
            candidateOnly:true,
            runningReleaseUpdated:false,
          },
        },
        artifactRefs:[{
          type:'technical_repair_case',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ nextAction:'生成并验证新的不可变 release。' },
        }],
      };
    },
  };
  await service.create({
    title:'修复候选源码',
    taskType:'operations.technical-repair',
    agentId:'technical-expert',
  });
  const result = await service.executeTechnicalRepairAssignment({
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'technical-expert',
  });
  assert.equal(result.result.status, 'waiting_test');
  assert.equal(result.result.currentStage, 'repair_candidate_awaiting_release');
  assert.equal(result.result.verified, false);
  assert.equal(result.result.recommendedCompletionStatus, 'waiting_test');
});

test('运维官 heartbeat 只执行一次确定性健康检查并复用已验证报告', async () => {
  const operator = hermesAgentFixture('operator', '运维官', ['operations.health-review'], {
    interaction:{ directFeishu:'required' },
  });
  const identity = paperclipIdentityFixture('health', 'operator', '运维官', {
    title:'A君定时本机巡检', description:'只检查登记服务。',
  });
  const governance = paperclipGovernanceFixture(identity);
  const { service } = setup({ agents:[operator], governance });
  let executions = 0;
  service.executors.operator = {
    async execute(task) {
      executions += 1;
      return {
        status:'succeeded',
        currentStage:'health_report_ready',
        execution:{ executor:'operator', mode:'local_health_review', outcome:'healthy' },
        usage:{ tools:[{ id:'deterministic-local-health-probe', calls:2 }] },
        artifactRefs:[{
          artifactId:`health-report:${task.taskId}`,
          taskId:task.taskId,
          type:'health_report',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ overall:'healthy', components:[{ id:'ajun-runtime', status:'healthy' }] }
        }]
      };
    }
  };
  const original = await service.create({
    title:'A君定时本机巡检',
    taskType:'operations.health-review',
    agentId:'operator'
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'operator'
  };
  const first = await service.executeOperationsHealthAssignment(input);
  const duplicate = await service.executeOperationsHealthAssignment(input);

  assert.equal(first.task.taskId, original.taskId);
  assert.equal(first.result.verified, true);
  assert.equal(first.result.healthStatus, 'healthy');
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
});

test('后台员工任务在同一次工具调用内等待终态，避免反复唤醒模型轮询', async () => {
  const xiaod = hermesAgentFixture('xiaod', '小D', ['media.transcribe-and-refine'], {
    interaction:{ directFeishu:'required' },
  });
  const identity = paperclipIdentityFixture('server-wait', 'xiaod', '小D', {
    title:'整理公开视频', description:'等待后台处理。',
  });
  const governance = paperclipAssignmentGovernanceFixture(identity);
  const { service } = setup({ agents:[xiaod], governance, employeeAssignmentWaitMs:80 });
  service.executors.xiaod = {
    async execute() {
      return { status:'running', currentStage:'transcription_running', artifactRefs:[] };
    },
    observe(task) {
      setTimeout(() => {
        void service.store.updateTask(task.taskId, {
          status:'succeeded',
          currentStage:'transcript_ready',
          artifactRefs:[verifiedArtifact(task, 'transcript')],
          execution:{
            ...(task.execution || {}),
            paperclipEmployee:{
              ...(task.execution?.paperclipEmployee || {}),
              state:'settled',
              status:'succeeded',
              verified:true,
              recommendedCompletionStatus:'succeeded',
            },
          },
        });
      }, 5);
    },
  };

  const result = await service.executeEmployeeAssignment({
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'xiaod',
  });

  assert.equal(result.result.status, 'succeeded');
  assert.equal(result.result.continuePolling, undefined);
  assert.equal(result.result.verified, true);
});

test('小拆 heartbeat 通过受控执行桥写回真实分析产物且重复调用幂等', async () => {
  const { service, records, identity } = setupContentGrowthAssignment('content', '正式拆解');
  let executions = 0;
  service.executors['video-content-analyst'] = {
    async execute(task) {
      executions += 1;
      return {
        status:'succeeded',
        currentStage:'fast_analysis_ready',
        usage:{
          model:{ provider:'openai-codex', model:'gpt-5.6-terra', inputTokens:120, outputTokens:30, apiCalls:1, cost:{ amount:0, currency:'USD' } },
          tools:[{ id:'fast-analysis-write', name:'正式拆解', calls:1 }]
        },
        artifactRefs:[{
          artifactId:`video-analysis:${task.taskId}`,
          taskId:task.taskId,
          type:'video_content_analysis_report',
          title:'正式拆解',
          validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:true },
          data:{ evidenceMode:'formal', modules:[{ name:'开场钩子' }] }
        }]
      };
    }
  };
  await service.create({
    title:'正式拆解',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    evidenceMode:'formal',
    depth:'full'
  });
  const input = { issueId:identity.issue.id, runId:identity.run.id, paperclipAgentId:identity.paperclipAgent.id, agentArmyId:identity.agentArmyId };
  const first = await service.executeContentGrowthAssignment(input);
  const duplicate = await service.executeContentGrowthAssignment(input);
  assert.equal(first.result.verified, true);
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
  const persisted = records.tasks.find((task) => task.taskId === first.task.taskId);
  assert.equal(persisted.usage.model.status, 'reported');
  assert.equal(persisted.usage.model.apiCalls, 1);
  assert.deepEqual(persisted.usage.cost, {
    status:'reported',
    amount:0,
    currency:'USD',
    basis:'task_usage_reported',
  });
});

test('v2 视频分析缺少模式结构证明时不能被 heartbeat 标成成功', async () => {
  const { service, records, identity } = setupContentGrowthAssignment('v2-unverified', '精华提炼');
  service.executors['video-content-analyst'] = {
    async execute(task) {
      return {
        status:'succeeded',
        currentStage:'digest_analysis_ready',
        artifactRefs:[{
          artifactId:`video-analysis:${task.taskId}`,
          taskId:task.taskId,
          type:'video_content_analysis_report',
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            analysisIntent:'digest',
            reportVersion:'video-analysis/v2'
          },
          data:{ analysisIntent:'digest', reportVersion:'video-analysis/v2', modules:[{ name:'定位与受众' }] }
        }]
      };
    }
  };
  await service.create({
    title:'精华提炼',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    analysisIntent:'digest',
    evidenceMode:'formal'
  });
  const result = await service.executeContentGrowthAssignment({
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:identity.agentArmyId
  });
  assert.equal(result.result.verified, false);
  assert.equal(result.result.recommendedCompletionStatus, 'waiting_test');
  const persisted = records.tasks.find((task) => task.taskId === result.task.taskId);
  assert.equal(persisted.execution.contentGrowth.verified, false);
  assert.equal(persisted.execution.contentGrowth.recommendedCompletionStatus, 'waiting_test');
});

test('长视频拆解按 240 秒以内分段等待并复用同一个后台执行', async () => {
  const { service, records, identity } = setupContentGrowthAssignment(
    'async-content',
    '长视频正式拆解',
    { contentGrowthWaitMs:5 },
  );
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  service.executors['video-content-analyst'] = {
    async execute(task) {
      executions += 1;
      await gate;
      return {
        status:'succeeded',
        currentStage:'full_analysis_ready',
        artifactRefs:[{
          artifactId:`video-analysis:${task.taskId}`,
          taskId:task.taskId,
          type:'video_content_analysis_report',
          title:'长视频正式拆解',
          validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:true },
          data:{ evidenceMode:'formal', generationMode:'hermes_advisor', modules:[{ name:'基本信息' }] }
        }]
      };
    }
  };
  await service.create({
    title:'长视频正式拆解',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    evidenceMode:'formal',
    depth:'full'
  });
  const input = { issueId:identity.issue.id, runId:identity.run.id, paperclipAgentId:identity.paperclipAgent.id, agentArmyId:identity.agentArmyId };
  const first = await service.executeContentGrowthAssignment(input);
  assert.equal(first.result.status, 'running');
  assert.equal(first.result.continuePolling, true);
  assert.equal(first.result.recommendedCompletionStatus, 'running');
  assert.equal(executions, 1);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await service.executeContentGrowthAssignment(input);
  assert.equal(second.result.verified, true);
  assert.equal(second.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(executions, 1);
  const persisted = records.tasks.find((task) => task.taskId === second.task.taskId);
  assert.equal(persisted.artifactRefs.length, 1);
  assert.equal(persisted.execution.contentGrowth.state, 'settled');
});

test('正式完整拆解的语义兜底不能冒充成功，迟到产物不能覆盖 Hermes 终态', async () => {
  const { service, records, identity } = setupContentGrowthAssignment('late-content', '正式拆解');
  service.executors['video-content-analyst'] = {
    async execute(task) {
      const live = records.tasks.find((item) => item.taskId === task.taskId);
      live.status = 'failed';
      live.currentStage = 'paperclip_hermes_failed';
      live.error = { code:'paperclip_hermes_reported_failure', message:'Hermes 已超时。' };
      return {
        status:'succeeded',
        currentStage:'full_analysis_ready',
        artifactRefs:[{
          artifactId:`video-analysis:${task.taskId}`,
          taskId:task.taskId,
          type:'video_content_analysis_report',
          title:'兜底拆解',
          validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:false },
          data:{ evidenceMode:'formal', generationMode:'deterministic_fallback', modules:[{ name:'基本信息' }] }
        }]
      };
    }
  };
  await service.create({
    title:'正式拆解',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    evidenceMode:'formal',
    depth:'full'
  });
  const input = { issueId:identity.issue.id, runId:identity.run.id, paperclipAgentId:identity.paperclipAgent.id, agentArmyId:identity.agentArmyId };
  const result = await service.executeContentGrowthAssignment(input);
  const persisted = records.tasks.find((task) => task.taskId === result.task.taskId);

  assert.equal(result.result.verified, false);
  assert.equal(result.result.recommendedCompletionStatus, 'waiting_test');
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.error.code, 'paperclip_hermes_reported_failure');
  assert.equal(persisted.artifactRefs[0].validation.semanticValidationPassed, false);
});

function setupContentGrowthAssignment(slug, title, options = {}) {
  const analyst = hermesAgentFixture(
    'video-content-analyst',
    '小拆',
    ['content.video-benchmark-analysis'],
    { interaction:{ directFeishu:'disabled' } },
  );
  const identity = paperclipIdentityFixture(slug, 'video-content-analyst', '小拆', {
    title,
    description:'引用确认稿。',
  });
  return {
    ...setup({ agents:[analyst], governance:paperclipGovernanceFixture(identity), ...options }),
    identity,
  };
}

function m5VisualArtifactFixture(projectId, overrides = {}) {
  const actionId = '12345678-abcd-4abc-8abc-1234567890ab:vision:aaaaaaaaaaaaaaaa';
  const receipt = {
    actionId,
    operation:'vision',
    model:'step-1o-turbo-vision',
    sourcePath:'campaigns/assets/frame-001.png',
    sourceChecksum:`sha256:${'a'.repeat(64)}`,
    observationChecksum:`sha256:${'b'.repeat(64)}`,
    callRecord:{
      actionId,
      operation:'vision',
      model:'step-1o-turbo-vision',
      promptChecksum:`sha256:${'c'.repeat(64)}`,
      costEvent:{ provider:'stepfun', projectId },
    },
    costCommit:{
      status:'confirmed',
      costEventId:'33333333-3333-4333-8333-333333333333',
      costEvent:{ provider:'stepfun', projectId, costCents:1 },
    },
  };
  const receiptOverride = overrides.providerReceipt || {};
  const providerReceipt = {
    ...receipt,
    ...receiptOverride,
    callRecord:{
      ...receipt.callRecord,
      ...(receiptOverride.callRecord || {}),
    },
    costCommit:{
      ...receipt.costCommit,
      ...(receiptOverride.costCommit || {}),
      costEvent:{
        ...receipt.costCommit.costEvent,
        ...(receiptOverride.costCommit?.costEvent || {}),
      },
    },
  };
  return {
    artifactId:'visual-analysis:test',
    type:'visual_analysis_package',
    title:'M5 画面分析包',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      schemaVersion:'agent.army/visual-analysis-package/v1',
      providerReceipt,
      insights:[{
        finding:'状态卡位于画面中央。',
        frameRef:'frame-001',
        timestamp:'00:00:03',
        evidenceKind:'stepfun_vision_frame',
      }],
    },
    ...overrides,
    data:overrides.data || {
      schemaVersion:'agent.army/visual-analysis-package/v1',
      providerReceipt,
      insights:[{
        finding:'状态卡位于画面中央。',
        frameRef:'frame-001',
        timestamp:'00:00:03',
        evidenceKind:'stepfun_vision_frame',
      }],
    },
  };
}

async function m5VisualCompletionFixture({ projectId, artifact }) {
  const caseId = '12345678-abcd-4abc-8abc-1234567890ab';
  const outputs = [];
  const completions = [];
  const identity = paperclipIdentityFixture('m5-visual', 'video-content-analyst', '小拆', {
    title:'M5 / 画面分析',
    description:`[agent-army:m5:routine:m5-visual-analysis] 处理画面分析阶段；当前 Case 为 ${caseId}，版本为 1。`,
    projectId,
  });
  const governance = paperclipAssignmentGovernanceFixture(identity, {
    async getPipelineCase() {
      return {
        id:caseId,
        projectId,
        stageKey:'visual_analysis',
        fields:{ theme:'AI Agent 实战', scheduledDate:'2026-07-31' },
      };
    },
    async getPipelineCaseOutputs() { return outputs; },
    async createIssueWorkProduct(_issueId, product) {
      outputs.push({ kind:'work_product', ...product });
      return product;
    },
    async completePaperclipIssue(issueId, input) {
      completions.push({ issueId, input });
    },
  });
  const agent = hermesAgentFixture(
    'video-content-analyst',
    '小拆',
    ['content.campaign-visual-analysis'],
    { interaction:{ directFeishu:'background' } },
  );
  const fixture = setup({ agents:[agent], governance });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:identity.agentArmyId,
  };
  const assigned = await fixture.service.getPaperclipAssignment(input);
  assigned.task.artifactRefs = [artifact];
  return {
    ...fixture,
    input,
    outputs,
    completions,
  };
}
