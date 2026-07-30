import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createM5ServerPublisherComposition,
  PaperclipMetricRecoveryRunScope,
} from '../src/m5-server-publisher-composition.js';
import {
  canonicalMetricRecoveryAuthorizationId,
  hashMetricRecoveryScope,
} from '../src/paperclip-metric-recovery-access.js';

const IDS = Object.freeze({
  company:'11111111-1111-4111-8111-111111111111',
  approval:'22222222-2222-4222-8222-222222222222',
  run:'33333333-3333-4333-8333-333333333333',
  issue:'44444444-4444-4444-8444-444444444444',
  agent:'55555555-5555-4555-8555-555555555555',
  campaign:'66666666-6666-4666-8666-666666666666',
  receipt:'77777777-7777-4777-8777-777777777777',
});
const NOW = new Date('2026-07-31T03:00:00.000Z');
const RUN_JWT = 'current.run.jwt';

test('server composition只从请求级current Run注入指标恢复凭据并保持Paperclip exact scope', async () => {
  const runScope = new PaperclipMetricRecoveryRunScope();
  const calls = [];
  const bindings = createM5ServerPublisherComposition({
    env:{},
    dataDir:'/tmp/agent-army-m5-server-composition',
    clock:() => new Date(NOW),
    getCampaignService:async () => ({
      async getRawCase() {},
      async control() {},
      async getDailyRoutineTrigger() {},
    }),
    currentRunCredentialProvider:() => runScope.currentCredential(),
    recoveryFetchImpl:async (url, init) => {
      const scope = JSON.parse(init.body).scope;
      calls.push({
        url,
        method:init.method,
        redirect:init.redirect,
        headers:{ ...init.headers },
        scope,
      });
      return response({
        approval:{
          id:IDS.approval,
          companyId:IDS.company,
          type:'request_board_approval',
          status:'approved',
          payload:{
            governanceKind:'metric_recovery_authorization_v1',
            scope,
            scopeHash:hashMetricRecoveryScope(scope),
            expiresAt:'2026-07-31T04:00:00.000Z',
            consumedAt:NOW.toISOString(),
            consumedByRunId:IDS.run,
            consumedByAgentId:IDS.agent,
          },
        },
        applied:true,
        replayed:false,
      });
    },
    production:{
      enabled:true,
      paperclipAccess:corePaperclipAccess(),
      connectorDependencies:{},
    },
  });
  const input = recoveryInput();

  await assert.rejects(
    bindings.publisher.paperclipControl.assertMetricRecoveryAllowed(input),
    /current Run|凭据不可用/,
  );
  const result = await runScope.run({
    apiKey:RUN_JWT,
    runId:IDS.run,
    issueId:IDS.issue,
    agentId:IDS.agent,
    companyId:IDS.company,
    approvalId:IDS.approval,
  }, () => bindings.publisher.paperclipControl.assertMetricRecoveryAllowed(input));

  assert.equal(result.authorized, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `http://127.0.0.1:3100/api/approvals/${IDS.approval}/recovery-authorizations/consume`,
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].headers.authorization, `Bearer ${RUN_JWT}`);
  assert.equal(calls[0].headers['x-paperclip-run-id'], IDS.run);
  assert.equal(calls[0].scope.issueId, IDS.issue);
  assert.equal(calls[0].scope.consumerAgentId, IDS.agent);
  assert.equal(JSON.stringify(result).includes(RUN_JWT), false);
});

test('server composition拒绝非loopback recovery origin和调用方凭据注入', async () => {
  const runScope = new PaperclipMetricRecoveryRunScope();
  const options = {
    env:{},
    dataDir:'/tmp/agent-army-m5-server-composition',
    getCampaignService:async () => ({}),
    currentRunCredentialProvider:() => runScope.currentCredential(),
    production:{
      enabled:true,
      paperclipAccess:corePaperclipAccess(),
      connectorDependencies:{},
    },
  };
  assert.throws(
    () => createM5ServerPublisherComposition({
      ...options,
      paperclipBaseUrl:'https://paperclip.example.com',
    }),
    /本机 HTTP origin/,
  );
  const bindings = createM5ServerPublisherComposition(options);
  await runScope.run({
    apiKey:RUN_JWT,
    runId:IDS.run,
    issueId:IDS.issue,
    agentId:IDS.agent,
    companyId:IDS.company,
    approvalId:IDS.approval,
  }, () => assert.rejects(
    bindings.publisher.paperclipControl.assertMetricRecoveryAllowed({
      ...recoveryInput(),
      apiKey:'caller-forged',
    }),
    /current-run provider/,
  ));
});

function recoveryInput() {
  return {
    action:'publisher.reconcile_stale_attempt',
    campaignId:IDS.campaign,
    receiptId:IDS.receipt,
    collectionKey:`${IDS.receipt}:24h`,
    attemptId:'attempt_metric_reconcile_24h',
    conclusion:'no_external_effect',
    authorizationId:canonicalMetricRecoveryAuthorizationId(IDS.approval),
    evidenceRef:'paperclip:work-product:metric-recovery-evidence-24h',
  };
}

function corePaperclipAccess() {
  return Object.fromEntries([
    'authorizePublisherRequest',
    'getPublisherConnectorApprovalSnapshot',
    'resolvePublisherCredentialReference',
    'verifyPublisherAccountIdentity',
    'assertPublisherCampaignBudget',
    'recordPublisherConnectorAttempt',
  ].map((method) => [method, async () => {
    throw new Error(`${method} 不应在恢复 composition 测试中调用。`);
  }]));
}

function response(value) {
  return {
    status:200,
    ok:true,
    async json() {
      return structuredClone(value);
    },
  };
}
