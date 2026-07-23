import assert from 'node:assert/strict';
import test from 'node:test';
import { TechnicalRepairDiagnoser } from '../src/technical-repair-diagnoser.js';

const task = { input:{ title:'修复执行器错误', context:{ failure:{ code:'executor_failed', stage:'execution' } } } };

test('技术诊断只读分析后给出受限修复范围', async () => {
  const calls = [];
  const running = Promise.resolve({ stdout:JSON.stringify({ decision:'repair', summary:'函数返回错误结果。', repairScope:{ files:['apps/ajun-runtime/src/example.js'], testCommand:'node --test apps/ajun-runtime/test/example.test.js', recoveryCheck:'确认示例恢复。' } }) });
  running.child = { stdin:{ end() {} } };
  const diagnoser = new TechnicalRepairDiagnoser({ execFileImpl:(...args) => { calls.push(args); return running; } });
  const result = await diagnoser.diagnose(task, '/workspace/project');
  assert.equal(result.status, 'ready');
  assert.equal(result.repairScope.files[0], 'apps/ajun-runtime/src/example.js');
  assert.match(calls[0][1].join(' '), /read-only/);
});

test('技术诊断不会接受敏感文件或危险检查命令', async () => {
  const running = Promise.resolve({ stdout:JSON.stringify({ decision:'repair', summary:'错误范围。', repairScope:{ files:['.env'], testCommand:'rm -rf .', recoveryCheck:'完成。' } }) });
  running.child = { stdin:{ end() {} } };
  const diagnoser = new TechnicalRepairDiagnoser({ execFileImpl:() => running });
  const result = await diagnoser.diagnose(task, '/workspace/project');
  assert.equal(result.status, 'waiting_for_test');
});
