import test from 'node:test';
import assert from 'node:assert/strict';

import { probeAgentManifestHealth } from '../src/agent-manifest-health-probe.ts';

test('probe returns profileOnline=true when gateway is healthy', async () => {
    const manifests = [
        { agentId: 'agent-a', interaction: { runtime: 'hermes-profile' } },
        { agentId: 'agent-b', interaction: { runtime: 'hermes-profile' } },
    ];
    const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'healthy' }) });
    const results = await probeAgentManifestHealth({ manifests, fetchImpl });
    assert.equal(results.length, 2);
    assert.equal(results[0].agentId, 'agent-a');
    assert.equal(results[0].profileOnline, true);
    assert.ok(results[0].checkedAt);
    assert.equal(results[1].agentId, 'agent-b');
    assert.equal(results[1].profileOnline, true);
});

test('probe returns profileOnline=false when gateway is unreachable', async () => {
    const manifests = [
        { agentId: 'agent-c', interaction: { runtime: 'hermes-profile' } },
    ];
    const fetchImpl = async () => { throw new Error('connection refused'); };
    const results = await probeAgentManifestHealth({ manifests, fetchImpl });
    assert.equal(results.length, 1);
    assert.equal(results[0].agentId, 'agent-c');
    assert.equal(results[0].profileOnline, false);
});

test('probe returns profileOnline=false when gateway returns non-ok', async () => {
    const manifests = [
        { agentId: 'agent-d', interaction: { runtime: 'hermes-profile' } },
    ];
    const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
    const results = await probeAgentManifestHealth({ manifests, fetchImpl });
    assert.equal(results[0].profileOnline, false);
});

test('probe skips agents without hermes-profile runtime', async () => {
    const manifests = [
        { agentId: 'agent-e', interaction: { runtime: 'hermes-profile' } },
        { agentId: 'agent-f', interaction: { runtime: 'direct-call' } },
        { agentId: 'agent-g', interaction: {} },
    ];
    const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
    const results = await probeAgentManifestHealth({ manifests, fetchImpl });
    assert.equal(results.length, 1);
    assert.equal(results[0].agentId, 'agent-e');
});

test('probe returns empty array when no manifests provided', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
    const results = await probeAgentManifestHealth({ manifests: [], fetchImpl });
    assert.equal(results.length, 0);
});
