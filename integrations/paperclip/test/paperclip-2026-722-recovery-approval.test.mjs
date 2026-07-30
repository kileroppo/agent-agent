import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  PAPERCLIP_VERSION,
  RECOVERY_APPROVAL_KIND,
  RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256,
  RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256,
  applyRecoveryApprovalPatch,
  bindRecoveryApprovalPayload,
  canonicalRecoveryScope,
  decideRecoveryConsume,
  decideRecoveryConsumeBinding,
  decideRecoveryRevoke,
  hashRecoveryScope,
  normalizeRecoveryApprovalPayload,
  patchRecoveryApprovalRouteSource,
  rollbackRecoveryApprovalPatch,
} from '../compat/paperclip-2026-722-recovery-approval.mjs';
import { main as applyMain } from '../scripts/apply-paperclip-2026-722-recovery-approval.mjs';
import { main as rollbackMain } from '../scripts/rollback-paperclip-2026-722-recovery-approval.mjs';

const SCOPE = Object.freeze({
  action:'publisher.reconcile_stale_attempt',
  campaignId:'33333333-3333-4333-8333-333333333333',
  receiptId:'44444444-4444-4444-8444-444444444444',
  collectionKey:'44444444-4444-4444-8444-444444444444:24h',
  attemptId:'attempt-1',
  conclusion:'no_external_effect',
  authorizationId:'authorization-1',
  evidenceRef:'paperclip:work-product:evidence-1',
  issueId:'11111111-1111-4111-8111-111111111111',
  consumerAgentId:'22222222-2222-4222-8222-222222222222',
});

test('scope canonical hash 与键顺序无关，任一授权字段变化都会失配', () => {
  const reordered = {
    consumerAgentId:SCOPE.consumerAgentId,
    issueId:SCOPE.issueId,
    evidenceRef:SCOPE.evidenceRef,
    conclusion:SCOPE.conclusion,
    authorizationId:SCOPE.authorizationId,
    collectionKey:SCOPE.collectionKey,
    receiptId:SCOPE.receiptId,
    attemptId:SCOPE.attemptId,
    campaignId:SCOPE.campaignId,
    action:SCOPE.action,
  };
  assert.equal(canonicalRecoveryScope(SCOPE), canonicalRecoveryScope(reordered));
  assert.equal(hashRecoveryScope(SCOPE), hashRecoveryScope(reordered));
  assert.notEqual(hashRecoveryScope(SCOPE), hashRecoveryScope({
    ...SCOPE,
    collectionKey:'72h',
  }));
  assert.throws(() => canonicalRecoveryScope({ ...SCOPE, invalid:Infinity }), /有限 JSON/);
});

test('创建和重提时由服务端重算 hash、拒绝过期，并清空伪造的撤销消费状态', () => {
  const now = new Date('2026-07-31T02:00:00.000Z');
  const normalized = normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:SCOPE,
    scopeHash:'sha256:attacker-controlled',
    expiresAt:'2026-07-31T03:00:00.000Z',
    revokedAt:'2026-01-01T00:00:00.000Z',
    revokedByUserId:'attacker',
    consumedAt:'2026-01-01T00:00:00.000Z',
    consumedByRunId:'attacker',
    consumedByAgentId:'attacker',
  }, { now });
  assert.equal(normalized.scopeHash, hashRecoveryScope(SCOPE));
  assert.equal(normalized.revokedAt, null);
  assert.equal(normalized.revokedByUserId, null);
  assert.equal(normalized.consumedAt, null);
  assert.equal(normalized.consumedByRunId, null);
  assert.equal(normalized.consumedByAgentId, null);
  const bound = bindRecoveryApprovalPayload(
    normalized,
    '55555555-5555-4555-8555-555555555555',
  );
  assert.equal(
    bound.scope.authorizationId,
    'paperclip:approval:55555555-5555-4555-8555-555555555555:recovery',
  );
  assert.equal(bound.scopeHash, hashRecoveryScope(bound.scope));
  assert.notEqual(bound.scopeHash, normalized.scopeHash);

  assert.throws(() => normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:SCOPE,
    expiresAt:'2026-07-31T02:00:00.000Z',
  }, { now }), /未来时间/);
  assert.throws(() => normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:{ ...SCOPE, conclusion:'operator_guess' },
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now }), /conclusion/);
  assert.throws(() => normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:{ ...SCOPE, extra:'not-approved' },
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now }), /未授权字段/);
  assert.throws(() => normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:{ ...SCOPE, collectionKey:`${SCOPE.receiptId}:6h` },
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now }), /固定检查点/);
  assert.throws(() => normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:{ ...SCOPE, campaignId:'not-a-uuid' },
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now }), /UUID/);
  assert.throws(() => normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:{ ...SCOPE, evidenceRef:'unsafe ref with spaces' },
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now }), /安全引用/);
});

