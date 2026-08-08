import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const checker = new URL('./check-architecture-boundaries.mjs', import.meta.url);

test('架构检查拒绝 packages 反向依赖 apps', async (context) => {
  const root = await fixture(context);
  await write(root, 'packages/contracts/src/index.js', "import '../../../apps/runtime/src/app.js';\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages 不得反向依赖 apps/);
});

test('架构检查同样审查 TypeScript 生产源码', async (context) => {
  const root = await fixture(context);
  await write(root, 'packages/contracts/src/index.ts', "import '../../../apps/runtime/src/app.ts';\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages 不得反向依赖 apps/);
});

test('架构检查拒绝生产源码深相对跨 workspace', async (context) => {
  const root = await fixture(context, { appDependencies:{ '@example/contracts':'1.0.0' } });
  await write(root, 'apps/runtime/src/app.js', "import '../../../packages/contracts/src/index.js';\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不得用深相对路径跨 workspace/);
});

test('架构检查拒绝未声明 bare workspace 依赖并允许显式依赖', async (context) => {
  const rejectedRoot = await fixture(context);
  await write(rejectedRoot, 'apps/runtime/src/app.js', "import '@example/contracts';\n");
  const rejected = run(rejectedRoot);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /必须声明依赖/);

  const acceptedRoot = await fixture(context, { appDependencies:{ '@example/contracts':'1.0.0' } });
  await write(acceptedRoot, 'apps/runtime/src/app.js', "import '@example/contracts';\n");
  const accepted = run(acceptedRoot);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test('架构检查拒绝重复 class 方法', async (context) => {
  const root = await fixture(context);
  await write(root, 'apps/runtime/src/app.js', 'export class Broken {\n  run() {\n  }\n  run() {\n  }\n}\n');
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /重复声明方法 run/);
});

test('架构检查拒绝应用层重新引入 m5-kernel 一行转发门面', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/m5-route-execution.ts',
    "export * from '@agent-army/m5-kernel/route-execution';\n",
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已退役的 M5 转发门面不得回流/);
});

test('架构检查拒绝核心责任模块重新长回巨型文件', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/task-service.js',
    `${Array.from({ length:651 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /责任模块超过 650 行/);
});

test('架构检查拒绝未登记的生产源码超过一千行', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/runtime/src/unlisted-large-module.js',
    `${Array.from({ length:1001 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /生产源码超过 1000 行/);
});

async function fixture(context, { appDependencies = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-architecture-check-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await write(root, 'apps/runtime/package.json', JSON.stringify({
    name:'example-runtime',
    private:true,
    type:'module',
    dependencies:appDependencies,
  }));
  await write(root, 'apps/runtime/src/app.js', 'export const app = true;\n');
  await write(root, 'packages/contracts/package.json', JSON.stringify({
    name:'@example/contracts',
    version:'1.0.0',
    type:'module',
    exports:{ '.':'./src/index.js' },
  }));
  await write(root, 'packages/contracts/src/index.js', 'export const contract = true;\n');
  await fs.mkdir(path.join(root, 'integrations'), { recursive:true });
  return root;
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive:true });
  await fs.writeFile(target, content);
}

function run(root) {
  return spawnSync(process.execPath, [checker.pathname], {
    encoding:'utf8',
    env:{ ...process.env, AGENT_ARMY_ARCHITECTURE_ROOT:root },
  });
}
