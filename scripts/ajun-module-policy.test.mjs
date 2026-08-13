import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AjunArchitecturePolicyCatalog } from './ajun-module-policy.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_AJUN_LINE_LIMITS = Object.freeze({
  'src/task-attention-presentation.js':250,
  'src/task-recovery.js':300,
  'src/task-service.js':250,
  'src/task-definition-registry.js':275,
  'src/task-definitions.js':200,
  'src/task-status-policy.js':180,
  'src/contracts/agent-army-task-input.js':600,
  'src/contracts/agent-army-adapter-projection.js':200,
  'src/agent-army-mcp-server.js':600,
  'src/agent-army-client.js':750,
  'src/task-approval-coordinator.js':100,
  'src/task-intake.js':350,
  'src/task-notification.js':350,
  'src/task-overview.js':275,
  'src/task-paperclip-assignment.js':350,
  'src/task-role-execution.js':750,
  'src/feishu-commander.js':100,
  'src/feishu-commander-routing.js':400,
  'src/feishu-commander-followup.js':300,
  'src/feishu-commander-context.js':400,
  'src/feishu-commander-replies.js':600,
  'src/local-content-growth.js':100,
  'src/local-content-analysis.js':750,
  'src/local-content-artifacts.js':450,
  'src/local-content-creation.js':450,
  'src/local-content-m5-vision.js':400,
  'src/open-task-routing.ts':100,
  'src/open-task-routing-policy.js':350,
  'src/open-task-research-state.js':650,
  'src/open-task-research-execution.js':700,
  'src/paperclip-bridge.js':100,
  'src/paperclip-organization.js':250,
  'src/paperclip-issue-operations.js':250,
  'src/paperclip-m5-case-operations.js':350,
  'src/paperclip-publisher.js':650,
  'src/paperclip-publisher-contract.js':400,
  'src/m5-local-chaos-acceptance.js':450,
  'src/m5-local-chaos-journey.js':400,
  'src/m5-local-chaos-adapters.js':350,
  'src/m5-local-chaos-fixtures.js':250,
  'src/m5-local-chaos-ledger.js':250,
  'public/app.js':750,
  'public/app-access-views.js':500,
  'public/app-interactions.js':450,
  'public/task-record-detail-view.js':450,
  'public/refresh-scheduler.js':150,
});
const LEGACY_AJUN_IMPORT_LIMITS = Object.freeze({
  'src/task-attention-presentation.js':8,
  'src/task-recovery.js':10,
  'public/task-record-detail-view.js':12,
  'public/refresh-scheduler.js':6,
});

test('Catalog 精确保留迁移前的 A君生产 Module 门禁', () => {
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

  assert.deepEqual(catalog.moduleRule('src/runtime-composition-root.js'), {
    lineLimit:220,
    importLimit:20,
    affectedTests:['test/runtime-start.test.js'],
  });
  assert.deepEqual(
    catalog.selectAffectedTests(['src/runtime-composition-root.js', 'test/runtime-start.test.js']),
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
    'apps/ajun-runtime/src/runtime/new-capability-composition.js',
    'export const capability = true;\n',
  );
  assert.throws(
    () => AjunArchitecturePolicyCatalog.load(unregisteredRoot),
    /装配 Module 必须登记到 module-policy\.json/,
  );
});

async function fixture(context, {
  modulePath = 'src/runtime-composition-root.js',
  moduleRule = {
    lineLimit:220,
    importLimit:20,
    affectedTests:['test/runtime-start.test.js'],
  },
  affectedTests,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-policy-catalog-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await write(root, 'apps/ajun-runtime/src/runtime-composition-root.js', 'export const runtime = true;\n');
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
