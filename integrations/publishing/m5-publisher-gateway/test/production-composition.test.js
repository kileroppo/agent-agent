import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CUA_PUBLISH_ACTIONS,
  CUA_RUNNER_SCHEMA,
  CuaPlatformConnector,
  DouyinOfficialApiConnector,
  PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA,
  createProductionPublisherComposition,
} from '../src/index.js';
import { deterministicCostReporter } from '../test-support/cost-reporter.js';
import {
  recordingAccountIdentityVerifier,
} from '../test-support/account-identity-verifier.js';

const NOW = new Date('2026-07-30T04:00:00.000Z');

test('production composition 默认关闭且不会读取批准快照或真实依赖', () => {
  const input = { enabled:false };
  Object.defineProperty(input, 'approvalSnapshot', {
    get() {
      throw new Error('默认关闭时不应读取批准快照');
    },
  });
  Object.defineProperty(input, 'connectorDependencies', {
    get() {
      throw new Error('默认关闭时不应读取 connector 依赖');
    },
  });

  assert.equal(createProductionPublisherComposition(input), null);
});

test('可信 Paperclip 批准快照与显式抖音依赖构成惰性 production composition', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-production-composition-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  let credentialCalls = 0;
  let httpCalls = 0;
  const composition = createProductionPublisherComposition({
    enabled:true,
    approvalSnapshot:approvalSnapshot([
      approval('douyin', 'douyin_official_api'),
    ]),
    connectorDependencies:{
      douyinOfficialApi:{
        credentialResolver:async () => {
          credentialCalls += 1;
          throw new Error('构造时不读取凭据');
        },
        httpRequest:async () => {
          httpCalls += 1;
          throw new Error('构造时不访问HTTP');
        },
      },
    },
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:control(),
    costReporter:deterministicCostReporter(),
    accountIdentityVerifier:recordingAccountIdentityVerifier(),
    clock:() => new Date(NOW),
  });

  assert.equal(composition.mode, 'real');
  assert.equal(composition.approvalSnapshotId, 'paperclip:publisher-approvals:test');
  assert.equal(credentialCalls, 0);
  assert.equal(httpCalls, 0);

  const runtime = composition.createRuntime();
  assert.equal(runtime.mode, 'real');
  assert.ok(runtime.connectors.douyin instanceof DouyinOfficialApiConnector);
  assert.equal(credentialCalls, 0);
  assert.equal(httpCalls, 0);
});

test('小红书 CUA runner 只能由 composition 调用方显式注入', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-production-cua-composition-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  let beginCalls = 0;
  const runner = {
    contract:{
      schemaVersion:CUA_RUNNER_SCHEMA,
      profileMode:'isolated_named',
      profileName:'m5-xiaohongshu-publisher',
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      allowedActions:[...CUA_PUBLISH_ACTIONS],
      arbitraryDesktop:false,
    },
    beginSession:async () => {
      beginCalls += 1;
      throw new Error('构造时不启动 session');
    },
    perform:async () => {},
    endSession:async () => {},
  };
  const composition = createProductionPublisherComposition({
    enabled:true,
    approvalSnapshot:approvalSnapshot([
      approval('xiaohongshu', 'cua'),
    ]),
    connectorDependencies:{ cuaRunners:{ xiaohongshu:runner } },
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:control(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  });

  const runtime = composition.createRuntime();
  assert.ok(runtime.connectors.xiaohongshu instanceof CuaPlatformConnector);
  assert.equal(beginCalls, 0);
});

test('伪造快照、重复平台、过期批准或缺少显式依赖均失败关闭', () => {
  const base = {
    enabled:true,
    workspaceRoot:'/tmp/m5-production-composition',
    ledgerPath:'/tmp/m5-production-composition-ledger.json',
    paperclipControl:control(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  };
  assert.throws(() => createProductionPublisherComposition({
    ...base,
    approvalSnapshot:{ ...approvalSnapshot([]), source:'environment' },
    connectorDependencies:{},
  }), { code:'publisher_approval_snapshot_invalid' });
  assert.throws(() => createProductionPublisherComposition({
    ...base,
    approvalSnapshot:approvalSnapshot([
      approval('douyin', 'douyin_official_api'),
      approval('douyin', 'cua'),
    ]),
    connectorDependencies:{},
  }), { code:'publisher_approval_snapshot_invalid' });
  assert.throws(() => createProductionPublisherComposition({
    ...base,
    approvalSnapshot:approvalSnapshot([
      { ...approval('douyin', 'douyin_official_api'), expiresAt:'2026-07-30T03:59:59.000Z' },
    ]),
    connectorDependencies:{
      douyinOfficialApi:{
        credentialResolver:async () => ({}),
        httpRequest:async () => ({}),
      },
    },
  }), { code:'real_connector_approval_invalid' });
  assert.throws(() => createProductionPublisherComposition({
    ...base,
    approvalSnapshot:approvalSnapshot([
      approval('xiaohongshu', 'cua'),
    ]),
    connectorDependencies:{},
  }), { code:'publisher_connector_dependency_missing' });
  assert.throws(() => createProductionPublisherComposition({
    ...base,
    approvalSnapshot:{
      ...approvalSnapshot([
        approval('douyin', 'douyin_official_api'),
      ]),
      capturedAt:'2026-07-30T04:00:00.001Z',
    },
    connectorDependencies:{
      douyinOfficialApi:{
        credentialResolver:async () => ({}),
        httpRequest:async () => ({}),
      },
    },
  }), { code:'publisher_approval_snapshot_invalid' });
});

function approvalSnapshot(approvals) {
  return {
    schemaVersion:PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA,
    source:'paperclip',
    snapshotId:'paperclip:publisher-approvals:test',
    capturedAt:'2026-07-30T03:59:00.000Z',
    approvals,
  };
}

function approval(platform, connectorKind) {
  return {
    status:'approved',
    approvalRef:`paperclip:connector-approval:${platform}-${connectorKind}`,
    platform,
    connectorKind,
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
}

function control() {
  return {
    assertPublishAllowed:async () => {
      throw new Error('构造时不读取 Paperclip');
    },
    pauseCampaignAndDisableCron:async () => {
      throw new Error('构造时不写 Paperclip');
    },
  };
}
