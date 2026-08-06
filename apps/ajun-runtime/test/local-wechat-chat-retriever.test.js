import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalWeChatChatRetriever } from '../src/local-wechat-chat-retriever.js';
import { wechatApprovalScope } from '../src/wechat-chat-defaults.js';

function healthyVaultStatus() {
  return {
    exists:true,
    databases:[
      { path:'contact/contact.db', available:true },
      { path:'session/session.db', available:true },
      { path:'message/message_0.db', available:true }
    ]
  };
}

function fixture() {
  const task = {
    taskId:'wechat-task-1',
    taskType:'wechat.chat.retrieval',
    assigneeAgentId:'wechat-chat-retriever',
    input:{
      title:'读取 yingz 群微信聊天',
      wechatChat:{
        chatSelector:'yingz',
        startTime:'2026-07-29T16:00:00.000Z',
        endTime:'2026-07-30T06:30:00.000Z',
        maxMessages:200,
        outputMode:'metadata-summary',
        refreshMode:'incremental',
        sameNameStrategy:'latest-active-session',
        privateContentModelAccess:'disabled'
      }
    }
  };
  const approvals = [{
    approvalId:'approval-wechat-1',
    taskId:task.taskId,
    action:'wechat-private-chat-read',
    status:'approved',
    requestedScope:wechatApprovalScope(task),
    validUntil:'2099-01-01T00:00:00.000Z'
  }];
  const store = {
    async listApprovals() { return approvals; },
    async updateApproval(id, patch) {
      Object.assign(approvals.find((item) => item.approvalId === id), patch);
    }
  };
  return { task, approvals, store };
}

test('微信 Vault 健康检查缺消息库时显示受限且不泄露本机路径', async () => {
  const { store } = fixture();
  const executor = new LocalWeChatChatRetriever({
    store,
    checkHealth:async () => ({
      decrypted_dir:'/Users/private/Library/Application Support/wechat-local-vault/decrypted/current',
      exists:true,
      databases:[
        { path:'contact/contact.db', available:true },
        { path:'session/session.db', available:true },
        { path:'message/message_0.db', available:false }
      ]
    }),
    now:() => new Date('2026-07-30T06:30:00.000Z')
  });

  const health = await executor.health({ force:true });

  assert.equal(health.status, 'degraded');
  assert.equal(health.requiredDatabases.contact, true);
  assert.equal(health.requiredDatabases.session, true);
  assert.equal(health.requiredDatabases.message, false);
  assert.equal(JSON.stringify(health).includes('/Users/private'), false);
});

test('默认本机摘要模型未安装时概览降级，但 Vault 健康事实仍保留', async () => {
  const { store } = fixture();
  const executor = new LocalWeChatChatRetriever({
    store,
    analyzer:{ async health() { return { status:'unavailable', model:'qwen3:14b', safeMessage:'本机尚未安装 qwen3:14b 模型。' }; } },
    checkHealth:async () => healthyVaultStatus(),
    now:() => new Date('2026-07-30T06:30:00.000Z')
  });
  const health = await executor.health({ force:true });
  assert.equal(health.status, 'degraded');
  assert.equal(health.requiredDatabases.message, true);
  assert.equal(health.analysisModel.status, 'unavailable');
  assert.match(health.safeMessage, /qwen3:14b/);
});

test('微信 Vault 未就绪时不消耗一次性审批也不读取聊天', async () => {
  const { task, approvals, store } = fixture();
  let refreshed = 0;
  const executor = new LocalWeChatChatRetriever({
    store,
    checkHealth:async () => ({ exists:false, databases:[] }),
    refreshVault:async () => { refreshed += 1; },
    runCli:async () => { throw new Error('不应读取聊天'); },
    now:() => new Date('2026-07-30T06:30:00.000Z')
  });

  await assert.rejects(
    () => executor.execute(task),
    (error) => error.code === 'wechat_vault_unavailable'
  );
  assert.equal(approvals[0].privateReadGrant, undefined);
  assert.equal(refreshed, 0);
});

