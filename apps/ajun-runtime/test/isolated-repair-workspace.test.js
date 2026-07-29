import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { IsolatedRepairWorkspace } from '../src/isolated-repair-workspace.js';
import { LocalTechnicalExpert } from '../src/local-technical-expert.js';

const execFile = promisify(execFileCallback);

test('A君用任务编号建立唯一修理副本，不触碰主目录', async () => {
  const commands = [];
  const workspace = new IsolatedRepairWorkspace({ projectRoot:'/project/main', parentDir:'/safe/repairs', fsImpl:{ async mkdir() {}, async access() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } }, execFileImpl:async (...args) => { commands.push(args); } });
  const prepared = await workspace.prepare({ taskId:'12345678-1234-1234-1234-123456789abc' });
  assert.equal(prepared.workspace, '/safe/repairs/12345678-1234-1234-1234-123456789abc');
  assert.deepEqual(commands[0][1], ['worktree', 'add', '--detach', prepared.workspace, 'HEAD']);
  assert.equal(commands[0][2].cwd, '/project/main');
});

test('独立副本会带上检查所需的只读测试文件，但不把它加入允许改动范围', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-workspace-'));
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
  assert.deepEqual(Object.keys(snapshot.files), ['docs/fixture/calculator.js']);
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
