import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesIntentPlanner } from '../src/hermes-intent-planner.js';

test('AI理解器只接受预先允许的任务类别', async () => {
  const planner = new HermesIntentPlanner({ hermesHome: '/safe/profile', run: async () => '{"intent":"army_overview"}' });
  assert.deepEqual(await planner.decide('大家都在干嘛？'), { intent: 'army_overview' });
});

test('AI理解器把身份介绍识别为聊天，不归成待办工作', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/safe/profile', run:async () => '{"intent":"identity"}' });
  assert.deepEqual(await planner.decide('你是谁？'), { intent:'identity' });
});

test('独立员工入口使用自己的 Hermes Profile，不借用 A君 Profile', async () => {
  let captured = null;
  const planner = new HermesIntentPlanner({ hermesHome:'/profiles/ajun', profileRoot:'/profiles', run:async (_command, _args, options) => { captured = options; return '{"intent":"health_check"}'; } });
  assert.deepEqual(await planner.decide('检查运行情况', { agentId:'operator' }), { intent:'health_check' });
  assert.equal(captured.env.HERMES_HOME, '/profiles/operator');
});

test('AI理解器可以把日报类问法归为军团工作汇报', async () => {
  const planner = new HermesIntentPlanner({ hermesHome: '/safe/profile', run: async () => '{"intent":"army_report"}' });
  assert.deepEqual(await planner.decide('给我一份今天军团的工作汇报'), { intent: 'army_report' });
});

test('AI理解器允许把成本问法归为实际使用汇总', async () => {
  const planner = new HermesIntentPlanner({ hermesHome: '/safe/profile', run: async () => '{"intent":"usage_report"}' });
  assert.deepEqual(await planner.decide('今天花了多少？'), { intent: 'usage_report' });
});

test('AI理解器拒绝模型返回的未知动作', async () => {
  const planner = new HermesIntentPlanner({ hermesHome: '/safe/profile', run: async () => '{"intent":"send_money"}' });
  assert.equal(await planner.decide('帮我付钱'), null);
});

test('AI 能把没有明确工作目标的自然聊天变成一句追问，不凭空派活', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/safe/profile', run:async () => '{"intent":"clarify","reply":"你是想查看哪一项的明细？"}' });
  assert.deepEqual(await planner.decide('哪几项？'), { intent:'clarify', reply:'你是想查看哪一项的明细？' });
});

test('AI 的追问不能夹带链接或无限长内容', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/safe/profile', run:async () => '{"intent":"clarify","reply":"https://unsafe.example"}' });
  assert.deepEqual(await planner.decide('继续'), { intent:'clarify' });
});

test('AI理解器允许把重复工作复盘交给架构师', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/safe/profile', run:async () => '{"intent":"architecture_review"}' });
  assert.deepEqual(await planner.decide('看看最近有哪些事情反复出现，是否需要新员工'), { intent:'architecture_review' });
});

test('AI理解器允许把多人内部协作交给军团总任务', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"cross_agent_mission"}' });
  assert.deepEqual(await planner.decide('组织大家一起盘点军团'), { intent:'cross_agent_mission' });
});

test('AI理解器允许把优先级和员工安排交给军团规划', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"army_planning"}' });
  assert.deepEqual(await planner.decide('帮我判断现在最优先做什么，安排合适的人去做'), { intent:'army_planning' });
});

test('AI 理解器区分 GitHub 检索和主题情报研究', async () => {
  const github = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"github_search"}' });
  assert.deepEqual(await github.decide('帮我在 GitHub 找开源项目'), { intent:'github_search' });
  const intel = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"intel_research"}' });
  assert.deepEqual(await intel.decide('研究这个主题并给结论和行动建议'), { intent:'intel_research' });
});

test('AI 理解器允许把材料和员工结果整理交给办公执行助理', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"office_briefing"}' });
  assert.deepEqual(await planner.decide('把这些员工结果整理成办公汇报包'), { intent:'office_briefing' });
});

test('AI只能从当前已经上岗的员工和任务里选择派活，不能编造岗位', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"route_task","taskType":"report.public-material","agentId":"public-reporter"}' });
  assert.deepEqual(await planner.decide('把这篇文章整理成中文摘要', { routes:[{ taskType:'report.public-material', agentId:'public-reporter', name:'公开资料报告员' }] }), { intent:'route_task', taskType:'report.public-material', agentId:'public-reporter' });
  const unsafe = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"route_task","taskType":"pay.money","agentId":"money-agent"}' });
  assert.equal(await unsafe.decide('帮我付款', { routes:[{ taskType:'report.public-material', agentId:'public-reporter' }] }), null);
});

test('AI 只能点名查看当前员工，不能把小D的近况扩成全团清单', async () => {
  const planner = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"employee_status","agentId":"xiaod"}' });
  assert.deepEqual(await planner.decide('看下小D最近干了啥', { employees:[{ agentId:'xiaod', name:'小D' }] }), { intent:'employee_status', agentId:'xiaod' });
  const unsafe = new HermesIntentPlanner({ hermesHome:'/tmp/hermes', run:async () => '{"intent":"employee_status","agentId":"made-up"}' });
  assert.equal(await unsafe.decide('看下小D最近干了啥', { employees:[{ agentId:'xiaod', name:'小D' }] }), null);
});
