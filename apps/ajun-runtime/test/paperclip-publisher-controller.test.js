import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaperclipPublisherController,
  PaperclipPublisherControllerError,
  trustedPublishInputs,
} from '../src/paperclip-publisher-controller.ts';
import {
  FakePlatformConnector,
  MemoryPublisherRepository,
  PublisherGateway,
} from '../../../integrations/publishing/m5-publisher-gateway/src/index.ts';

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const DAY_ID = '22222222-2222-4222-8222-222222222222';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const ISSUE_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const PIPELINE_ID = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-07-30T02:00:00.000Z');
const CHECKSUM = `sha256:${'a'.repeat(64)}`;

function grant(overrides = {}) {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{
      douyin:'account:douyin:test',
      xiaohongshu:'account:xhs:test',
    },
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:[
      'direct_message',
      'comment',
      'follow',
      'paid_promotion',
      'payment',
      'account_settings',
      'delete_history',
    ],
    budgetCents:625,
    ...overrides,
  };
}

function trustedOutputs() {
  return [{
    id:'work_product:content',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.content-autonomy',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/content-version/v1',
      kind:'ContentVersion',
      contentVersion:{
        platform:'douyin',
        contentVersionId:'content-v1',
        checksum:CHECKSUM,
        mediaPath:'campaign/day/douyin.mp4',
        title:'AI Agent 实战',
        body:'从真实执行结果复盘 Agent 工作流。',
        tags:['AI Agent', '实战'],
      },
    },
  }, {
    id:'work_product:review',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.content-autonomy',
    sourceTrust:null,
    status:'approved',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/machine-review/v1',
      kind:'MachineReview',
      reviewReport:{
        status:'passed',
        contentVersionId:'content-v1',
        checks:{
          facts:true,
          privacy:true,
          rights:true,
          media:true,
          claims:true,
          grantScope:true,
          duplicate:true,
        },
      },
    },
  }];
}

class FakeGovernance {
  constructor({ stageKey = 'publish', campaignGrant = grant(), outputs = trustedOutputs() } = {}) {
    this.issue = {
      id:ISSUE_ID,
      status:'in_progress',
      assigneeAgentId:AGENT_ID,
      description:`[agent-army:m5:routine:m5-publish] 固定发布；当前 Case 为 ${CASE_ID}，版本为 1。`,
    };
    this.cases = new Map([
      [CASE_ID, {
        case:{
          id:CASE_ID,
          parentCaseId:DAY_ID,
          pipelineId:PIPELINE_ID,
          fields:{ platform:'douyin', scheduledDate:'2026-07-30' },
        },
        stage:{ key:stageKey },
        pipeline:{ id:PIPELINE_ID },
      }],
      [DAY_ID, {
        case:{ id:DAY_ID, parentCaseId:CAMPAIGN_ID, pipelineId:PIPELINE_ID, fields:{} },
        stage:{ key:'publish' },
        pipeline:{ id:PIPELINE_ID },
      }],
      [CAMPAIGN_ID, {
        case:{
          id:CAMPAIGN_ID,
          parentCaseId:null,
          pipelineId:PIPELINE_ID,
          fields:{ campaignGrant },
        },
        stage:{ key:'campaign_active' },
        pipeline:{ id:PIPELINE_ID },
      }],
    ]);
    this.outputs = structuredClone(outputs);
    this.calls = [];
  }

  async verifySystemAssignment(input) {
    this.calls.push({ kind:'verify', input:structuredClone(input) });
    assert.equal(input.systemRole, 'm5-publisher-controller');
    assert.equal(input.paperclipAgentId, AGENT_ID);
    return { issue:structuredClone(this.issue), run:{ id:input.runId } };
  }

  async assertCaseIssueLink(caseId, issueId) {
    this.calls.push({ kind:'link', caseId, issueId });
    assert.equal(caseId, CASE_ID);
    assert.equal(issueId, ISSUE_ID);
  }

  async getPipelineCase(caseId) {
    const value = this.cases.get(caseId);
    if (!value) throw new Error(`missing case ${caseId}`);
    return structuredClone(value);
  }

  async getPipelineCaseOutputs(caseId) {
    assert.equal(caseId, CASE_ID);
    return { caseId, items:structuredClone(this.outputs) };
  }

  async createIssueWorkProduct(issueId, product, options) {
    assert.equal(issueId, ISSUE_ID);
    assert.equal(options.runId, RUN_ID);
    this.outputs.push({
      id:`work_product:${product.externalId}`,
      kind:'work_product',
      sourceTrust:null,
      ...structuredClone(product),
    });
    this.calls.push({ kind:'work-product', product:structuredClone(product) });
  }

