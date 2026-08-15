import assert from 'node:assert/strict';
import test from 'node:test';
import { ValidationError } from '../src/task-service.ts';
import {
  coordinator,
  setupTaskService,
  verifiedArtifact,
  verifiedHealthReport,
} from './support/task-service-fixture.js';

test('TaskIntake 规范化分析模式并保持兼容深度', async () => {
  const analyst = { agentId:'video-content-analyst', status:'active', acceptedTaskTypes:['content.video-benchmark-analysis'] };
  const { service } = setupTaskService({ agents:[analyst] });
  const task = await service.create({ title:'快速总结这个视频', taskType:'content.video-benchmark-analysis', agentId:'video-content-analyst', analysisIntent:'template', depth:'fast' });
  assert.equal(task.input.analysisIntent, 'template');
  assert.equal(task.input.depth, 'full');
});

test('TaskIntake 将军团路由任务统一登记到 A君', async () => {
  const { service } = setupTaskService({ agents:[coordinator] });
  const task = await service.create({ title:'安排一次任务', taskType:'army.route-task' });
  assert.equal(task.assigneeAgentId, 'ajun');
  assert.equal(task.status, 'queued');
});

test('TaskIntake 保留小D显式账号绑定并拒绝非法连接标识', async () => {
  const xiaod = { agentId:'xiaod', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const { service } = setupTaskService({ agents:[xiaod] });
  const connectionId = '123e4567-e89b-42d3-a456-426614174000';
  const task = await service.create({ title:'整理小红书素材', taskType:'media.transcribe-and-refine', agentId:'xiaod', sourceUrl:'https://www.xiaohongshu.com/explore/example', connectionId });
  assert.equal(task.input.connectionId, connectionId);
  await assert.rejects(() => service.create({ title:'非法连接', taskType:'media.transcribe-and-refine', agentId:'xiaod', connectionId:'../wrong' }), ValidationError);
});

test('TaskIntake 不因标题内容改写多人总任务类型', async () => {
  const ajun = { agentId:'ajun', status:'active', acceptedTaskTypes:['army.cross-agent-mission'] };
  const { service } = setupTaskService({ agents:[ajun] });
  service.executors.ajun = { async execute(task) {
    assert.equal(task.taskType, 'army.cross-agent-mission');
    return { status:'running', currentStage:'mission_planned', artifactRefs:[] };
  } };
  const task = await service.create({ title:'整理公开视频、核对资料并生成老板汇报', taskType:'army.cross-agent-mission', agentId:'ajun' });
  assert.equal(task.taskType, 'army.cross-agent-mission');
  assert.equal(task.status, 'running');
});

test('TaskIntake 保留小R受限执行所需公开输入', async () => {
  const intel = { agentId:'intel-researcher', status:'active', acceptedTaskTypes:['research.github-search', 'research.intel-report'] };
  const { service } = setupTaskService({ agents:[intel] });
  const githubTask = await service.create({ title:'读公开仓库', taskType:'research.github-search', agentId:'intel-researcher', repo:'openai/example', path:'README' });
  assert.deepEqual({ repo:githubTask.input.repo, path:githubTask.input.path }, { repo:'openai/example', path:'README' });
  const searchTask = await service.create({ title:'搜索并比较 3 个 GitHub 开源多智能体编排项目', taskType:'research.github-search', agentId:'intel-researcher' });
  assert.equal(searchTask.input.query, 'multi-agent');
  const reportTask = await service.create({ title:'研究主题', taskType:'research.intel-report', agentId:'intel-researcher', topic:'Agent 运行时', sourceUrls:['https://example.com/a'] });
  assert.equal(reportTask.input.topic, 'Agent 运行时');
  assert.deepEqual(reportTask.input.sourceUrls, ['https://example.com/a']);
});

test('TaskIntake 保留小办 PPT 受控创作字段且本地敏感材料不误触审批', async () => {
  const office = { agentId:'office-assistant', status:'draft', acceptedTaskTypes:['office.presentation-package'] };
  const { service, records } = setupTaskService({ agents:[office] });
  const task = await service.create({ title:'公开固定样例', purpose:'验证本地演示文稿交付链', audience:'负责人', taskType:'office.presentation-package', slideCount:2, designMode:'design_system', outline:[{ title:'结论', bullets:['本地导出'] }], outputs:['pptd', 'pptx'], dataClassification:'sensitive', externalProcessingApproved:false });
  assert.equal(task.input.purpose, '验证本地演示文稿交付链');
  assert.equal(task.input.slideCount, 2);
  assert.deepEqual(task.input.outputs, ['pptd', 'pptx']);
  assert.equal(task.input.externalProcessingApproved, false);
  assert.equal(records.approvals.length, 0);
});

test('TaskIntake 从中文自然语言提取公开链接时不吞标点', async () => {
  const intel = { agentId:'intel-researcher', status:'draft', acceptedTaskTypes:['research.intel-report'] };
  const { service } = setupTaskService({ agents:[intel] });
  const task = await service.create({ title:'请研究 http://info.cern.ch/hypertext/WWW/TheProject.html，给我中文背景。', taskType:'research.intel-report', agentId:'intel-researcher' });
  assert.equal(task.input.sourceUrl, 'http://info.cern.ch/hypertext/WWW/TheProject.html');
});

test('TaskIntake 在多岗位匹配时要求明确路由', async () => {
  const { service } = setupTaskService({ agents:[coordinator, { ...coordinator, agentId:'backup' }] });
  const task = await service.create({ title:'安排一次任务', taskType:'army.route-task' });
  assert.equal(task.assigneeAgentId, null);
  assert.equal(task.currentStage, 'routing_needed');
});

test('TaskIntake 将公开素材任务路由给已启用小D', async () => {
  const xiaod = { agentId:'xiaod', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const { service } = setupTaskService({ agents:[xiaod] });
  const task = await service.create({ title:'整理公开视频', taskType:'media.transcribe-and-refine', sourceUrl:'https://example.com/demo.mp4' });
  assert.equal(task.assigneeAgentId, 'xiaod');
  assert.equal(task.status, 'queued');
});

test('TaskIntake 高风险描述创建待审批记录', async () => {
  const { service, records } = setupTaskService({ agents:[coordinator] });
  const task = await service.create({ title:'向外发布周报', taskType:'army.route-task' });
  assert.equal(records.approvals.length, 1);
  assert.equal(task.status, 'waiting_approval');
});

test('TaskIntake 识别并列安全约束中明确否定的高风险动作', async () => {
  const operator = { agentId:'operator', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service, records } = setupTaskService({ agents:[operator] });
  service.executors.operator = { async execute(task) { return { status:'succeeded', artifactRefs:[verifiedHealthReport(task)] }; } };
  const task = await service.create({ title:'军团健康检查', description:'只读健康检查，仅观察公共能力状态并返回结果，不涉及登录、外发、配置修改或执行恢复动作。', taskType:'operations.health-review' });
  assert.equal(records.approvals.length, 0);
  assert.equal(task.status, 'succeeded');
});

test('TaskIntake 识别“不外发或发布”的并列否定', async () => {
  const operator = { agentId:'operator', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service, records } = setupTaskService({ agents:[operator] });
  service.executors.operator = { async execute(task) { return { status:'succeeded', artifactRefs:[verifiedHealthReport(task)] }; } };
  const task = await service.create({ title:'军团只读健康检查', description:'只生成可核验健康报告；不重启服务、不修改配置、不外发或发布。', taskType:'operations.health-review' });
  assert.equal(records.approvals.length, 0);
  assert.equal(task.status, 'succeeded');
});

test('受信任只读诊断不再二次审批且不唤醒 Paperclip Hermes', async () => {
  const operator = {
    agentId:'operator',
    status:'active',
    acceptedTaskTypes:['operations.failure-recovery'],
    executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile' },
  };
  let localExecutions = 0;
  const { service, records } = setupTaskService({ agents:[operator] });
  service.executors.operator = { async execute(task) {
    localExecutions += 1;
    return {
      status:'succeeded',
      currentStage:'recovery_decision_ready',
      artifactRefs:[verifiedArtifact(task, 'recovery_decision', {
        diagnosis:{
          conclusion:'Paperclip 执行链结束，但没有形成可验证产物。',
          evidence:'故障代码 paperclip_hermes_failed；阶段 paperclip_hermes。',
          impact:'原任务仍未完成，已有记录保持不变。',
          nextAction:'检查 Paperclip 执行记录，再决定是否修复或重跑。',
        },
      })],
    };
  } };

  const task = await service.create({
    title:'只读诊断：检查系统状态',
    description:'只读分类原任务失败和缺失证据，输出恢复建议。禁止重跑原任务、修改代码、扩大权限或调用外部发布动作。',
    taskType:'operations.failure-recovery',
    agentId:'operator',
    requester:{ kind:'local-owner', ref:'A君' },
    source:{ channel:'internal-recovery' },
    parentTaskId:'failed-parent',
    context:{
      parentPaperclipIssueId:'paperclip-issue-original',
      failedTaskId:'failed-parent',
      diagnosisOnly:true,
      prohibitedActions:['retry', 'code_write', 'permission_expansion', 'external_publish'],
    },
    recovery:{ mode:'read_only_diagnosis' },
  });

  assert.equal(records.approvals.length, 0);
  assert.equal(localExecutions, 1);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.currentStage, 'recovery_decision_ready');
});

test('TaskIntake 明确不外发的只读任务不触发审批', async () => {
  const reporter = { agentId:'public-reporter', status:'active', acceptedTaskTypes:['report.public-material'], runtime:{ kind:'proposal-public-report' } };
  const { service, records } = setupTaskService({ agents:[reporter] });
  service.fallbackExecutor = { supports() { return true; }, async execute(task) { return { status:'succeeded', artifactRefs:[verifiedArtifact(task, 'public_web_report', { summary:'公开网页摘要' })] }; } };
  const task = await service.create({ title:'整理公开网页', description:'只读公开页面，不外发、不发布、不付费。', taskType:'report.public-material', sourceUrl:'https://example.com' });
  assert.equal(records.approvals.length, 0);
  assert.equal(task.status, 'succeeded');
});

test('TaskIntake 草稿或知识笔记不因描述中的发布词误触审批', async () => {
  const office = { agentId:'office-assistant', status:'active', acceptedTaskTypes:['office.knowledge-summary'] };
  const { service } = setupTaskService({ agents:[office] });
  service.executors['office-assistant'] = { async execute(task) { return { status:'succeeded', artifactRefs:[verifiedArtifact(task, 'knowledge_summary_note')] }; } };
  const task = await service.create({ title:'归档草稿闭环', description:'记录人工发布前检查和未外发边界，只写知识笔记。', taskType:'office.knowledge-summary', agentId:'office-assistant' });
  assert.equal(task.status, 'succeeded');
  assert.equal(task.approvalRefs.length, 0);
});

test('TaskIntake 微信聊天任务采用默认范围且只建一次隐私确认', async () => {
  const wechat = { agentId:'wechat-chat-retriever', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'] };
  const { service, records } = setupTaskService({ agents:[wechat] });
  let executed = 0;
  service.executors['wechat-chat-retriever'] = { async execute(task) {
    executed += 1;
    assert.equal(task.input.wechatChat.chatSelector, 'yingz');
    assert.equal(task.input.wechatChat.privateContentModelAccess, 'local-only');
    return { status:'succeeded', artifactRefs:[verifiedArtifact(task, 'wechat_chat_analysis_report')] };
  } };
  const task = await service.create({ title:'获取微信聊天', description:'群名：yingz', taskType:'wechat.chat.retrieval' });
  assert.equal(task.status, 'waiting_approval');
  assert.equal(records.approvals.length, 1);
  assert.equal(executed, 0);
  const completed = await service.approveApproval(records.approvals[0].approvalId);
  assert.equal(completed.status, 'succeeded');
  assert.equal(executed, 1);
});

test('TaskIntake 微信聊天缺群名时只要求补该输入', async () => {
  const wechat = { agentId:'wechat-chat-retriever', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'] };
  const { service, records } = setupTaskService({ agents:[wechat] });
  const task = await service.create({ title:'获取微信聊天', taskType:'wechat.chat.retrieval' });
  assert.equal(task.status, 'needs_input');
  assert.equal(task.error.code, 'wechat_chat_required');
  assert.equal(records.approvals.length, 0);
});