test('consume 只允许未过期未撤销的一次消费，同 run+agent+scope 重试是 exact replay', () => {
  const now = new Date('2026-07-31T02:00:00.000Z');
  const payload = normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:SCOPE,
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now });
  assert.deepEqual(decideRecoveryConsume(payload, {
    scopeHash:payload.scopeHash,
    runId:'33333333-3333-4333-8333-333333333333',
    agentId:SCOPE.consumerAgentId,
    now,
  }), { action:'apply' });

  const consumed = {
    ...payload,
    consumedAt:'2026-07-31T02:01:00.000Z',
    consumedByRunId:'33333333-3333-4333-8333-333333333333',
    consumedByAgentId:SCOPE.consumerAgentId,
  };
  assert.deepEqual(decideRecoveryConsume(consumed, {
    scopeHash:payload.scopeHash,
    runId:consumed.consumedByRunId,
    agentId:consumed.consumedByAgentId,
    now,
  }), { action:'replay' });
  assert.deepEqual(decideRecoveryConsume(consumed, {
    scopeHash:payload.scopeHash,
    runId:'44444444-4444-4444-8444-444444444444',
    agentId:consumed.consumedByAgentId,
    now,
  }), { action:'deny', reason:'consumed' });
  assert.deepEqual(decideRecoveryConsume({
    ...payload,
    revokedAt:'2026-07-31T02:01:00.000Z',
  }, {
    scopeHash:payload.scopeHash,
    runId:'33333333-3333-4333-8333-333333333333',
    agentId:SCOPE.consumerAgentId,
    now,
  }), { action:'deny', reason:'revoked' });
  assert.deepEqual(decideRecoveryConsume({
    ...payload,
    expiresAt:'2026-07-31T01:59:59.000Z',
  }, {
    scopeHash:payload.scopeHash,
    runId:'33333333-3333-4333-8333-333333333333',
    agentId:SCOPE.consumerAgentId,
    now,
  }), { action:'deny', reason:'expired' });
});

test('board revoke 与 consume 互斥，重复 revoke 是幂等重放', () => {
  const now = new Date('2026-07-31T02:00:00.000Z');
  const payload = normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:SCOPE,
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now });
  assert.deepEqual(decideRecoveryRevoke(payload), { action:'apply' });
  assert.deepEqual(decideRecoveryRevoke({
    ...payload,
    revokedAt:'2026-07-31T02:01:00.000Z',
  }), { action:'replay' });
  assert.deepEqual(decideRecoveryRevoke({
    ...payload,
    consumedAt:'2026-07-31T02:01:00.000Z',
    consumedByRunId:'33333333-3333-4333-8333-333333333333',
    consumedByAgentId:SCOPE.consumerAgentId,
  }), { action:'deny', reason:'consumed' });

  const consumed = {
    ...payload,
    consumedAt:'2026-07-31T02:01:00.000Z',
    consumedByRunId:'33333333-3333-4333-8333-333333333333',
    consumedByAgentId:SCOPE.consumerAgentId,
  };
  assert.deepEqual(decideRecoveryRevoke(consumed), {
    action:'deny',
    reason:'consumed',
  });
  const revoked = {
    ...payload,
    revokedAt:'2026-07-31T02:01:00.000Z',
  };
  assert.deepEqual(decideRecoveryConsume(revoked, {
    scopeHash:payload.scopeHash,
    runId:'33333333-3333-4333-8333-333333333333',
    agentId:SCOPE.consumerAgentId,
    now,
  }), { action:'deny', reason:'revoked' });
});

