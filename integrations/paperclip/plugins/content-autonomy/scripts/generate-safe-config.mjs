#!/usr/bin/env node
import {
  M5_CONTENT_ROLES,
  M5_ROLE_TOOL_BUNDLES,
} from '../src/role-tool-bundles.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

const options = parseArgs(process.argv.slice(2));
const apiBase = loopbackApiBase(options['api-base'] || 'http://127.0.0.1:3100');
const companyId = uuid(options['company-id'], '--company-id 必须是 Paperclip Company UUID。');
const secretId = uuid(options['secret-id'], '--secret-id 必须是 Paperclip Secret UUID；脚本不读取 Secret 值。');
const budgetTicketPublicKey = await readPublicKey(options['budget-public-key-file']);

const agents = await readJson(`${apiBase}/api/companies/${encodeURIComponent(companyId)}/agents`);
const plugins = await readJson(`${apiBase}/api/plugins`);
const plugin = list(plugins).find((item) =>
  item?.pluginKey === 'agent-army.content-autonomy'
  || item?.manifestJson?.id === 'agent-army.content-autonomy',
);
if (!plugin?.id || plugin?.status !== 'ready') {
  if (!plugin?.id) fail('content-autonomy 插件尚未安装，未生成配置草案。');
}

const agentRoleBindings = Object.fromEntries(M5_CONTENT_ROLES.map((role) => {
  const matches = list(agents).filter((agent) =>
    agent?.metadata?.agentArmyId === role
    && agent?.adapterType === 'hermes_local'
    && ['idle', 'active', 'running'].includes(agent?.status),
  );
  if (matches.length !== 1) {
    fail(`岗位 ${role} 必须恰好匹配一个可用的 hermes_local Agent，当前为 ${matches.length} 个。`);
  }
  return [role, uuid(matches[0].id, `岗位 ${role} 的 Paperclip Agent UUID 无效。`)];
}));
if (new Set(Object.values(agentRoleBindings)).size !== M5_CONTENT_ROLES.length) {
  fail('8 个 M5 岗位没有映射到 8 个唯一 Agent UUID。');
}

const officialTtsVoices = ['vibrant-youth'];
const costRatesCents = {
  visionInputPerMillionTokens:35,
  visionOutputPerMillionTokens:112,
  imagePerGeneration:1,
  ttsPerThousandCharacters:9,
};

const agentToolGrants = Object.fromEntries(M5_CONTENT_ROLES.map((role) => [
  agentRoleBindings[role],
  [...M5_ROLE_TOOL_BUNDLES[role]],
]));
const draft = {
  stepfunSecretRef:{ type:'secret_ref', secretId, version:'latest' },
  budgetTicketPublicKey,
  stepfunBaseUrl:'https://api.stepfun.com/v1',
  stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
  officialTtsVoices,
  agentRoleBindings,
  agentToolGrants,
  costRatesCents,
};
process.stdout.write(`${JSON.stringify(draft, null, 2)}\n`);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) {
      fail(`参数无效：${key || '(empty)'}`);
    }
    parsed[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return parsed;
}

function loopbackApiBase(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    fail('--api-base 只允许本机 Paperclip HTTP 地址。');
  }
  return url.toString().replace(/\/$/, '');
}

async function readJson(url) {
  const response = await fetch(url, { headers:{ accept:'application/json' } });
  if (!response.ok) fail(`Paperclip 只读请求失败：HTTP ${response.status}。`);
  return response.json();
}

function uuid(value, message) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) fail(message);
  return id;
}

function list(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readPublicKey(value) {
  const file = path.resolve(String(value || ''));
  if (!String(value || '').trim()) fail('--budget-public-key-file 缺失。');
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch {
    fail('预算票据公钥文件不可读。');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('预算票据公钥必须是普通文件。');
  const content = await fs.readFile(file, 'utf8');
  if (!content.includes('BEGIN PUBLIC KEY') || content.length > 1000) {
    fail('预算票据公钥格式无效。');
  }
  return content;
}
