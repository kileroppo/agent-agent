#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import { feishuRegisterAppOptions } from '../src/feishu-agent-provisioning-plan.js';
import { FileAgentFeishuAppStore } from '../src/agent-feishu-app-store.js';

const execFileAsync = promisify(execFile);
const agentId = String(process.argv[2] || '').trim();
const existingAppIdFlagIndex = process.argv.indexOf('--app-id');
const existingAppId = existingAppIdFlagIndex >= 0
  ? String(process.argv[existingAppIdFlagIndex + 1] || '').trim()
  : '';
if (!agentId) throw new Error('用法：node scripts/create-feishu-agent-app.mjs <agent-id>');
if (existingAppIdFlagIndex >= 0 && !existingAppId) {
  throw new Error('--app-id 后必须提供已有飞书应用 ID。');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'agents', agentId, 'manifest.json'), 'utf8'));
if (manifest.status !== 'active') throw new Error('该岗位尚未上岗，不能创建飞书智能体应用。');
const options = feishuRegisterAppOptions(manifest);
const store = new FileAgentFeishuAppStore();
// The SDK's device-code poller is unref'ed. Keep this CLI alive until the
// owner scans, otherwise Node can exit immediately after printing the QR URL.
const keepAlive = setInterval(() => {}, 1_000);
try {
  const result = await lark.registerApp({
    ...options,
    ...(existingAppId ? { appId: existingAppId, createOnly: false } : {}),
    source:'agent-army',
    onQRCodeReady(info) {
      console.log(existingAppId
        ? '已打开已有应用的飞书授权页，请确认更新。'
        : '已打开飞书创建页，请确认创建。');
      void execFileAsync('open', [info.url]).catch(() => {
        console.log('无法自动打开飞书页面，请从浏览器历史中打开最新的飞书授权页。');
      });
    },
    onStatusChange(info) { if (info.status === 'slow_down') console.log('飞书正在确认，请稍等。'); }
  });
  const ownerOpenId = String(result.user_info?.open_id || '').trim();
  if (!ownerOpenId) throw new Error('飞书没有返回创建人身份；应用已创建，但未写入本机允许名单。');
  await store.saveSecret(agentId, result.client_secret);
  await store.upsertApp({ agentId, appId:result.client_id, allowedUserIds:[ownerOpenId], allowedGroupIds:[] });
  console.log(`${manifest.name} 的飞书智能体应用已创建并写入受控本机配置。重启 A君运行台后才会连接。`);
} catch (error) {
  console.error(`飞书应用接入失败：${String(error?.code || error?.name || 'unknown_error')}`);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
