import assert from 'node:assert/strict';
import test from 'node:test';

import { routeDiagnosisApi } from '../src/runtime-http-diagnosis.ts';

function request(method, url) {
  return { method, url };
}

function minimalObservations() {
  return {
    gatewayProcess: { status: 'observed', loaded: true, pid: 123, label: 'ai.hermes.gateway', state: 'running', lastExitStatus: 0 },
    adapterPatch: { status: 'observed', exists: true, hasCommanderRoute: true, duplicateRouteDefinitions: 1, markers: { PROFILE_GUARD_V1: true, DIRECT_REPLY_V1: true } },
    requiredEnv: { status: 'observed', plistExists: true, variables: { AJUN_FEISHU_COMMANDER_INGRESS_URL: { present: true, classification: 'expected_loopback' }, AGENT_ARMY_FEISHU_AGENT_ID: { present: true, agentId: 'ajun' }, AJUN_FEISHU_ENTRY_AGENT_ID: { present: false } } },
    runtimeIngress: { status: 'observed', reachable: true, healthStatus: 'healthy', releaseStatus: 'immutable_release' },
    profileGuard: { status: 'observed', agentId: 'ajun', source: 'AGENT_ARMY_FEISHU_AGENT_ID', guardMarkerPresent: true },
    feishuAdmission: { status: 'observed', configured: true, entryCount: 2, hit: true, requesterRefDigest: 'sha256:abc123def456', fieldPath: 'allowed_users' },
  };
}

test('GET /api/diagnose/feishu-chain from local returns 200 with diagnosis schema', async () => {
  const result = await routeDiagnosisApi({
    request: request('GET', '/api/diagnose/feishu-chain'),
    local: true,
    observeChain: async () => minimalObservations(),
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.schemaVersion, 'agent.army/feishu-commander-chain-diagnosis/v1');
  assert.ok(Array.isArray(result.payload.checks));
  assert.ok(typeof result.payload.verdict === 'string');
  assert.ok(typeof result.payload.generatedAt === 'string');
});

test('GET /api/diagnose/feishu-chain from non-local returns 403', async () => {
  const result = await routeDiagnosisApi({
    request: request('GET', '/api/diagnose/feishu-chain'),
    local: false,
    observeChain: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result.status, 403);
  assert.ok(result.payload.error);
});

test('diagnosis contains checks array and verdict', async () => {
  const result = await routeDiagnosisApi({
    request: request('GET', '/api/diagnose/feishu-chain'),
    local: true,
    observeChain: async () => minimalObservations(),
  });
  assert.equal(result.status, 200);
  const diagnosis = result.payload;
  assert.ok(Array.isArray(diagnosis.checks));
  assert.ok(diagnosis.checks.length > 0);
  assert.ok(['blocking_gap', 'no_local_gap_found', 'diagnosis_incomplete'].includes(diagnosis.verdict));
  for (const check of diagnosis.checks) {
    assert.ok(typeof check.conclusion === 'string');
    assert.ok(typeof check.truthLayer === 'string');
    assert.ok(typeof check.id === 'string');
  }
  assert.ok(diagnosis.uniqueNextStep === null || typeof diagnosis.uniqueNextStep === 'string');
});

test('routeDiagnosisApi returns null for unrelated routes', async () => {
  const result = await routeDiagnosisApi({
    request: request('GET', '/api/health'),
    local: true,
    observeChain: async () => minimalObservations(),
  });
  assert.equal(result, null);
});

test('routeDiagnosisApi returns null for POST method', async () => {
  const result = await routeDiagnosisApi({
    request: request('POST', '/api/diagnose/feishu-chain'),
    local: true,
    observeChain: async () => minimalObservations(),
  });
  assert.equal(result, null);
});
