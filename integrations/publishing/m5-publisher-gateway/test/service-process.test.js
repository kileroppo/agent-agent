import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FilePublisherRepository,
  PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA,
  createProductionPublisherComposition,
  publishIdempotencyKey,
} from '../src/index.js';
import { createPublisherGatewayService } from '../src/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceScript = path.resolve(here, '../scripts/run-service.mjs');
const authorizedServiceScript = path.resolve(here, '../test-support/run-authorized-service.mjs');
const campaignId = '11111111-1111-4111-8111-111111111111';
const routineId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const runId = '55555555-5555-4555-8555-555555555555';
const issueId = '66666666-6666-4666-8666-666666666666';

test('独立服务默认 disabled，健康可读且发布接口失败关闭', async (context) => {
  const child = await startService({});
  context.after(() => stopChild(child.process));

  const health = await requestJson(`${child.origin}/health`);
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, {
    status:'disabled',
    mode:'disabled',
    hardStop:false,
    realConnectorsConfigured:false,
  });

  const rejected = await requestJson(`${child.origin}/publish`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:'{}',
  });
  assert.equal(rejected.response.status, 503);
  assert.equal(rejected.body.error, 'publisher_runtime_disabled');
});

test('独立服务不能只靠 real 环境变量发现 connector 或写入授权', async (context) => {
  const child = await startService({
    M5_PUBLISHER_MODE:'real',
    M5_PUBLISHER_PRODUCTION_ENABLED:'1',
    M5_PUBLISHER_APPROVAL_SNAPSHOT:'paperclip:forged-from-env',
    M5_PUBLISHER_CONNECTOR_KIND:'douyin_official_api',
  });
  context.after(() => stopChild(child.process));

  const health = await requestJson(`${child.origin}/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.mode, 'real');
  assert.equal(health.body.realConnectorsConfigured, false);
  const rejected = await requestJson(
    `${child.origin}/publish`,
    authorizedJsonPost({ campaignId }, 'paperclip-auth-env-real', 'publisher.publish'),
  );
  assert.equal(rejected.response.status, 503);
  assert.equal(rejected.body.error, 'publisher_request_authorizer_required');
});

test('写接口在 Runtime 初始化前拒绝缺失、错配和重放的 Paperclip 授权', async (context) => {
  const authorizer = {
    authorize:async (input) => {
      if (input.authorizationId === 'paperclip-auth-replayed') {
        return { ...input, authorized:true, replayed:true };
      }
      if (input.authorizationId === 'paperclip-auth-mismatch') {
        return { ...input, authorized:true, action:'publisher.read_own_metrics' };
      }
      return { ...input, authorized:true, replayed:false };
    },
  };
  const service = createPublisherGatewayService({
    mode:'fake',
    host:'127.0.0.1',
    port:0,
    workspaceRoot:'relative-path-that-must-not-be-read-before-auth',
    ledgerPath:'relative-ledger-that-must-not-be-read-before-auth',
    paperclipControl:{
      assertPublishAllowed:async () => {
        throw new Error('授权失败前不应读取 Paperclip');
      },
      pauseCampaignAndDisableCron:async () => {},
    },
    requestAuthorizer:authorizer,
  });
  context.after(() => service.close());
  const address = await service.listen();
  const origin = address.origin;

  const missing = await requestJson(`${origin}/publish`, jsonPost({ campaignId }));
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error, 'publisher_request_unauthorized');
  assert.equal(service.runtime, null);

  const mismatched = await requestJson(
    `${origin}/publish`,
    authorizedJsonPost(
      { campaignId },
      'paperclip-auth-mismatch',
      'publisher.publish',
    ),
  );
  assert.equal(mismatched.response.status, 403);
  assert.equal(mismatched.body.error, 'publisher_authorization_scope_mismatch');
  assert.equal(service.runtime, null);

  const campaignMismatch = await requestJson(
    `${origin}/publish`,
    authorizedJsonPost(
      { campaignId:'different-campaign' },
      'paperclip-auth-campaign-mismatch',
      'publisher.publish',
    ),
  );
  assert.equal(campaignMismatch.response.status, 403);
  assert.equal(campaignMismatch.body.error, 'publisher_authorization_scope_mismatch');
  assert.equal(service.runtime, null);

  const replayed = await requestJson(
    `${origin}/publish`,
    authorizedJsonPost(
      { campaignId },
      'paperclip-auth-replayed',
      'publisher.publish',
    ),
  );
  assert.equal(replayed.response.status, 409);
  assert.equal(replayed.body.error, 'publisher_authorization_replayed');
  assert.equal(service.runtime, null);
});

test('缺少 requestAuthorizer 时写接口失败关闭且 Runtime 保持未初始化', async (context) => {
  const service = createPublisherGatewayService({
    mode:'fake',
    host:'127.0.0.1',
    port:0,
    workspaceRoot:'relative-path-that-must-not-be-read-before-auth',
    ledgerPath:'relative-ledger-that-must-not-be-read-before-auth',
    paperclipControl:{
      assertPublishAllowed:async () => {},
      pauseCampaignAndDisableCron:async () => {},
    },
  });
  context.after(() => service.close());
  const address = await service.listen();
  const response = await requestJson(
    `${address.origin}/publish`,
    authorizedJsonPost({ campaignId }, 'publisher-auth-missing', 'publisher.publish'),
  );
  assert.equal(response.response.status, 503);
  assert.equal(response.body.error, 'publisher_request_authorizer_required');
  assert.equal(service.runtime, null);
});

test('standalone real 服务拒绝注入可信 production composition', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-standalone-real-denied-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const now = new Date();
  const productionComposition = createProductionPublisherComposition({
    enabled:true,
    approvalSnapshot:{
      schemaVersion:PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA,
      source:'paperclip',
      snapshotId:'paperclip:standalone-real-must-be-denied',
      capturedAt:new Date(now.getTime() - 1_000).toISOString(),
      approvals:[{
        status:'approved',
        approvalRef:'paperclip:connector-approval:xhs-standalone-denied',
        platform:'xiaohongshu',
        connectorKind:'cua',
        capability:'publish',
        expiresAt:new Date(now.getTime() + 60_000).toISOString(),
      }],
    },
    connectorDependencies:{
      cuaRunners:{ xiaohongshu:{} },
    },
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:{
      assertPublishAllowed:async () => {
        throw new Error('standalone 拒绝前不应回读 Paperclip');
      },
      pauseCampaignAndDisableCron:async () => {
        throw new Error('standalone 拒绝前不应写 Paperclip');
      },
    },
    clock:() => new Date(now),
  });

  assert.throws(() => createPublisherGatewayService({
    mode:'real',
    host:'127.0.0.1',
    port:0,
    productionComposition,
    requestAuthorizer:{
      authorize:async (input) => ({ ...input, authorized:true, replayed:false }),
    },
  }), { code:'standalone_real_publisher_denied' });
});

test('fake 独立进程完成发布和回执，重启后幂等重放', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-service-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const media = Buffer.from('standalone-fake-publisher-video');
  await fs.writeFile(path.join(root, 'douyin.mp4'), media);
  const checksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  const paperclip = await startFakePaperclip();
  context.after(() => closeServer(paperclip.server));
  const env = {
    M5_PUBLISHER_MODE:'fake',
    M5_PUBLISHER_HOST:'127.0.0.1',
    M5_PUBLISHER_PORT:'0',
    M5_PUBLISHER_WORKSPACE_ROOT:root,
    M5_PUBLISHER_LEDGER_PATH:path.join(root, 'ledger', 'publisher.json'),
    M5_PUBLISHER_PAPERCLIP_API_BASE:paperclip.origin,
    M5_PUBLISHER_DAILY_ROUTINE_ID:routineId,
  };

  let child = await startService(env, { withAuthorizer:true });
  context.after(() => stopChild(child.process));
  const health = await requestJson(`${child.origin}/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.mode, 'fake');
  assert.equal(health.body.realConnectorsConfigured, false);

  const request = publishRequest(checksum, paperclip.grant);
  const first = await requestJson(
    `${child.origin}/publish`,
    authorizedJsonPost(request, 'paperclip-auth-publish-0001', 'publisher.publish'),
  );
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  assert.match(first.body.receipt.externalContentId, /^fake-douyin-/);

  const authorizationReplay = await requestJson(
    `${child.origin}/publish`,
    authorizedJsonPost(request, 'paperclip-auth-publish-0001', 'publisher.publish'),
  );
  assert.equal(authorizationReplay.response.status, 409);
  assert.equal(authorizationReplay.body.error, 'publisher_authorization_replayed');

  const receipt = await requestJson(
    `${child.origin}/receipts/${encodeURIComponent(first.body.receipt.receiptId)}`,
  );
  assert.equal(receipt.response.status, 200);
  assert.equal(receipt.body.receipt.receiptId, first.body.receipt.receiptId);
  assert.deepEqual(receipt.body.receipt.metricSnapshots, []);

  const metrics = await requestJson(
    `${child.origin}/metrics`,
    authorizedJsonPost({
      receiptId:first.body.receipt.receiptId,
      collectionKey:`${first.body.receipt.receiptId}:2h`,
      collectedAt:new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    }, 'paperclip-auth-metrics-0001', 'publisher.read_own_metrics'),
  );
  assert.equal(metrics.response.status, 422, JSON.stringify(metrics.body));
  assert.equal(metrics.body.error, 'metric_checkpoint_not_due');

  const withMetrics = await requestJson(
    `${child.origin}/receipts/${encodeURIComponent(first.body.receipt.receiptId)}`,
  );
  assert.equal(withMetrics.body.receipt.metricSnapshots.length, 0);

  await stopChild(child.process);
  child = await startService(env, { withAuthorizer:true });
  const replay = await requestJson(
    `${child.origin}/publish`,
    authorizedJsonPost(request, 'paperclip-auth-publish-0002', 'publisher.publish'),
  );
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.receipt.receiptId, first.body.receipt.receiptId);
  assert.equal(paperclip.assertCalls, 2);
});

