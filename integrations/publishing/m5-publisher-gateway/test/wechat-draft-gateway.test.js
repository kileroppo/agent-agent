import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { M5_SCHEMA_IDS } from '@agent-army/m5-contracts';
import {
  MemoryPublisherRepository,
  WechatDraftGateway,
  WorkspaceArtifactVerifier,
} from '../src/index.js';
import { deterministicCostReporter } from '../test-support/cost-reporter.js';

const NOW = new Date('2026-08-05T03:00:00.000Z');

test('公众号草稿成功写入独立回执，重复请求不重复调用 connector', async (context) => {
  const fixture = await createFixture(context);
  const connector = successfulConnector();
  const control = paperclipControl();
  const reporter = deterministicCostReporter();
  const gateway = new WechatDraftGateway({
    repository:new MemoryPublisherRepository(),
    artifactVerifier:new WorkspaceArtifactVerifier(fixture.root),
    connector,
    approvalScope:approvalScope(),
    paperclipControl:control,
    costReporter:reporter,
    clock:() => new Date(NOW),
  });

  const first = await gateway.createDraft(fixture.request);
  const replay = await gateway.createDraft(fixture.request);

  assert.equal(first.replayed, false);
  assert.equal(first.receipt.schemaVersion, M5_SCHEMA_IDS.WECHAT_DRAFT_RECEIPT);
  assert.equal(first.receipt.kind, 'WechatDraftReceipt');
  assert.equal(first.receipt.externalPublished, false);
  assert.equal(first.receipt.groupSent, false);
  assert.equal(first.receipt.humanReviewRequired, true);
  assert.equal(first.receipt.externalDraftId, 'draft-media-123');
  assert.equal(replay.replayed, true);
  assert.equal(connector.calls.length, 1);
  assert.equal(control.authorizationCalls.length, 3);
  assert.equal(control.pauseCalls.length, 0);
  assert.equal(reporter.reportCalls.length, 1);
  assert.equal(reporter.reportCalls[0].amountUsd, 0);
  assert.equal(reporter.reportCalls[0].operation, 'create_wechat_draft');
});

test('Paperclip 授权不匹配时不会获取文件或调用公众号', async (context) => {
  const fixture = await createFixture(context);
  const connector = successfulConnector();
  const control = paperclipControl({ authorized:false });
  const verifier = {
    async acquire() {
      throw new Error('授权失败时不应获取文件');
    },
  };
  const gateway = new WechatDraftGateway({
    repository:new MemoryPublisherRepository(),
    artifactVerifier:verifier,
    connector,
    approvalScope:approvalScope(),
    paperclipControl:control,
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  });

  await assert.rejects(() => gateway.createDraft(fixture.request), {
    code:'wechat_draft_authorization_invalid',
  });
  assert.equal(connector.calls.length, 0);
});

test('公众号调用结果不确定会暂停活动，后续请求禁止自动重试', async (context) => {
  const fixture = await createFixture(context);
  const control = paperclipControl();
  const connector = successfulConnector({ fail:true });
  const gateway = new WechatDraftGateway({
    repository:new MemoryPublisherRepository(),
    artifactVerifier:new WorkspaceArtifactVerifier(fixture.root),
    connector,
    approvalScope:approvalScope(),
    paperclipControl:control,
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  });

  await assert.rejects(() => gateway.createDraft(fixture.request), {
    code:'wechat_draft_attempt_ambiguous',
  });
  await assert.rejects(() => gateway.createDraft(fixture.request), {
    code:'wechat_draft_attempt_ambiguous',
  });
  assert.equal(connector.calls.length, 1);
  assert.equal(control.pauseCalls.length, 1);
  assert.equal(control.pauseCalls[0].reason, 'wechat_draft_attempt_requires_reconciliation');
});

test('公众号 connector 返回其他账号时按不确定结果暂停', async (context) => {
  const fixture = await createFixture(context);
  const control = paperclipControl();
  const connector = successfulConnector({ accountRef:'paperclip:account:other' });
  const gateway = new WechatDraftGateway({
    repository:new MemoryPublisherRepository(),
    artifactVerifier:new WorkspaceArtifactVerifier(fixture.root),
    connector,
    approvalScope:approvalScope(),
    paperclipControl:control,
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  });
  await assert.rejects(() => gateway.createDraft(fixture.request), {
    code:'wechat_draft_attempt_ambiguous',
  });
  assert.equal(control.pauseCalls.length, 1);
});