test('consume-vs-revoke 在同 scope 串行锁下并发时只允许一方 applied', async () => {
  const now = new Date('2026-07-31T02:00:00.000Z');
  let payload = normalizeRecoveryApprovalPayload({
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope:SCOPE,
    expiresAt:'2026-07-31T03:00:00.000Z',
  }, { now });
  let lock = Promise.resolve();
  const serialized = async (action) => {
    const previous = lock;
    let release;
    lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (action === 'consume') {
        const decision = decideRecoveryConsume(payload, {
          scopeHash:payload.scopeHash,
          runId:'33333333-3333-4333-8333-333333333333',
          agentId:SCOPE.consumerAgentId,
          now,
        });
        if (decision.action === 'apply') {
          payload = {
            ...payload,
            consumedAt:now.toISOString(),
            consumedByRunId:'33333333-3333-4333-8333-333333333333',
            consumedByAgentId:SCOPE.consumerAgentId,
          };
        }
        return decision;
      }
      const decision = decideRecoveryRevoke(payload);
      if (decision.action === 'apply') {
        payload = { ...payload, revokedAt:now.toISOString() };
      }
      return decision;
    } finally {
      release();
    }
  };
  const decisions = await Promise.all([
    serialized('consume'),
    serialized('revoke'),
  ]);
  assert.equal(decisions.filter((item) => item.action === 'apply').length, 1);
  assert.equal(decisions.filter((item) => item.action === 'deny').length, 1);
});

test('consume 只接受 agent Run JWT，并逐项绑定 company/agent/run/issue/link', () => {
  const actor = {
    type:'agent',
    source:'agent_jwt',
    companyId:'company-1',
    agentId:SCOPE.consumerAgentId,
    runId:'33333333-3333-4333-8333-333333333333',
  };
  const approval = { id:'approval-1', companyId:'company-1' };
  const run = {
    id:actor.runId,
    companyId:approval.companyId,
    agentId:actor.agentId,
    contextSnapshot:{ issueId:SCOPE.issueId },
  };
  const link = {
    companyId:approval.companyId,
    approvalId:approval.id,
    issueId:SCOPE.issueId,
  };
  const binding = { actor, approval, scope:SCOPE, run, link };
  assert.deepEqual(decideRecoveryConsumeBinding(binding), { allowed:true });
  assert.deepEqual(decideRecoveryConsumeBinding({
    ...binding,
    actor:{ ...actor, type:'board', source:'local_implicit' },
  }), { allowed:false, reason:'run_jwt' });
  assert.deepEqual(decideRecoveryConsumeBinding({
    ...binding,
    actor:{ ...actor, source:'agent_key' },
  }), { allowed:false, reason:'run_jwt' });
  assert.deepEqual(decideRecoveryConsumeBinding({
    ...binding,
    actor:{ ...actor, companyId:'wrong-company' },
  }), { allowed:false, reason:'company' });
  assert.deepEqual(decideRecoveryConsumeBinding({
    ...binding,
    scope:{ ...SCOPE, consumerAgentId:'wrong-agent' },
  }), { allowed:false, reason:'scope' });
  for (const wrongRun of [
    { ...run, id:'wrong-run' },
    { ...run, companyId:'wrong-company' },
    { ...run, agentId:'wrong-agent' },
    { ...run, contextSnapshot:{ issueId:'wrong-issue' } },
  ]) {
    assert.deepEqual(decideRecoveryConsumeBinding({
      ...binding,
      run:wrongRun,
    }), { allowed:false, reason:'run' });
  }
  assert.deepEqual(decideRecoveryConsumeBinding({
    ...binding,
    link:{ ...link, issueId:'wrong-issue' },
  }), { allowed:false, reason:'issue_link' });
});

test('route 补丁锁定唯一源码锚点和原/目标 SHA，未知源码失败关闭', async (context) => {
  assert.equal(PAPERCLIP_VERSION, '2026.722.0');
  assert.match(RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256, /^[a-f0-9]{64}$/);
  assert.match(RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256, /^[a-f0-9]{64}$/);
  assert.notEqual(
    RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256,
    RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256,
  );
  assert.throws(
    () => patchRecoveryApprovalRouteSource('unknown source'),
    /SHA或补丁锚点不匹配/,
  );

  const installedRoute = await resolveInstalledApprovalRoute();
  const original = await fs.readFile(installedRoute, 'utf8');
  const patched = patchRecoveryApprovalRouteSource(original);
  assert.equal(patchRecoveryApprovalRouteSource(patched), patched);
  assert.match(patched, /recovery-authorizations\/consume/);
  assert.match(patched, /recovery-authorizations\/revoke/);
  assert.match(patched, /pg_advisory_xact_lock/);
  assert.match(patched, /issueApprovals/);
  assert.match(patched, /heartbeatRuns/);
  assert.match(patched, /recoveryApprovalId = recoveryPayloadRequested \? randomUUID\(\)/);
  assert.match(patched, /id: recoveryApprovalId/);
  assert.match(
    patched,
    /recoveryPayloadResubmitted && existing\.type !== "request_board_approval"/,
  );
  assert.match(patched, /req\.actor\.source !== "agent_jwt"/);
  assert.doesNotMatch(
    patched.slice(
      patched.indexOf('recovery-authorizations/consume'),
      patched.indexOf('recovery-authorizations/revoke'),
    ),
    /assertBoard\(req\)/,
  );
});

