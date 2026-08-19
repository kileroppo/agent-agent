import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

import { CustomAiCapabilityStore } from '../src/custom-ai-capability-store.ts';

function tmpDir() {
    return path.join(os.tmpdir(), `custom-ai-test-${crypto.randomUUID()}`);
}

test('register creates entry and returns it with id', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const entry = await store.register({
        capabilityType: 'tts',
        label: 'Azure TTS',
        endpointUrl: 'http://localhost:9999',
    });
    assert.ok(entry.id);
    assert.equal(entry.capabilityType, 'tts');
    assert.equal(entry.label, 'Azure TTS');
    assert.equal(entry.endpointUrl, 'http://localhost:9999');
    assert.equal(entry.healthCheckPath, '/health');
    assert.equal(entry.healthCheckMethod, 'GET');
    assert.ok(entry.registeredAt);
    assert.equal(entry.lastHealthCheck, null);
    assert.equal(entry.lastHealthStatus, 'unknown');
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('list returns registered entries', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    await store.register({ capabilityType: 'tts', label: 'TTS 1', endpointUrl: 'http://localhost:9001' });
    await store.register({ capabilityType: 'asr', label: 'ASR 1', endpointUrl: 'http://localhost:9002' });
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.ok(list.some(e => e.capabilityType === 'tts'));
    assert.ok(list.some(e => e.capabilityType === 'asr'));
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('remove deletes entry', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const entry = await store.register({ capabilityType: 'tts', label: 'TTS', endpointUrl: 'http://localhost:9003' });
    const result = await store.remove(entry.id);
    assert.equal(result.removed, true);
    const list = await store.list();
    assert.equal(list.length, 0);
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('validation rejects missing capabilityType', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    await assert.rejects(
        () => store.register({ label: 'Test', endpointUrl: 'http://localhost:9004' }),
        (error) => error.message.includes('capabilityType')
    );
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('validation rejects missing endpointUrl', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    await assert.rejects(
        () => store.register({ capabilityType: 'tts', label: 'Test' }),
        (error) => error.message.includes('endpointUrl')
    );
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('health check updates status', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const server = http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
        else { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const entry = await store.register({
        capabilityType: 'tts',
        label: 'Local TTS',
        endpointUrl: `http://127.0.0.1:${port}`,
    });
    const updated = await store.checkHealth(entry.id);
    assert.equal(updated.lastHealthStatus, 'healthy');
    assert.ok(updated.lastHealthCheck);
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('health check marks unhealthy when endpoint is down', async () => {
    const dataDir = tmpDir();
    const store = new CustomAiCapabilityStore({ dataDir });
    const entry = await store.register({
        capabilityType: 'tts',
        label: 'Dead TTS',
        endpointUrl: 'http://127.0.0.1:1',
        healthCheckPath: '/health',
    });
    const updated = await store.checkHealth(entry.id);
    assert.equal(updated.lastHealthStatus, 'unhealthy');
    assert.ok(updated.lastHealthCheck);
    await fs.rm(dataDir, { recursive: true, force: true });
});
