import assert from 'node:assert/strict';
import test from 'node:test';
import { configureGovernanceHermesRuntime } from '../scripts/configure-governance-hermes-runtime.mjs';

test('治理员工配置复用 Paperclip 公司技能并只通过 Hermes 官方 CLI 配置 Profile', async () => {
  const commands = [];
  const copies = [];
  const removals = [];
  const result = await configureGovernanceHermesRuntime({
    agentIds:['architect'],
    profileHomeFor:() => '/tmp/agent-army-test-profiles/architect',
    stat:async () => ({ isDirectory:() => true }),
    copyFile:async (source, target) => { copies.push({ source, target, kind:'file' }); },
    copyDirectory:async (source, target) => { copies.push({ source, target, kind:'directory' }); },
    removeDirectory:async (target) => { removals.push(target); },
    run:async (command, args, options) => {
      commands.push({ command, args, options });
      return { code:command === '/bin/launchctl' && args[0] === 'print' ? 1 : 0 };
    },
    fetchImpl:async (url) => {
      const pathname = new URL(url).pathname;
      const payload = pathname === '/api/companies'
        ? [{ id:'company-1', name:'Agent军团' }]
        : [
            { slug:'paperclip', sourceLocator:'/opt/paperclip/skills/paperclip' },
            { slug:'paperclip-converting-plans-to-tasks', sourceLocator:'/opt/paperclip/skills/paperclip-converting-plans-to-tasks' }
          ];
      return { ok:true, async json() { return payload; } };
    }
  });

  assert.equal(result[0].agentId, 'architect');
  assert.deepEqual(result[0].skills, ['paperclip', 'paperclip-converting-plans-to-tasks']);
  assert.equal(copies.filter((item) => item.kind === 'directory').length, 2);
  assert.equal(removals.length, 2);
  assert.ok(commands.some((item) => item.args.includes('mcp') && item.args.includes('add')));
  assert.ok(commands.some((item) => item.args.includes('tools') && item.args.includes('disable') && item.args.includes('feishu')));
  assert.ok(commands.some((item) => item.args.includes('gateway') && item.args.includes('--start-on-login')));
  assert.ok(commands.some((item) => item.command === '/bin/launchctl' && item.args.includes('bootstrap')));
  assert.ok(commands.some((item) => item.command === '/bin/launchctl' && item.args.includes('kickstart')));
  const mcpAdd = commands.find((item) => item.args.includes('mcp') && item.args.includes('add'));
  assert.ok(mcpAdd.args.some((item) => item === 'AGENT_ARMY_AGENT_ID=architect'));
  assert.ok(mcpAdd.args.some((item) => item.includes('paperclip_assignment_complete')));
});
