import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalAiCapabilityClient, CAPABILITY_CATEGORIES } from '../src/local-ai-capability-client.ts';

test('controlOverview returns categories array with correct structure', async () => {
  const client = new LocalAiCapabilityClient({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          status: 'ready',
          services: [
            { id: 'qwen35', name: 'Qwen', node: 'mac', endpoint: '127.0.0.1:18081', mode: 'on_demand', state: 'running', actions: ['stop', 'restart'] },
            { id: 'speech-tools', name: 'Speech', node: 'mac', endpoint: '127.0.0.1:18083', mode: 'on_demand', state: 'running', actions: ['stop'] },
          ],
          routing: [
            { capability: 'text.generate', providers: ['qwen35/default'] },
            { capability: 'audio.transcribe', providers: ['speech-tools/whisper'] },
            { capability: 'audio.synthesize', providers: ['speech-tools/tts'] },
            { capability: 'vision.analyze', providers: ['qwen35/vision'] },
          ],
        };
      },
    }),
  });
  const overview = await client.controlOverview();
  assert.ok(Array.isArray(overview.categories));
  assert.equal(overview.categories.length, 5);
  for (const category of overview.categories) {
    assert.ok(category.id, 'category must have id');
    assert.ok(category.label, 'category must have label');
    assert.ok(Array.isArray(category.capabilities), 'category must have capabilities array');
    assert.equal(typeof category.readyCount, 'number');
    assert.equal(typeof category.totalCount, 'number');
    assert.ok(Array.isArray(category.serviceIds));
  }
});

test('readyCount and totalCount are calculated correctly from routing', async () => {
  const client = new LocalAiCapabilityClient({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          status: 'ready',
          services: [
            { id: 'qwen35', name: 'Qwen', node: 'mac', endpoint: '127.0.0.1:18081', mode: 'on_demand', state: 'running', actions: ['stop'] },
            { id: 'embedding', name: 'Embed', node: 'mac', endpoint: '127.0.0.1:18084', mode: 'on_demand', state: 'running', actions: ['stop'] },
          ],
          routing: [
            { capability: 'text.generate', providers: ['qwen35/default'] },
            { capability: 'embedding.create', providers: ['embedding/bge'] },
            { capability: 'rerank.score', providers: [] },
            { capability: 'knowledge.index', providers: ['embedding/indexer'] },
            { capability: 'knowledge.search', providers: [] },
          ],
        };
      },
    }),
  });
  const overview = await client.controlOverview();
  const text = overview.categories.find((c) => c.id === 'text');
  assert.equal(text.readyCount, 1);
  assert.equal(text.totalCount, 1);

  const knowledge = overview.categories.find((c) => c.id === 'knowledge');
  assert.equal(knowledge.totalCount, 4);
  assert.equal(knowledge.readyCount, 2);
});

test('all known capabilities are covered by at least one category', () => {
  const allCovered = new Set();
  for (const category of CAPABILITY_CATEGORIES) {
    for (const cap of category.capabilities) {
      allCovered.add(cap);
    }
  }
  const knownCapabilities = [
    'text.generate', 'vision.analyze', 'video.analyze',
    'audio.transcribe', 'audio.synthesize', 'image.generate',
    'image.edit', 'embedding.create', 'rerank.score',
    'knowledge.index', 'knowledge.search', 'audio.clone_authorized',
    'video.generate',
  ];
  for (const cap of knownCapabilities) {
    assert.ok(allCovered.has(cap), `capability ${cap} should be covered by a category`);
  }
});

test('categories includes serviceIds mapped from routing providers', async () => {
  const client = new LocalAiCapabilityClient({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          status: 'ready',
          services: [
            { id: 'qwen35', name: 'Qwen', node: 'mac', endpoint: '127.0.0.1:18081', mode: 'on_demand', state: 'running', actions: [] },
            { id: 'mflux', name: 'MLX Flux', node: 'mac', endpoint: '127.0.0.1:18085', mode: 'on_demand', state: 'running', actions: [] },
          ],
          routing: [
            { capability: 'text.generate', providers: ['qwen35/default'] },
            { capability: 'image.generate', providers: ['mflux/flux'] },
            { capability: 'image.edit', providers: ['mflux/inpaint', 'comfyui/edit'] },
          ],
        };
      },
    }),
  });
  const overview = await client.controlOverview();
  const text = overview.categories.find((c) => c.id === 'text');
  assert.ok(text.serviceIds.includes('qwen35'));

  const image = overview.categories.find((c) => c.id === 'image');
  assert.ok(image.serviceIds.includes('mflux'));
  assert.ok(image.serviceIds.includes('comfyui'));
});

test('unavailable control still returns categories with zero readyCount', async () => {
  const client = new LocalAiCapabilityClient({
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  const overview = await client.controlOverview();
  assert.equal(overview.status, 'degraded');
  assert.ok(Array.isArray(overview.categories));
  assert.equal(overview.categories.length, 5);
  for (const category of overview.categories) {
    assert.equal(category.readyCount, 0);
  }
});
