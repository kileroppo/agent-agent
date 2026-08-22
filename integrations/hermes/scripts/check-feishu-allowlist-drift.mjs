#!/usr/bin/env node

/**
 * Feishu allowlist drift detector.
 *
 * Compares the军团 side allowedUserIds (from feishu-agent-apps.json)
 * against the Hermes gateway side FEISHU_ALLOWED_USERS (from profile .env).
 *
 * Reports drift status WITHOUT outputting any actual user IDs or secrets.
 *
 * Exit codes:
 *   0 = aligned
 *   1 = drift detected or error
 *
 * See .kiro/specs/feishu-commander-no-reply-fix/bugfix.md §1.30–1.33, §2.38–2.42.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, '../../..');

export function parseEnvValue(raw) {
  const trimmed = String(raw || '').trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  return trimmed;
}

export function extractManagedKey(envContent, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm');
  const match = envContent.match(pattern);
  if (!match) return null;
  return parseEnvValue(match[1]);
}

export function parseIdSet(value) {
  if (!value) return new Set();
  return new Set(value.split(',').map((id) => id.trim()).filter(Boolean));
}

export async function checkFeishuAllowlistDrift({
  agentId = 'ajun',
  privateDir = process.env.AGENT_ARMY_PRIVATE_DIR || path.join(os.homedir(), '.agent-army'),
  hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'),
  profileRoot = process.env.AGENT_ARMY_HERMES_PROFILE_ROOT || path.join(os.homedir(), '.hermes', 'profiles'),
} = {}) {
  const appStorePath = path.join(privateDir, 'feishu-agent-apps.json');
  let appDocument;
  try {
    appDocument = JSON.parse(await fs.readFile(appStorePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'error', reason: 'private-store-not-found', path: appStorePath };
    }
    return { status: 'error', reason: 'private-store-invalid', path: appStorePath };
  }

  const apps = Array.isArray(appDocument?.apps) ? appDocument.apps : [];
  const app = apps.find((item) => item?.agentId === agentId);
  if (!app) {
    return { status: 'error', reason: 'agent-not-in-store', agentId };
  }

  const armySide = parseIdSet(
    Array.isArray(app.allowedUserIds) ? app.allowedUserIds.join(',') : String(app.allowedUserIds || '')
  );

  const profileDir = agentId === 'ajun'
    ? hermesHome
    : path.join(profileRoot, agentId);
  const envPath = path.join(profileDir, '.env');

  let envContent;
  try {
    envContent = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'error', reason: 'profile-env-not-found', path: envPath, agentId };
    }
    return { status: 'error', reason: 'profile-env-unreadable', path: envPath, agentId };
  }

  const gatewayRaw = extractManagedKey(envContent, 'FEISHU_ALLOWED_USERS');
  if (gatewayRaw === null) {
    return { status: 'error', reason: 'key-not-in-profile-env', agentId, key: 'FEISHU_ALLOWED_USERS' };
  }
  const gatewaySide = parseIdSet(gatewayRaw);

  const armyOnly = [...armySide].filter((id) => !gatewaySide.has(id));
  const gatewayOnly = [...gatewaySide].filter((id) => !armySide.has(id));
  const aligned = armyOnly.length === 0 && gatewayOnly.length === 0;

  return {
    status: aligned ? 'aligned' : 'drift',
    agentId,
    armySideCount: armySide.size,
    gatewaySideCount: gatewaySide.size,
    armyOnlyCount: armyOnly.length,
    gatewayOnlyCount: gatewayOnly.length,
    profileDir,
    // NOTE: Never output actual user IDs — only counts and alignment status.
  };
}

function formatResult(result) {
  if (result.status === 'error') {
    return `白名单漂移检测错误：${result.reason}（${result.agentId || '?'}）`;
  }
  if (result.status === 'aligned') {
    return `白名单已对齐（${result.agentId}）：军团侧 ${result.armySideCount} 人，网关侧 ${result.gatewaySideCount} 人。`;
  }
  const parts = [`白名单漂移（${result.agentId}）：`];
  if (result.armyOnlyCount > 0) {
    parts.push(`军团侧多出 ${result.armyOnlyCount} 人（网关侧缺失，消息会被静默丢弃）`);
  }
  if (result.gatewayOnlyCount > 0) {
    parts.push(`网关侧多出 ${result.gatewayOnlyCount} 人（军团侧未授权）`);
  }
  parts.push(`军团侧 ${result.armySideCount} 人，网关侧 ${result.gatewaySideCount} 人。`);
  parts.push('运行 provision-hermes-employee-feishu.mjs 同步，然后重启 Gateway。');
  return parts.join('；');
}

async function main() {
  const agentIds = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['ajun'];

  let hasDrift = false;
  for (const agentId of agentIds) {
    const result = await checkFeishuAllowlistDrift({ agentId });
    console.log(formatResult(result));
    if (result.status === 'drift') hasDrift = true;
    if (result.status === 'error') hasDrift = true;
  }
  process.exitCode = hasDrift ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