test('同名群自动选择最近活跃会话，报告不落聊天原文或发送者', async () => {
  const { task, approvals, store } = fixture();
  const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-agent-report-'));
  let refreshed = 0;
  const calls = [];
  const executor = new LocalWeChatChatRetriever({
    store,
    reportsDir,
    checkHealth:async () => healthyVaultStatus(),
    refreshVault:async () => { refreshed += 1; },
    runCli:async (args) => {
      calls.push(args);
      if (args[0] === 'contacts') return {
        contacts:[
          { username:'private-chat-id-old', display_name:'yingz', remark:'', nick_name:'yingz', alias:'' },
          { username:'private-chat-id-new', display_name:'yingz', remark:'', nick_name:'yingz', alias:'' }
        ]
      };
      if (args[0] === 'sessions') return [
        { username:'private-chat-id-new', timestamp:200 },
        { username:'private-chat-id-old', timestamp:100 }
      ];
      if (args[0] === 'history') {
        assert.equal(args[1], 'private-chat-id-new');
        assert.equal(args[args.indexOf('--start-time') + 1], '2026-07-30 00:00:00');
        assert.equal(args[args.indexOf('--end-time') + 1], '2026-07-30 14:30:00');
        return {
          messages:[
            { time:'2026-07-30 14:00:00', timestamp:1785391200, sender:'敏感发送者', type:'文本', content:'绝不能落盘的原文' },
            { time:'2026-07-30 14:01:00', timestamp:1785391260, sender:'敏感发送者', type:'图片', content:'[图片]' }
          ]
        };
      }
      throw new Error('unexpected command');
    },
    now:() => new Date('2026-07-30T06:30:00.000Z')
  });

  const result = await executor.execute(task);
  assert.equal(refreshed, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.execution.modelUsed, false);
  assert.equal(result.artifactRefs[0].data.messageCount, 2);
  assert.deepEqual(result.artifactRefs[0].data.typeCounts, { 文本:1, 图片:1 });
  assert.equal(approvals[0].privateReadGrant.uses.length, 1);
  const report = await fs.readFile(new URL(result.artifactRefs[0].uri), 'utf8');
  assert.doesNotMatch(report, /绝不能落盘的原文|敏感发送者|private-chat-id/);
  assert.equal((await fs.stat(new URL(result.artifactRefs[0].uri))).mode & 0o777, 0o600);
  assert.ok(calls.some((args) => args[0] === 'history'));
});

test('同一任务重试不重复扣授权次数', async () => {
  const { task, approvals, store } = fixture();
  approvals[0].privateReadGrant = {
    schemaVersion:'agent.army/private-read-grant/v1',
    grantId:'grant-1',
    ownerId:'owner',
    sourceApprovalId:approvals[0].approvalId,
    feishuChatRef:'local-console',
    requestingAgentId:'wechat-chat-retriever',
    scope:approvals[0].requestedScope,
    maxUses:10,
    uses:[{ taskId:task.taskId, readStartedAt:'2026-07-30T06:30:00.000Z' }],
    createdAt:'2026-07-30T06:30:00.000Z',
    expiresAt:'2099-01-01T00:00:00.000Z',
    revokedAt:null
  };
  const executor = new LocalWeChatChatRetriever({
    store,
    checkHealth:async () => healthyVaultStatus(),
    refreshVault:async () => {},
    runCli:async (args) => {
      if (args[0] === 'contacts') return { contacts:[{ username:'chat-id', display_name:'yingz' }] };
      if (args[0] === 'sessions') return [{ username:'chat-id', timestamp:1 }];
      if (args[0] === 'history') return { messages:[] };
      throw new Error('unexpected');
    }
  });
  await executor.execute(task);
  assert.equal(approvals[0].privateReadGrant.uses.length, 1);
});

test('本机模型未就绪时不创建或扣减临时授权', async () => {
  const { task, approvals, store } = fixture();
  task.input.wechatChat.outputMode = 'local-summary';
  const executor = new LocalWeChatChatRetriever({
    store,
    analyzer:{ async health() { return { status:'unavailable', safeMessage:'模型未安装' }; } },
    checkHealth:async () => healthyVaultStatus(),
    refreshVault:async () => { throw new Error('不应刷新'); }
  });
  await assert.rejects(() => executor.execute(task), (error) => error.code === 'wechat_local_model_unavailable');
  assert.equal(approvals[0].privateReadGrant, undefined);
});
