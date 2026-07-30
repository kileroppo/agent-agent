import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaperclipMetricRecoveryAccess,
  PaperclipMetricRecoveryAccessError,
  canonicalMetricRecoveryAuthorizationId,
  hashMetricRecoveryScope,
} from '../src/paperclip-metric-recovery-access.js';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const APPROVAL_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const ISSUE_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const CAMPAIGN_ID = '66666666-6666-4666-8666-666666666666';
const RECEIPT_ID = '77777777-7777-4777-8777-777777777777';
const RUN_JWT = 'header.payload.signature-secret-value';
const NOW = new Date('2026-07-31T03:00:00.000Z');

const CREDENTIAL = Object.freeze({
  apiKey:RUN_JWT,
  runId:RUN_ID,
  issueId:ISSUE_ID,
  agentId:AGENT_ID,
  companyId:COMPANY_ID,
  approvalId:APPROVAL_ID,
});

const INPUT = Object.freeze({
  action:'publisher.reconcile_stale_attempt',
  campaignId:CAMPAIGN_ID,
  receiptId:RECEIPT_ID,
  collectionKey:`${RECEIPT_ID}:24h`,
  attemptId:'attempt_metric_reconcile_24h',
  conclusion:'no_external_effect',
  authorizationId:canonicalMetricRecoveryAuthorizationId(APPROVAL_ID),
  evidenceRef:'paperclip:work-product:metric-recovery-evidence-24h',
  checkedAt:NOW.toISOString(),
});

test('只从 current-run provider 取 Run JWT 与身份并消费 exact scope', async () => {
  const calls = [];
  let credentialCalls = 0;
  const access = new PaperclipMetricRecoveryAccess({
    baseUrl:'http://127.0.0.1:3100',
    clock:() => new Date(NOW),
    currentRunCredentialProvider:async () => {
      credentialCalls += 1;
      return structuredClone(CREDENTIAL);
    },
    fetchImpl:async (url, options) => {
      calls.push({
        url,
        method:options.method,
        redirect:options.redirect,
        headers:{ ...options.headers },
        body:JSON.parse(options.body),
      });
      return jsonResponse(consumeReceipt({
        scope:options.body ? JSON.parse(options.body).scope : null,
        applied:true,
      }));
    },
  });

  const result = await access.assertPublisherMetricRecoveryAllowed(INPUT);
  assert.equal(credentialCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `http://127.0.0.1:3100/api/approvals/${APPROVAL_ID}/recovery-authorizations/consume`,
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].headers.authorization, `Bearer ${RUN_JWT}`);
  assert.equal(calls[0].headers['x-paperclip-run-id'], RUN_ID);
  assert.deepEqual(calls[0].body.scope, expectedScope());
  assert.deepEqual(result, {
    authorized:true,
    source:'paperclip',
    action:INPUT.action,
    campaignId:INPUT.campaignId,
    receiptId:INPUT.receiptId,
    collectionKey:INPUT.collectionKey,
    attemptId:INPUT.attemptId,
    conclusion:INPUT.conclusion,
    authorizationId:INPUT.authorizationId,
    evidenceRef:INPUT.evidenceRef,
    approvalRef:`paperclip:approval:${APPROVAL_ID}`,
    replayed:false,
  });
  assert.equal(JSON.stringify(result).includes(RUN_JWT), false);
});

test('同 approval/run/scope 的 consume exact replay 可通过，身份或 scope 漂移失败关闭', async () => {
  const access = setupAccess(({ scope }) => consumeReceipt({
    scope,
    applied:false,
    replayed:true,
  }));
  assert.equal(
    (await access.assertPublisherMetricRecoveryAllowed(INPUT)).replayed,
    true,
  );

  for (const [name, mutate] of [
    ['company', (value) => ({
      ...value,
      approval:{
        ...value.approval,
        companyId:'88888888-8888-4888-8888-888888888888',
      },
    })],
    ['status', (value) => ({
      ...value,
      approval:{ ...value.approval, status:'pending' },
    })],
    ['scopeHash', (value) => ({
      ...value,
      approval:{
        ...value.approval,
        payload:{
          ...value.approval.payload,
          scopeHash:`sha256:${'0'.repeat(64)}`,
        },
      },
    })],
    ['revoked', (value) => ({
      ...value,
      approval:{
        ...value.approval,
        payload:{ ...value.approval.payload, revokedAt:NOW.toISOString() },
      },
    })],
    ['expired', (value) => ({
      ...value,
      approval:{
        ...value.approval,
        payload:{ ...value.approval.payload, expiresAt:NOW.toISOString() },
      },
    })],
    ['run', (value) => ({
      ...value,
      approval:{
        ...value.approval,
        payload:{
          ...value.approval.payload,
          consumedByRunId:'99999999-9999-4999-8999-999999999999',
        },
      },
    })],
    ['agent', (value) => ({
      ...value,
      approval:{
        ...value.approval,
        payload:{
          ...value.approval.payload,
          consumedByAgentId:'99999999-9999-4999-8999-999999999999',
        },
      },
    })],
    ['scope', (value) => ({
      ...value,
      approval:{
        ...value.approval,
        payload:{
          ...value.approval.payload,
          scope:{
            ...value.approval.payload.scope,
            conclusion:'external_effect_verified',
          },
        },
      },
    })],
    ['no-state', (value) => ({ ...value, applied:false, replayed:false })],
    ['both-state', (value) => ({ ...value, applied:true, replayed:true })],
  ]) {
    const denied = setupAccess(({ scope }) => mutate(consumeReceipt({
      scope,
      applied:true,
    })));
    await assert.rejects(
      denied.assertPublisherMetricRecoveryAllowed(INPUT),
      PaperclipMetricRecoveryAccessError,
      name,
    );
  }
});

