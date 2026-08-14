import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AjunArchitecturePolicyCatalog } from './ajun-module-policy.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_AJUN_LINE_LIMITS = Object.freeze({
  'src/task-attention-presentation.ts':250,
  'src/task-recovery.ts':300,
  'src/task-service.ts':250,
  'src/task-definition-registry.ts':275,
  'src/task-definitions.ts':200,
  'src/task-status-policy.ts':180,
  'src/contracts/agent-army-task-input.ts':600,
  'src/contracts/agent-army-adapter-projection.ts':200,
  'src/agent-army-mcp-server.ts':600,
  'src/agent-army-client.ts':750,
  'src/task-approval-coordinator.ts':120,
  'src/task-intake.ts':350,
  'src/task-notification.ts':350,
  'src/task-overview.ts':275,
  'src/task-paperclip-assignment.ts':350,
  'src/task-role-execution.ts':750,
  'src/feishu-commander.ts':100,
  'src/feishu-commander-routing.ts':400,
  'src/feishu-commander-followup.ts':300,
  'src/feishu-commander-context.ts':400,
  'src/feishu-commander-replies.ts':600,
  'src/local-content-growth.ts':100,
  'src/local-content-analysis.ts':750,
  'src/local-content-artifacts.ts':450,
  'src/local-content-creation.ts':450,
  'src/local-content-m5-vision.ts':400,
  'src/open-task-routing.ts':100,
  'src/open-task-routing-policy.ts':350,
  'src/open-task-research-state.ts':650,
  'src/open-task-research-execution.ts':700,
  'src/paperclip-bridge.ts':100,
  'src/paperclip-organization.ts':250,
  'src/paperclip-issue-operations.ts':250,
  'src/paperclip-m5-case-operations.ts':350,
  'src/paperclip-publisher.ts':650,
  'src/paperclip-publisher-contract.ts':400,
  'src/m5-local-chaos-acceptance.ts':450,
  'src/m5-local-chaos-journey.ts':400,
  'src/m5-local-chaos-adapters.ts':350,
  'src/m5-local-chaos-fixtures.ts':250,
  'src/m5-local-chaos-ledger.ts':250,
  'frontend/src/app.ts':750,
  'frontend/src/app-access-views.ts':500,
  'frontend/src/app-interactions.ts':450,
  'frontend/src/task-record-detail-view.ts':450,
  'frontend/src/refresh-scheduler.ts':150,
});
const LEGACY_AJUN_IMPORT_LIMITS = Object.freeze({
  'src/task-attention-presentation.ts':8,
  'src/task-recovery.ts':10,
  'frontend/src/task-record-detail-view.ts':12,
  'frontend/src/refresh-scheduler.ts':6,
});

test('Catalog 精确保留 TypeScript 迁移后的 A君生产 Module 门禁', () => {
  const catalog = AjunArchitecturePolicyCatalog.load(repositoryRoot);
  const actualLineLimits = Object.fromEntries(
    Object.keys(LEGACY_AJUN_LINE_LIMITS).map((modulePath) => [
      modulePath,
      catalog.moduleRule(modulePath)?.lineLimit,
    ]),
  );
  const actualImportLimits = Object.fromEntries(
    Object.keys(LEGACY_AJUN_IMPORT_LIMITS).map((modulePath) => [
      modulePath,
      catalog.moduleRule(modulePath)?.importLimit,
    ]),
  );

  assert.deepEqual(actualLineLimits, LEGACY_AJUN_LINE_LIMITS);
  assert.deepEqual(actualImportLimits, LEGACY_AJUN_IMPORT_LIMITS);
});

test('AjunArchitecturePolicyCatalog 集中提供模块门禁、affected tests 和测试分组', async (context) => {
  const root = await fixture(context);
  const catalog = AjunArchitecturePolicyCatalog.load(root);

  assert.deepEqual(catalog.moduleRule('src/runtime-composition-root.ts'), {
    lineLimit:220,
    importLimit:20,
    affectedTests:['test/runtime-start.test.js'],
  });
  assert.deepEqual(
    catalog.selectAffectedTests(['src/runtime-composition-root.ts', 'test/runtime-start.test.js']),
    ['test/runtime-start.test.js'],
  );
  assert.deepEqual(
    [...catalog.testFileLineLimits()],
    [['apps/ajun-runtime/test/runtime-start.test.js', 500]],
  );
  assert.deepEqual(catalog.testGroupLineLimits(), [{
    name:'运行装配接缝测试',
    lineLimit:700,
    paths:['apps/ajun-runtime/test/runtime-start.test.js'],
  }]);
});

test('AjunArchitecturePolicyCatalog 对未知字段和路径越界失败关闭', async (context) => {
  const unknownRoot = await fixture(context, {
    moduleRule:{ lineLimt:220 },
  });
  assert.throws(
    () => AjunArchitecturePolicyCatalog.load(unknownRoot),
    /Module 策略包含未知字段 lineLimt/,
  );

  const escapedRoot = await fixture(context, {
    modulePath:'src/runtime/../outside.js',
  });
  assert.throws(
    () => AjunArchitecturePolicyCatalog.load(escapedRoot),
    /非法路径/,
  );
});

test('AjunArchitecturePolicyCatalog 要求策略目标、测试和装配覆盖真实存在', async (context) => {
  const missingModuleRoot = await fixture(context);
  const missingModulePolicy = path.join(missingModuleRoot, 'apps/ajun-runtime/module-policy.json');
  const missingModule = JSON.parse(await fs.readFile(missingModulePolicy, 'utf8'));
  missingModule.modules['src/missing.js'] = { lineLimit:100 };
  await fs.writeFile(missingModulePolicy, JSON.stringify(missingModule));
  assert.throws(
    () => AjunArchitecturePolicyCatalog.load(missingModuleRoot),
    /Module 策略指向的文件不存在/,
  );

  const missingTestRoot = await fixture(context, {
    affectedTests:['test/missing.test.js'],
  });
  assert.throws(
    () => AjunArchitecturePolicyCatalog.load(missingTestRoot),
    /affectedTests 指向的测试不存在/,
  );

  const unregisteredRoot = await fixture(context);
  await write(
    unregisteredRoot,
    'apps/ajun-runtime/src/runtime/new-capability-composition.ts',
    'export const capability = true;\n',
  );
  assert.throws(
    () => AjunArchitecturePolicyCatalog.load(unregisteredRoot),
    /装配 Module 必须登记到 module-policy\.json/,
  );
});

async function fixture(context, {
  modulePath = 'src/runtime-composition-root.ts',
  moduleRule = {
    lineLimit:220,
    importLimit:20,
    affectedTests:['test/runtime-start.test.js'],
  },
  affectedTests,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-policy-catalog-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await write(root, 'apps/ajun-runtime/src/runtime-composition-root.ts', 'export const runtime = true;\n');
  await write(root, 'apps/ajun-runtime/test/runtime-start.test.js', 'export const runtime = true;\n');
  await write(root, 'apps/ajun-runtime/module-policy.json', JSON.stringify({
    schemaVersion:'agent.army/ajun-module-policy/v1',
    modules:{
      [modulePath]:{
        ...moduleRule,
        ...(affectedTests ? { affectedTests } : {}),
      },
    },
    testGroups:{
      'runtime-seams':{
        label:'运行装配接缝测试',
        lineLimit:700,
        files:{
          'test/runtime-start.test.js':{ lineLimit:500 },
        },
      },
    },
  }));
  return root;
}

async function write(root, relative, content) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive:true });
  await fs.writeFile(file, content);
}
