import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalPaperclipHeartbeat,
  PaperclipPublisherRunContext,
} from '../src/paperclip-publisher-run-context.ts';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const FORGED_AGENT_ID = '55555555-5555-4555-8555-555555555555';
const BEARER_TOKEN = 'paperclip-run-jwt';

function fixture({
  actor = { id:AGENT_ID, companyId:COMPANY_ID },
  verified,
} = {}) {
  const calls = [];
  const paperclipAdapter = {
    async authenticateRun(input) {
      calls.push({ kind:'authenticate', input:structuredClone(input) });
      return structuredClone(actor);
    },
  };
  const governance = {
    async verifySystemAssignment(input) {
      calls.push({ kind:'verify', input:structuredClone(input) });
      return structuredClone(verified || {
        issue:{ id:ISSUE_ID, companyId:COMPANY_ID },
        run:{ id:RUN_ID, companyId:COMPANY_ID },
        paperclipAgent:{ id:AGENT_ID, companyId:COMPANY_ID },
        systemRole:'m5-publisher-controller',
      });
    },
  };
  return {
    calls,
    context:new PaperclipPublisherRunContext({ paperclipAdapter, governance }),
  };
}

function heartbeat(overrides = {}) {
  return {
    runId:RUN_ID,
    agentId:FORGED_AGENT_ID,
    context:{ taskId:ISSUE_ID },
    ...overrides,
  };
}

test('发布上下文用请求头 JWT 认证 actor，并只返回 Paperclip 核验后的 canonical 标识', async () => {
  const { context, calls } = fixture();

  const result = await context.resolve({
    heartbeat:heartbeat(),
    bearerToken:BEARER_TOKEN,
  });

  assert.deepEqual(calls, [{
    kind:'authenticate',
    input:{ apiKey:BEARER_TOKEN, runId:RUN_ID },
  }, {
    kind:'verify',
    input:{
      issueId:ISSUE_ID,
      runId:RUN_ID,
      paperclipAgentId:AGENT_ID,
      systemRole:'m5-publisher-controller',
    },
  }]);
  assert.deepEqual(result, {
    issueId:ISSUE_ID,
    runId:RUN_ID,
    agentId:AGENT_ID,
    companyId:COMPANY_ID,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal('bearerToken' in result, false);
  assert.notEqual(result.agentId, FORGED_AGENT_ID);
});

test('请求 body 中伪造 token 不能代替请求头 JWT', async () => {
  const { context, calls } = fixture();

  await assert.rejects(
    context.resolve({
      heartbeat:heartbeat({ apiKey:'body-token', authorization:'Bearer body-token' }),
    }),
    /JWT/,
  );
  assert.deepEqual(calls, []);
});

test('JWT actor 与核验后的运行、任务或公司不一致时关闭失败', async () => {
  const mismatches = [{
    issue:{ id:'99999999-9999-4999-8999-999999999999', companyId:COMPANY_ID },
    run:{ id:RUN_ID, companyId:COMPANY_ID },
    paperclipAgent:{ id:AGENT_ID, companyId:COMPANY_ID },
  }, {
    issue:{ id:ISSUE_ID, companyId:COMPANY_ID },
    run:{ id:'99999999-9999-4999-8999-999999999999', companyId:COMPANY_ID },
    paperclipAgent:{ id:AGENT_ID, companyId:COMPANY_ID },
  }, {
    issue:{ id:ISSUE_ID, companyId:COMPANY_ID },
    run:{ id:RUN_ID, companyId:COMPANY_ID },
    paperclipAgent:{ id:AGENT_ID, companyId:'99999999-9999-4999-8999-999999999999' },
  }];

  for (const verified of mismatches) {
    const { context } = fixture({ verified });
    await assert.rejects(
      context.resolve({
        heartbeat:heartbeat(),
        bearerToken:BEARER_TOKEN,
      }),
      /身份链不一致/,
    );
  }
});

test('canonical heartbeat 覆盖 body 伪造身份但保留 Paperclip 非身份上下文', () => {
  const result = canonicalPaperclipHeartbeat(heartbeat({
    runId:'forged-run',
    context:{ taskId:'forged-issue', wakeReason:'routine' },
  }), {
    issueId:ISSUE_ID,
    runId:RUN_ID,
    agentId:AGENT_ID,
  });

  assert.equal(result.runId, RUN_ID);
  assert.equal(result.agentId, AGENT_ID);
  assert.deepEqual(result.context, {
    taskId:ISSUE_ID,
    wakeReason:'routine',
  });
});

test('system role 不一致时关闭失败', async () => {
  const { context } = fixture({
    verified:{
      issue:{ id:ISSUE_ID, companyId:COMPANY_ID },
      run:{ id:RUN_ID, companyId:COMPANY_ID },
      paperclipAgent:{ id:AGENT_ID, companyId:COMPANY_ID },
      systemRole:'m5-metrics-controller',
    },
  });
  await assert.rejects(
    context.resolve({
      heartbeat:heartbeat(),
      bearerToken:BEARER_TOKEN,
    }),
    /身份链不一致/,
  );
});
