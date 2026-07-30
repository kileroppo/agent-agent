import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContentAcquisitionCenter } from '../../../integrations/access/content-acquisition-center.js';
import { WeChatLocalVaultAdapter } from '../../../integrations/access/wechat-local-vault-adapter.js';
import { WECHAT_CHAT_AGENT_ID, WECHAT_CHAT_CAPABILITY, wechatApprovalScope } from './wechat-chat-defaults.js';

export class LocalWeChatChatRetriever {
  constructor({
    store,
    skillDir = process.env.WECHAT_VAULT_SKILL_DIR || path.join(os.homedir(), 'Documents/work/AIcode/skills-lib/yichen-wechat-local-vault'),
    pythonPath = process.env.WECHAT_VAULT_PYTHON || path.join(os.homedir(), 'Library/Application Support/wechat-local-vault/runtime-venv/bin/python'),
    reportsDir = process.env.WECHAT_VAULT_REPORTS_DIR || path.join(os.homedir(), 'Library/Application Support/wechat-local-vault/reports'),
    runCli = null,
    refreshVault = null,
    now = () => new Date()
  } = {}) {
    if (!store) throw new Error('微信聊天取件员必须连接 A君任务存储。');
    this.store = store;
    this.skillDir = path.resolve(skillDir);
    this.pythonPath = path.resolve(pythonPath);
    this.reportsDir = path.resolve(reportsDir);
    this.vaultCliPath = path.join(this.skillDir, 'scripts/vault_cli.py');
    this.decryptScriptPath = path.join(this.skillDir, 'scripts/decrypt_all_dbs.py');
    this.runCli = runCli || ((args) => runJsonCommand(this.pythonPath, this.vaultCliPath, args));
    this.refreshVault = refreshVault || (() => runQuietCommand(this.pythonPath, this.decryptScriptPath, ['--mode', 'incremental']));
    this.now = now;
  }

  async execute(task) {
    const request = task?.input?.wechatChat || {};
    if (!request.chatSelector) throw safeError('wechat_chat_required', '请告诉我联系人或群名；其余范围使用默认值。');
    const approval = await this.approvedScope(task);
    const consumedAt = this.now().toISOString();
    await this.store.updateApproval(approval.approvalId, { consumedAt });
    const consumedApproval = { ...approval, consumedAt };
    await this.refreshVault();
    const selectedChat = await this.resolveSingleChat(request.chatSelector);
    const adapter = new WeChatLocalVaultAdapter({
      scopeResolver:async (approvalRef) => this.resolveAdapterScope(task, consumedApproval, approvalRef, selectedChat.username),
      runVaultQuery:({ chat, startTime, endTime, limit }) => this.runCli([
        'history', chat,
        '--start-time', cliLocalTime(startTime),
        '--end-time', cliLocalTime(endTime),
        '--limit', String(limit),
        '--format', 'json'
      ]),
      now:this.now
    });
    const center = new ContentAcquisitionCenter({
      adapters:[adapter],
      connectionBroker:null,
      operations:{ async record() {} }
    });
    const acquired = await center.fetch({
      taskId:task.taskId,
      source:`wechat-vault://local/chat?approval=${encodeURIComponent(consumedApproval.approvalId)}`,
      requestedCapabilities:[WECHAT_CHAT_CAPABILITY],
      requestingAgentId:WECHAT_CHAT_AGENT_ID,
      runtimeRequirement:'wechat_chat_read'
    });
    if (!acquired.ok) throw safeError(acquired.code, acquired.safeMessage);
    const slice = acquired.contentPackage.contentItems.chat_slice;
    const report = buildPrivateReport({ task, request, slice, selectedChat, now:this.now() });
    const reportPath = await this.writeReport(task.taskId, report);
    return {
      status:'succeeded',
      currentStage:'wechat_chat_slice_ready',
      execution:{
        ...(task.execution || {}),
        owner:'ajun-local',
        mode:'on-demand',
        modelUsed:false,
        finishedAt:this.now().toISOString(),
        outcome:'succeeded'
      },
      artifactRefs:[{
        artifactId:`wechat-chat-report:${task.taskId}`,
        type:'wechat_chat_retrieval_report',
        title:'微信聊天只读结果证明',
        uri:`file://${reportPath}`,
        data:{
          containsRawChat:false,
          chatLabel:report.chatLabel,
          messageCount:report.messageCount,
          firstMessageAt:report.firstMessageAt,
          lastMessageAt:report.lastMessageAt,
          typeCounts:report.typeCounts,
          scope:report.scope,
          modelUsed:false,
          externalSideEffects:0
        },
        validation:{ exists:true, readable:true, nonEmpty:true, containsRawChat:false, checkedAt:this.now().toISOString() }
      }]
    };
  }

  async approvedScope(task) {
    const approvals = await this.store.listApprovals();
    const expected = wechatApprovalScope(task);
    const approval = approvals.find((item) =>
      item.taskId === task.taskId
      && item.action === 'wechat-private-chat-read'
      && item.status === 'approved'
    );
    if (!approval) throw safeError('approval_required', '本次微信聊天读取尚未获得负责人确认。');
    if (approval.consumedAt) throw safeError('approval_consumed', '本次微信聊天读取确认已经使用过，请重新发起任务。');
    if (JSON.stringify(approval.requestedScope || {}) !== JSON.stringify(expected)) {
      throw safeError('scope_not_granted', '审批范围与当前微信聊天任务不一致，未读取。');
    }
    return approval;
  }

