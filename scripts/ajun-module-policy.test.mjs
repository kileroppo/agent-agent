import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AjunArchitecturePolicyCatalog } from './ajun-module-policy.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AjunArchitecturePolicyCatalog 能够正确加载生产 module-policy.json 并解析模块与生效限额', () => {
  const catalog = AjunArchitecturePolicyCatalog.load(repositoryRoot);
  assert.ok(catalog.modules().size > 30, '生产模块定义数必须充足');
  
  const detailViewRule = catalog.moduleRule('frontend/src/task-record-detail-view.ts');
  assert.ok(detailViewRule, 'task-record-detail-view.ts 必须存在策略');
  assert.equal(typeof detailViewRule.lineLimit, 'number');
  assert.equal(catalog.effectiveLineLimit('frontend/src/task-record-detail-view.ts'), detailViewRule.lineLimit);
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

test('AjunArchitecturePolicyCatalog 支持带 TTL 生命周期的 Waiver 豁免与失效阻断', async (context) => {
  const futureDate = '2099-12-31';
  const pastDate = '2020-01-01';

  const waiverRoot = await fixture(context, {
    waivers:[
      {
        module:'src/runtime-composition-root.ts',
        reason:'重构过渡期',
        author:'developer',
        expiresAt:futureDate,
        allowLineLimit:300,
      },
    ],
  });

  const catalog = AjunArchitecturePolicyCatalog.load(waiverRoot);
  assert.equal(catalog.effectiveLineLimit('src/runtime-composition-root.ts'), 300);
  const waiverInfo = catalog.waiverInfo('src/runtime-composition-root.ts');
  assert.equal(waiverInfo.expired, false);
  assert.equal(waiverInfo.reason, '重构过渡期');

  // 过期检测
  const expiredWaiverRoot = await fixture(context, {
    waivers:[
      {
        module:'src/runtime-composition-root.ts',
        reason:'已过期豁免',
        author:'developer',
        expiresAt:pastDate,
        allowLineLimit:300,
      },
    ],
  });
  const expiredCatalog = AjunArchitecturePolicyCatalog.load(expiredWaiverRoot);
  assert.equal(expiredCatalog.effectiveLineLimit('src/runtime-composition-root.ts'), 220); // 回退到 base limit
  const expiredInfo = expiredCatalog.waiverInfo('src/runtime-composition-root.ts');
  assert.equal(expiredInfo.expired, true);

  // 诊断 checkModule
  const passCheck = catalog.checkModule('src/runtime-composition-root.ts', 'const a = 1;\n');
  assert.equal(passCheck.status, 'PASS');

  const warnCheck = catalog.checkModule('src/runtime-composition-root.ts', Array(250).fill('// line').join('\n'));
  assert.equal(warnCheck.status, 'WARN'); // 在 waiver 范围内，标记为 WARN

  const failCheck = catalog.checkModule('src/runtime-composition-root.ts', Array(350).fill('// line').join('\n'));
  assert.equal(failCheck.status, 'FAIL'); // 超过 waiver 上限，标记为 FAIL
});

test('AjunArchitecturePolicyCatalog 对非法 Waiver 严格校验并失败关闭', async (context) => {
  // 1. 目标模块不存在
  await assert.rejects(
    () => fixture(context, {
      waivers:[{ module:'src/non-existent.ts', reason:'test', author:'dev', expiresAt:'2099-01-01', allowLineLimit:300 }],
    }).then(AjunArchitecturePolicyCatalog.load),
    /豁免的目标模块未在 modules 列表中定义/,
  );

  // 2. 超出最大允许浮动上限
  await assert.rejects(
    () => fixture(context, {
      waivers:[{ module:'src/runtime-composition-root.ts', reason:'test', author:'dev', expiresAt:'2099-01-01', allowLineLimit:1000 }],
    }).then(AjunArchitecturePolicyCatalog.load),
    /超过该模块允许的最大浮动上限/,
  );

  // 3. 缺少 reason 或 author
  await assert.rejects(
    () => fixture(context, {
      waivers:[{ module:'src/runtime-composition-root.ts', reason:'', author:'dev', expiresAt:'2099-01-01', allowLineLimit:300 }],
    }).then(AjunArchitecturePolicyCatalog.load),
    /必须提供明确的豁免原因/,
  );
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
  waivers = [],
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
    waivers,
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
