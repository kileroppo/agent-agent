import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskRecordService } from '../src/task-record-service.ts';

const baseTask = {
    taskId: '22222222-2222-4222-8222-222222222222',
    status: 'succeeded',
    taskType: 'office.presentation-package',
    assigneeAgentId: 'office-assistant',
    input: { title: '测试任务' },
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:10:00.000Z',
};

test('detail response includes costAttribution when task has usage data', async () => {
    const task = {
        ...baseTask,
        usage: {
            schemaVersion: 'agent.army/task-usage/v1',
            recordedAt: '2026-08-07T10:10:00.000Z',
            execution: { executor: 'hermes-agent', durationMs: 45000, outcome: 'succeeded' },
            model: { status: 'reported', inputTokens: 1200, outputTokens: 800, apiCalls: 3 },
            cost: { status: 'reported', amount: 0.05, currency: 'USD', basis: 'estimated' },
        },
    };
    const service = new TaskRecordService({
        store: {
            getTask: async () => task,
            listApprovals: async () => [],
        },
    });
    const detail = await service.detail(task.taskId, { audience: 'local-owner' });
    assert.ok(detail.costAttribution);
    assert.equal(detail.costAttribution.executor, 'hermes-agent');
    assert.equal(detail.costAttribution.durationMs, 45000);
    assert.equal(detail.costAttribution.inputTokens, 1200);
    assert.equal(detail.costAttribution.outputTokens, 800);
    assert.equal(detail.costAttribution.totalCost, '$0.05');
    assert.equal(detail.costAttribution.currency, 'USD');
    assert.equal(detail.costAttribution.recordedAt, '2026-08-07T10:10:00.000Z');
});

test('costAttribution field mapping uses assigneeAgentId as fallback executor', async () => {
    const task = {
        ...baseTask,
        usage: {
            schemaVersion: 'agent.army/task-usage/v1',
            recordedAt: '2026-08-07T10:10:00.000Z',
            execution: { durationMs: 12000, outcome: 'succeeded' },
            model: { status: 'reported', inputTokens: 500, outputTokens: 300, apiCalls: 1 },
            cost: { status: 'reported', amount: 0.02, currency: 'CNY', basis: 'actual' },
        },
    };
    const service = new TaskRecordService({
        store: {
            getTask: async () => task,
            listApprovals: async () => [],
        },
    });
    const detail = await service.detail(task.taskId, { audience: 'local-owner' });
    assert.equal(detail.costAttribution.executor, 'office-assistant');
    assert.equal(detail.costAttribution.currency, 'CNY');
});

test('costAttribution is null when task has no usage data', async () => {
    const task = { ...baseTask };
    const service = new TaskRecordService({
        store: {
            getTask: async () => task,
            listApprovals: async () => [],
        },
    });
    const detail = await service.detail(task.taskId, { audience: 'local-owner' });
    assert.equal(detail.costAttribution, null);
});

test('costAttribution is null when model and cost are not reported', async () => {
    const task = {
        ...baseTask,
        usage: {
            schemaVersion: 'agent.army/task-usage/v1',
            recordedAt: '2026-08-07T10:10:00.000Z',
            execution: { executor: 'agent-x', durationMs: 1000, outcome: 'failed' },
            model: { status: 'not_reported' },
            cost: { status: 'not_reported' },
        },
    };
    const service = new TaskRecordService({
        store: {
            getTask: async () => task,
            listApprovals: async () => [],
        },
    });
    const detail = await service.detail(task.taskId, { audience: 'local-owner' });
    assert.equal(detail.costAttribution, null);
});