test('Paperclip原生 approval svc.create 接受显式id并原样写入同一次insert', async () => {
  const installedRoute = await resolveInstalledApprovalRoute();
  const serviceFile = path.join(
    path.dirname(path.dirname(installedRoute)),
    'services',
    'approvals.js',
  );
  const { approvalService } = await import(pathToFileURL(serviceFile).href);
  let inserted = null;
  const db = {
    insert() {
      return {
        values(value) {
          inserted = value;
          return {
            returning() {
              return Promise.resolve([value]);
            },
          };
        },
      };
    },
  };
  const approvalId = '55555555-5555-4555-8555-555555555555';
  const companyId = '66666666-6666-4666-8666-666666666666';
  const created = await approvalService(db).create(companyId, {
    id:approvalId,
    type:'request_board_approval',
    payload:{ governanceKind:RECOVERY_APPROVAL_KIND },
  });
  assert.equal(inserted.id, approvalId);
  assert.equal(inserted.companyId, companyId);
  assert.equal(created.id, approvalId);
});

test('route 补丁在隔离副本上生成0600备份、幂等且可恢复原SHA', async (context) => {
  const installedRoute = await resolveInstalledApprovalRoute();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-recovery-approval-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const paperclipRoot = path.join(root, 'node_modules', 'paperclipai');
  const serverRoot = path.join(root, 'node_modules', '@paperclipai', 'server');
  const paperclipEntry = path.join(paperclipRoot, 'dist', 'index.js');
  const routeFile = path.join(serverRoot, 'dist', 'routes', 'approvals.js');
  await fs.mkdir(path.dirname(paperclipEntry), { recursive:true });
  await fs.mkdir(path.dirname(routeFile), { recursive:true });
  await fs.writeFile(path.join(paperclipRoot, 'package.json'), JSON.stringify({
    name:'paperclipai',
    version:PAPERCLIP_VERSION,
  }));
  await fs.writeFile(path.join(serverRoot, 'package.json'), JSON.stringify({
    name:'@paperclipai/server',
    version:PAPERCLIP_VERSION,
  }));
  await fs.writeFile(paperclipEntry, '');
  await fs.copyFile(installedRoute, routeFile);

  const applied = await applyRecoveryApprovalPatch({ paperclipEntry });
  assert.equal(applied.changed, true);
  assert.equal(applied.status, 'applied');
  assert.equal(await fileSha(routeFile), RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256);
  assert.equal(await fileSha(applied.backupFile), RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256);
  assert.equal((await fs.stat(applied.backupFile)).mode & 0o777, 0o600);
  assert.deepEqual(
    pick(await applyRecoveryApprovalPatch({ paperclipEntry }), ['changed', 'status']),
    { changed:false, status:'already_applied' },
  );

  const rolledBack = await rollbackRecoveryApprovalPatch({ paperclipEntry });
  assert.equal(rolledBack.changed, true);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(await fileSha(routeFile), RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256);
  assert.equal(await fileSha(rolledBack.backupFile), RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256);
});

test('apply和rollback CLI缺少版本与动作双确认时不修改', async () => {
  await assert.rejects(applyMain([]), /显式确认/);
  await assert.rejects(rollbackMain([]), /显式确认/);
});

async function fileSha(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

async function resolveInstalledApprovalRoute() {
  const explicit = process.env.PAPERCLIP_2026_722_APPROVAL_ROUTE;
  if (explicit) return explicit;
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  const entries = await fs.readdir(npxRoot, { withFileTypes:true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageFile = path.join(
      npxRoot,
      entry.name,
      'node_modules',
      '@paperclipai',
      'server',
      'package.json',
    );
    const routeFile = path.join(
      npxRoot,
      entry.name,
      'node_modules',
      '@paperclipai',
      'server',
      'dist',
      'routes',
      'approvals.js',
    );
    try {
      const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'));
      if (
        pkg.name === '@paperclipai/server'
        && pkg.version === PAPERCLIP_VERSION
        && await fileSha(routeFile) === RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256
      ) {
        return routeFile;
      }
    } catch {
      // Keep looking for the exact installed compatibility target.
    }
  }
  throw new Error('未找到原版 Paperclip 2026.722.0 approvals.js 测试目标。');
}
