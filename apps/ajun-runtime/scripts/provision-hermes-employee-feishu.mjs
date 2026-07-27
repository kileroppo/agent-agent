#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_AGENTS = new Set([
  'ajun',
  'intel-researcher',
  'office-assistant',
  'creator',
  'task-coordinator',
  'reviewer',
  'architect',
  'operator',
  'technical-expert'
]);
const MANAGED_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_ALLOWED_USERS',
  'FEISHU_CONNECTION_MODE',
  'FEISHU_GROUP_POLICY',
  'FEISHU_REQUIRE_MENTION',
  'FEISHU_ALLOW_BOTS',
  'FEISHU_ALLOW_ALL_USERS'
];

export async function provisionHermesEmployeeFeishu({
  agentIds,
  privateDir = process.env.AGENT_ARMY_PRIVATE_DIR || path.join(os.homedir(), '.agent-army'),
  profileRoot = process.env.AGENT_ARMY_HERMES_PROFILE_ROOT || path.join(os.homedir(), '.hermes', 'profiles'),
  defaultHermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
} = {}) {
  const ids = normalizeAgentIds(agentIds);
  if (!ids.length) throw new ProvisionError('至少需要指定一名允许迁移的员工。');

  const [appDocument, secretDocument] = await Promise.all([
    readJson(path.join(privateDir, 'feishu-agent-apps.json')),
    readJson(path.join(privateDir, 'feishu-agent-secrets.json'))
  ]);
  const apps = Array.isArray(appDocument?.apps) ? appDocument.apps : [];
  const results = [];

  for (const agentId of ids) {
    const app = apps.find((item) => item?.agentId === agentId);
    const appId = String(app?.appId || '').trim();
    const appSecret = String(secretDocument?.secrets?.[agentId] || '').trim();
    const allowedUserIds = normalizeList(app?.allowedUserIds);
    if (!/^cli_[a-zA-Z0-9]{8,}$/.test(appId) || appSecret.length < 16 || !allowedUserIds.length) {
      throw new ProvisionError(`${agentId} 的本机飞书应用资料不完整，未迁移。`);
    }

    const profileDir = agentId === 'ajun'
      ? safeExistingDirectory(defaultHermesHome)
      : safeProfileDirectory(profileRoot, agentId);
    const stat = await fs.stat(profileDir).catch(() => null);
    if (!stat?.isDirectory()) throw new ProvisionError(`${agentId} 的 Hermes Profile 不存在。`);

    const envPath = path.join(profileDir, '.env');
    const existing = await fs.readFile(envPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const values = {
      FEISHU_APP_ID:appId,
      FEISHU_APP_SECRET:appSecret,
      FEISHU_ALLOWED_USERS:allowedUserIds.join(','),
      FEISHU_CONNECTION_MODE:'websocket',
      FEISHU_GROUP_POLICY:'allowlist',
      FEISHU_REQUIRE_MENTION:'true',
      FEISHU_ALLOW_BOTS:'none',
      FEISHU_ALLOW_ALL_USERS:'false'
    };
    await fs.writeFile(envPath, mergeEnv(existing, values), { mode:0o600 });
    await fs.chmod(envPath, 0o600);
    results.push({ agentId, profileDir, configured:true, keys:[...MANAGED_KEYS] });
  }

  return results;
}

export function mergeEnv(existing, values) {
  const managed = new Set(MANAGED_KEYS);
  const retained = String(existing || '').split(/\r?\n/).filter((line) => {
    const key = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1];
    return !key || !managed.has(key);
  });
  while (retained.length && retained.at(-1) === '') retained.pop();
  const managedLines = MANAGED_KEYS.map((key) => `${key}=${quoteEnv(values[key])}`);
  return `${retained.length ? `${retained.join('\n')}\n` : ''}${managedLines.join('\n')}\n`;
}

function normalizeAgentIds(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((item) => String(item || '').trim()).filter((item) => ALLOWED_AGENTS.has(item)))];
}

function normalizeList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function safeProfileDirectory(profileRoot, agentId) {
  const root = path.resolve(String(profileRoot || ''));
  const candidate = path.resolve(root, agentId);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new ProvisionError('Hermes Profile 路径越界。');
  return candidate;
}

function safeExistingDirectory(value) {
  const candidate = path.resolve(String(value || ''));
  if (!candidate || candidate === path.parse(candidate).root) {
    throw new ProvisionError('默认 Hermes Home 路径无效。');
  }
  return candidate;
}

function quoteEnv(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n')}"`;
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ProvisionError('找不到本机员工飞书应用私有存储。');
    if (error instanceof SyntaxError) throw new ProvisionError('本机员工飞书应用私有存储格式无效。');
    throw error;
  }
}

export class ProvisionError extends Error {}

async function main() {
  const agentIds = process.argv.slice(2);
  try {
    const results = await provisionHermesEmployeeFeishu({ agentIds });
    for (const result of results) console.log(`已安全配置 ${result.agentId} 的 Hermes 飞书入口；未输出任何凭据。`);
  } catch (error) {
    console.error(error instanceof ProvisionError ? error.message : 'Hermes 员工飞书入口配置失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
