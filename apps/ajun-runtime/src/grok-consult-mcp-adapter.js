import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SERVER = path.join(os.homedir(), '.codex/plugins/cache/yichen-skills/yichen-grok-consult/0.1.0/mcp/server.mjs');

export class GrokConsultMcpAdapter {
  constructor({
    serverPath = process.env.YICHEN_GROK_MCP_SERVER || DEFAULT_SERVER,
    authPath = path.join(os.homedir(), '.grok/auth.json'),
    accessMode = process.env.AGENT_ARMY_GROK_ACCESS || 'auto',
    invokeMcp = invokeStdioMcp,
  } = {}) {
    this.serverPath = path.resolve(serverPath);
    this.authPath = path.resolve(authPath);
    this.accessMode = normalizeGrokAccessMode(accessMode);
    this.invokeMcp = invokeMcp;
  }

  async health() {
    if (this.accessMode === 'disabled') {
      return { status:'not_enabled', safeMessage:'当前未订阅 Grok，已停用；小R继续使用网页研究和统一搜索。' };
    }
    const [server, auth] = await Promise.all([exists(this.serverPath), exists(this.authPath)]);
    if (!server) return { status:'unavailable', safeMessage:'Grok 受控插件服务未安装。' };
    if (!auth) return { status:'needs_login', safeMessage:'请在本机终端运行 grok login；Agent 不会代填账号。' };
    if (this.accessMode !== 'subscribed') {
      return { status:'needs_subscription', safeMessage:'已登录，但未确认 Grok 订阅额度可用。' };
    }
    return { status:'ready', safeMessage:'Grok 受控只读插件已就绪。' };
  }

  async searchX({ query, hours = 24, maxResults = 10 } = {}) {
    const health = await this.health();
    if (health.status !== 'ready') {
      const code = health.status === 'needs_login' ? 'grok_login_required' : 'grok_account_unavailable';
      throw grokError(code, health.safeMessage);
    }
    const result = await this.invokeMcp({
      serverPath:this.serverPath,
      tool:'search_x_with_grok',
      arguments:{ query:String(query || '').trim().slice(0, 2_000), hours, max_results:maxResults, timezone:'Asia/Shanghai' },
    });
    if (result?.isError) throw grokError('grok_consult_failed', safePluginMessage(result));
    return {
      text:String(result?.content?.find((item) => item.type === 'text')?.text || '').slice(0, 60_000),
      route:'yichen-grok-consult-mcp',
    };
  }
}

async function invokeStdioMcp({ serverPath, tool, arguments:args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio:['pipe', 'pipe', 'ignore'] });
    const initializeId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(grokError('grok_consult_timeout', 'Grok 受控查询超时。'));
    }, 600_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd < 0) break;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === initializeId) {
          child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0', method:'notifications/initialized', params:{} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0', id:callId, method:'tools/call', params:{ name:tool, arguments:args } })}\n`);
        }
        if (message.id === callId) {
          clearTimeout(timer);
          child.stdin.end();
          resolve(message.result || { isError:true, content:[{ type:'text', text:message.error?.message || 'Grok 插件调用失败。' }] });
        }
      }
    });
    child.on('error', () => { clearTimeout(timer); reject(grokError('grok_consult_unavailable', 'Grok 受控插件无法启动。')); });
    child.on('close', (code) => {
      if (code !== 0) { clearTimeout(timer); reject(grokError('grok_consult_unavailable', 'Grok 受控插件异常退出。')); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0', id:initializeId, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'agent-army', version:'1.0.0' } } })}\n`);
  });
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function safePluginMessage(result) {
  const text = String(result?.content?.find((item) => item.type === 'text')?.text || 'Grok 查询失败。');
  return /quota|余额|额度/i.test(text) ? 'Grok 账号额度已耗尽。' : 'Grok 查询失败；未切换到未批准的替代路线。';
}

function normalizeGrokAccessMode(value) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  return ['auto', 'subscribed', 'disabled'].includes(normalized) ? normalized : 'auto';
}

function grokError(code, message) {
  return Object.assign(new Error(message), { code, category:'manual', retryable:false });
}
