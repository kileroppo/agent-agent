#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  AGENT_ARMY_REPOSITORY_ROOT,
  GOVERNANCE_HERMES_AGENT_IDS,
  hermesProfileHome
} from '../src/governance-hermes-runtime.ts';

const scriptPath = fileURLToPath(import.meta.url);

export function verifyGovernanceFeishuAcceptance({
  agentIds = GOVERNANCE_HERMES_AGENT_IDS,
  marker = '青松',
  continuityAgentId = 'creator',
  profileHomeFor = hermesProfileHome,
  readManifest = (agentId) => JSON.parse(fs.readFileSync(
    path.join(AGENT_ARMY_REPOSITORY_ROOT, 'agents', agentId, 'manifest.json'),
    'utf8'
  )),
  inspectLaunchAgent = inspectLaunchAgentFromSystem,
  inspectProfile = inspectHermesProfile
} = {}) {
  const employees = agentIds.map((agentId) => {
    const manifest = readManifest(agentId);
    const launchAgent = inspectLaunchAgent(agentId);
    const profile = inspectProfile(profileHomeFor(agentId), marker);
    const crossedRestart = agentId === continuityAgentId
      && launchAgent.startedAtMs > 0
      && profile.firstMessageAtMs > 0
      && profile.lastMessageAtMs > launchAgent.startedAtMs
      && profile.firstMessageAtMs < launchAgent.startedAtMs
      && profile.userMessages >= 2
      && profile.assistantMessages >= 2;
    return {
      agentId,
      name:manifest.name,
      gatewayRunning:launchAgent.running,
      gatewayPid:launchAgent.pid,
      feishuSessions:profile.sessionCount,
      userMessages:profile.userMessages,
      assistantMessages:profile.assistantMessages,
      markerSeenInUser:profile.markerSeenInUser,
      markerSeenInAssistant:profile.markerSeenInAssistant,
      sessionFingerprint:profile.sessionFingerprint,
      crossedRestart
    };
  });
  const fingerprints = employees.map((item) => item.sessionFingerprint).filter(Boolean);
  const isolatedSessions = fingerprints.length === employees.length
    && new Set(fingerprints).size === fingerprints.length;
  const allDirectChatsPassed = employees.every((item) => (
    item.gatewayRunning
    && item.feishuSessions >= 1
    && item.userMessages >= 1
    && item.assistantMessages >= 1
    && item.markerSeenInUser
    && item.markerSeenInAssistant
  ));
  const restartContinuityPassed = employees.some((item) => item.agentId === continuityAgentId && item.crossedRestart);
  return {
    passed:allDirectChatsPassed && isolatedSessions && restartContinuityPassed,
    marker,
    continuityAgentId,
    isolatedSessions,
    allDirectChatsPassed,
    restartContinuityPassed,
    employees
  };
}

function inspectHermesProfile(profileHome, marker) {
  const databasePath = path.join(profileHome, 'state.db');
  if (!fs.existsSync(databasePath)) return emptyProfileResult();
  const database = new DatabaseSync(databasePath, { readOnly:true });
  try {
    const sessionCount = Number(database.prepare(
      "SELECT count(*) AS count FROM sessions WHERE source='feishu'"
    ).get()?.count || 0);
    const session = database.prepare(`
      SELECT id, session_key
      FROM sessions
      WHERE source='feishu'
      ORDER BY started_at DESC
      LIMIT 1
    `).get();
    if (!session) return { ...emptyProfileResult(), sessionCount };
    const messages = database.prepare(`
      SELECT
        sum(CASE WHEN role='user' THEN 1 ELSE 0 END) AS user_messages,
        sum(CASE WHEN role='assistant' THEN 1 ELSE 0 END) AS assistant_messages,
        sum(CASE WHEN role='user' AND content LIKE ? THEN 1 ELSE 0 END) AS user_marker,
        sum(CASE WHEN role='assistant' AND content LIKE ? THEN 1 ELSE 0 END) AS assistant_marker,
        min(timestamp) AS first_message_at,
        max(timestamp) AS last_message_at
      FROM messages
      WHERE session_id=? AND active=1
    `).get(`%${marker}%`, `%${marker}%`, session.id);
    return {
      sessionCount,
      userMessages:Number(messages?.user_messages || 0),
      assistantMessages:Number(messages?.assistant_messages || 0),
      markerSeenInUser:Number(messages?.user_marker || 0) > 0,
      markerSeenInAssistant:Number(messages?.assistant_marker || 0) > 0,
      firstMessageAtMs:Number(messages?.first_message_at || 0) * 1000,
      lastMessageAtMs:Number(messages?.last_message_at || 0) * 1000,
      sessionFingerprint:fingerprint(session.session_key || session.id)
    };
  } finally {
    database.close();
  }
}

function inspectLaunchAgentFromSystem(agentId) {
  const label = `ai.hermes.gateway-${agentId}`;
  try {
    const output = execFileSync('launchctl', ['print', `gui/${os.userInfo().uid}/${label}`], {
      encoding:'utf8',
      stdio:['ignore', 'pipe', 'ignore']
    });
    const pid = Number(output.match(/^\s*pid = (\d+)$/m)?.[1] || 0);
    let startedAtMs = 0;
    if (pid > 0) {
      const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding:'utf8',
        stdio:['ignore', 'pipe', 'ignore']
      }).trim();
      startedAtMs = Date.parse(started) || 0;
    }
    return { running:/^\s*state = running$/m.test(output), pid, startedAtMs };
  } catch {
    return { running:false, pid:0, startedAtMs:0 };
  }
}

function emptyProfileResult() {
  return {
    sessionCount:0,
    userMessages:0,
    assistantMessages:0,
    markerSeenInUser:false,
    markerSeenInAssistant:false,
    firstMessageAtMs:0,
    lastMessageAtMs:0,
    sessionFingerprint:''
  };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function printHuman(result) {
  for (const item of result.employees) {
    console.log([
      item.name,
      item.gatewayRunning ? `Gateway运行中(PID ${item.gatewayPid})` : 'Gateway未运行',
      `飞书会话${item.feishuSessions}`,
      `老板消息${item.userMessages}`,
      `员工回复${item.assistantMessages}`,
      item.markerSeenInAssistant ? '代号命中' : '代号未命中',
      item.crossedRestart ? '跨重启连续' : ''
    ].filter(Boolean).join(' | '));
  }
  console.log(`会话隔离：${result.isolatedSessions ? '通过' : '未通过'}`);
  console.log(`六人真实私聊：${result.allDirectChatsPassed ? '通过' : '未通过'}`);
  console.log(`重启连续追问：${result.restartContinuityPassed ? '通过' : '未通过'}`);
  console.log(`总结果：${result.passed ? 'PASS' : 'FAIL'}`);
}

async function main() {
  const json = process.argv.includes('--json');
  const markerIndex = process.argv.indexOf('--marker');
  const marker = markerIndex >= 0 ? String(process.argv[markerIndex + 1] || '').trim() : '青松';
  if (!marker) throw new Error('验收代号不能为空。');
  const result = verifyGovernanceFeishuAcceptance({ marker });
  if (json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error?.message || '治理员工飞书验收失败。');
    process.exitCode = 1;
  });
}
