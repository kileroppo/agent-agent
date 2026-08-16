import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskPresentation, presentTask, shortTaskRef, taskDetailBaseUrl } from '../src/task-presentation.ts';

const task = {
  taskId:'7df3c85a-1111-2222-3333-444444444444',
  status:'needs_input',
  currentStage:'waiting_for_source',
  input:{ title:'整理员工资料' },
  approvalRefs:[],
  error:{ code:'source_missing', userMessage:'请补充员工名单。' }
};

test('任务展示统一输出中文短编号、下一步和无凭据详情链接', () => {
  const presentation = presentTask(task, { detailBaseUrl:'http://127.0.0.1:4321/?token=secret#x' });
  assert.equal(presentation.taskRef, '#7DF3C85A');
  assert.equal(presentation.statusLabel, '等待补充');
  assert.equal(presentation.nextAction, '请补充员工名单。');
  assert.equal(presentation.detailUrl, 'http://127.0.0.1:4321/tasks/7df3c85a-1111-2222-3333-444444444444');
  assert.equal(presentation.technical.errorCode, 'source_missing');
});

test('带账号信息的详情地址会被拒绝，不把凭据放进任务链接', () => {
  assert.equal(taskDetailBaseUrl('https://name:password@example.com/'), '');
  assert.equal(presentTask(task, { detailBaseUrl:'https://name:password@example.com/' }).detailUrl, null);
});

