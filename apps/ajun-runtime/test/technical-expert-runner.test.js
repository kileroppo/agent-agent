import test from 'node:test';
import assert from 'node:assert/strict';
import { TechnicalExpertRunner } from '../src/technical-expert-runner.ts';

const task = { input:{ title:'修复登记遗漏', description:'技术修复任务没有记录。', context:{ repairScope:{ files:['apps/ajun-runtime/src/task-service.js'], testCommand:'npm test --prefix apps/ajun-runtime', recoveryCheck:'确认小D业务任务不会被登记。' } } } };

test('技术专家只在修复范围完整时启动，并要求留下可核对结果', async () => {
  const calls = [];
  const runner = new TechnicalExpertRunner({ command:'codex', execFileImpl:async (...args) => { calls.push(args); }, fsImpl:{ async readFile() { return JSON.stringify({ type:'artifact' }); } } });
  const result = await runner.run(task, '/safe/repair');
  assert.equal(result.status, 'evidence_ready');
  assert.equal(calls[0][0], 'codex');
  assert.match(calls[0][1].at(-1), /只允许修改这些文件：apps\/ajun-runtime\/src\/task-service\.js/);
  assert.match(calls[0][1].at(-1), /paperclip-work-product\.json/);
  assert.match(calls[0][1].at(-1), /agentArmyRepairEvidence/);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
});

test('缺少文件范围、自动检查或恢复检查时不启动技术专家', async () => {
  const runner = new TechnicalExpertRunner({ execFileImpl:async () => { throw new Error('must not run'); } });
  assert.deepEqual(await runner.run({ input:{ context:{ repairScope:{ files:['apps/a.js'] } } } }, '/safe/repair'), { status:'waiting_for_scope' });
});

test('技术专家运行超时会标记为待测试，而不是无限等待', async () => {
  const runner = new TechnicalExpertRunner({ execFileImpl:async () => { const error = new Error('timed out'); error.killed = true; error.signal = 'SIGTERM'; throw error; } });
  const result = await runner.run(task, '/safe/repair');
  assert.equal(result.status, 'waiting_for_test');
  assert.match(result.reason, /超过本轮时限/);
});

test('技术专家启动后立即关闭输入，避免等待不存在的追加指令', async () => {
  let inputClosed = false;
  const running = Promise.resolve();
  running.child = { stdin:{ end() { inputClosed = true; } } };
  const runner = new TechnicalExpertRunner({ execFileImpl:() => running, fsImpl:{ async readFile() { return JSON.stringify({ type:'artifact' }); } } });
  await runner.run(task, '/safe/repair');
  assert.equal(inputClosed, true);
});