  async resolveAdapterScope(task, approval, approvalRef, resolvedChatId) {
    const scope = approval.requestedScope;
    return {
      status:approval.status,
      approvalRef,
      requestingAgentId:WECHAT_CHAT_AGENT_ID,
      taskId:task.taskId,
      chatSelector:resolvedChatId,
      startTime:scope.startTime,
      endTime:scope.endTime,
      maxMessages:scope.maxMessages,
      expiresAt:approval.validUntil
    };
  }

  async resolveSingleChat(chatSelector) {
    const [contactsPayload, sessionsPayload] = await Promise.all([
      this.runCli(['contacts', '--query', chatSelector, '--limit', '50', '--format', 'json']),
      this.runCli(['sessions', '--limit', '500', '--format', 'json'])
    ]);
    const normalized = String(chatSelector).trim().toLocaleLowerCase('zh-Hans-CN');
    const contacts = Array.isArray(contactsPayload?.contacts) ? contactsPayload.contacts : [];
    const exact = contacts.filter((item) =>
      ['display_name', 'remark', 'nick_name', 'alias']
        .some((field) => String(item?.[field] || '').trim().toLocaleLowerCase('zh-Hans-CN') === normalized)
    );
    if (exact.length === 0) throw safeError('wechat_chat_not_found', `没有找到“${safeLabel(chatSelector)}”这个联系人或群。`);
    if (exact.length === 1) return { username:String(exact[0].username), strategy:'unique-exact-match' };
    const sessionTimes = new Map(
      (Array.isArray(sessionsPayload) ? sessionsPayload : [])
        .map((item) => [String(item?.username || ''), Number(item?.timestamp) || 0])
    );
    const active = exact
      .map((item) => ({ item, timestamp:sessionTimes.get(String(item.username)) || 0 }))
      .filter((entry) => entry.timestamp > 0)
      .sort((left, right) => right.timestamp - left.timestamp);
    if (!active.length || (active[1] && active[0].timestamp === active[1].timestamp)) {
      throw safeError('wechat_chat_ambiguous', `找到多个同名“${safeLabel(chatSelector)}”，且无法唯一判断最近活跃会话。`);
    }
    return { username:String(active[0].item.username), strategy:'latest-active-session' };
  }

  async writeReport(taskId, report) {
    await fs.mkdir(this.reportsDir, { recursive:true, mode:0o700 });
    await fs.chmod(this.reportsDir, 0o700);
    const reportPath = path.join(this.reportsDir, `${safeFileName(taskId)}.json`);
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode:0o600 });
    await fs.chmod(reportPath, 0o600);
    return reportPath;
  }
}

function buildPrivateReport({ task, request, slice, selectedChat, now }) {
  const messages = Array.isArray(slice?.messages) ? slice.messages : [];
  const typeCounts = {};
  for (const message of messages) {
    const type = String(message?.type || '未知').slice(0, 80);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }
  const times = messages.map((item) => String(item?.time || '')).filter(Boolean).sort();
  const safeCore = {
    taskId:task.taskId,
    chatLabel:safeLabel(request.chatSelector),
    messageCount:messages.length,
    firstMessageAt:times[0] || null,
    lastMessageAt:times.at(-1) || null,
    typeCounts,
    scope:{ startTime:request.startTime, endTime:request.endTime, maxMessages:request.maxMessages },
    selectionStrategy:selectedChat.strategy
  };
  return {
    schemaVersion:'agent.army/wechat-chat-retrieval-report/v1',
    createdAt:now.toISOString(),
    containsRawChat:false,
    containsSenderIdentifiers:false,
    modelUsed:false,
    externalSideEffects:0,
    ...safeCore,
    evidenceChecksum:crypto.createHash('sha256').update(JSON.stringify(safeCore)).digest('hex')
  };
}

function runJsonCommand(command, script, args) {
  return runCommand(command, [script, ...args], { capture:true }).then((output) => {
    try {
      return JSON.parse(output);
    } catch {
      throw safeError('wechat_vault_invalid_result', '微信 Vault 返回了无法解析的结果。');
    }
  });
}

function runQuietCommand(command, script, args) {
  return runCommand(command, [script, ...args], { capture:false }).then(() => undefined);
}

function runCommand(command, args, { capture }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(safeError('wechat_vault_timeout', '微信 Vault 本次读取超时。'));
    }, 120_000);
    if (capture) child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 5_000_000) child.kill('SIGTERM');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(safeError('wechat_vault_unavailable', '本机微信 Vault 入口不可用。'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 5_000_000) {
        reject(safeError('wechat_vault_unavailable', '微信 Vault 本次读取失败。'));
      } else {
        resolve(output);
      }
    });
  });
}

function safeError(code, message) {
  return Object.assign(new Error(message), { code, category:'manual', retryable:false });
}

function safeLabel(value) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80);
}

function safeFileName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || crypto.randomUUID();
}

function cliLocalTime(value) {
  const date = new Date(value);
  return [
    date.getFullYear(), '-',
    String(date.getMonth() + 1).padStart(2, '0'), '-',
    String(date.getDate()).padStart(2, '0'), ' ',
    String(date.getHours()).padStart(2, '0'), ':',
    String(date.getMinutes()).padStart(2, '0'), ':',
    String(date.getSeconds()).padStart(2, '0')
  ].join('');
}
