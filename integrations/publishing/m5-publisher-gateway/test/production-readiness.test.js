import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PRODUCTION_READINESS_SCHEMA,
  createProductionReadinessReport,
} from '../src/index.js';
import {
  main,
  parseArguments,
} from '../scripts/check-production-readiness.mjs';

const DISABLED_HEALTH = {
  reachable:true,
  port:4390,
  httpStatus:200,
  body:{
    status:'disabled',
    mode:'disabled',
    hardStop:false,
    realConnectorsConfigured:false,
  },
};

const PRODUCTION_HEALTH = {
  reachable:true,
  port:4390,
  httpStatus:200,
  body:{
    status:'ok',
    mode:'real',
    hardStop:false,
    realConnectorsConfigured:true,
  },
};

const READINESS_CLOCK = () => new Date('2026-08-08T00:00:00.000Z');
const CURRENT_PROFILE_LEASE = Object.freeze({
  ref:'paperclip:cua-profile-lease:xiaohongshu-primary',
  status:'approved',
  expiresAt:'2026-08-09T00:00:00.000Z',
});

test('Gateway 公共导出和 package CLI 暴露同一只读生产预检', async () => {
  assert.equal(typeof createProductionReadinessReport, 'function');
  assert.equal(
    PRODUCTION_READINESS_SCHEMA,
    'agent.army/publisher-production-readiness/v1',
  );
  const packageJson = JSON.parse(
    await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    packageJson.scripts?.['production:readiness'],
    'node scripts/check-production-readiness.mjs',
  );
});

test('默认 disabled 服务与未授权输入明确报告 not_ready 和唯一下一步', async () => {
  const report = await createProductionReadinessReport({
    healthSnapshot:DISABLED_HEALTH,
    inputSnapshot:{
      campaign:{ status:'draft' },
      selectors:{},
      profileLeaseRef:null,
      productionProviderInjected:false,
    },
  });

  assert.equal(report.schemaVersion, PRODUCTION_READINESS_SCHEMA);
  assert.equal(report.status, 'not_ready');
  assert.equal(report.readOnly, true);
  assert.deepEqual(report.blockers.map((item) => item.code), [
    'publisher_health_not_production_ready',
    'campaign_not_approved',
    'selector_candidate_missing',
    'selector_frozen_missing',
    'profile_lease_reference_missing',
    'production_provider_not_injected',
  ]);
  assert.deepEqual(report.nextAction, {
    action:'obtain-approved-campaign-snapshot',
    reason:'campaign_not_approved',
  });
  assert.equal(Object.hasOwn(report, 'nextActions'), false);
});

test('全部只读前置条件满足时仍只建议申请受控真实发布审批', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'm5-production-readiness-')),
  );
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const candidate = path.join(root, 'candidate.json');
  const frozen = path.join(root, 'frozen.json');
  await fs.writeFile(candidate, '{}', { mode:0o600 });
  await fs.writeFile(frozen, '{}', { mode:0o444 });

  const report = await createProductionReadinessReport({
    healthSnapshot:PRODUCTION_HEALTH,
    inputSnapshot:{
      campaign:{ status:'approved' },
      selectors:{ candidate, frozen },
      profileLease:CURRENT_PROFILE_LEASE,
      productionProviderInjected:true,
    },
    clock:READINESS_CLOCK,
  });

  assert.equal(report.status, 'ready');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.nextAction, {
    action:'request-controlled-real-publish-approval',
    reason:'production_preflight_passed',
  });
  assert.deepEqual(report.checks.selectors, {
    candidate:{ present:true, safe:true, kind:'regular_file' },
    frozen:{ present:true, safe:true, kind:'regular_file' },
  });
});

test('已启动的 active Campaign 仍是有效生产授权状态', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'm5-production-readiness-active-')),
  );
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const candidate = path.join(root, 'candidate.json');
  const frozen = path.join(root, 'frozen.json');
  await fs.writeFile(candidate, '{}', { mode:0o600 });
  await fs.writeFile(frozen, '{}', { mode:0o444 });

  const report = await createProductionReadinessReport({
    healthSnapshot:PRODUCTION_HEALTH,
    inputSnapshot:{
      campaign:{ status:'active' },
      selectors:{ candidate, frozen },
      profileLease:CURRENT_PROFILE_LEASE,
      productionProviderInjected:true,
    },
    clock:READINESS_CLOCK,
  });

  assert.equal(report.status, 'ready');
  assert.deepEqual(report.checks.campaign, {
    snapshotPresent:true,
    status:'active',
    approved:true,
  });
});

