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

test('架构检查要求 Workflow 核心 Module 使用 TypeScript', async (context) => {
  const root = await fixture(context);
  await write(root, 'apps/ajun-runtime/src/workflow/policy.js', 'export const policy = true;\n');
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Workflow 核心 Module 必须使用 TypeScript/);
});

test('架构检查拒绝 Workflow 绕过 Interface 直接依赖平台 Adapter', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/workflow/execution.ts',
    "import '../adapters/local-ai-capability-adapter.ts';\nexport const execution = true;\n",
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不得直接依赖平台或 Adapter Implementation/);
});

test('架构检查拒绝 Workflow 直接访问网络或启动进程', async (context) => {
  const root = await fixture(context);
  await write(root, 'apps/ajun-runtime/src/workflow/execution.ts', "export async function run() { return fetch('https://example.com'); }\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不得直接访问网络或启动进程/);
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
    'apps/ajun-runtime/src/task-service.ts',
    `${Array.from({ length:251 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /责任模块超过 250 行/);
});

test('架构检查拒绝 TaskService 重新声明已委托方法', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/task-service.ts',
    'export class TaskService {\n  async approveApproval() {}\n}\n',
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approveApproval 已委托给深层 Module/);
});

test('架构检查拒绝任务定义消费者重新维护影子映射', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/feishu-commander-replies.ts',
    "const TASK_TYPE_BY_INTENT = { office: 'office.presentation-package' };\n",
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /任务意图映射必须从 TaskDefinitionRegistry 读取/);
});

test('架构检查拒绝岗位声明未登记的任务类型', async (context) => {
  const root = await fixture(context);
  await write(root, 'apps/ajun-runtime/src/task-definitions.ts', "taskDefinition('known.task');\n");
  await write(root, 'agents/operator/manifest.json', JSON.stringify({ acceptedTaskTypes:['unknown.task'] }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown\.task 未登记到 TaskDefinitionRegistry/);
});

test('架构检查拒绝任务状态消费者重新维护影子终态', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/agent-army-client.ts',
    "const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);\n",
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /通知停止状态必须从 TaskStatusPolicy 读取/);
});

test('架构检查拒绝 Hermes 任务卡业务逻辑回流到字符串补丁', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs',
    "const dynamicTaskCardMethods = `def handle(): pass`;\n",
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不得把任务卡业务逻辑重新内嵌为字符串补丁/);
});

test('架构检查拒绝 TaskService 接缝测试重新长回巨型文件', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/test/task-service.test.js',
    `${Array.from({ length:1801 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /接缝测试超过 1800 行/);
});

test('架构检查限制 TaskService 接缝测试总负担', async (context) => {
  const root = await fixture(context);
  for (const name of [
    'task-service.test.js',
    'task-service-paperclip-execution.test.js',
    'task-service-runtime-presentation.test.js',
    'task-service-m5-recovery.test.js',
  ]) {
    await write(root, `apps/ajun-runtime/test/${name}`, `${'// seam\n'.repeat(776)}`);
  }
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TaskService 接缝测试总计 .*超过 3100 行/);
});

test('架构检查拒绝产品装配职责重新回流到根入口', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/runtime-composition-root.ts',
    `${Array.from({ length:221 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime-composition-root\.ts: 责任模块超过 220 行/);
});

test('架构检查拒绝产品装配根重新直接认识过多实现', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/runtime-composition-root.ts',
    `${Array.from({ length:21 }, (_, index) => `import './module-${index}.js';`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /产品装配根超过 20 个直接 import/);
});

test('A君 Module 策略损坏时架构检查失败关闭', async (context) => {
  const root = await fixture(context);
  await write(root, 'apps/ajun-runtime/module-policy.json', '{broken-json');
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /A君 Module 策略无法读取/);
});

test('A君 Module 策略拒绝拼错字段和越界路径', async (context) => {
  const root = await fixture(context);
  await write(root, 'apps/ajun-runtime/module-policy.json', JSON.stringify({
    schemaVersion:'agent.army/ajun-module-policy/v1',
    modules:{
      'src/../../outside.js':{ lineLimt:100 },
    },
  }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /非法路径|未知字段/);
});

test('架构检查要求装配 Module 双向登记且策略目标存在', async (context) => {
  const missingRegistrationRoot = await fixture(context);
  await write(
    missingRegistrationRoot,
    'apps/ajun-runtime/src/runtime/new-capability-composition.ts',
    'export const capability = true;\n',
  );
  const missingRegistration = run(missingRegistrationRoot);
  assert.notEqual(missingRegistration.status, 0);
  assert.match(missingRegistration.stderr, /装配 Module 必须登记/);

  const missingTargetRoot = await fixture(context);
  const policyPath = path.join(missingTargetRoot, 'apps/ajun-runtime/module-policy.json');
  const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  policy.modules['src/missing-module.ts'] = { lineLimit:100 };
  await fs.writeFile(policyPath, JSON.stringify(policy));
  const missingTarget = run(missingTargetRoot);
  assert.notEqual(missingTarget.status, 0);
  assert.match(missingTarget.stderr, /Module 策略指向的文件不存在/);

  const missingTestRoot = await fixture(context);
  const missingTestPolicyPath = path.join(missingTestRoot, 'apps/ajun-runtime/module-policy.json');
  const missingTestPolicy = JSON.parse(await fs.readFile(missingTestPolicyPath, 'utf8'));
  missingTestPolicy.modules['src/task-recovery.ts'].affectedTests = ['test/missing.test.js'];
  await fs.writeFile(missingTestPolicyPath, JSON.stringify(missingTestPolicy));
  const missingTest = run(missingTestRoot);
  assert.notEqual(missingTest.status, 0);
  assert.match(missingTest.stderr, /affectedTests 指向的测试不存在/);
});

test('架构检查为候选任务恢复与展示 Module 预留行数门禁', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/src/task-recovery.ts',
    `${Array.from({ length:301 }, (_, index) => `// ${index}`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task-recovery\.ts: 责任模块超过 300 行/);
});

test('架构检查限制候选任务详情和刷新 Module 的直接 import 扩散', async (context) => {
  const root = await fixture(context);
  await write(
    root,
    'apps/ajun-runtime/frontend/src/task-record-detail-view.ts',
    `${Array.from({ length:13 }, (_, index) => `import './module-${index}.js';`).join('\n')}\n`,
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task-record-detail-view\.ts: 产品装配根超过 12 个直接 import/);
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
  await write(root, 'apps/ajun-runtime/module-policy.json', JSON.stringify({
    schemaVersion:'agent.army/ajun-module-policy/v1',
    modules:{
      'src/runtime-composition-root.ts':{ lineLimit:220, importLimit:20 },
      'src/task-service.ts':{ lineLimit:250 },
      'src/task-recovery.ts':{ lineLimit:300 },
      'frontend/src/task-record-detail-view.ts':{ importLimit:12 },
    },
    testGroups:{
      'task-service-seams':{
        label:'TaskService 接缝测试',
        lineLimit:3100,
        files:{
          'test/task-service.test.js':{ lineLimit:1800 },
          'test/task-service-paperclip-execution.test.js':{ lineLimit:1800 },
          'test/task-service-runtime-presentation.test.js':{ lineLimit:1800 },
          'test/task-service-m5-recovery.test.js':{ lineLimit:1800 },
        },
      },
    },
  }));
  await write(root, 'apps/ajun-runtime/src/runtime-composition-root.ts', 'export const runtime = true;\n');
  await write(root, 'apps/ajun-runtime/src/task-service.ts', 'export const task = true;\n');
  await write(root, 'apps/ajun-runtime/src/task-recovery.ts', 'export const recovery = true;\n');
  await write(root, 'apps/ajun-runtime/frontend/src/task-record-detail-view.ts', 'export const detail = true;\n');
  for (const name of [
    'task-service.test.js',
    'task-service-paperclip-execution.test.js',
    'task-service-runtime-presentation.test.js',
    'task-service-m5-recovery.test.js',
  ]) {
    await write(root, `apps/ajun-runtime/test/${name}`, 'export const testSeam = true;\n');
  }
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
