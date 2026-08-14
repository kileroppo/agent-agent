import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WECHAT_DRAFT_APPROVAL_SNAPSHOT_SCHEMA,
  WENYAN_RUNNER_SCHEMA,
  WechatDraftGateway,
  createWechatDraftComposition,
} from '../src/index.ts';
import { deterministicCostReporter } from '../test-support/cost-reporter.js';

const NOW = new Date('2026-08-05T03:00:00.000Z');

test('公众号草稿 composition 默认关闭且不读取真实依赖', () => {
  const input = { enabled:false };
  Object.defineProperty(input, 'connectorDependencies', {
    get() { throw new Error('默认关闭时不应读取 connector 依赖'); },
  });
  assert.equal(createWechatDraftComposition(input), null);
});

test('有效 Paperclip 快照只构造惰性草稿网关，不运行 CLI 或读取凭据', () => {
  let preflightCalls = 0;
  let credentialCalls = 0;
  const composition = createWechatDraftComposition({
    enabled:true,
    approvalSnapshot:approvalSnapshot(),
    connectorDependencies:{
      wenyan:{
        runner:{
          contract:{
            schemaVersion:WENYAN_RUNNER_SCHEMA,
            createsDraftOnly:true,
            groupSend:false,
          },
          preflight:async () => { preflightCalls += 1; },
          createDraft:async () => {},
        },
        credentialResolver:async () => { credentialCalls += 1; },
      },
    },
    workspaceRoot:path.join(os.tmpdir(), 'wechat-composition-workspace'),
    ledgerPath:path.join(os.tmpdir(), 'wechat-composition-ledger.json'),
    paperclipControl:control(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  });

  assert.equal(composition.mode, 'real');
  assert.equal(composition.accountRef, 'paperclip:account:wechat-main');
  assert.ok(composition.createGateway() instanceof WechatDraftGateway);
  assert.equal(preflightCalls, 0);
  assert.equal(credentialCalls, 0);
});

test('过期、错误平台或缺少 Wenyan 依赖均失败关闭', () => {
  const base = {
    enabled:true,
    workspaceRoot:'/tmp/wechat-composition-workspace',
    ledgerPath:'/tmp/wechat-composition-ledger.json',
    paperclipControl:control(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  };
  assert.throws(() => createWechatDraftComposition({
    ...base,
    approvalSnapshot:{ ...approvalSnapshot(), platform:'douyin' },
    connectorDependencies:{},
  }), { code:'wechat_draft_approval_invalid' });
  assert.throws(() => createWechatDraftComposition({
    ...base,
    approvalSnapshot:{ ...approvalSnapshot(), expiresAt:'2026-08-05T02:59:59.000Z' },
    connectorDependencies:{},
  }), { code:'wechat_draft_approval_invalid' });
  assert.throws(() => createWechatDraftComposition({
    ...base,
    approvalSnapshot:approvalSnapshot(),
    connectorDependencies:{},
  }), { code:'wechat_draft_connector_dependency_missing' });
});

function approvalSnapshot() {
  return {
    schemaVersion:WECHAT_DRAFT_APPROVAL_SNAPSHOT_SCHEMA,
    source:'paperclip',
    snapshotId:'paperclip:wechat-draft-approval-snapshot:001',
    status:'approved',
    platform:'wechat_official_account',
    capability:'create_wechat_draft',
    connectorKind:'wechat_wenyan_cli',
    approvalRef:'paperclip:connector-approval:wechat-wenyan',
    accountRef:'paperclip:account:wechat-main',
    secretRef:'paperclip:secret:wechat-main',
    capturedAt:'2026-08-05T02:59:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
}

function control() {
  return {
    assertWechatDraftAllowed:async () => { throw new Error('构造时不读取 Paperclip'); },
    pauseCampaignAndDisableCron:async () => { throw new Error('构造时不写 Paperclip'); },
  };
}
