import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskRecordService } from '../src/task-record-service.ts';

const baseTask = {
    taskId: '33333333-3333-4333-8333-333333333333',
    status: 'succeeded',
    taskType: 'office.presentation-package',
    assigneeAgentId: 'office-assistant',
    input: { title: '工作流任务' },
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:10:00.000Z',
};

test('detail includes workflowBreadcrumb when task has workflow data', async () => {
    const task = {
        ...baseTask,
        workflow: {
            workflowId: 'wf-001',
            step: { stepId: 'step-2' },
            parentWorkflowId: 'wf-parent-001',
        },
    };
    const siblingTask = {
        taskId: '44444444-4444-4444-8444-444444444444',
        status: 'succeeded',
        input: { title: '关联任务' },
        workflow: { workflowId: 'wf-001' },
    };
    const service = new TaskRecordService({
        store: {
            getTask: async () => task,
            listApprovals: async () => [],
            listWorkflowTasks: async () => [task, siblingTask],
            getWorkflowAcceptance: async () => null,
        },
    });
    const detail = await service.detail(task.taskId, { audience: 'local-owner' });
    assert.ok(detail.workflowBreadcrumb);
    assert.equal(detail.workflowBreadcrumb.workflowId, 'wf-001');
    assert.equal(detail.workflowBreadcrumb.currentStepId, 'step-2');
    assert.equal(detail.workflowBreadcrumb.parentWorkflowId, 'wf-parent-001');
});

test('workflowBreadcrumb contains siblings from the same workflow', async () => {
    const task = {
        ...baseTask,
        workflow: {
            workflowId: 'wf-002',
            step: { stepId: 'step-1' },
        },
    };
    const sibling1 = {
        taskId: '55555555-5555-4555-8555-555555555555',
        status: 'running',
        input: { title: '第二步任务' },
        workflow: { workflowId: 'wf-002' },
    };
    const sibling2 = {
        taskId: '66666666-6666-4666-8666-666666666666',
        status: 'waiting',
        input: { title: '第三步任务' },
        workflow: { workflowId: 'wf-002' },
    };
    const service = new TaskRecordService({
        store: {
            getTask: async () => task,
            listApprovals: async () => [],
            listWorkflowTasks: async () => [task, sibling1, sibling2],
            getWorkflowAcceptance: async () => null,
        },
    });
    const detail = await service.detail(task.taskId, { audience: 'local-owner' });
    assert.equal(detail.workflowBreadcrumb.siblings.length, 2);
    assert.equal(detail.workflowBreadcrumb.siblings[0].taskId, '55555555-5555-4555-8555-555555555555');
    assert.equal(detail.workflowBreadcrumb.siblings[0].title, '第二步任务');
    assert.equal(detail.workflowBreadcrumb.siblings[0].status, 'running');
    assert.equal(detail.workflowBreadcrumb.siblings[1].taskId, '66666666-6666-4666-8666-666666666666');
});

test('workflowBreadcrumb is null when task has no workflow data', async () => {
    const task = { ...baseTask };
    const service = new TaskRecordService({
        store: {
            getTask: async () => task,
            listApprovals: async () => [],
        },
    });
    const detail = await service.detail(task.taskId, { audience: 'local-owner' });
    assert.equal(detail.workflowBreadcrumb, null);
});
