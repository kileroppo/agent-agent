import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 'agent.army/ajun-module-policy/v1';
const POLICY_FIELDS = new Set(['schemaVersion', 'modules', 'testGroups', 'waivers']);
const MODULE_RULE_FIELDS = new Set(['lineLimit', 'importLimit', 'affectedTests', 'defaultEnabled']);
const TEST_GROUP_FIELDS = new Set(['label', 'lineLimit', 'files']);
const TEST_FILE_RULE_FIELDS = new Set(['lineLimit']);
const WAIVER_FIELDS = new Set(['module', 'reason', 'author', 'expiresAt', 'allowLineLimit', 'allowImportLimit']);
const AJUN_DIRECTORY = 'apps/ajun-runtime';

export class AjunArchitecturePolicyCatalog {
  #modules;
  #testGroups;
  #waivers;

  static load(root, policyPath = null) {
    const file = policyPath || path.join(root, AJUN_DIRECTORY, 'module-policy.json');
    const policy = readPolicy(file);
    return new AjunArchitecturePolicyCatalog({ root, file, policy });
  }

  constructor({ root, file, policy }) {
    this.root = path.resolve(root);
    this.file = file;
    this.runtimeRoot = path.join(this.root, AJUN_DIRECTORY);
    this.schemaVersion = SCHEMA_VERSION;
    this.#modules = normalizeModules(policy.modules);
    this.#testGroups = normalizeTestGroups(policy.testGroups || {});
    this.#waivers = normalizeWaivers(policy.waivers || [], this.#modules);
    this.#validateCoverage();
    Object.freeze(this);
  }

  moduleRule(relativePath) {
    return this.#modules.get(toPosix(relativePath)) || null;
  }

