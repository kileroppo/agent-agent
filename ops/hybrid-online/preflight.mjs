#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODE_RULES = {
  cloud: {
    platform: 'linux',
    required: [
      'NODE_ENV',
      'PORT',
      'AJUN_HOST',
      'AGENT_ARMY_DEPLOYMENT_MODE',
      'AGENT_ARMY_EMPLOYEE_FEISHU_OWNER',
      'AGENT_ARMY_DATA_DIR',
      'AGENT_ARMY_PRIVATE_DIR',
      'AGENT_ARMY_WORKER_TOKEN',
      'AJUN_HERMES_NATIVE_FEISHU',
      'AJUN_HERMES_NATIVE_EMPLOYEE_IDS',
      'AJUN_HERMES_COMMAND',
      'AJUN_HERMES_HOME',
      'AGENT_ARMY_HERMES_PROFILE_ROOT',
      'PAPERCLIP_URL'
    ],
    commands: ['curl', 'systemctl']
  },
  mac: {
    platform: 'darwin',
    required: [
      'AGENT_ARMY_CLOUD_URL',
      'AGENT_ARMY_CLOUD_TRANSPORT',
      'AGENT_ARMY_WORKER_TOKEN',
      'AGENT_ARMY_WORKER_ID',
      'AGENT_ARMY_NODE_BIN',
      'AGENT_ARMY_GCLOUD_BIN',
      'AGENT_ARMY_GCP_PROJECT',
      'AGENT_ARMY_GCP_ZONE',
      'AGENT_ARMY_GCP_INSTANCE',
      'AGENT_ARMY_IAP_LOCAL_PORT',
      'XIAOD_RUNTIME_URL',
      'AGENT_ARMY_WORKER_POLL_MS'
    ],
    commands: ['curl', 'launchctl', 'plutil']
  }
};

export async function runPreflight({ mode, envPath, hostChecks = true } = {}) {
  const rule = MODE_RULES[mode];
  if (!rule) throw new PreflightError('模式只能是 cloud 或 mac。');
  const resolvedEnvPath = path.resolve(String(envPath || ''));
  const stat = await fs.stat(resolvedEnvPath).catch(() => null);
  if (!stat?.isFile()) throw new PreflightError('找不到指定的私有配置文件。');
  if ((stat.mode & 0o077) !== 0) throw new PreflightError('私有配置文件权限过宽；请设置为仅所有者可读写。');

  const values = parseEnv(await fs.readFile(resolvedEnvPath, 'utf8'));
  const checks = validateConfig(mode, values);
  if (hostChecks) {
    if (process.platform !== rule.platform) throw new PreflightError(`${mode} 预检必须在目标操作系统执行。`);
    assertNode22(mode === 'mac' ? values.AGENT_ARMY_NODE_BIN : process.execPath);
    for (const command of rule.commands) {
      if (!findExecutable(command)) throw new PreflightError(`缺少必需命令：${command}`);
    }
    if (mode === 'cloud') assertExecutable(values.AJUN_HERMES_COMMAND, 'Hermes 命令');
    if (mode === 'mac') {
      assertExecutable(values.AGENT_ARMY_NODE_BIN, 'Node.js 命令');
      assertExecutable(values.AGENT_ARMY_GCLOUD_BIN, 'Google Cloud CLI');
    }
  }
  return { mode, envPath:resolvedEnvPath, checks };
}

export function validateConfig(mode, values) {
  const rule = MODE_RULES[mode];
  if (!rule) throw new PreflightError('模式只能是 cloud 或 mac。');
  for (const key of rule.required) {
    if (!String(values[key] || '').trim()) throw new PreflightError(`缺少必需配置：${key}`);
  }
  assertPrivateToken(values.AGENT_ARMY_WORKER_TOKEN);
  return mode === 'cloud' ? validateCloud(values) : validateMac(values);
}

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) throw new PreflightError('私有配置文件含无法识别的行。');
    const key = line.slice(0, index).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new PreflightError('私有配置文件含无效字段名。');
    values[key] = unquote(line.slice(index + 1).trim());
  }
  return values;
}

function validateCloud(values) {
  if (values.NODE_ENV !== 'production') throw new PreflightError('NODE_ENV 必须为 production。');
  if (values.PORT !== '4321') throw new PreflightError('云端 A君端口必须为 4321。');
  if (values.AJUN_HOST !== '127.0.0.1') throw new PreflightError('云端 A君只能监听 127.0.0.1。');
  if (values.AGENT_ARMY_DEPLOYMENT_MODE !== 'cloud') throw new PreflightError('云端部署模式必须为 cloud。');
  if (values.AGENT_ARMY_EMPLOYEE_FEISHU_OWNER !== 'cloud') throw new PreflightError('正式云端接管时，员工飞书入口归属必须为 cloud。');
  if (values.AJUN_HERMES_NATIVE_FEISHU !== 'true') throw new PreflightError('云端必须启用 Hermes 原生飞书入口。');
  const nativeEmployees = [...new Set(String(values.AJUN_HERMES_NATIVE_EMPLOYEE_IDS || '').split(',').map((item) => item.trim()).filter(Boolean))].sort();
  if (nativeEmployees.join(',') !== 'intel-researcher,office-assistant') {
    throw new PreflightError('云端首批 Hermes 原生员工必须且只能是小R和小办。');
  }

  const dataDir = assertSafeAbsolutePath(values.AGENT_ARMY_DATA_DIR, '数据目录');
  const privateDir = assertSafeAbsolutePath(values.AGENT_ARMY_PRIVATE_DIR, '私有目录');
  const profileRoot = assertSafeAbsolutePath(values.AGENT_ARMY_HERMES_PROFILE_ROOT, 'Hermes Profile 根目录');
  const hermesHome = assertSafeAbsolutePath(values.AJUN_HERMES_HOME, 'A君 Hermes Profile');
  if (!inside(privateDir, dataDir)) throw new PreflightError('私有目录必须位于 Agent军团数据目录内。');
  if (!inside(hermesHome, profileRoot)) throw new PreflightError('A君 Hermes Profile 必须位于 Profile 根目录内。');
  assertLoopbackHttp(values.PAPERCLIP_URL, 'Paperclip 地址');
  assertSafeAbsolutePath(values.AJUN_HERMES_COMMAND, 'Hermes 命令');
  return [
    '配置文件权限',
    '回环监听',
    '员工飞书唯一接管',
    '云端数据隔离',
    'Hermes Profile 隔离',
    'Worker 令牌',
    'Paperclip 回环地址'
  ];
}