test('调用方不能注入凭据或伪造 approval 到 authorizationId 映射', async () => {
  let providerCalls = 0;
  let fetchCalls = 0;
  const access = new PaperclipMetricRecoveryAccess({
    currentRunCredentialProvider:async () => {
      providerCalls += 1;
      return CREDENTIAL;
    },
    fetchImpl:async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  for (const field of [
    'apiKey',
    'runId',
    'issueId',
    'agentId',
    'companyId',
    'approvalId',
  ]) {
    await assert.rejects(
      access.assertPublisherMetricRecoveryAllowed({
        ...INPUT,
        [field]:'caller-forged',
      }),
      PaperclipMetricRecoveryAccessError,
    );
  }
  await assert.rejects(
    access.assertPublisherMetricRecoveryAllowed({
      ...INPUT,
      authorizationId:'paperclip:approval:caller-forged:recovery',
    }),
    PaperclipMetricRecoveryAccessError,
  );
  assert.equal(providerCalls, 1);
  assert.equal(fetchCalls, 0);
});

test('3xx、网络错误、凭据错误和敏感上游消息均失败关闭且不泄露 Token', async () => {
  const redirecting = new PaperclipMetricRecoveryAccess({
    currentRunCredentialProvider:async () => CREDENTIAL,
    fetchImpl:async () => ({
      ok:false,
      status:302,
      async json() {
        return { error:`redirect ${RUN_JWT}` };
      },
    }),
  });
  await rejectsWithoutSecret(
    redirecting.assertPublisherMetricRecoveryAllowed(INPUT),
    RUN_JWT,
  );

  const networkFailure = new PaperclipMetricRecoveryAccess({
    currentRunCredentialProvider:async () => CREDENTIAL,
    fetchImpl:async () => {
      throw new Error(`network leaked ${RUN_JWT}`);
    },
  });
  await rejectsWithoutSecret(
    networkFailure.assertPublisherMetricRecoveryAllowed(INPUT),
    RUN_JWT,
  );

  const providerFailure = new PaperclipMetricRecoveryAccess({
    currentRunCredentialProvider:async () => {
      throw new Error(`provider leaked ${RUN_JWT}`);
    },
    fetchImpl:async () => {
      throw new Error('must not call');
    },
  });
  await rejectsWithoutSecret(
    providerFailure.assertPublisherMetricRecoveryAllowed(INPUT),
    RUN_JWT,
  );
});

test('只允许无凭据的本机HTTP origin，拒绝非loopback、HTTPS和路径注入', () => {
  for (const baseUrl of [
    'http://192.168.1.10:3100',
    'http://127.0.0.1.evil.example:3100',
    'https://127.0.0.1:3100',
    'http://user:password@127.0.0.1:3100',
    'http://127.0.0.1:3100/api',
    'http://127.0.0.1:3100/?next=http://evil.example',
  ]) {
    assert.throws(
      () => new PaperclipMetricRecoveryAccess({
        baseUrl,
        currentRunCredentialProvider:async () => CREDENTIAL,
      }),
      PaperclipMetricRecoveryAccessError,
      baseUrl,
    );
  }
  for (const baseUrl of [
    'http://127.0.0.1:3100',
    'http://localhost:3100',
    'http://[::1]:3100',
  ]) {
    assert.doesNotThrow(() => new PaperclipMetricRecoveryAccess({
      baseUrl,
      currentRunCredentialProvider:async () => CREDENTIAL,
    }));
  }
});

function setupAccess(responseFactory) {
  return new PaperclipMetricRecoveryAccess({
    clock:() => new Date(NOW),
    currentRunCredentialProvider:async () => structuredClone(CREDENTIAL),
    fetchImpl:async (_url, options) => jsonResponse(
      responseFactory(JSON.parse(options.body)),
    ),
  });
}

function expectedScope() {
  return {
    action:INPUT.action,
    attemptId:INPUT.attemptId,
    authorizationId:INPUT.authorizationId,
    campaignId:INPUT.campaignId,
    collectionKey:INPUT.collectionKey,
    conclusion:INPUT.conclusion,
    consumerAgentId:AGENT_ID,
    evidenceRef:INPUT.evidenceRef,
    issueId:ISSUE_ID,
    receiptId:INPUT.receiptId,
  };
}

function consumeReceipt({ scope, applied, replayed = false }) {
  return {
    approval:{
      id:APPROVAL_ID,
      companyId:COMPANY_ID,
      type:'request_board_approval',
      status:'approved',
      payload:{
        governanceKind:'metric_recovery_authorization_v1',
        scope,
        scopeHash:hashMetricRecoveryScope(scope),
        expiresAt:'2026-07-31T04:00:00.000Z',
        revokedAt:null,
        revokedByUserId:null,
        consumedAt:'2026-07-31T03:00:01.000Z',
        consumedByRunId:RUN_ID,
        consumedByAgentId:AGENT_ID,
      },
    },
    applied,
    replayed,
  };
}

function jsonResponse(payload) {
  return {
    ok:true,
    status:200,
    async json() {
      return structuredClone(payload);
    },
  };
}

async function rejectsWithoutSecret(promise, secret) {
  try {
    await promise;
    assert.fail('expected rejection');
  } catch (error) {
    assert.equal(error instanceof PaperclipMetricRecoveryAccessError, true);
    assert.equal(String(error.message).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
  }
}