test('stopped Campaign 明确要求新建授权草案，不能被当成 paused 或旧批准继续', async () => {
  const report = await createProductionReadinessReport({
    healthSnapshot:PRODUCTION_HEALTH,
    inputSnapshot:{
      campaign:{ status:'stopped' },
      selectors:{},
      profileLease:CURRENT_PROFILE_LEASE,
      productionProviderInjected:true,
    },
    clock:READINESS_CLOCK,
  });

  assert.equal(report.checks.campaign.status, 'stopped');
  assert.ok(report.blockers.some((item) => item.code === 'campaign_stopped'));
  assert.deepEqual(report.nextAction, {
    action:'create-new-campaign-authorization-draft',
    reason:'campaign_stopped',
  });
});

test('selector 候选符号链接或 frozen 宽写权限都形成阻断', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'm5-production-readiness-unsafe-')),
  );
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const source = path.join(root, 'source.json');
  const candidate = path.join(root, 'candidate-link.json');
  const frozen = path.join(root, 'frozen.json');
  await fs.writeFile(source, '{}', { mode:0o600 });
  await fs.symlink(source, candidate);
  await fs.writeFile(frozen, '{}', { mode:0o666 });
  await fs.chmod(frozen, 0o666);

  const report = await createProductionReadinessReport({
    healthSnapshot:PRODUCTION_HEALTH,
    inputSnapshot:{
      campaign:{ status:'approved' },
      selectors:{ candidate, frozen },
      profileLease:CURRENT_PROFILE_LEASE,
      productionProviderInjected:true,
    },
    clock:READINESS_CLOCK,
  });

  assert.equal(report.status, 'not_ready');
  assert.deepEqual(report.blockers.map((item) => item.code), [
    'selector_candidate_unsafe',
    'selector_frozen_unsafe',
  ]);
  assert.deepEqual(report.nextAction, {
    action:'prepare-safe-selector-candidate',
    reason:'selector_candidate_unsafe',
  });
});

test('输入快照或 Profile lease 引用夹带 Secret 标记时拒绝且不回显内容', async () => {
  const secret = 'never-print-me';
  const report = await createProductionReadinessReport({
    healthSnapshot:PRODUCTION_HEALTH,
    inputSnapshot:{
      campaign:{ status:'approved', token:secret },
      selectors:{},
      profileLease:{
        ref:`paperclip:secret:${secret}`,
        status:'approved',
        expiresAt:'2026-08-09T00:00:00.000Z',
      },
      productionProviderInjected:true,
    },
    clock:READINESS_CLOCK,
  });

  assert.equal(report.status, 'not_ready');
  assert.ok(report.blockers.some((item) => item.code === 'readiness_snapshot_contains_secret'));
  assert.ok(report.blockers.some((item) => item.code === 'profile_lease_reference_invalid'));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});

test('过期 Profile lease 和只有引用的旧快照都不能冒充当前有效授权', async () => {
  const expired = await createProductionReadinessReport({
    healthSnapshot:PRODUCTION_HEALTH,
    inputSnapshot:{
      campaign:{ status:'approved' },
      selectors:{},
      profileLease:{
        ref:'paperclip:cua-profile-lease:xiaohongshu-primary',
        status:'approved',
        expiresAt:'2026-08-07T23:59:59.999Z',
      },
      productionProviderInjected:true,
    },
    clock:READINESS_CLOCK,
  });
  assert.ok(expired.blockers.some((item) => item.code === 'profile_lease_expired'));
  assert.equal(expired.checks.profileLease.current, false);

  const legacy = await createProductionReadinessReport({
    healthSnapshot:PRODUCTION_HEALTH,
    inputSnapshot:{
      campaign:{ status:'approved' },
      selectors:{},
      profileLeaseRef:'paperclip:cua-profile-lease:xiaohongshu-primary',
      productionProviderInjected:true,
    },
    clock:READINESS_CLOCK,
  });
  assert.ok(legacy.blockers.some(
    (item) => item.code === 'profile_lease_status_unverified',
  ));
  assert.equal(legacy.checks.profileLease.current, false);
});

test('CLI 无输入时只探测固定 4390 并输出当前 not_ready，不接受 .env 快照', async () => {
  let output = '';
  let probes = 0;
  const report = await main([], {
    probeHealth:async () => {
      probes += 1;
      return DISABLED_HEALTH;
    },
    stdout:{ write:value => { output += value; } },
  });

  assert.equal(probes, 1);
  assert.equal(report.status, 'not_ready');
  assert.deepEqual(JSON.parse(output), report);
  assert.throws(
    () => parseArguments(['--snapshot', '.env']),
    { code:'production_readiness_snapshot_path_invalid' },
  );
});