test('预算不足会在文件外发前暂停活动，且请求不能夹带凭据', async (context) => {
  const fixture = await createFixture(context);
  const control = paperclipControl();
  const connector = successfulConnector();
  const gateway = new WechatDraftGateway({
    repository:new MemoryPublisherRepository(),
    artifactVerifier:new WorkspaceArtifactVerifier(fixture.root),
    connector,
    approvalScope:approvalScope(),
    paperclipControl:control,
    costReporter:deterministicCostReporter({ allowed:false }),
    clock:() => new Date(NOW),
  });
  await assert.rejects(() => gateway.createDraft({
    ...fixture.request,
    appSecret:'must-not-enter-request',
  }), { code:'wechat_draft_request_invalid' });
  await assert.rejects(() => gateway.createDraft(fixture.request), {
    code:'publisher_budget_exceeded',
  });
  assert.equal(connector.calls.length, 0);
  assert.equal(control.pauseCalls.length, 1);
  assert.equal(control.pauseCalls[0].reason, 'budget_exceeded');
});

test('公众号草稿成功但回执落账失败时暂停活动且绝不自动重发', async (context) => {
  const fixture = await createFixture(context);
  const control = paperclipControl();
  const connector = successfulConnector();
  const gateway = new WechatDraftGateway({
    repository:new FailReceiptCommitRepository(),
    artifactVerifier:new WorkspaceArtifactVerifier(fixture.root),
    connector,
    approvalScope:approvalScope(),
    paperclipControl:control,
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  });
  await assert.rejects(() => gateway.createDraft(fixture.request), {
    code:'wechat_draft_attempt_ambiguous',
  });
  await assert.rejects(() => gateway.createDraft(fixture.request), {
    code:'wechat_draft_attempt_ambiguous',
  });
  assert.equal(connector.calls.length, 1);
  assert.equal(control.pauseCalls.length, 1);
});

async function createFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-draft-gateway-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'wechat/images'), { recursive:true });
  const article = '---\ntitle: Agent Army\n---\nBody\n';
  const image = 'image-data';
  await fs.writeFile(path.join(root, 'wechat/article.md'), article);
  await fs.writeFile(path.join(root, 'wechat/images/cover.png'), image);
  return {
    root,
    request:{
      schemaVersion:M5_SCHEMA_IDS.WECHAT_DRAFT_REQUEST,
      campaignId:'campaign-wechat-001',
      contentVersionId:'content-version-001',
      accountRef:'paperclip:account:wechat-main',
      secretRef:'paperclip:secret:wechat-main',
      authorizationId:'paperclip:wechat-draft-auth:001',
      articlePath:'wechat/article.md',
      theme:'default',
      highlight:'solarized-light',
      files:[
        { relativePath:'wechat/article.md', checksum:checksum(article) },
        { relativePath:'wechat/images/cover.png', checksum:checksum(image) },
      ],
    },
  };
}

function checksum(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function successfulConnector({ fail = false, accountRef = 'paperclip:account:wechat-main' } = {}) {
  const calls = [];
  return {
    platform:'wechat_official_account',
    connectorMode:'real:wechat_wenyan_cli',
    costReportingMode:'local_zero',
    calls,
    async createDraft(input) {
      calls.push(input);
      if (fail) throw Object.assign(new Error('unknown transport result'), { code:'transport_lost' });
      return {
        state:'draft_created',
        externalDraftId:'draft-media-123',
        evidence:'wenyan:draft:draft-media-123',
        accountRef,
        draftCreatedAt:NOW.toISOString(),
      };
    },
  };
}

function paperclipControl({ authorized = true } = {}) {
  const authorizationCalls = [];
  const pauseCalls = [];
  return {
    authorizationCalls,
    pauseCalls,
    async assertWechatDraftAllowed(input) {
      authorizationCalls.push(structuredClone(input));
      return {
        authorized,
        source:'paperclip',
        capability:'create_wechat_draft',
        campaignId:input.campaignId,
        accountRef:input.accountRef,
        secretRef:input.secretRef,
        authorizationId:input.authorizationId,
        approvalRef:'paperclip:approval:wechat-draft',
        expiresAt:'2026-08-06T00:00:00.000Z',
      };
    },
    async pauseCampaignAndDisableCron(input) {
      pauseCalls.push(structuredClone(input));
      return {
        campaignId:input.campaignId,
        grantStatus:'paused',
        cronStatus:'disabled',
        controlEventId:'paperclip:event:pause-wechat-draft',
      };
    },
  };
}

function approvalScope() {
  return {
    accountRef:'paperclip:account:wechat-main',
    secretRef:'paperclip:secret:wechat-main',
  };
}

class FailReceiptCommitRepository extends MemoryPublisherRepository {
  async update(mutator) {
    return super.update(async (state) => {
      const receiptCount = Object.keys(state.receipts).length;
      const result = await mutator(state);
      if (Object.keys(state.receipts).length > receiptCount) {
        throw new Error('simulated receipt commit failure');
      }
      return result;
    });
  }
}