  async completePublisherIssue(issueId, payload) {
    assert.equal(issueId, ISSUE_ID);
    this.issue.status = 'done';
    this.calls.push({ kind:'complete', payload:structuredClone(payload) });
  }
}

function gateway(canonicalGrant = grant()) {
  return new PublisherGateway({
    repository:new MemoryPublisherRepository(),
    connectors:{
      douyin:new FakePlatformConnector('douyin', [{
        type:'success',
        publishedAt:NOW.toISOString(),
      }]),
      xiaohongshu:new FakePlatformConnector('xiaohongshu'),
    },
    artifactVerifier:{
      async verify(relativePath, checksum) {
        assert.equal(relativePath, 'campaign/day/douyin.mp4');
        assert.equal(checksum, CHECKSUM);
        return { relativePath, checksum, bytes:1 };
      },
    },
    paperclipControl:{
      async assertPublishAllowed(input) {
        return {
          campaignId:input.campaignId,
          grantStatus:'active',
          currentStage:'campaign_active',
          canonicalGrant:structuredClone(canonicalGrant),
        };
      },
      async pauseCampaignAndDisableCron() {
        throw new Error('happy path should not pause');
      },
    },
    mode:'fake',
    clock:() => new Date(NOW),
  });
}

function payload(overrides = {}) {
  return {
    runId:RUN_ID,
    agentId:AGENT_ID,
    context:{ taskId:ISSUE_ID },
    ...overrides,
  };
}

test('发布上下文派生集中绑定 Case、Grant、内容、审核与幂等键并保持克隆语义', () => {
  const outputs = trustedOutputs();
  const campaignGrant = grant();
  const derived = trustedPublishInputs({
    outputs,
    targetCase:{ fields:{ platform:'douyin', scheduledDate:'2026-07-30' } },
    campaignCase:{ id:CAMPAIGN_ID },
    grant:campaignGrant,
    executionTime:new Date(NOW),
  });

  assert.equal(derived.contentVersion, outputs[0].metadata.contentVersion);
  assert.equal(derived.reviewReport, outputs[1].metadata.reviewReport);
  assert.notEqual(derived.request.grant, campaignGrant);
  assert.notEqual(derived.request.tags, derived.contentVersion.tags);
  assert.notEqual(derived.request.reviewReport, derived.reviewReport);
  assert.equal(
    derived.request.idempotencyKey,
    `${CAMPAIGN_ID}:douyin:content-v1:2026-07-30`,
  );
  assert.equal(derived instanceof Promise, false);
});

test('发布上下文派生保持 grant、tags、reviewReport 的克隆异常顺序', () => {
  const outputs = trustedOutputs();
  Object.defineProperty(outputs[0].metadata.contentVersion.tags, '0', {
    enumerable:true,
    configurable:true,
    get() { throw new Error('tags-clone-reached'); },
  });
  Object.defineProperty(outputs[1].metadata.reviewReport, 'cloneProbe', {
    enumerable:true,
    get() { throw new Error('review-clone-reached'); },
  });
  const campaignGrant = grant({ cloneFailure:() => 'not-cloneable' });
  const input = {
    outputs,
    targetCase:{ fields:{ platform:'douyin', scheduledDate:'2026-07-30' } },
    campaignCase:{ id:CAMPAIGN_ID },
    grant:campaignGrant,
    executionTime:new Date(NOW),
  };

  assert.throws(
    () => trustedPublishInputs(input),
    (error) => error?.name === 'DataCloneError'
      && error.message !== 'tags-clone-reached'
      && error.message !== 'review-clone-reached',
  );

  delete campaignGrant.cloneFailure;
  assert.throws(
    () => trustedPublishInputs(input),
    /tags-clone-reached/,
  );

  outputs[0].metadata.contentVersion.tags = ['AI Agent', '实战'];
  assert.throws(
    () => trustedPublishInputs(input),
    /review-clone-reached/,
  );
});

