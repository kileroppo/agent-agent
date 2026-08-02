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
  const adapter = new GrokConsultMcpAdapter({ serverPath, authPath, invokeMcp:async (input) => { request = input; return { isError:false, content:[{ type:'text', text:'公开结果' }] }; } });
  const result = await adapter.searchX({ query:'Agent', hours:12, maxResults:5 });
  assert.equal(request.tool, 'search_x_with_grok');
  assert.equal(request.arguments.max_results, 5);
  assert.equal(result.route, 'yichen-grok-consult-mcp');
});
