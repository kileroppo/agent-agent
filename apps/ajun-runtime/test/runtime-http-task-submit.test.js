import assert from 'node:assert/strict';
import test from 'node:test';
import { routeTaskSubmitApi } from '../src/runtime-http-task-submit.ts';

function fakeRequest(method, url) {
    return { method, url };
}

function fakeRegistry(agents = []) {
    return { list: async () => agents };
}

function fakeTasks(createdTask = { taskId: 'abc-123', status: 'queued' }) {
    const calls = [];
    return {
        calls,
        create: async (input) => { calls.push(input); return createdTask; },
    };
}

test('POST /api/tasks/submit with valid title creates task', async () => {
    const tasks = fakeTasks({ taskId: 'new-task-id', status: 'queued', input: { title: 'Test task' } });
    const result = await routeTaskSubmitApi({
        request: fakeRequest('POST', '/api/tasks/submit'),
        local: true,
        tasks,
        registry: fakeRegistry(),
        readBody: async () => ({ title: 'Test task', description: 'Some details' }),
    });
    assert.equal(result.status, 201);
    assert.equal(result.payload.task.taskId, 'new-task-id');
    assert.equal(tasks.calls.length, 1);
    assert.equal(tasks.calls[0].title, 'Test task');
    assert.equal(tasks.calls[0].description, 'Some details');
    assert.equal(tasks.calls[0].requesterName, 'console-owner');
    assert.deepEqual(tasks.calls[0].source, { channel: 'runtime-console' });
});

test('POST /api/tasks/submit with agentId passes it through', async () => {
    const tasks = fakeTasks({ taskId: 'routed-id', status: 'queued' });
    const result = await routeTaskSubmitApi({
        request: fakeRequest('POST', '/api/tasks/submit'),
        local: true,
        tasks,
        registry: fakeRegistry(),
        readBody: async () => ({ title: 'Targeted task', agentId: 'intel-researcher' }),
    });
    assert.equal(result.status, 201);
    assert.equal(tasks.calls[0].agentId, 'intel-researcher');
});

test('POST /api/tasks/submit with missing title returns 400', async () => {
    const result = await routeTaskSubmitApi({
        request: fakeRequest('POST', '/api/tasks/submit'),
        local: true,
        tasks: fakeTasks(),
        registry: fakeRegistry(),
        readBody: async () => ({ description: 'no title here' }),
    });
    assert.equal(result.status, 400);
    assert.ok(result.payload.error);
});

test('POST /api/tasks/submit with empty title returns 400', async () => {
    const result = await routeTaskSubmitApi({
        request: fakeRequest('POST', '/api/tasks/submit'),
        local: true,
        tasks: fakeTasks(),
        registry: fakeRegistry(),
        readBody: async () => ({ title: '   ' }),
    });
    assert.equal(result.status, 400);
});

test('GET /api/tasks/submit/options returns agent list', async () => {
    const agents = [
        { agentId: 'intel-researcher', name: 'Intel', role: 'Researcher', entryCategories: ['research-entry'], entryDefault: true, taskLabel: 'Research' },
        { agentId: 'office-assistant', name: 'Office', role: 'Assistant', entryCategories: ['office-task'], entryDefault: true, taskLabel: 'Office' },
        { agentId: 'hidden-agent', name: 'Hidden', role: 'Internal', status: 'active' },
    ];
    const result = await routeTaskSubmitApi({
        request: fakeRequest('GET', '/api/tasks/submit/options'),
        local: true,
        tasks: fakeTasks(),
        registry: fakeRegistry(agents),
        readBody: async () => ({}),
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.agents.length, 2);
    assert.equal(result.payload.agents[0].agentId, 'intel-researcher');
    assert.equal(result.payload.agents[1].agentId, 'office-assistant');
});

test('non-local requests return 403', async () => {
    const result = await routeTaskSubmitApi({
        request: fakeRequest('POST', '/api/tasks/submit'),
        local: false,
        tasks: fakeTasks(),
        registry: fakeRegistry(),
        readBody: async () => ({ title: 'Should fail' }),
    });
    assert.equal(result.status, 403);
    assert.ok(result.payload.error);
});

test('non-local GET options returns 403', async () => {
    const result = await routeTaskSubmitApi({
        request: fakeRequest('GET', '/api/tasks/submit/options'),
        local: false,
        tasks: fakeTasks(),
        registry: fakeRegistry(),
        readBody: async () => ({}),
    });
    assert.equal(result.status, 403);
});

test('unrelated URL returns null', async () => {
    const result = await routeTaskSubmitApi({
        request: fakeRequest('GET', '/api/overview'),
        local: true,
        tasks: fakeTasks(),
        registry: fakeRegistry(),
        readBody: async () => ({}),
    });
    assert.equal(result, null);
});

test('GET /api/tasks/submit/options returns empty list when registry is undefined', async () => {
    const result = await routeTaskSubmitApi({
        request: fakeRequest('GET', '/api/tasks/submit/options'),
        local: true,
        tasks: fakeTasks(),
        registry: undefined,
        readBody: async () => ({}),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.agents, []);
});
