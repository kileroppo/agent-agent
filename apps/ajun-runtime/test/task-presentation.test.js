import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskPresentation, presentTask, shortTaskRef, taskDetailBaseUrl } from '../src/task-presentation.js';

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