test('模型看到的是中文任务摘要而不是原始英文状态 JSON', () => {
  const value = { presentation:presentTask(task, { detailBaseUrl:'http://127.0.0.1:4321' }) };
  const text = formatTaskPresentation(value);
  assert.match(text, /等待补充 · 整理员工资料/);
  assert.match(text, /任务 #7DF3C85A/);
  assert.match(text, /下一步：请补充员工名单/);
  assert.doesNotMatch(text, /needs_input|waiting_for_source|source_missing/);
});

test('短编号只用于展示，完整编号仍保留在技术详情中', () => {
  assert.equal(shortTaskRef(task.taskId), '#7DF3C85A');
  assert.equal(presentTask(task).technical.taskId, task.taskId);
});

test('批准后未启动的多人任务明确说明原因并给唯一继续动作', () => {
  const presentation = presentTask({
    taskId:'86eea524-eb4a-426c-bcc6-ff6aa9ce5155',
    taskType:'army.cross-agent-mission',
    status:'queued',
    currentStage:'approval_approved',
    input:{ title:'爆款候选拆解｜晕肉了' },
    artifactRefs:[],
  }, { recoveryView:{ actions:[{
    actionKey:'resume_approved_mission',
    label:'继续处理',
    emphasis:'primary',
    confirmation:'只执行已确认范围，不自动发布。',
  }] } });

  assert.equal(presentation.statusLabel, '需要继续');
  assert.equal(presentation.attention.kind, 'approved_not_started');
  assert.equal(presentation.attention.headline, '已批准，但没有开始');
  assert.match(presentation.attention.cause, /执行器没有接手/);
  assert.match(presentation.attention.impact, /没有生成素材或拆解报告/);
  assert.match(presentation.attention.nextAction, /不会重复审批，也不会自动发布/);
  assert.deepEqual(presentation.attention.actions.map((item) => item.label), ['继续处理']);
});

test('视频分析结果展示当前模式和唯一的人工下一步', () => {
  const presentation = presentTask({
    taskId:'video-analysis-1',
    taskType:'content.video-benchmark-analysis',
    status:'succeeded',
    currentStage:'analysis_ready',
    input:{ title:'分析这个视频', analysisIntent:'template' },
    artifactRefs:[{
      type:'video_content_analysis_report',
      data:{
        analysisIntent:'template',
        reportVersion:'video-analysis/v2',
        nextAction:{ label:'用这个结构写我的主题', requiresExplicitUserChoice:true }
      }
    }]
  });

  assert.match(presentation.summary, /模板学习报告已完成/);
  assert.equal(presentation.nextAction, '用这个结构写我的主题');
  assert.equal(presentation.technical.analysisIntent, 'template');
  assert.equal(presentation.technical.reportVersion, 'video-analysis/v2');
});

test('失败展示选择当前 Paperclip Run 的岗位回报并过滤旧套话', () => {
  const recoveryView = {
    actions:[
      { actionId:'legacy-invalid', label:'没有 actionKey 的动作必须丢弃' },
      { actionKey:'retry', label:'重新尝试', emphasis:'primary', confirmation:'确认依赖已恢复。', internal:'不能透传' },
      { actionKey:'diagnose', label:'查看诊断', emphasis:'secondary', confirmation:'只读检查。' },
      { actionKey:'dismiss', label:'暂不处理', emphasis:'secondary', confirmation:'保留现状。' },
      { actionKey:'overflow', label:'不应进入契约', emphasis:'secondary', confirmation:'不应进入。' },
    ],
    verification:{ state:'pending', taskId:'verify-1', detailPath:'/tasks/verify-1', internal:'不能透传' },
  };
  const presentation = presentTask({
    taskId:'failure-report-1',
    status:'failed',
    currentStage:'paperclip_hermes_failed',
    input:{ title:'审查供应商结果' },
    governance:{ completionSync:{ runId:'run-current' } },
    execution:{ finishedAt:'2026-08-08T02:00:00.000Z' },
    artifactRefs:[
      { type:'employee_role_report', data:{ paperclipRunId:'run-old', summary:'旧运行失败。', remainingRisks:'旧风险。' } },
      { type:'employee_role_report', data:{ paperclipRunId:'run-current', summary:'供应商额度不足，本轮没有形成结果。', evidence:'调用 https://provider.example/result?token=secret 在产物生成前停止，token=raw-secret。', remainingRisks:'额度恢复前原样重试仍会失败。' } },
    ],
    error:{
      code:'paperclip_hermes_reported_failure',
      userMessage:'员工已如实回报任务失败，请查看结果摘要和剩余风险。',
      category:'manual',
      stage:'paperclip_hermes',
      retryable:false,
      occurredAt:'2026-08-08T02:00:00.000Z',
    },
  }, { recoveryView });

  assert.equal(presentation.attention.schemaVersion, 'agent.army/task-attention-presentation/v1');
  assert.equal(presentation.attention.kind, 'failed');
  assert.equal(presentation.attention.headline, '本轮未完成');
  assert.equal(presentation.attention.cause, '供应商额度不足，本轮没有形成结果。');
  assert.equal(Object.hasOwn(presentation.attention, 'summary'), false);
  assert.match(presentation.attention.evidence, /\[链接已脱敏\]/);
  assert.match(presentation.attention.evidence, /\[已脱敏\]/);
  assert.doesNotMatch(presentation.attention.evidence, /provider\.example|raw-secret/);
  assert.equal(presentation.attention.remainingRisks, '额度恢复前原样重试仍会失败。');
  assert.equal(presentation.attention.nextAction, '当前不应原样重试；请根据失败原因补充信息或调整范围。');
  assert.deepEqual(presentation.attention.actions, [
    { actionKey:'retry', label:'重新尝试', emphasis:'primary', confirmation:'确认依赖已恢复。' },
    { actionKey:'diagnose', label:'查看诊断', emphasis:'secondary', confirmation:'只读检查。' },
    { actionKey:'dismiss', label:'暂不处理', emphasis:'secondary', confirmation:'保留现状。' },
  ]);
  assert.deepEqual(presentation.attention.verification, {
    state:'pending',
    taskId:'verify-1',
    detailPath:'/tasks/verify-1',
  });
  assert.deepEqual(Object.keys(presentation.attention.technical).sort(), ['code', 'occurredAt', 'retryable', 'stage']);
  assert.match(presentation.summary, /供应商额度不足/);
  assert.doesNotMatch(presentation.nextAction, /员工已如实回报/);
});

test('当前 Run 没有匹配报告时倒序兼容最后一份有摘要的旧报告', () => {
  const presentation = presentTask({
    taskId:'legacy-run-fallback',
    status:'failed',
    input:{ title:'历史失败' },
    governance:{ completionSync:{ runId:'run-current' } },
    artifactRefs:[
      { type:'employee_role_report', data:{ paperclipRunId:'run-old-1', summary:'较早原因。' } },
      { type:'employee_role_report', data:{ paperclipRunId:'run-old-2' } },
      { type:'employee_role_report', data:{ paperclipRunId:'run-old-3', summary:'最后一份可用原因。' } },
    ],
    error:{ code:'legacy_failure', retryable:false },
  });

  assert.equal(presentation.attention.cause, '最后一份可用原因。');
});

test('旧失败任务没有岗位报告时保留精确安全错误并输出空恢复视图', () => {
  const presentation = presentTask({
    taskId:'legacy-failure-1',
    status:'failed',
    currentStage:'execution_failed',
    input:{ title:'旧任务' },
    updatedAt:'2026-08-08T03:00:00.000Z',
    error:{
      code:'executor_failed',
      userMessage:'本地任务未能完成，请检查输入文件。',
      category:'manual',
      stage:'execution',
      retryable:true,
    },
  });

  assert.equal(presentation.attention.cause, '本地任务未能完成，请检查输入文件。');
  assert.equal(presentation.attention.evidence, null);
  assert.equal(presentation.attention.remainingRisks, null);
  assert.deepEqual(presentation.attention.actions, []);
  assert.equal(presentation.attention.verification, null);
  assert.equal(presentation.attention.technical.code, 'executor_failed');
  assert.equal(presentation.attention.technical.retryable, true);
});

test('待处理状态统一映射为稳定 attention kind', () => {
  for (const [status, kind] of [
    ['needs_input', 'needs_input'],
    ['waiting_test', 'waiting_test'],
    ['pending_approval', 'waiting_approval'],
    ['waiting_approval', 'waiting_approval'],
    ['paused', 'paused'],
  ]) {
    const presentation = presentTask({
      taskId:`attention-${status}`,
      status,
      input:{ title:'待处理任务' },
      error:{ userMessage:'请查看并处理。' },
    });
    assert.equal(presentation.attention.kind, kind);
    assert.ok(presentation.attention.cause);
    assert.ok(presentation.attention.impact);
  }
});
