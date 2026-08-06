import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GrokConsultMcpAdapter } from '../src/grok-consult-mcp-adapter.js';

test('未登录时明确失败且不调用插件或替代路线', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-adapter-'));
  const serverPath = path.join(root, 'server.mjs');
  await fs.writeFile(serverPath, '');
  let calls = 0;
  const adapter = new GrokConsultMcpAdapter({ serverPath, authPath:path.join(root, 'missing-auth.json'), invokeMcp:async () => { calls += 1; } });
  assert.equal((await adapter.health()).status, 'needs_login');
  await assert.rejects(() => adapter.searchX({ query:'Agent' }), (error) => error.code === 'grok_login_required');
  assert.equal(calls, 0);
});

test('只通过已安装 Grok MCP 的公开 X 工具执行', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-adapter-'));
  const serverPath = path.join(root, 'server.mjs');
  const authPath = path.join(root, 'auth.json');
  await fs.writeFile(serverPath, '');
  await fs.writeFile(authPath, '{}');
  let request;
  const adapter = new GrokConsultMcpAdapter({ serverPath, authPath, accessMode:'subscribed', invokeMcp:async (input) => { request = input; return { isError:false, content:[{ type:'text', text:'公开结果' }] }; } });
  const result = await adapter.searchX({ query:'Agent', hours:12, maxResults:5 });
  assert.equal(request.tool, 'search_x_with_grok');
  assert.equal(request.arguments.max_results, 5);
  assert.equal(result.route, 'yichen-grok-consult-mcp');
});

test('登录文件不冒充订阅额度，未订阅时不调用 Grok 插件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-adapter-'));
  const serverPath = path.join(root, 'server.mjs');
  const authPath = path.join(root, 'auth.json');
  await fs.writeFile(serverPath, '');
  await fs.writeFile(authPath, '{}');
  let calls = 0;
  const pending = new GrokConsultMcpAdapter({ serverPath, authPath, invokeMcp:async () => { calls += 1; } });
  assert.equal((await pending.health()).status, 'needs_subscription');
  await assert.rejects(() => pending.searchX({ query:'Agent' }), (error) => error.code === 'grok_account_unavailable');
  const disabled = new GrokConsultMcpAdapter({ serverPath, authPath, accessMode:'disabled', invokeMcp:async () => { calls += 1; } });
  assert.equal((await disabled.health()).status, 'not_enabled');
  await assert.rejects(() => disabled.searchX({ query:'Agent' }), (error) => error.code === 'grok_account_unavailable');
  assert.equal(calls, 0);
});