function validateMac(values) {
  const cloudUrl = parseUrl(values.AGENT_ARMY_CLOUD_URL, '私人云地址');
  if (values.AGENT_ARMY_CLOUD_TRANSPORT !== 'iap-ssh') throw new PreflightError('Mac 工作间必须使用 Google IAP SSH 私有隧道。');
  const localPort = Number(values.AGENT_ARMY_IAP_LOCAL_PORT);
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) throw new PreflightError('IAP 本机端口无效。');
  if (cloudUrl.protocol !== 'http:' || cloudUrl.hostname !== '127.0.0.1' || Number(cloudUrl.port) !== localPort || cloudUrl.username || cloudUrl.password || cloudUrl.hash) {
    throw new PreflightError('私人云地址必须指向 IAP 映射的本机回环端口。');
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values.AGENT_ARMY_GCP_PROJECT)) throw new PreflightError('Google Cloud 项目标识无效。');
  if (!/^[a-z]+-[a-z]+\d-[a-z]$/.test(values.AGENT_ARMY_GCP_ZONE)) throw new PreflightError('Google Cloud 可用区无效。');
  if (!/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(values.AGENT_ARMY_GCP_INSTANCE)) throw new PreflightError('Google Cloud 实例名称无效。');
  assertLoopbackHttp(values.XIAOD_RUNTIME_URL, '小D地址');
  assertSafeAbsolutePath(values.AGENT_ARMY_NODE_BIN, 'Node.js 命令');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(values.AGENT_ARMY_WORKER_ID)) {
    throw new PreflightError('Mac 工作间标识格式无效。');
  }
  const pollMs = Number(values.AGENT_ARMY_WORKER_POLL_MS);
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) {
    throw new PreflightError('Worker 轮询间隔必须在 1000 至 60000 毫秒之间。');
  }
  return [
    '配置文件权限',
    'Google IAP SSH 私有隧道',
    'IAP 本机回环地址',
    '小D回环地址',
    'Worker 令牌',
    'Worker 标识',
    '轮询间隔'
  ];
}

function assertPrivateToken(value) {
  const token = String(value || '');
  if (token.length < 32 || /change_me|example|placeholder/i.test(token)) {
    throw new PreflightError('Worker 令牌必须是至少 32 位的真实随机值，不能使用模板值。');
  }
}

function assertLoopbackHttp(value, label) {
  const url = parseUrl(value, label);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) {
    throw new PreflightError(`${label}必须使用无内嵌凭据的本机 HTTP 地址。`);
  }
}

function assertSafeAbsolutePath(value, label) {
  const resolved = path.resolve(String(value || ''));
  if (!path.isAbsolute(String(value || '')) || ['/', '/var', '/Users', os.homedir()].includes(resolved)) {
    throw new PreflightError(`${label}必须是明确且非宽泛的绝对路径。`);
  }
  return resolved;
}

function assertExecutable(filePath, label) {
  try {
    const result = spawnSync('/usr/bin/test', ['-x', filePath]);
    if (result.status !== 0) throw new Error('not executable');
  } catch {
    throw new PreflightError(`${label}不存在或不可执行。`);
  }
}

function assertNode22(command) {
  const result = spawnSync(command, ['--version'], { encoding:'utf8', timeout:5000 });
  const major = Number(String(result.stdout || '').trim().match(/^v(\d+)/)?.[1]);
  if (result.status !== 0 || !Number.isInteger(major) || major < 22) {
    throw new PreflightError('需要可执行的 Node.js 22 或更高版本。');
  }
}

function findExecutable(command) {
  return spawnSync('/usr/bin/env', ['sh', '-c', 'command -v "$1" >/dev/null 2>&1', 'preflight', command]).status === 0;
}

function parseUrl(value, label) {
  try { return new URL(String(value || '')); }
  catch { throw new PreflightError(`${label}格式无效。`); }
}

function inside(candidate, root) {
  return candidate.startsWith(`${root}${path.sep}`);
}

function unquote(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) return value.slice(1, -1);
  return value;
}

export class PreflightError extends Error {}

async function main() {
  const [mode, envPath] = process.argv.slice(2);
  try {
    const result = await runPreflight({ mode, envPath });
    console.log(`通过：${result.mode} 上线前体检`);
    for (const check of result.checks) console.log(`- ${check}`);
  } catch (error) {
    console.error(`未通过：${error instanceof PreflightError ? error.message : '上线前体检发生未知错误。'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
