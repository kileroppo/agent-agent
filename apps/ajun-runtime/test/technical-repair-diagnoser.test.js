import assert from 'node:assert/strict';
import test from 'node:test';
import { TechnicalRepairDiagnoser } from '../src/technical-repair-diagnoser.ts';

const task = { input:{ title:'修复执行器错误', context:{ failure:{ code:'executor_failed', stage:'execution' } } } };

test('技术诊断只读分析后给出受限修复范围', async () => {
  const calls = [];
  const running = Promise.resolve({ stdout:JSON.stringify({ decision:'repair', summary:'函数返回错误结果。', repairScope:{ files:['apps/ajun-runtime/src/example.js'], testCommand:'node --test apps/ajun-runtime/test/example.test.js', recoveryCheck:'确认示例恢复。' } }) });
  running.child = { stdin:{ end() {} } };
  const diagnoser = new TechnicalRepairDiagnoser({
    execFileImpl:(...args) => { calls.push(args); return running; },
    fsImpl:{ async access() {} }
  });
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

test('技术诊断引用不存在的代码或测试路径时不能进入自动修复', async () => {
  const running = Promise.resolve({ stdout:JSON.stringify({
    decision:'repair',
    failureClass:'code_defect',
    summary:'猜测某文件有问题。',
    repairScope:{
      files:['apps/ajun-runtime/src/not-real.js'],
      testCommand:'node --test apps/ajun-runtime/test/not-real.test.js',
      recoveryCheck:'确认恢复。'
    }
  }) });
  running.child = { stdin:{ end() {} } };
  const diagnoser = new TechnicalRepairDiagnoser({
    execFileImpl:() => running,
    fsImpl:{ async access() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } }
  });
  const result = await diagnoser.diagnose(task, '/workspace/project');
  assert.equal(result.status, 'waiting_for_test');
  assert.deepEqual(result.invalidPaths, [
    'apps/ajun-runtime/src/not-real.js',
    'apps/ajun-runtime/test/not-real.test.js'
  ]);
});
