#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ENV_KEY = 'STEPFUN_API_KEY';
const PAPERCLIP_SECRET_KEY = 'STEPFUN_M5_API_KEY';
const PAPERCLIP_SECRET_NAME = 'StepFun M5';
const MAX_ENV_FILE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function importStepFunSecret({
  apiBase,
  companyId,
  envFile,
  fetchImpl = fetch,
}) {
  const base = loopbackApiBase(apiBase);
  const company = uuid(companyId, '--company-id 必须是 Paperclip Company UUID。');
  const file = path.resolve(required(envFile, '--env-file 必须显式指定。'));
  const secretsUrl = `${base}/api/companies/${encodeURIComponent(company)}/secrets`;

  const existing = await requestJson(fetchImpl, secretsUrl, {
    method:'GET',
    headers:{ accept:'application/json' },
  }, '读取 Paperclip Secret 元数据失败');
  const existingSecrets = list(existing);
  if (!existingSecrets) {
    throw safeError('读取 Paperclip Secret 元数据失败：响应结构无效。');
  }
  if (existingSecrets.some((item) =>
    normalizedSecretKey(item?.key) === normalizedSecretKey(PAPERCLIP_SECRET_KEY)
    && item?.status !== 'deleted')) {
    throw safeError('Paperclip 已存在 STEPFUN_M5_API_KEY；拒绝重复导入。');
  }

  const value = await readPrivateEnvValue(file, ENV_KEY);
  const created = await requestJson(fetchImpl, secretsUrl, {
    method:'POST',
    headers:{
      accept:'application/json',
      'cache-control':'no-store',
      'content-type':'application/json',
    },
    body:JSON.stringify({
      name:PAPERCLIP_SECRET_NAME,
      key:PAPERCLIP_SECRET_KEY,
      provider:'local_encrypted',
      managedMode:'paperclip_managed',
      description:'M5 content-autonomy StepFun credential',
      value,
    }),
  }, '创建 Paperclip Secret 失败');

  if (
    !UUID.test(String(created?.id || ''))
    || normalizedSecretKey(created?.key) !== normalizedSecretKey(PAPERCLIP_SECRET_KEY)
    || created?.provider !== 'local_encrypted'
    || created?.status !== 'active'
  ) {
    throw safeError('Paperclip 返回了无效的 Secret 元数据；请只读检查 Secrets 页面。');
  }

  return {
    id:created.id,
    key:String(created.key),
    provider:'local_encrypted',
    status:'active',
  };
}

export async function readPrivateEnvValue(file, key = ENV_KEY) {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw safeError('当前系统不支持安全的无符号链接文件读取。');
  }

  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch {
    throw safeError('无法安全打开 --env-file；必须是当前用户拥有的 0600 普通文件。');
  }

  try {
    const stat = await handle.stat();
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
      || (currentUid !== null && stat.uid !== currentUid)
      || stat.size > MAX_ENV_FILE_BYTES
    ) {
      throw safeError('--env-file 必须是当前用户拥有、单硬链接、最大 64KB 的 0600 普通文件。');
    }
    const content = await handle.readFile({ encoding:'utf8' });
    return parseEnvValue(content, key);
  } finally {
    await handle.close();
  }
}

export function parseEnvValue(content, key = ENV_KEY) {
  const matches = [];
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    matches.push(parseDotenvScalar(match[2]));
  }
  if (matches.length !== 1) {
    throw safeError(matches.length === 0
      ? `--env-file 中缺少 ${key}。`
      : `--env-file 中存在重复的 ${key}。`);
  }
  const value = matches[0];
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw safeError(`${key} 为空、过长或包含非法字符。`);
  }
  return value;
}

function parseDotenvScalar(rawValue) {
  const value = String(rawValue).trim();
  if (!value) return '';
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value.at(-1) !== quote) {
      throw safeError(`${ENV_KEY} 的引号格式无效。`);
    }
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

async function requestJson(fetchImpl, url, init, failureMessage) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw safeError(`${failureMessage}：网络请求未完成。`);
  }
  if (!response?.ok) {
    if (response?.status === 409) {
      throw safeError('Paperclip 已存在 STEPFUN_M5_API_KEY；拒绝重复导入。');
    }
    throw safeError(`${failureMessage}：HTTP ${Number(response?.status) || 'unknown'}。`);
  }
  try {
    return await response.json();
  } catch {
    throw safeError(`${failureMessage}：响应不是有效 JSON。`);
  }
}

function list(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : null;
}

function normalizedSecretKey(value) {
  return String(value || '').trim().toLowerCase();
}

function loopbackApiBase(value = 'http://127.0.0.1:3100') {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw safeError('--api-base 必须是本机 Paperclip HTTP 地址。');
  }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/'
  ) {
    throw safeError('--api-base 只允许无凭据、无查询参数的本机 Paperclip HTTP 地址。');
  }
  return url.toString().replace(/\/$/, '');
}

function uuid(value, message) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw safeError(message);
  return id;
}

function required(value, message) {
  const text = String(value || '').trim();
  if (!text) throw safeError(message);
  return text;
}

function safeError(message) {
  const error = new Error(message);
  error.name = 'SafeImportError';
  return error;
}

function parseArgs(args) {
  const allowed = new Set(['api-base', 'company-id', 'env-file']);
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    const key = item.startsWith('--') ? item.slice(2) : '';
    const value = args[index + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || key in result) {
      throw safeError(`参数无效：${item || '(empty)'}。`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await importStepFunSecret({
      apiBase:options['api-base'] || 'http://127.0.0.1:3100',
      companyId:options['company-id'],
      envFile:options['env-file'],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'StepFun Secret 导入失败。'}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) await main();