test('到点指标写入文件账本后，独立进程重启只重放同一份快照', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-metric-restart-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const ledgerPath = path.join(root, 'ledger', 'publisher.json');
  const receipt = {
    receiptId:'55555555-5555-4555-8555-555555555555',
    idempotencyKey:'campaign-metric:douyin:content-metric:2026-07-30',
    campaignId:'campaign-metric',
    platform:'douyin',
    contentVersionId:'content-metric',
    contentChecksum:`sha256:${'a'.repeat(64)}`,
    scheduledDate:'2026-07-30',
    externalContentId:'fake-douyin-metric-restart',
    evidence:'fake://douyin/content/metric-restart',
    accountRef:'account:douyin:test',
    publishedAt:new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    connectorMode:'fake',
  };
  await new FilePublisherRepository(ledgerPath).write({
    receipts:{ [receipt.idempotencyKey]:receipt },
  });
  const paperclip = await startFakePaperclip();
  context.after(() => closeServer(paperclip.server));
  const env = {
    M5_PUBLISHER_MODE:'fake',
    M5_PUBLISHER_HOST:'127.0.0.1',
    M5_PUBLISHER_PORT:'0',
    M5_PUBLISHER_WORKSPACE_ROOT:root,
    M5_PUBLISHER_LEDGER_PATH:ledgerPath,
    M5_PUBLISHER_PAPERCLIP_API_BASE:paperclip.origin,
    M5_PUBLISHER_DAILY_ROUTINE_ID:routineId,
  };
  const input = {
    receiptId:receipt.receiptId,
    collectionKey:`${receipt.receiptId}:2h`,
    collectedAt:new Date().toISOString(),
  };

  let child = await startService(env, { withAuthorizer:true });
  context.after(() => stopChild(child.process));
  const crossCampaign = await requestJson(
    `${child.origin}/metrics`,
    authorizedJsonPost(
      input,
      'paperclip-auth-metric-cross-campaign',
      'publisher.read_own_metrics',
      campaignId,
    ),
  );
  assert.equal(crossCampaign.response.status, 422, JSON.stringify(crossCampaign.body));
  assert.equal(crossCampaign.body.error, 'metric_campaign_scope_mismatch');

  const first = await requestJson(
    `${child.origin}/metrics`,
    authorizedJsonPost(
      input,
      'paperclip-auth-metric-restart-0001',
      'publisher.read_own_metrics',
      receipt.campaignId,
    ),
  );
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  await stopChild(child.process);

  child = await startService(env, { withAuthorizer:true });
  const replay = await requestJson(
    `${child.origin}/metrics`,
    authorizedJsonPost(
      input,
      'paperclip-auth-metric-restart-0002',
      'publisher.read_own_metrics',
      receipt.campaignId,
    ),
  );
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.snapshot.snapshotId, first.body.snapshot.snapshotId);
  const persisted = await requestJson(
    `${child.origin}/receipts/${encodeURIComponent(receipt.receiptId)}`,
  );
  assert.equal(persisted.body.receipt.metricSnapshots.length, 1);
});

