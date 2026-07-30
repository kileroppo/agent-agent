import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalWeChatChatRetriever } from '../src/local-wechat-chat-retriever.js';
import { wechatApprovalScope } from '../src/wechat-chat-defaults.js';

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

test('同名群自动选择最近活跃会话，报告不落聊天原文或发送者', async () => {
  const { task, approvals, store } = fixture();
  const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-agent-report-'));
  let refreshed = 0;
  const calls = [];
  const executor = new LocalWeChatChatRetriever({
    store,
    reportsDir,
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
  assert.equal(approvals[0].consumedAt, '2026-07-30T06:30:00.000Z');
  const report = await fs.readFile(new URL(result.artifactRefs[0].uri), 'utf8');
  assert.doesNotMatch(report, /绝不能落盘的原文|敏感发送者|private-chat-id/);
  assert.equal((await fs.stat(new URL(result.artifactRefs[0].uri))).mode & 0o777, 0o600);
  assert.ok(calls.some((args) => args[0] === 'history'));
});

test('一次批准只能消费一次', async () => {
  const { task, approvals, store } = fixture();
  approvals[0].consumedAt = '2026-07-30T06:30:00.000Z';
  const executor = new LocalWeChatChatRetriever({
    store,
    refreshVault:async () => {},
    runCli:async () => { throw new Error('不应读取'); }
  });
  await assert.rejects(() => executor.execute(task), (error) => error.code === 'approval_consumed');
});