  modules() {
    return new Map(this.#modules);
  }

  waivers() {
    return new Map(this.#waivers);
  }

  waiverInfo(relativePath, now = new Date()) {
    const normalized = toPosix(relativePath);
    const waiver = this.#waivers.get(normalized);
    if (!waiver) return null;
    const expiryDate = new Date(`${waiver.expiresAt}T23:59:59Z`);
    const expired = Number.isNaN(expiryDate.getTime()) ? true : now.getTime() > expiryDate.getTime();
    return Object.freeze({
      ...waiver,
      expired,
    });
  }

  effectiveLineLimit(relativePath, now = new Date()) {
    const normalized = toPosix(relativePath);
    const base = this.moduleRule(normalized)?.lineLimit || null;
    if (!base) return null;
    const waiver = this.waiverInfo(normalized, now);
    if (waiver && !waiver.expired && waiver.allowLineLimit) {
      return waiver.allowLineLimit;
    }
    return base;
  }

  effectiveImportLimit(relativePath, now = new Date()) {
    const normalized = toPosix(relativePath);
    const base = this.moduleRule(normalized)?.importLimit || null;
    if (!base) return null;
    const waiver = this.waiverInfo(normalized, now);
    if (waiver && !waiver.expired && waiver.allowImportLimit) {
      return waiver.allowImportLimit;
    }
    return base;
  }

  selectAffectedTests(relativePaths) {
    const mappedTests = new Set(
      [...this.#modules.values()].flatMap((rule) => rule.affectedTests || []),
    );
    const selected = new Set();
    for (const rawPath of relativePaths) {
      const relativePath = toPosix(rawPath);
      const tests = this.moduleRule(relativePath)?.affectedTests;
      if (tests) {
        for (const testFile of tests) selected.add(testFile);
        continue;
      }
      if (mappedTests.has(relativePath)) {
        selected.add(relativePath);
        continue;
      }
      return null;
    }
    return [...selected].sort();
  }

  testFileLineLimits() {
    const limits = new Map();
    for (const group of this.#testGroups.values()) {
      for (const [testFile, rule] of group.files) {
        if (rule.lineLimit) limits.set(`${AJUN_DIRECTORY}/${testFile}`, rule.lineLimit);
      }
    }
    return limits;
  }

  testGroupLineLimits() {
    return [...this.#testGroups.values()].map((group) => Object.freeze({
      name:group.label,
      lineLimit:group.lineLimit,
      paths:Object.freeze([...group.files.keys()].map((testFile) => `${AJUN_DIRECTORY}/${testFile}`)),
    }));
  }

  checkModule(relativePath, sourceCode = null, now = new Date()) {
    const normalized = toPosix(relativePath);
    const rule = this.moduleRule(normalized);
    if (!rule) {
      return {
        module: normalized,
        registered: false,
        status: 'UNKNOWN',
        message: '未在 module-policy.json 登记',
      };
    }

    let code = sourceCode;
    if (code === null) {
      try {
        code = fs.readFileSync(path.join(this.runtimeRoot, normalized), 'utf8');
      } catch (err) {
        return {
          module: normalized,
          registered: true,
          status: 'FAIL',
          message: `无法读取文件: ${err.message}`,
        };
      }
    }

    const currentLines = code.split(/\r?\n/).length;
    const currentImports = [...code.matchAll(/^\s*import\b/gm)].length;
    const baseLineLimit = rule.lineLimit || null;
    const baseImportLimit = rule.importLimit || null;
    const effectiveLineLimit = this.effectiveLineLimit(normalized, now);
    const effectiveImportLimit = this.effectiveImportLimit(normalized, now);
    const waiver = this.waiverInfo(normalized, now);

    const violations = [];
    const warnings = [];

    if (waiver?.expired) {
      violations.push(`Waiver 豁免已于 ${waiver.expiresAt} 过期 (申请人: ${waiver.author}, 原因: ${waiver.reason})`);
    } else if (waiver && !waiver.expired) {
      if (currentLines > baseLineLimit) {
        warnings.push(`使用临时 Waiver 豁免至 ${waiver.allowLineLimit} 行 (剩余有效期至 ${waiver.expiresAt}, 原因: ${waiver.reason})`);
      }
    }

    if (effectiveLineLimit && currentLines > effectiveLineLimit) {
      violations.push(`代码行数 ${currentLines} 超过上限 ${effectiveLineLimit}`);
    }

    if (effectiveImportLimit && currentImports > effectiveImportLimit) {
      violations.push(`导入数 ${currentImports} 超过上限 ${effectiveImportLimit}`);
    }

    const status = violations.length > 0 ? 'FAIL' : (warnings.length > 0 ? 'WARN' : 'PASS');
    return {
      module: normalized,
      registered: true,
      status,
      currentLines,
      baseLineLimit,
      effectiveLineLimit,
      currentImports,
      baseImportLimit,
      effectiveImportLimit,
      waiver,
      violations,
      warnings,
      message: violations.join('; ') || warnings.join('; ') || '正常',
    };
  }

  #validateCoverage() {
    for (const relativePath of requiredCompositionModules(this.runtimeRoot)) {
      if (!this.#modules.has(relativePath)) {
        throw new Error(`${AJUN_DIRECTORY}/${relativePath}: 装配 Module 必须登记到 module-policy.json`);
      }
    }
    for (const [relativePath, rule] of this.#modules) {
      assertExistingFile(this.runtimeRoot, relativePath, 'Module 策略指向的文件不存在');
      for (const testFile of rule.affectedTests || []) {
        assertExistingFile(
          this.runtimeRoot,
          testFile,
          `affectedTests 指向的测试不存在（${testFile}）`,
          relativePath,
        );
      }
    }
    for (const group of this.#testGroups.values()) {
      for (const testFile of group.files.keys()) {
        assertExistingFile(
          this.runtimeRoot,
          testFile,
          `测试门禁指向的测试不存在（${testFile}）`,
          `testGroups.${group.id}`,
        );
      }
    }
  }
}

export function loadAjunModulePolicy(root, policyPath = null) {
  return AjunArchitecturePolicyCatalog.load(root, policyPath);
}