test('发布上下文派生保持 Case 日期、执行日、内容、审核、Grant 的拒绝顺序和错误身份', () => {
  const malformed = trustedOutputs();
  delete malformed[0].metadata.contentVersion.checksum;
  const base = {
    outputs:malformed,
    targetCase:{ fields:{ platform:'douyin', scheduledDate:'2026-07-30' } },
    campaignCase:{ id:CAMPAIGN_ID },
    grant:grant(),
    executionTime:new Date(NOW),
  };

  const duplicates = trustedOutputs();
  duplicates.push(
    structuredClone(duplicates[0]),
    structuredClone(duplicates[1]),
  );
  assert.throws(
    () => trustedPublishInputs({ ...base, outputs:duplicates }),
    (error) => error instanceof PaperclipPublisherControllerError
      && error.message
        === '当前 Case 必须各有一个可信 ContentVersion 和 MachineReview，实际为 2/2。',
  );

  assert.throws(
    () => trustedPublishInputs({
      ...base,
      targetCase:{ fields:{ platform:'douyin', scheduledDate:'2026-02-31' } },
    }),
    (error) => error instanceof PaperclipPublisherControllerError
      && error.message === '发布 Case 缺少可信平台或发布日期。',
  );
  assert.throws(
    () => trustedPublishInputs({
      ...base,
      targetCase:{ fields:{ platform:'douyin', scheduledDate:'2026-07-29' } },
    }),
    (error) => error instanceof PaperclipPublisherControllerError
      && error.code === 'publisher_scheduled_date_mismatch'
      && error.recoveryAction?.action === 'reschedule_platform_case_for_current_date',
  );
  assert.throws(
    () => trustedPublishInputs(base),
    (error) => error instanceof PaperclipPublisherControllerError
      && error.message === 'ContentVersion 与当前平台 Case 不一致或缺少发布产物。',
  );

  const reviewBeforeGrant = trustedOutputs();
  reviewBeforeGrant[1].metadata.reviewReport.checks.privacy = false;
  assert.throws(
    () => trustedPublishInputs({
      ...base,
      outputs:reviewBeforeGrant,
      grant:grant({ platforms:[] }),
    }),
    (error) => error instanceof PaperclipPublisherControllerError
      && error.message === '机器审核未完整通过或审核版本不匹配。',
  );
});

test('发布控制器严格核验 Paperclip 身份和 Case，从可信产物派生参数并写回唯一凭证', async () => {
  const governance = new FakeGovernance();
  const publisher = gateway();
  const publish = publisher.publish.bind(publisher);
  let authorizationContext = null;
  publisher.publish = (request, context) => {
    authorizationContext = structuredClone(context);
    return publish(request);
  };
  const handler = new PaperclipPublisherController({
    governance,
    publisher,
    now:() => new Date(NOW),
  });

  const result = await handler.handle(payload());
  assert.equal(result.accepted, true);
  assert.equal(result.receipt.campaignId, CAMPAIGN_ID);
  assert.equal(result.receipt.platform, 'douyin');
  assert.equal(result.receipt.contentVersionId, 'content-v1');
  assert.deepEqual(authorizationContext, {
    action:'publisher.publish',
    runId:RUN_ID,
    issueId:ISSUE_ID,
    campaignId:CAMPAIGN_ID,
    agentId:AGENT_ID,
    authorizationId:`paperclip:${RUN_ID}:${ISSUE_ID}:publisher.publish`,
  });
  assert.equal(result.receipt.idempotencyKey, `${CAMPAIGN_ID}:douyin:content-v1:2026-07-30`);
  const products = governance.calls.filter((item) => item.kind === 'work-product');
  assert.equal(products.length, 1);
  assert.equal(products[0].product.provider, 'agent-army.publisher-gateway');
  assert.equal(products[0].product.metadata.schemaVersion, 'agent.army/publish-receipt/v1');
  assert.equal(products[0].product.metadata.kind, 'PublishReceipt');
  assert.equal(governance.calls.filter((item) => item.kind === 'complete').length, 1);

  governance.issue.status = 'in_progress';
  const replay = await handler.handle(payload());
  assert.equal(replay.replayed, true);
  assert.equal(governance.calls.filter((item) => item.kind === 'work-product').length, 1);

  governance.issue.status = 'done';
  const completedReplay = await handler.handle(payload());
  assert.equal(completedReplay.replayed, true);
  assert.equal(governance.calls.filter((item) => item.kind === 'complete').length, 2);
});

test('done Issue 也必须通过 marker、Case、阶段、授权和唯一凭证核验', async () => {
  const governance = new FakeGovernance();
  governance.issue.status = 'done';
  governance.issue.description = governance.issue.description.replace('m5-publish', 'm5-review');
  let publishes = 0;
  const handler = new PaperclipPublisherController({
    governance,
    publisher:{ async publish() { publishes += 1; } },
    now:() => new Date(NOW),
  });
  await assert.rejects(() => handler.handle(payload()), /只接受 M5 发布 Routine/);
  assert.equal(publishes, 0);
  assert.equal(governance.calls.some((item) => item.kind === 'complete'), false);
});

test('调用方不能选择活动、平台、版本、文件、审核或幂等键', async () => {
  for (const [key, value] of [
    ['campaignId', CAMPAIGN_ID],
    ['platform', 'xiaohongshu'],
    ['contentVersionId', 'forged'],
    ['mediaPath', '../outside.mp4'],
    ['reviewReport', { status:'passed' }],
    ['idempotencyKey', 'forged'],
  ]) {
    const governance = new FakeGovernance();
    const handler = new PaperclipPublisherController({
      governance,
      publisher:gateway(),
      now:() => new Date(NOW),
    });
    await assert.rejects(() => handler.handle(payload({
      context:{ taskId:ISSUE_ID, nested:{ [key]:value } },
    })), new RegExp(`不接受调用方指定 ${key}`));
    assert.equal(governance.calls.length, 0);
  }
});