test('独立进程拒绝绑定非 loopback 地址', async () => {
  const result = await runServiceUntilExit({
    M5_PUBLISHER_HOST:'0.0.0.0',
    M5_PUBLISHER_PORT:'0',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /publisher_service_host_denied/);
  assert.doesNotMatch(result.stdout, /publisher_gateway_listening/);
});

async function startFakePaperclip() {
  const grant = activeGrant();
  const state = {
    caseVersion:1,
    grant,
    triggerEnabled:true,
    assertCalls:0,
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://paperclip.test');
    if (request.method === 'GET' && url.pathname === `/api/cases/${campaignId}`) {
      state.assertCalls += 1;
      return sendJson(response, 200, caseDocument(state));
    }
    if (request.method === 'GET' && url.pathname === `/api/routines/${routineId}`) {
      return sendJson(response, 200, {
        id:routineId,
        projectId,
        triggers:[{
          id:'44444444-4444-4444-8444-444444444444',
          kind:'schedule',
          enabled:state.triggerEnabled,
        }],
      });
    }
    if (
      request.method === 'PATCH'
      && url.pathname === '/api/routine-triggers/44444444-4444-4444-8444-444444444444'
    ) {
      const body = await readJson(request);
      state.triggerEnabled = body.enabled;
      return sendJson(response, 200, { id:'44444444-4444-4444-8444-444444444444', ...body });
    }
    if (request.method === 'PATCH' && url.pathname === `/api/cases/${campaignId}`) {
      const body = await readJson(request);
      assert.equal(body.expectedVersion, state.caseVersion);
      state.caseVersion += 1;
      state.grant = body.fields.campaignGrant;
      return sendJson(response, 200, caseDocument(state));
    }
    return sendJson(response, 404, { error:'not_found' });
  });
  const address = await listen(server);
  return {
    server,
    origin:`http://127.0.0.1:${address.port}`,
    grant,
    get assertCalls() {
      return state.assertCalls;
    },
  };
}

