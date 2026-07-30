import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CapabilityGrantError,
  CapabilityGrantStore,
  FileCapabilityGrantAdapter,
  MemoryCapabilityGrantAdapter,
  normalizeCapabilityGrant
} from '../src/capability-grant-store.js';

const safeGrant = {
  capabilityId:'public-search-v2',
  source:{ kind:'official_registry', locator:'registry://hermes/public-search' },
  version:'2.1.0',
  hash:`sha256:${'a'.repeat(64)}`,
  permissions:['public-web:read'],
  risk:'low',
  audit:{ status:'passed', evidenceRefs:['artifact:audit-1'] },
  sandbox:{ status:'passed', evidenceRefs:['artifact:sandbox-1'] },
  expiresAt:'2026-08-29T00:00:00.000Z',
  rollbackRef:'capability:public-search-v1'
};

test('低风险能力在审计、沙箱和最小权限检查通过后才可 active', () => {
  const grant = normalizeCapabilityGrant(safeGrant, {
    allowedPermissions:['public-web:read', 'workspace:read'],
    now:'2026-07-29T10:00:00.000Z'
  });
  assert.equal(grant.schemaVersion, 'agent.army/capability-grant/v1');
  assert.equal(grant.status, 'active');
  assert.equal(grant.source.kind, 'official_registry');
  assert.deepEqual(grant.permissions, ['public-web:read']);
  assert.equal(grant.audit.status, 'passed');
  assert.equal(grant.sandbox.status, 'passed');
  assert.equal(grant.rollbackRef, 'capability:public-search-v1');
});

test('高风险、凭据、外部写入或权限扩大一律等待审批', () => {
  for (const patch of [
    { risk:'high' },
    { requiresCredentials:true },
    { externalWrite:true },
    { permissions:['workspace:write'] }
  ]) {
    const grant = normalizeCapabilityGrant({ ...safeGrant, ...patch }, {
      allowedPermissions:['public-web:read'],
      now:'2026-07-29T10:00:00.000Z'
    });
    assert.equal(grant.status, 'waiting_approval');
    assert.equal(grant.approval.required, true);
  }
});

test('能力契约拒绝敏感字段和未通过审计的伪 active 记录', () => {
  assert.throws(
    () => normalizeCapabilityGrant({ ...safeGrant, metadata:{ token:'never-store-this' } }),
    (error) => error instanceof CapabilityGrantError && error.code === 'sensitive_data_rejected'
  );
  const pending = normalizeCapabilityGrant({
    ...safeGrant,
    status:'active',
    audit:{ status:'failed', evidenceRefs:['artifact:audit-failed'] }
  }, {
    allowedPermissions:['public-web:read'],
    now:'2026-07-29T10:00:00.000Z'
  });
  assert.equal(pending.status, 'rejected');
});

test('可注入内存 Store 以 capabilityId 幂等更新并返回副本', async () => {
  const adapter = new MemoryCapabilityGrantAdapter();
  const store = new CapabilityGrantStore({
    adapter,
    allowedPermissions:['public-web:read'],
    clock:() => new Date('2026-07-29T10:00:00.000Z')
  });
  const saved = await store.upsert(safeGrant);
  saved.permissions.push('mutated-by-caller');
  assert.deepEqual((await store.get('public-search-v2')).permissions, ['public-web:read']);

  await store.upsert({ ...safeGrant, version:'2.2.0', hash:`sha256:${'b'.repeat(64)}` });
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].version, '2.2.0');
});

test('文件 Adapter 只持久化脱敏授权契约，并可由新 Store 重新读取', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-grants-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const filePath = path.join(directory, 'grants.json');
  const options = {
    allowedPermissions:['public-web:read'],
    clock:() => new Date('2026-07-29T10:00:00.000Z')
  };
  const writer = new CapabilityGrantStore({
    ...options,
    adapter:new FileCapabilityGrantAdapter({ filePath })
  });
  await writer.upsert(safeGrant);

  const reader = new CapabilityGrantStore({
    ...options,
    adapter:new FileCapabilityGrantAdapter({ filePath })
  });
  assert.equal((await reader.get('public-search-v2')).status, 'active');
  const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(disk.schemaVersion, 'agent.army/capability-grant-store/v1');
  assert.equal(JSON.stringify(disk).includes('token'), false);
});