test('Publisher disabled 时安全失败，不写凭证或完成 Issue', async () => {
  const governance = new FakeGovernance();
  const handler = new PaperclipPublisherController({
    governance,
    publisher:null,
    now:() => new Date(NOW),
  });
  await assert.rejects(() => handler.handle(payload()), /真实发布保持关闭/);
  assert.equal(governance.calls.length, 0);
});

test('上海跨 UTC 午夜后拒绝执行前一日或未来平台 Case，Publisher 调用保持为零', async () => {
  for (const [scheduledDate, now] of [
    ['2026-07-30', '2026-07-30T16:00:00.000Z'],
    ['2026-08-01', '2026-07-31T04:00:00.000Z'],
  ]) {
    const governance = new FakeGovernance();
    governance.cases.get(CASE_ID).case.fields.scheduledDate = scheduledDate;
    let publishes = 0;
    const handler = new PaperclipPublisherController({
      governance,
      publisher:{
        async publish() {
          publishes += 1;
          throw new Error('日期错配不得调用 Publisher');
        },
      },
      now:() => new Date(now),
    });

    await assert.rejects(
      handler.handle(payload()),
      (error) => {
        assert.equal(error.code, 'publisher_scheduled_date_mismatch');
        assert.equal(
          error.recoveryAction?.action,
          'reschedule_platform_case_for_current_date',
        );
        assert.equal(error.recoveryAction?.scheduledDate, scheduledDate);
        assert.equal(error.recoveryAction?.executionDate, '2026-07-31');
        assert.equal(error.recoveryAction?.timeZone, 'Asia/Shanghai');
        return true;
      },
    );
    assert.equal(publishes, 0);
    assert.equal(
      governance.calls.some((item) => item.kind === 'work-product'),
      false,
    );
  }
});

test('marker、publish 阶段、active Grant、可信产物任一不成立均不会调用 Publisher', async (t) => {
  for (const [label, mutate, expected] of [
    ['marker', (governance) => {
      governance.issue.description = governance.issue.description.replace('m5-publish', 'm5-review');
    }, /只接受 M5 发布 Routine/],
    ['case-link', (governance) => {
      governance.assertCaseIssueLink = async () => {
        throw new Error('M5 发布任务与声明的 Pipeline Case 没有关联。');
      };
    }, /没有关联/],
    ['stage', (governance) => {
      governance.cases.get(CASE_ID).stage.key = 'verify';
    }, /不在 publish 阶段/],
    ['grant', (governance) => {
      governance.cases.get(CAMPAIGN_ID).case.fields.campaignGrant.status = 'paused';
    }, /active CampaignGrant/],
    ['content', (governance) => {
      governance.outputs[0].sourceTrust = {
        preset:'low_trust_review',
        disposition:'quarantined',
      };
    }, /可信 ContentVersion/],
    ['review', (governance) => {
      governance.outputs[1].metadata.reviewReport.checks.privacy = false;
    }, /机器审核未完整通过/],
    ['review-version', (governance) => {
      delete governance.outputs[1].metadata.reviewReport.contentVersionId;
    }, /机器审核未完整通过/],
    ['calendar-date', (governance) => {
      governance.cases.get(CASE_ID).case.fields.scheduledDate = '2026-02-31';
    }, /可信平台或发布日期/],
  ]) {
    await t.test(label, async () => {
      const governance = new FakeGovernance();
      mutate(governance);
      let publishes = 0;
      const handler = new PaperclipPublisherController({
        governance,
        publisher:{ async publish() { publishes += 1; } },
        now:() => new Date(NOW),
      });
      await assert.rejects(() => handler.handle(payload()), expected);
      assert.equal(publishes, 0);
      assert.equal(governance.calls.some((item) => item.kind === 'work-product'), false);
    });
  }
});

test('凭证写回后回读不唯一时不完成 Issue', async () => {
  const governance = new FakeGovernance();
  governance.createIssueWorkProduct = async (_issueId, product) => {
    governance.outputs.push(
      ...[1, 2].map((index) => ({
        id:`work_product:duplicate-${index}`,
        kind:'work_product',
        sourceTrust:null,
        ...structuredClone(product),
      })),
    );
  };
  const handler = new PaperclipPublisherController({
    governance,
    publisher:gateway(),
    now:() => new Date(NOW),
  });
  await assert.rejects(() => handler.handle(payload()), /必须唯一且可回读/);
  assert.equal(governance.calls.some((item) => item.kind === 'complete'), false);
});
