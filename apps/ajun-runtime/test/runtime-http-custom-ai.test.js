import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { routeCustomAiApi } from '../src/runtime-http-custom-ai.ts';
import { CustomAiCapabilityStore } from '../src/custom-ai-capability-store.ts';

function tmpDir() {
    return path.join(os.tmpdir(), `custom-ai-http-test-${crypto.randomUUID()}`);
}

function request(method, url) {
    return { method, url };
}

test('POST /api/custom-ai/capabilities creates entry', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const result = await routeCustomAiApi({
        request: request('POST', '/api/custom-ai/capabilities'),
        local: true,
        store,
        readBody: async () => ({ capabilityType: 'tts', label: 'Azure TTS', endpointUrl: 'http://localhost:9000' }),
    });
    assert.equal(result.status, 201);
    assert.ok(result.payload.capability.id);
    assert.equal(result.payload.capability.capabilityType, 'tts');
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('GET /api/custom-ai/capabilities lists entries', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    await store.register({ capabilityType: 'tts', label: 'TTS', endpointUrl: 'http://localhost:9001' });
    const result = await routeCustomAiApi({
        request: request('GET', '/api/custom-ai/capabilities'),
        local: true,
        store,
        readBody: async () => ({}),
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.capabilities.length, 1);
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('DELETE /api/custom-ai/capabilities/:id removes entry', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const entry = await store.register({ capabilityType: 'tts', label: 'TTS', endpointUrl: 'http://localhost:9002' });
    const result = await routeCustomAiApi({
        request: request('DELETE', `/api/custom-ai/capabilities/${entry.id}`),
        local: true,
        store,
        readBody: async () => ({}),
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.removed, true);
    const list = await store.list();
    assert.equal(list.length, 0);
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('non-local requests get 403', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const result = await routeCustomAiApi({
        request: request('GET', '/api/custom-ai/capabilities'),
        local: false,
        store,
        readBody: async () => ({}),
    });
    assert.equal(result.status, 403);
    assert.ok(result.payload.error);
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('returns null for unrelated routes', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const result = await routeCustomAiApi({
        request: request('GET', '/api/overview'),
        local: true,
        store,
        readBody: async () => ({}),
    });
    assert.equal(result, null);
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('POST health-check triggers probe for an entry', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const entry = await store.register({ capabilityType: 'tts', label: 'TTS', endpointUrl: 'http://127.0.0.1:1' });
    const result = await routeCustomAiApi({
        request: request('POST', `/api/custom-ai/capabilities/${entry.id}/health-check`),
        local: true,
        store,
        readBody: async () => ({}),
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.capability.lastHealthStatus, 'unhealthy');
    await fs.rm(dataDir, { recursive: true, force: true });
});
