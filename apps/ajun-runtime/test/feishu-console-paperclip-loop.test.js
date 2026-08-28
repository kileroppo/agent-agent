import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskExecutionCoordinator } from '../src/task-execution-coordinator.ts';
import { TaskCapabilityCatalog } from '../src/task-capability-catalog.ts';
import { TaskStore } from '../src/task-store.ts';
import { FeishuCommander } from '../src/feishu-commander.ts';
import { taskRoutingDecision } from '../src/feishu-commander-replies.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('控制台补充输入：Paperclip 离线时平滑降级走受控本地执行，不打回 needs_input', async () => {
  let stored = {
    taskId: 'task-xiaod-1',
    taskType: 'media.transcribe-and-refine',
    status: 'queued',
    assigneeAgentId: 'xiaod',
    governance: null,
    input: { title: 'https://example.com/video.mp4', sourceUrl: 'https://example.com/video.mp4' },
  };
  const store = {
    async getTask() { return stored; },
    async updateTask(_taskId, patch) { stored = { ...stored, ...patch }; return stored; },
    async list() { return [stored]; },
  };

  let localExecuted = false;
  const localExecutor = {
    async execute(task) {
      localExecuted = true;
      return {
        status: 'succeeded',
        currentStage: 'transcript_ready',
        artifactRefs: [
          {
            type: 'xiaod_media_delivery',
            validation: { exists: true, readable: true, nonEmpty: true },
            data: { deliveryMode: 'local_only', currentTranscriptDelivered: true },
          },
          {
            type: 'confirmed_transcript',
            validation: { exists: true, readable: true, nonEmpty: true, qualityGatePassed: true, automaticConfirmed: true, transcriptVersion: 1 },
            data: { text: '转录正文' },
          },
        ],
      };
    },
  };

  const coordinator = new TaskExecutionCoordinator({
    store,
    capabilityCatalog: new TaskCapabilityCatalog({ executors: { xiaod: localExecutor } }),
    governance: {
      async project() {
        return { status: 'sync_pending', reason: 'Paperclip 服务未启动' };
      },
    },
  });

  const agent = {
    agentId: 'xiaod',
    status: 'active',
    executionOwner: 'paperclip-hermes',
    interaction: { runtime: 'hermes-profile', directFeishu: 'required' },
  };

  const result = await coordinator.execute(stored, agent);
  assert.equal(localExecuted, true, '本地执行器应被顺利唤醒');
  assert.notEqual(result.status, 'needs_input', '不应被打回 needs_input 阻塞状态');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.governance.governanceMode, 'local_fallback');
});

test('控制台补充输入：Paperclip 在线时自动补全工单投影并进入 heartbeat 等待', async () => {
  let stored = {
    taskId: 'task-xiaod-2',
    taskType: 'media.transcribe-and-refine',
    status: 'queued',
    assigneeAgentId: 'xiaod',
    governance: null,
    input: { title: 'https://example.com/video.mp4' },
  };
  const store = {
    async updateTask(_taskId, patch) { stored = { ...stored, ...patch }; return stored; },
  };

  const coordinator = new TaskExecutionCoordinator({
    store,
    capabilityCatalog: new TaskCapabilityCatalog(),
    governance: {
      async project() {
        return { status: 'synced', paperclipIssueId: 'issue-123', paperclipIssueIdentifier: 'PC-123' };
      },
    },
  });

  const agent = {
    agentId: 'xiaod',
    status: 'active',
    executionOwner: 'paperclip-hermes',
    interaction: { runtime: 'hermes-profile', directFeishu: 'required' },
  };

  const result = await coordinator.execute(stored, agent);
  assert.equal(result.status, 'running');
  assert.equal(result.currentStage, 'waiting_paperclip_heartbeat');
  assert.equal(result.execution.paperclipIssueId, 'issue-123');
});

test('飞书直聊小D：发送“查看任务进度#7082B792”时精准识别为进度查询，不创建空白转录任务', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-feishu-loop-'));
  try {
    const store = new TaskStore(path.join(dir, 'runtime.json'));
    const sourceTask = await store.createTask({
      taskType: 'media.transcribe-and-refine',
      status: 'running',
      currentStage: 'transcribing',
      assigneeAgentId: 'xiaod',
      source: { channel: 'feishu', chatRef: 'chat-direct-xiaod' },
    });
    const shortId = sourceTask.taskId.slice(0, 8);

    let createdTaskCount = 0;
    const commander = new FeishuCommander({
      store,
      tasks: {
        async create(input) {
          createdTaskCount += 1;
          return store.createTask(input);
        },
      },
    });

    const reply = await commander.handle({
      text: `查看任务进度#${shortId}`,
      sourceEventRef: 'evt-progress-query-1',
      chatRef: 'chat-direct-xiaod',
      targetAgentId: 'xiaod',
      profileId: 'xiaod',
    });

    assert.equal(createdTaskCount, 0, '查询进度时不应创建任何新任务');
    assert.equal(reply.kind, 'task_progress');
    assert.equal(reply.task.taskId, sourceTask.taskId);
    assert.match(reply.reply, new RegExp(shortId, 'i'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('taskRoutingDecision 支持短任务编号与带中文前缀的查看任务进度', () => {
  const decision1 = taskRoutingDecision('查看任务进度#7082B792');
  assert.equal(decision1?.action, 'query_task');
  assert.equal(decision1?.query?.taskId, '7082B792');

  const decision2 = taskRoutingDecision('任务 #7082B792 进展如何');
  assert.equal(decision2?.action, 'query_task');
  assert.equal(decision2?.query?.taskId, '7082B792');
});