function readPolicy(file) {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`A君 Module 策略无法读取：${error.message}`);
  }
  rejectUnknownFields(policy, POLICY_FIELDS, 'A君 Module 策略包含未知顶层字段');
  if (policy.schemaVersion !== SCHEMA_VERSION || !plainObject(policy.modules)) {
    throw new Error(`A君 Module 策略必须使用 ${SCHEMA_VERSION}`);
  }
  if (policy.testGroups !== undefined && !plainObject(policy.testGroups)) {
    throw new Error('A君 Module 策略 testGroups 必须是对象');
  }
  if (policy.waivers !== undefined && !Array.isArray(policy.waivers)) {
    throw new Error('A君 Module 策略 waivers 必须是数组');
  }
  return policy;
}

function normalizeModules(rawModules) {
  const modules = new Map();
  for (const [relativePath, rule] of Object.entries(rawModules)) {
    if (!safeModulePath(relativePath)) {
      throw new Error(`A君 Module 策略包含非法路径：${relativePath}`);
    }
    if (!plainObject(rule)) throw new Error(`${relativePath}: Module 策略必须是对象`);
    rejectUnknownFields(rule, MODULE_RULE_FIELDS, `${relativePath}: Module 策略包含未知字段`);
    if (Object.keys(rule).length === 0) throw new Error(`${relativePath}: Module 策略不得为空`);
    const normalized = {};
    if (rule.lineLimit !== undefined) normalized.lineLimit = positiveInteger(rule.lineLimit, relativePath, 'lineLimit');
    if (rule.importLimit !== undefined) normalized.importLimit = positiveInteger(rule.importLimit, relativePath, 'importLimit');
    if (rule.affectedTests !== undefined) {
      if (!Array.isArray(rule.affectedTests)
        || rule.affectedTests.length === 0
        || rule.affectedTests.some((testFile) => !safeTestPath(testFile))) {
        throw new Error(`${relativePath}: affectedTests 必须只包含 A君 test/ 下的测试文件`);
      }
      normalized.affectedTests = Object.freeze([...new Set(rule.affectedTests)].sort());
    }
    modules.set(relativePath, Object.freeze(normalized));
  }
  return modules;
}

