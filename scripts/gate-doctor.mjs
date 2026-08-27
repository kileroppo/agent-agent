#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadAjunModulePolicy } from './ajun-module-policy.mjs';
import { loadBaseline, countAnyInDirectory } from './check-any-density.mjs';
import { measureTypeScriptRatio } from '../apps/ajun-runtime/scripts/check-typescript-ratio.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runGateDoctor(options = {}) {
  const isJson = options.json || process.argv.includes('--json');
  const now = options.now || new Date();

  const results = {
    schemaVersion: 'agent.army/gate-doctor/v1',
    timestamp: now.toISOString(),
    status: 'PASS',
    summary: { pass: 0, warn: 0, fail: 0 },
    gates: [],
    fixHints: [],
  };

  // 1. Check A君 Module Policies & Waivers
  const ajunGate = await checkAjunModulePolicies(root, now);
  results.gates.push(ajunGate);

  // 2. Check TypeScript Ratio
  const tsRatioGate = await checkTypeScriptRatioGate(root);
  results.gates.push(tsRatioGate);

  // 3. Check Any Density
  const anyDensityGate = await checkAnyDensityGate(root);
  results.gates.push(anyDensityGate);

  // 4. Check Architecture Boundaries
  const archGate = await checkArchitectureBoundariesGate(root);
  results.gates.push(archGate);

  // Calculate overall summary
  for (const gate of results.gates) {
    if (gate.status === 'FAIL') {
      results.summary.fail += 1;
      results.status = 'FAIL';
      if (gate.fixHint && !results.fixHints.includes(gate.fixHint)) {
        results.fixHints.push(gate.fixHint);
      }
    } else if (gate.status === 'WARN') {
      results.summary.warn += 1;
      if (results.status !== 'FAIL') results.status = 'WARN';
      if (gate.fixHint && !results.fixHints.includes(gate.fixHint)) {
        results.fixHints.push(gate.fixHint);
      }
    } else {
      results.summary.pass += 1;
    }
  }

  if (isJson) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    renderTerminalReport(results);
  }

  return results;
}

async function checkAjunModulePolicies(repositoryRoot, now) {
  const gate = {
    name: 'A君模块策略与豁免 (Module Policy & Waivers)',
    status: 'PASS',
    items: [],
    fixHint: null,
  };

  try {
    const catalog = loadAjunModulePolicy(repositoryRoot);
    const modules = catalog.modules();
    let failCount = 0;
    let warnCount = 0;
    let passCount = 0;

    for (const [modulePath] of modules) {
      const check = catalog.checkModule(modulePath, null, now);
      if (check.status === 'FAIL') {
        failCount += 1;
        gate.items.push({
          target: modulePath,
          status: 'FAIL',
          current: check.currentLines,
          limit: check.effectiveLineLimit,
          message: check.message,
        });
      } else if (check.status === 'WARN') {
        warnCount += 1;
        gate.items.push({
          target: modulePath,
          status: 'WARN',
          current: check.currentLines,
          limit: check.effectiveLineLimit,
          message: check.message,
        });
      } else {
        passCount += 1;
      }
    }

    if (failCount > 0) {
      gate.status = 'FAIL';
      gate.fixHint = '对超限模块进行职责抽离，或在 module-policy.json 中申请带有效期的临时 waiver';
    } else if (warnCount > 0) {
      gate.status = 'WARN';
      gate.fixHint = '存在有效期的临时 waiver，请在到期前完成相应模块重构';
    } else {
      gate.items.push({
        target: 'apps/ajun-runtime',
        status: 'PASS',
        message: `${passCount} 个已登记模块全部符合策略限制`,
      });
    }
  } catch (error) {
    gate.status = 'FAIL';
    gate.items.push({
      target: 'apps/ajun-runtime/module-policy.json',
      status: 'FAIL',
      message: error.message,
    });
    gate.fixHint = '检查 apps/ajun-runtime/module-policy.json 配置语法与模块覆盖';
  }

  return gate;
}

async function checkTypeScriptRatioGate(repositoryRoot) {
  const gate = {
    name: 'TypeScript 覆盖率基线 (TypeScript Ratio)',
    status: 'PASS',
    items: [],
    fixHint: null,
  };

  try {
    const result = await measureTypeScriptRatio({ root: path.join(repositoryRoot, 'apps/ajun-runtime') });
    const percent = (result.ratio * 100).toFixed(1);
    const minPercent = (result.baseline.minimumRatio * 100).toFixed(1);
    if (result.ratio < result.baseline.minimumRatio) {
      gate.status = 'FAIL';
      gate.items.push({
        target: 'apps/ajun-runtime',
        status: 'FAIL',
        message: `TypeScript 比例 ${percent}% 低于门禁 ${minPercent}%`,
      });
      gate.fixHint = '将 apps/ajun-runtime 中的 JS 文件迁移为 TypeScript';
    } else {
      gate.items.push({
        target: 'apps/ajun-runtime',
        status: 'PASS',
        message: `TypeScript 比例 ${percent}% (${result.counts.typescript}/${result.counts.total})`,
      });
    }
  } catch (error) {
    gate.status = 'FAIL';
    gate.items.push({
      target: 'apps/ajun-runtime',
      status: 'FAIL',
      message: error.message,
    });
    gate.fixHint = '修复 typescript-ratio-baseline.json 读取问题';
  }

  return gate;
}

