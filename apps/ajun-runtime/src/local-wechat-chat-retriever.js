import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContentAcquisitionCenter } from 'ajun-common-access/content-acquisition-center';
import { WeChatLocalVaultAdapter } from 'ajun-common-access/wechat-local-vault-adapter';
import { LocalPrivateChatAnalyzer } from './local-private-chat-analyzer.js';
import { consumePrivateReadGrant, privateReadGrantStatus, resolvePrivateReadGrant } from './private-read-grant.js';
import { WECHAT_CHAT_AGENT_ID, WECHAT_CHAT_CAPABILITY, wechatApprovalScope } from './wechat-chat-defaults.js';

export class LocalWeChatChatRetriever {
  constructor({
    store,
    skillDir = process.env.WECHAT_VAULT_SKILL_DIR || path.join(os.homedir(), 'Documents/work/AIcode/skills-lib/yichen-wechat-local-vault'),
    pythonPath = process.env.WECHAT_VAULT_PYTHON || path.join(os.homedir(), 'Library/Application Support/wechat-local-vault/runtime-venv/bin/python'),
    reportsDir = process.env.WECHAT_VAULT_REPORTS_DIR || path.join(os.homedir(), 'Library/Application Support/wechat-local-vault/reports'),
    runCli = null,
    refreshVault = null,
    checkHealth = null,
    analyzer = new LocalPrivateChatAnalyzer(),
    healthTtlMs = 30_000,
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
    this.checkHealth = checkHealth || (() => runJsonCommand(
      this.pythonPath,
      this.vaultCliPath,
      ['status', '--format', 'json'],
      { timeoutMs:10_000 }
    ));
    this.healthTtlMs = Math.max(1_000, Math.min(Number(healthTtlMs) || 30_000, 300_000));
    this.analyzer = analyzer;
    this.healthCache = null;
    this.now = now;
  }

  async health({ force = false, includeAnalysis = true } = {}) {
    const checkedAt = this.now();
    if (!force && this.healthCache && checkedAt.getTime() - this.healthCache.checkedAtMs < this.healthTtlMs) {
      return includeAnalysis ? this.withAnalysisHealth(this.healthCache.result) : this.healthCache.result;
    }
    let result;
    try {
      result = normalizeVaultHealth(await this.checkHealth(), checkedAt);
    } catch {
      result = {
        status:'unavailable',
        checkedAt:checkedAt.toISOString(),
        requiredDatabases:{ contact:false, session:false, message:false },
        safeMessage:'本机微信只读库健康检查失败，请由运维官检查本机运行环境。'
      };
    }
    this.healthCache = { checkedAtMs:checkedAt.getTime(), result };
    return includeAnalysis ? this.withAnalysisHealth(result) : result;
  }

  async withAnalysisHealth(vaultHealth) {
    if (vaultHealth.status !== 'healthy') return vaultHealth;
    const analysisModel = await this.analyzer.health();
    if (analysisModel.status === 'ready') return { ...vaultHealth, analysisModel };
    return {
      ...vaultHealth,
      status:'degraded',
      analysisModel,
      safeMessage:`微信只读库已就绪；${analysisModel.safeMessage}`,
    };
  }

  async execute(task) {
    const request = task?.input?.wechatChat || {};
    if (!request.chatSelector) throw safeError('wechat_chat_required', '请告诉我联系人或群名；其余范围使用默认值。');
    const health = await this.health({ includeAnalysis:false });
    if (health.status !== 'healthy') {
      throw safeError('wechat_vault_unavailable', health.safeMessage);
    }
    const needsLocalAnalysis = request.outputMode !== 'metadata-summary';
    if (needsLocalAnalysis) {
      const modelHealth = await this.analyzer.health();
      if (modelHealth.status !== 'ready') throw safeError('wechat_local_model_unavailable', modelHealth.safeMessage);
    }
    const granted = await this.approvedScope(task);
    await this.refreshVault();
    const selectedChat = await this.resolveSingleChat(request.chatSelector);
    const consumedGrant = consumePrivateReadGrant(granted.grant, { taskId:task.taskId, now:this.now() });
    await this.store.updateApproval(granted.approval.approvalId, { privateReadGrant:consumedGrant });
    const grantState = privateReadGrantStatus(consumedGrant, { now:this.now() });
    const adapter = new WeChatLocalVaultAdapter({
      scopeResolver:async (approvalRef) => this.resolveAdapterScope(task, granted.approval, consumedGrant, approvalRef, selectedChat.username),
      runVaultQuery:({ chat, startTime, endTime, limit }) => this.runCli([
        'history', chat,
        '--start-time', cliLocalTime(startTime),
        '--end-time', cliLocalTime(endTime),
        '--limit', String(limit),
        '--format', 'json'
      ]),
      healthStatus:health.status,
      now:this.now
    });
    const center = new ContentAcquisitionCenter({
      adapters:[adapter],
      connectionBroker:null,
      operations:{ async record() {} }
    });
    const acquired = await center.fetch({
      taskId:task.taskId,
      source:`wechat-vault://local/chat?approval=${encodeURIComponent(granted.approval.approvalId)}`,
      requestedCapabilities:[WECHAT_CHAT_CAPABILITY],
      requestingAgentId:WECHAT_CHAT_AGENT_ID,
      runtimeRequirement:'wechat_chat_read'
    });
    if (!acquired.ok) throw safeError(acquired.code, acquired.safeMessage);
    const slice = acquired.contentPackage.contentItems.chat_slice;
    const analysis = needsLocalAnalysis ? await this.analyzer.analyze(slice?.messages) : null;
    const report = buildPrivateReport({ task, request, slice, selectedChat, analysis, grantState, now:this.now() });
    const reportPath = await this.writeReport(task.taskId, report);
    return {
      status:'succeeded',
      currentStage:'wechat_chat_slice_ready',
      execution:{
        ...(task.execution || {}),
        owner:'ajun-local',
        mode:'on-demand',
        modelUsed:needsLocalAnalysis,
        modelBoundary:needsLocalAnalysis ? 'loopback-only' : 'none',
        finishedAt:this.now().toISOString(),
        outcome:'succeeded'
      },
      artifactRefs:[{
        artifactId:`wechat-chat-report:${task.taskId}`,
        type:needsLocalAnalysis ? 'wechat_chat_analysis_report' : 'wechat_chat_retrieval_report',
        title:needsLocalAnalysis ? '微信聊天本机分析报告' : '微信聊天只读结果证明',
        uri:`file://${reportPath}`,
        data:{
          containsRawChat:false,
          chatLabel:report.chatLabel,
          messageCount:report.messageCount,
          firstMessageAt:report.firstMessageAt,
          lastMessageAt:report.lastMessageAt,
          typeCounts:report.typeCounts,
          scope:report.scope,
          modelUsed:needsLocalAnalysis,
          modelBoundary:needsLocalAnalysis ? 'loopback-only' : 'none',
          analysis:analysis ? {
            summary:analysis.summary,
            topics:analysis.topics,
            decisions:analysis.decisions,
            todos:analysis.todos,
            risks:analysis.risks,
            replySuggestions:analysis.replySuggestions,
          } : null,
          grant:grantState,
          externalSideEffects:0
        },
        validation:{ exists:true, readable:true, nonEmpty:true, containsRawChat:false, checkedAt:this.now().toISOString() }
      }]
    };
  }

  async approvedScope(task) {
    const approvals = await this.store.listApprovals();
    const expected = wechatApprovalScope(task);
    const resolved = resolvePrivateReadGrant({ approvals, task, expectedScope:expected, now:this.now() });
    if (!resolved) throw safeError('approval_required', '本次微信聊天范围尚未获得负责人确认，或临时授权已失效。');
    if (resolved.created) {
      await this.store.updateApproval(resolved.approval.approvalId, { privateReadGrant:resolved.grant });
    }
    return resolved;
  }

  async resolveAdapterScope(task, approval, grant, approvalRef, resolvedChatId) {
    const scope = grant.scope;
    return {
      status:approval.status,
      approvalRef,
      requestingAgentId:WECHAT_CHAT_AGENT_ID,
      taskId:task.taskId,
      chatSelector:resolvedChatId,
      startTime:scope.startTime,
      endTime:scope.endTime,
      maxMessages:scope.maxMessages,
      expiresAt:grant.expiresAt
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

function buildPrivateReport({ task, request, slice, selectedChat, analysis, grantState, now }) {
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
    schemaVersion:analysis ? 'agent.army/wechat-chat-analysis-report/v1' : 'agent.army/wechat-chat-retrieval-report/v1',
    createdAt:now.toISOString(),
    containsRawChat:false,
    containsSenderIdentifiers:false,
    modelUsed:Boolean(analysis),
    modelBoundary:analysis ? 'loopback-only' : 'none',
    externalSideEffects:0,
    analysis:analysis || null,
    grant:grantState,
    ...safeCore,
    evidenceChecksum:crypto.createHash('sha256').update(JSON.stringify(safeCore)).digest('hex')
  };
}

function runJsonCommand(command, script, args, { timeoutMs = 120_000 } = {}) {
  return runCommand(command, [script, ...args], { capture:true, timeoutMs }).then((output) => {
    try {
      return JSON.parse(output);
    } catch {
      throw safeError('wechat_vault_invalid_result', '微信 Vault 返回了无法解析的结果。');
    }
  });
}

function runQuietCommand(command, script, args) {
  return runCommand(command, [script, ...args], { capture:false, timeoutMs:120_000 }).then(() => undefined);
}

function runCommand(command, args, { capture, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(safeError('wechat_vault_timeout', '微信 Vault 本次读取超时。'));
    }, timeoutMs);
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

function normalizeVaultHealth(payload, checkedAt) {
  const databases = Array.isArray(payload?.databases) ? payload.databases : [];
  const available = (matcher) => databases.some((item) => item?.available === true && matcher(String(item.path || '')));
  const requiredDatabases = {
    contact:available((value) => value === 'contact/contact.db'),
    session:available((value) => value === 'session/session.db'),
    message:available((value) => value.startsWith('message/') && value.endsWith('.db'))
  };
  const ready = payload?.exists === true && Object.values(requiredDatabases).every(Boolean);
  return {
    status:ready ? 'healthy' : payload?.exists === true ? 'degraded' : 'unavailable',
    checkedAt:checkedAt.toISOString(),
    requiredDatabases,
    safeMessage:ready
      ? '本机微信只读库已就绪。'
      : payload?.exists === true
        ? '本机微信只读库缺少联系人、会话或消息库，请先安全刷新。'
        : '本机微信只读库尚未初始化。'
  };
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
