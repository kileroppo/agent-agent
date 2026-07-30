import { spawn } from 'node:child_process';
import path from 'node:path';

const CAPABILITY = 'wechat.local-vault.chat.read';

export class WeChatLocalVaultAdapter {
  constructor({ scopeResolver, runVaultQuery = null, vaultCliPath = null, now = () => new Date() } = {}) {
    if (typeof scopeResolver !== 'function') throw new Error('微信 Vault 适配器必须配置逐次审批范围解析器。');
    this.id = 'yichen-wechat-local-vault';
    this.versionRef = 'controlled-v1';
    this.capabilities = [CAPABILITY];
    this.accessMode = 'private_scoped';
    this.priorityClass = 'specialized';
    this.healthStatus = 'healthy';
    this.runtimeRequirements = ['wechat_chat_read'];
    this.scopeResolver = scopeResolver;
    this.runVaultQuery = runVaultQuery || ((input) => defaultRunVaultQuery({ ...input, vaultCliPath }));
    this.now = now;
  }

  matches(source) {
    try {
      const parsed = new URL(source);
      return parsed.protocol === 'wechat-vault:' && parsed.hostname === 'local' && parsed.pathname === '/chat';
    } catch {
      return false;
    }
  }

  providerFor() {
    return 'wechat_local_vault';
  }

  async acquire({ source, requestedCapabilities, requestingAgentId, taskId }) {
    if (!Array.isArray(requestedCapabilities) || requestedCapabilities.length !== 1 || requestedCapabilities[0] !== CAPABILITY) {
      throw scopedError('scope_not_granted', '当前请求超出微信聊天只读能力范围。');
    }
    const approvalRef = approvalReference(source);
    const scope = await this.scopeResolver(approvalRef);
    const normalized = validateScope(scope, {
      approvalRef,
      requestingAgentId,
      taskId,
      now:this.now()
    });
    const payload = await this.runVaultQuery({
      chat:normalized.chatSelector,
      startTime:normalized.startTime,
      endTime:normalized.endTime,
      limit:normalized.maxMessages
    });
    const messages = normalizeMessages(payload?.messages, normalized);
    return {
      providedCapabilities:[CAPABILITY],
      contentItems:{
        chat_slice:{
          messageCount:messages.length,
          messages,
          scope:{
            startTime:normalized.startTime,
            endTime:normalized.endTime,
            maxMessages:normalized.maxMessages
          }
        }
      },
      runtime:{ kind:'wechat_chat_slice', ephemeral:true },
      validation:{
        exists:true,
        readable:true,
        accessScope:'private_scoped_read',
        perRequestApproval:true,
        approvalRef,
        singleChat:true,
        boundedTimeRange:true,
        rawDatabaseExposed:false,
        keyMaterialExposed:false
      },
      capabilityNotes:'只读取本次负责人批准的单一会话和时间范围；消息只在当前执行内存中流转。'
    };
  }
}

function approvalReference(source) {
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw scopedError('approval_required', '缺少有效的微信私聊逐次审批引用。');
  }
  const value = String(parsed.searchParams.get('approval') || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value)) {
    throw scopedError('approval_required', '缺少有效的微信私聊逐次审批引用。');
  }
  return value;
}

function validateScope(scope, { approvalRef, requestingAgentId, taskId, now }) {
  if (!scope || scope.status !== 'approved' || scope.approvalRef !== approvalRef) {
    throw scopedError('approval_required', '本次微信聊天读取尚未获得负责人逐次批准。');
  }
  if (scope.requestingAgentId !== requestingAgentId || scope.taskId !== taskId) {
    throw scopedError('scope_not_granted', '本次审批不属于当前 Agent 或任务。');
  }
  if (scope.expiresAt && Date.parse(scope.expiresAt) <= now.getTime()) {
    throw scopedError('approval_expired', '本次微信聊天读取审批已过期。');
  }
  if (typeof scope.chatSelector !== 'string' || !scope.chatSelector.trim() || Array.isArray(scope.chatSelector)) {
    throw scopedError('scope_not_granted', '本次审批必须只指定一个微信会话。');
  }
  const start = Date.parse(scope.startTime);
  const end = Date.parse(scope.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw scopedError('scope_not_granted', '本次审批必须包含有效的起止时间。');
  }
  if (end - start > 31 * 24 * 60 * 60 * 1000) {
    throw scopedError('scope_not_granted', '单次微信聊天读取范围不能超过 31 天。');
  }
  return {
    chatSelector:scope.chatSelector.trim(),
    startTime:new Date(start).toISOString(),
    endTime:new Date(end).toISOString(),
    maxMessages:Math.min(Math.max(Number(scope.maxMessages) || 50, 1), 200)
  };
}

function normalizeMessages(value, scope) {
  if (!Array.isArray(value)) throw scopedError('adapter_empty_result', '微信 Vault 没有返回可用消息。');
  const start = Date.parse(scope.startTime);
  const end = Date.parse(scope.endTime);
  return value.slice(0, scope.maxMessages).map((item) => {
    const timestamp = Number(item?.timestamp) * 1000;
    const parsedTime = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.parse(item?.time);
    if (!Number.isFinite(parsedTime) || parsedTime < start || parsedTime > end) {
      throw scopedError('scope_violation', '微信 Vault 返回了审批时间范围之外的消息。');
    }
    return {
      time:new Date(parsedTime).toISOString(),
      sender:String(item?.sender || '').slice(0, 160),
      type:String(item?.type || '未知').slice(0, 80),
      content:String(item?.content || '').slice(0, 20_000)
    };
  });
}

function defaultRunVaultQuery({ vaultCliPath, chat, startTime, endTime, limit }) {
  if (!vaultCliPath || !path.isAbsolute(vaultCliPath) || path.basename(vaultCliPath) !== 'vault_cli.py') {
    throw scopedError('tool_unavailable', '本机尚未配置微信 Vault 只读查询入口。');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [
      vaultCliPath,
      'history',
      chat,
      '--start-time', cliTime(startTime),
      '--end-time', cliTime(endTime),
      '--limit', String(limit),
      '--format', 'json'
    ], { stdio:['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(scopedError('adapter_unavailable', '微信 Vault 只读查询超时。'));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 5_000_000) child.kill('SIGTERM');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(scopedError('tool_unavailable', '本机微信 Vault 只读查询入口不可用。'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 5_000_000) {
        return reject(scopedError('adapter_unavailable', '微信 Vault 只读查询失败。'));
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(scopedError('adapter_unavailable', '微信 Vault 返回了无法解析的结果。'));
      }
    });
  });
}

function cliTime(value) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds())
  ].join('');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function scopedError(code, message) {
  return Object.assign(new Error(message), { code });
}