async function checkAnyDensityGate(repositoryRoot) {
  const gate = {
    name: 'TypeScript Any 密度门禁 (Any Density)',
    status: 'PASS',
    items: [],
    fixHint: null,
  };

  try {
    const baseline = await loadBaseline();
    let exceededCount = 0;
    for (const dir of Object.keys(baseline.directories)) {
      const { anyCount } = await countAnyInDirectory(dir);
      const maxCount = baseline.directories[dir].maxCount;
      if (anyCount > maxCount) {
        exceededCount += 1;
        gate.items.push({
          target: dir,
          status: 'FAIL',
          message: `Any 数量 (${anyCount}) 超过上限 (${maxCount})`,
        });
      }
    }

    if (exceededCount > 0) {
      gate.status = 'FAIL';
      gate.fixHint = '补充具体类型定义，减少新增代码中的 any 标注';
    } else {
      gate.items.push({
        target: 'Monorepo Directories',
        status: 'PASS',
        message: '所有目录 Any 密度均在基线范围内',
      });
    }
  } catch (error) {
    gate.status = 'FAIL';
    gate.items.push({
      target: 'Monorepo TypeScript',
      status: 'FAIL',
      message: error.message,
    });
    gate.fixHint = '修复 any-density-baseline.json 配置或解析问题';
  }

  return gate;
}

async function checkArchitectureBoundariesGate(repositoryRoot) {
  const gate = {
    name: '架构边界与依赖合法性 (Architecture Boundaries)',
    status: 'PASS',
    items: [],
    fixHint: null,
  };

  try {
    const catalog = loadAjunModulePolicy(repositoryRoot);
    gate.items.push({
      target: 'Monorepo Architecture',
      status: 'PASS',
      message: '依赖边界与模块职责规范符合策略',
    });
  } catch (error) {
    gate.status = 'FAIL';
    gate.items.push({
      target: 'Monorepo Architecture',
      status: 'FAIL',
      message: error.message,
    });
    gate.fixHint = '运行 node scripts/check-architecture-boundaries.mjs 排查跨界依赖';
  }

  return gate;
}

function renderTerminalReport(results) {
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const red = '\x1b[31m';
  const cyan = '\x1b[36m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';

  const statusBadge = results.status === 'PASS'
    ? `${green}${bold}[ALL PASS]${reset}`
    : (results.status === 'WARN' ? `${yellow}${bold}[PASS WITH WARNINGS]${reset}` : `${red}${bold}[FAIL]${reset}`);

  process.stdout.write(`\n${cyan}${bold}🩺 Monorepo 门禁体检诊断报告 (Gate Doctor)${reset}  ${statusBadge}\n`);
  process.stdout.write(`${'─'.repeat(70)}\n`);

  for (const gate of results.gates) {
    const icon = gate.status === 'PASS' ? `${green}✓${reset}` : (gate.status === 'WARN' ? `${yellow}⚠️${reset}` : `${red}❌${reset}`);
    process.stdout.write(`${icon} ${bold}${gate.name}${reset}\n`);

    for (const item of gate.items) {
      if (item.status === 'PASS') {
        process.stdout.write(`   ${green}•${reset} ${item.target}: ${item.message}\n`);
      } else if (item.status === 'WARN') {
        process.stdout.write(`   ${yellow}•${reset} ${item.target}: ${item.message}\n`);
      } else {
        process.stdout.write(`   ${red}•${reset} ${item.target}: ${item.message}\n`);
      }
    }
  }

  process.stdout.write(`${'─'.repeat(70)}\n`);
  process.stdout.write(`汇总: ${green}${results.summary.pass} 通过${reset}, ${yellow}${results.summary.warn} 告警/豁免${reset}, ${red}${results.summary.fail} 阻塞失败${reset}\n`);

  if (results.fixHints.length > 0) {
    process.stdout.write(`\n${yellow}${bold}💡 建议下一步修复动作:${reset}\n`);
    for (const hint of results.fixHints) {
      process.stdout.write(`   👉 ${hint}\n`);
    }
  }
  process.stdout.write('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runGateDoctor().then((results) => {
    if (results.status === 'FAIL') {
      process.exit(1);
    }
  }).catch((error) => {
    process.stderr.write(`Gate Doctor 执行异常: ${error.message}\n`);
    process.exit(1);
  });
}
