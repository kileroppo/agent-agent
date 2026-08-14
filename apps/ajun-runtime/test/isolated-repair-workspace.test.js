import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { IsolatedRepairWorkspace } from '../src/isolated-repair-workspace.ts';
import { LocalTechnicalExpert } from '../src/local-technical-expert.ts';
import { resolveRuntimeSourceRoot } from '../src/runtime-source-root.ts';

const execFile = promisify(execFileCallback);

test('默认修理副本目录由当前用户 home 组合，不固化开发机路径', () => {
  const workspace = new IsolatedRepairWorkspace({ projectRoot:'/safe/source' });
  assert.equal(
    workspace.parentDir,
    path.join(os.homedir(), '.paperclip', 'agent-army-worktrees', 'ajun-repairs'),
  );
});

test('A君用任务编号建立并复验归属当前源码根的唯一修理副本', async (t) => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-workspace-owner-')));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const projectRoot = path.join(temp, 'project');
  const parentDir = path.join(temp, 'repairs');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'fix.js'), 'before\n');
  await execFile('git', ['init'], { cwd:projectRoot });
  await execFile('git', ['add', '.'], { cwd:projectRoot });
  await execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { cwd:projectRoot });
  const source = await resolveRuntimeSourceRoot({ runtimeRoot:await fs.realpath(projectRoot) });
  const workspace = new IsolatedRepairWorkspace({
    projectRoot:source.sourceProjectRoot,
    parentDir,
    sourceIdentity:source.sourceIdentity,
    verifySourceRoot:source.verify,
  });
  const task = {
    taskId:'12345678-1234-1234-1234-123456789abc',
    input:{ context:{ repairScope:{ files:['fix.js'] } } },
  };
  const prepared = await workspace.prepare(task);
  assert.equal(prepared.workspace, path.join(parentDir, task.taskId));
  assert.equal(prepared.reused, false);
  assert.equal((await workspace.prepare(task)).reused, true);
  await assert.rejects(
    workspace.prepare({
      ...task,
      input:{ context:{ repairScope:{ files:['other.js'] } } },
    }),
    /不属于当前任务或源码根/,
  );
});

test('独立副本会带上检查所需的只读测试文件，但不把它加入允许改动范围', async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-workspace-')));
  const projectRoot = path.join(temp, 'project'); const parentDir = path.join(temp, 'repairs');
  await fs.mkdir(path.join(projectRoot, 'docs/fixture'), { recursive:true });
  await fs.writeFile(path.join(projectRoot, 'docs/fixture/calculator.js'), 'export const add = () => -1;\n');
  await fs.writeFile(path.join(projectRoot, 'docs/fixture/calculator.test.js'), 'test file\n');
  await execFile('git', ['init'], { cwd:projectRoot }); await execFile('git', ['add', '.'], { cwd:projectRoot }); await execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { cwd:projectRoot });
  await fs.writeFile(path.join(projectRoot, 'docs/fixture/calculator.test.js'), 'dirty test file\n');
  const workspace = new IsolatedRepairWorkspace({ projectRoot, parentDir });
  const prepared = await workspace.prepare({ taskId:'repair-support-file-123', input:{ context:{ repairScope:{ files:['docs/fixture/calculator.js'], testCommand:'node --test docs/fixture/calculator.test.js' } } } });
  assert.equal(await fs.readFile(path.join(prepared.workspace, 'docs/fixture/calculator.test.js'), 'utf8'), 'dirty test file\n');
  const snapshot = JSON.parse(await fs.readFile(path.join(prepared.workspace, '.agent-army-repair-snapshot.json'), 'utf8'));
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.taskId, 'repair-support-file-123');
  assert.deepEqual(Object.keys(snapshot.files), ['docs/fixture/calculator.js']);
});

test('修复范围含源码 symlink 时拒绝复制到修理副本', async (t) => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-workspace-symlink-')));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const projectRoot = path.join(temp, 'project');
  const parentDir = path.join(temp, 'repairs');
  const outside = path.join(temp, 'outside.js');
  await fs.mkdir(projectRoot);
  await fs.writeFile(outside, 'outside\n');
  await fs.symlink(outside, path.join(projectRoot, 'fix.js'));
  await fs.writeFile(path.join(projectRoot, 'tracked.js'), 'tracked\n');
  await execFile('git', ['init'], { cwd:projectRoot });
  await execFile('git', ['add', '.'], { cwd:projectRoot });
  await execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { cwd:projectRoot });
  const source = await resolveRuntimeSourceRoot({ runtimeRoot:await fs.realpath(projectRoot) });
  const workspace = new IsolatedRepairWorkspace({
    projectRoot:source.sourceProjectRoot,
    parentDir,
    sourceIdentity:source.sourceIdentity,
    verifySourceRoot:source.verify,
  });
  await assert.rejects(
    workspace.prepare({
      taskId:'repair-symlink-source-123',
      input:{ context:{ repairScope:{ files:['fix.js'] } } },
    }),
    /符号链接/,
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside\n');
});

test('非法修复文件或测试路径在 mkdir 和 git worktree 前失败关闭', async () => {
  const sideEffects = [];
  const workspace = new IsolatedRepairWorkspace({
    projectRoot:'/safe/source',
    parentDir:'/safe/worktrees',
    fsImpl:{
      async mkdir() { sideEffects.push('mkdir'); },
      async lstat() { sideEffects.push('lstat'); },
    },
    execFileImpl:async () => { sideEffects.push('git'); },
  });
  const invalidScopes = [
    { files:[] },
    { files:[null] },
    { files:[''] },
    { files:['/tmp/outside.js'] },
    { files:['src/../outside.js'] },
    { files:['src\\..\\outside.js'] },
    { files:['src/fix.js'], testCommand:42 },
    { files:['src/fix.js'], testCommand:'node --test /tmp/outside.test.js' },
    { files:['src/fix.js'], testCommand:'node --test test/../outside.test.js' },
    { files:['src/fix.js'], testCommand:'node --test test/not-a-test.txt' },
  ];
  for (const [index, repairScope] of invalidScopes.entries()) {
    await assert.rejects(
      workspace.prepare({
        taskId:`invalid-scope-task-${String(index).padStart(2, '0')}`,
        input:{ context:{ repairScope } },
      }),
      /修复范围|修复范围文件|自动检查|node --test/,
    );
  }
  assert.deepEqual(sideEffects, []);
});

test('技术专家先准备独立副本，再等待修复证据，不把准备工作说成已修好', async () => {
  const expert = new LocalTechnicalExpert({ now:() => new Date('2026-07-21T00:00:00.000Z'), workspace:{ async prepare() { return { workspace:'/safe/repairs/task-1', reused:false }; } } });
  const result = await expert.execute({
    taskId:'task-1',
    execution:{},
    governance:{ paperclipAssigneeAgentId:'expert-1' },
    input:{ context:{
      failure:{ code:'executor_failed' },
      repairScope:{
        files:['apps/ajun-runtime/src/example.js'],
        testCommand:'node --test apps/ajun-runtime/test/example.test.js',
        recoveryCheck:'确认原故障不再出现'
      }
    } }
  });
  assert.equal(result.status, 'running');
  assert.equal(result.currentStage, 'isolated_workspace_ready');
  assert.equal(result.execution.workspace.path, '/safe/repairs/task-1');
  assert.equal(result.artifactRefs.some((item) => item.type === 'isolated_repair_workspace'), true);
  assert.equal(result.artifactRefs[0].data.implementationStarted, false);
});
