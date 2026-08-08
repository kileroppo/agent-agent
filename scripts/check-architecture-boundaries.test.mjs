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
    `${Array.from({ length:351 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /责任模块超过 350 行/);
});

test('架构检查拒绝 TaskService 重新声明已委托方法', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/task-service.js',
    'export class TaskService {\n  async approveApproval() {}\n}\n',
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approveApproval 已委托给深层 Module/);
});

test('架构检查拒绝产品装配职责重新回流到根入口', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/runtime-composition-root.js',
    `${Array.from({ length:301 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime-composition-root\.js: 责任模块超过 300 行/);
});

test('架构检查拒绝产品装配根重新直接认识过多实现', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/runtime-composition-root.js',
    `${Array.from({ length:36 }, (_, index) => `import './module-${index}.js';`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /产品装配根超过 35 个直接 import/);
});

test('架构检查为候选任务恢复与展示 Module 预留行数门禁', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/task-recovery.js',
    `${Array.from({ length:301 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task-recovery\.js: 责任模块超过 300 行/);
});

test('架构检查限制候选任务详情和刷新 Module 的直接 import 扩散', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/public/task-record-detail-view.js',
    `${Array.from({ length:13 }, (_, index) => `import './module-${index}.js';`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task-record-detail-view\.js: 产品装配根超过 12 个直接 import/);
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

test('仓库目录清单必须覆盖所有 Workspace 和应用目录', async (context) => {
  const root = await fixture(context);
  await write(root, 'package.json', JSON.stringify({
    private:true,
    workspaces:['apps/runtime', 'packages/contracts'],
  }));
  await write(root, 'repository-catalog.json', JSON.stringify({
    schemaVersion:'agent.army/repository-catalog/v1',
    areas:[],
    entries:[repositoryEntry({
      path:'apps/runtime',
      name:'example-runtime',
      classification:'product-runtime',
      entrypoint:'apps/runtime/src/app.js',
    })],
  }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages\/contracts: 根 Workspace 未登记/);
});

test('历史回滚资产不得重新成为活动 Workspace', async (context) => {
  const root = await fixture(context);
  await write(root, 'apps/legacy/rollback.sh', '#!/bin/sh\n');
  await write(root, 'apps/runtime/src/replacement.js', 'export const replacement = true;\n');
  await write(root, 'package.json', JSON.stringify({
    private:true,
    workspaces:['apps/runtime', 'packages/contracts'],
  }));
  await write(root, 'repository-catalog.json', JSON.stringify({
    schemaVersion:'agent.army/repository-catalog/v1',
    areas:[],
    entries:[
      repositoryEntry({
        path:'apps/legacy',
        name:'legacy',
        classification:'legacy-rollback',
        lifecycle:'active',
        workspace:true,
        entrypoint:'apps/legacy/rollback.sh',
        replacement:'apps/runtime/src/replacement.js',
      }),
      repositoryEntry({
        path:'apps/runtime',
        name:'example-runtime',
        classification:'product-runtime',
        entrypoint:'apps/runtime/src/app.js',
      }),
      repositoryEntry({
        path:'packages/contracts',
        name:'@example/contracts',
        classification:'shared-contract',
        entrypoint:'packages/contracts/src/index.js',
      }),
    ],
  }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy-rollback 必须是 retained-rollback 且不得进入 Workspace/);
});

test('损坏的仓库目录清单不能绕过结构检查', async (context) => {
  const root = await fixture(context);
  await write(root, 'repository-catalog.json', '{not-json');
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repository-catalog\.json: 不是有效 JSON/);
});

test('正式 Workspace 必须提供用途描述和 README', async (context) => {
  const root = await fixture(context);
  await write(root, 'package.json', JSON.stringify({
    private:true,
    workspaces:['apps/runtime', 'packages/contracts'],
  }));
  await write(root, 'repository-catalog.json', JSON.stringify({
    schemaVersion:'agent.army/repository-catalog/v1',
    areas:[],
    entries:[
      repositoryEntry({
        path:'apps/runtime',
        name:'example-runtime',
        classification:'product-runtime',
        entrypoint:'apps/runtime/src/app.js',
      }),
      repositoryEntry({
        path:'packages/contracts',
        name:'@example/contracts',
        classification:'shared-contract',
        entrypoint:'packages/contracts/src/index.js',
      }),
    ],
  }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Workspace package\.json 必须说明产品或 Module 用途/);
  assert.match(result.stderr, /Workspace 必须提供 README 说明入口、验证和非目标/);
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

function repositoryEntry(overrides) {
  return {
    path:'',
    name:'',
    classification:'platform-adapter',
    lifecycle:'active',
    workspace:true,
    deployable:false,
    entrypoint:'',
    ...overrides,
  };
}