function caseDocument(state) {
  return {
    case:{
      id:campaignId,
      version:state.caseVersion,
      parentCaseId:null,
      fields:{
        projectId,
        campaignGrant:structuredClone(state.grant),
      },
    },
    stage:{ key:'campaign_active' },
    pipeline:{ projectId },
  };
}

function activeGrant() {
  const now = Date.now();
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{ douyin:'account:douyin:test', xiaohongshu:'account:xhs:test' },
    startsAt:new Date(now - 24 * 60 * 60_000).toISOString(),
    expiresAt:new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
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
  };
}

function publishRequest(checksum, grant) {
  const request = {
    campaignId,
    grant:structuredClone(grant),
    platform:'douyin',
    contentVersionId:'content-v1',
    contentChecksum:checksum,
    scheduledDate:dateInShanghai(new Date()),
    mediaPath:'douyin.mp4',
    title:'独立服务本地 fake 发布',
    body:'只生成本地假回执，不访问真实平台。',
    tags:['AI Agent'],
    reviewReport:{
      status:'passed',
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
  };
  request.idempotencyKey = publishIdempotencyKey(request);
  return request;
}

function dateInShanghai(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'Asia/Shanghai',
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function startService(extraEnv, { withAuthorizer = false } = {}) {
  const processHandle = spawn(
    process.execPath,
    [withAuthorizer ? authorizedServiceScript : serviceScript],
    {
    env:{
      ...process.env,
      M5_PUBLISHER_MODE:'',
      M5_PUBLISHER_HOST:'127.0.0.1',
      M5_PUBLISHER_PORT:'0',
      M5_PUBLISHER_WORKSPACE_ROOT:'',
      M5_PUBLISHER_LEDGER_PATH:'',
      M5_PUBLISHER_PAPERCLIP_API_BASE:'',
      M5_PUBLISHER_PAPERCLIP_API_KEY:'',
      M5_PUBLISHER_DAILY_ROUTINE_ID:'',
      M5_PUBLISHER_PRODUCTION_ENABLED:'',
      ...extraEnv,
      M5_PUBLISHER_PORT:'0',
    },
      stdio:['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  processHandle.stdout.setEncoding('utf8');
  processHandle.stderr.setEncoding('utf8');
  processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
  processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Publisher 服务启动超时：${stderr}`));
    }, 5_000);
    const inspect = () => {
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'publisher_gateway_listening') {
            clearTimeout(timeout);
            resolve(event);
            return;
          }
        } catch {
          // Ignore incomplete output until the next chunk arrives.
        }
      }
    };
    processHandle.stdout.on('data', inspect);
    processHandle.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Publisher 服务提前退出 ${code}：${stderr}`));
    });
  });
  if (
    address.host !== '127.0.0.1'
    || !Number.isInteger(address.port)
    || address.port <= 0
    || new URL(address.origin).port !== String(address.port)
  ) {
    await stopChild(processHandle);
    throw new Error(`Publisher 测试服务没有使用 OS 分配的 loopback 临时端口：${JSON.stringify(address)}`);
  }
  return {
    process:processHandle,
    origin:address.origin,
    host:address.host,
    port:address.port,
  };
}

async function runServiceUntilExit(extraEnv) {
  const processHandle = spawn(process.execPath, [serviceScript], {
    env:{
      ...process.env,
      M5_PUBLISHER_MODE:'',
      M5_PUBLISHER_HOST:'127.0.0.1',
      ...extraEnv,
      M5_PUBLISHER_PORT:'0',
    },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.setEncoding('utf8');
  processHandle.stderr.setEncoding('utf8');
  processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
  processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => processHandle.once('exit', resolve));
  return { code, stdout, stderr };
}

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await new Promise((resolve) => processHandle.once('exit', resolve));
}

function jsonPost(body) {
  return {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  };
}

function authorizedJsonPost(body, authorizationId, unusedAction, authorizedCampaignId = campaignId) {
  return {
    ...jsonPost(body),
    headers:{
      'content-type':'application/json',
      authorization:'Bearer fixture-paperclip-run-token',
      'x-paperclip-run-id':runId,
      'x-paperclip-issue-id':issueId,
      'x-paperclip-campaign-id':authorizedCampaignId,
      'x-paperclip-authorization-id':authorizationId,
    },
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  return { response, body:await response.json() };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address();
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type':'application/json' });
  response.end(JSON.stringify(payload));
}
