import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 'agent.army/ajun-module-policy/v1';
const POLICY_FIELDS = new Set(['schemaVersion', 'modules']);
const MODULE_RULE_FIELDS = new Set(['lineLimit', 'importLimit', 'affectedTests']);

export function loadAjunModulePolicy(root, policyPath = null) {
  const file = policyPath || path.join(root, 'apps/ajun-runtime/module-policy.json');
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`A君 Module 策略无法读取：${error.message}`);
  }
  if (!plainObject(policy) || Object.keys(policy).some((field) => !POLICY_FIELDS.has(field))) {
    throw new Error('A君 Module 策略包含未知顶层字段');
  }
  if (policy.schemaVersion !== SCHEMA_VERSION || !plainObject(policy.modules)) {
    throw new Error(`A君 Module 策略必须使用 ${SCHEMA_VERSION}`);
  }
  const modules = new Map();
  for (const [relativePath, rule] of Object.entries(policy.modules)) {
    if (!safeModulePath(relativePath)) {
      throw new Error(`A君 Module 策略包含非法路径：${relativePath}`);
    }
    if (!plainObject(rule)) throw new Error(`${relativePath}: Module 策略必须是对象`);
    const unknownFields = Object.keys(rule).filter((field) => !MODULE_RULE_FIELDS.has(field));
    if (unknownFields.length) {
      throw new Error(`${relativePath}: Module 策略包含未知字段 ${unknownFields.join(', ')}`);
    }
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
  return Object.freeze({ schemaVersion:SCHEMA_VERSION, modules });
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
  return /^(?:src|public)\/[a-z0-9./-]+\.(?:js|mjs|ts|tsx)$/.test(value)
    && safeSegments(value);
}

function safeTestPath(value) {
  return /^test\/[a-z0-9./-]+\.test\.(?:js|mjs|ts)$/.test(value)
    && safeSegments(value);
}

function safeSegments(value) {
  return String(value).split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}
