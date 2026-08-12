import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentArmyMcpServer } from '../src/agent-army-mcp-server.js';

test('MCP 单任务和多人任务都保留 Hermes Gateway 动态卡投递契约', async (t) => {
  const calls = [];
  const server = createAgentArmyMcpServer({
    client:{
      async createTask(input) {
        calls.push(['task', input]);
        return {
          taskId:'task-card',
          completionDelivery:input.completionDelivery,
          presentation:{
            statusLabel:'处理中',
            summary:'任务正在处理。',
            taskRef:'#TASKCARD',
            nextAction:'等待结果即可。',
          },
        };
      },
      async createMission(input) {
        calls.push(['mission', input]);
        return {
          mission:{ taskId:'mission-card' },
          children:[],
          completionDelivery:input.completionDelivery,
        };
      },
    },
    scope:{
      agentIds:[],
      taskTypes:[],
      enforceToolAllowlist:false,
      allowedTools:['task_create', 'mission_create'],
      localAiCapabilities:[],
      allowMissions:true,
    },
  });
  const client = new Client({ name:'completion-delivery-test', version:'1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name:'task_create',
    arguments:{
      title:'建立一张动态任务卡',
      task_type:'media.transcribe-and-refine',
      agent_id:'xiaod',
      chat_ref:'oc_owner',
      completion_delivery:{ mode:'dynamic_card', owner:'hermes_gateway' },
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls[0][1].completionDelivery, {
    mode:'dynamic_card',
    owner:'hermes_gateway',
  });
  assert.deepEqual(result.structuredContent.completionDelivery, {
    mode:'dynamic_card',
    owner:'hermes_gateway',
  });

  const mission = await client.callTool({
    name:'mission_create',
    arguments:{
      title:'建立动态卡多人任务',
      items:[{
        title:'整理公开视频',
        task_type:'media.transcribe-and-refine',
        agent_id:'xiaod',
      }],
      chat_ref:'oc_owner',
      completion_delivery:{ mode:'dynamic_card', owner:'hermes_gateway' },
    },
  });

  assert.equal(mission.isError, undefined);
  assert.deepEqual(calls[1][1].completionDelivery, {
    mode:'dynamic_card',
    owner:'hermes_gateway',
  });
  assert.deepEqual(mission.structuredContent.completionDelivery, {
    mode:'dynamic_card',
    owner:'hermes_gateway',
  });
});