function normalizeWaivers(rawWaivers, modules) {
  const waivers = new Map();
  for (const [index, waiver] of rawWaivers.entries()) {
    const label = `waivers[${index}]`;
    if (!plainObject(waiver)) {
      throw new Error(`${label}: waiver 必须是对象`);
    }
    rejectUnknownFields(waiver, WAIVER_FIELDS, `${label}: waiver 包含未知字段`);
    const modulePath = toPosix(waiver.module);
    if (!safeModulePath(modulePath)) {
      throw new Error(`${label}: 非法 module 路径 ${waiver.module}`);
    }
    if (!modules.has(modulePath)) {
      throw new Error(`${label}: 豁免的目标模块未在 modules 列表中定义 (${modulePath})`);
    }
    const reason = String(waiver.reason || '').trim();
    if (!reason) {
      throw new Error(`${label}: 必须提供明确的豁免原因 (reason)`);
    }
    const author = String(waiver.author || '').trim();
    if (!author) {
      throw new Error(`${label}: 必须提供豁免申请人 (author)`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(waiver.expiresAt) || Number.isNaN(new Date(waiver.expiresAt).getTime())) {
      throw new Error(`${label}: expiresAt 必须是有效的 YYYY-MM-DD 日期格式`);
    }
    const baseRule = modules.get(modulePath);
    let allowLineLimit;
    if (waiver.allowLineLimit !== undefined) {
      allowLineLimit = positiveInteger(waiver.allowLineLimit, label, 'allowLineLimit');
      const maxAllowed = Math.ceil((baseRule.lineLimit || 500) * 1.6) + 100;
      if (allowLineLimit > maxAllowed) {
        throw new Error(`${label}: allowLineLimit (${allowLineLimit}) 超过该模块允许的最大浮动上限 (${maxAllowed})`);
      }
    }
    let allowImportLimit;
    if (waiver.allowImportLimit !== undefined) {
      allowImportLimit = positiveInteger(waiver.allowImportLimit, label, 'allowImportLimit');
    }
    if (!allowLineLimit && !allowImportLimit) {
      throw new Error(`${label}: 必须至少指定 allowLineLimit 或 allowImportLimit 之一`);
    }
    waivers.set(modulePath, Object.freeze({
      module: modulePath,
      reason,
      author,
      expiresAt: waiver.expiresAt,
      allowLineLimit,
      allowImportLimit,
    }));
  }
  return waivers;
}

function normalizeTestGroups(rawGroups) {
  const groups = new Map();
  for (const [id, group] of Object.entries(rawGroups)) {
    if (!/^[a-z0-9-]+$/.test(id) || !plainObject(group)) {
      throw new Error(`testGroups.${id}: 测试门禁分组无效`);
    }
    rejectUnknownFields(group, TEST_GROUP_FIELDS, `testGroups.${id}: 测试门禁包含未知字段`);
    if (!String(group.label || '').trim() || !plainObject(group.files)) {
      throw new Error(`testGroups.${id}: 测试门禁必须包含 label 和 files`);
    }
    const files = new Map();
    for (const [testFile, rule] of Object.entries(group.files)) {
      if (!safeTestPath(testFile) || !plainObject(rule)) {
        throw new Error(`testGroups.${id}: 非法测试路径 ${testFile}`);
      }
      rejectUnknownFields(rule, TEST_FILE_RULE_FIELDS, `testGroups.${id}.${testFile}: 测试门禁包含未知字段`);
      const normalized = {};
      if (rule.lineLimit !== undefined) {
        normalized.lineLimit = positiveInteger(rule.lineLimit, testFile, 'lineLimit');
      }
      files.set(testFile, Object.freeze(normalized));
    }
    if (!files.size) throw new Error(`testGroups.${id}: 测试门禁 files 不得为空`);
    groups.set(id, Object.freeze({
      id,
      label:group.label.trim(),
      lineLimit:positiveInteger(group.lineLimit, `testGroups.${id}`, 'lineLimit'),
      files,
    }));
  }
  return groups;
}

function requiredCompositionModules(runtimeRoot) {
  const modules = ['src/runtime-composition-root.ts'];
  const directory = path.join(runtimeRoot, 'src/runtime');
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes:true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('-composition.ts')) {
      modules.push(`src/runtime/${entry.name}`);
    }
  }
  return modules;
}

function assertExistingFile(runtimeRoot, target, message, owner = target) {
  const resolved = path.resolve(runtimeRoot, target);
  if (!resolved.startsWith(`${runtimeRoot}${path.sep}`) || !fs.statSync(resolved, { throwIfNoEntry:false })?.isFile()) {
    throw new Error(`${AJUN_DIRECTORY}/${owner}: ${message}`);
  }
}

function rejectUnknownFields(value, allowed, message) {
  if (!plainObject(value)) throw new Error(message);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) throw new Error(`${message} ${unknown.join(', ')}`);
}

function positiveInteger(value, relativePath, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${relativePath}: ${field} 必须是正整数`);
  }
  return value;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeModulePath(value) {
  return /^(?:src|public|frontend\/src)\/[a-z0-9./-]+\.(?:js|mjs|ts|tsx)$/.test(value)
    && safeSegments(value);
}

function safeTestPath(value) {
  return /^test\/[a-z0-9./-]+\.test\.(?:js|mjs|ts)$/.test(value)
    && safeSegments(value);
}

function safeSegments(value) {
  const candidate = String(value);
  return !path.posix.isAbsolute(candidate)
    && !candidate.includes('\\')
    && path.posix.normalize(candidate) === candidate
    && candidate.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function toPosix(value) {
  return String(value || '').split(path.sep).join('/');
}
