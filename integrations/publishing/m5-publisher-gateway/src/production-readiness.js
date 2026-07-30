import fs from 'node:fs/promises';
import path from 'node:path';

export const PRODUCTION_READINESS_SCHEMA =
  'agent.army/publisher-production-readiness/v1';

const PUBLISHER_PORT = 4390;
const FORBIDDEN_KEY = /(cookie|token|secret|password|credential|authorization|api.?key|login.?state)/i;
const FORBIDDEN_REFERENCE = /(cookie|token|secret|password|credential|authorization|api.?key|login.?state|bearer)/i;

export async function createProductionReadinessReport({
  healthSnapshot = null,
  inputSnapshot = null,
  fileSystem = fs,
} = {}) {
  const blockers = [];
  const health = inspectHealth(healthSnapshot, blockers);
  const snapshot = normalizeInputSnapshot(inputSnapshot, blockers);
  const campaign = inspectCampaign(snapshot, blockers);
  const candidateBlockers = [];
  const frozenBlockers = [];
  const [candidate, frozen] = await Promise.all([
    inspectSelectorFile(
      snapshot?.selectors?.candidate,
      'candidate',
      fileSystem,
      candidateBlockers,
    ),
    inspectSelectorFile(
      snapshot?.selectors?.frozen,
      'frozen',
      fileSystem,
      frozenBlockers,
    ),
  ]);
  blockers.push(...candidateBlockers, ...frozenBlockers);
  const profileLease = inspectProfileLeaseReference(snapshot?.profileLeaseRef, blockers);
  const productionProvider = inspectProductionProvider(
    snapshot?.productionProviderInjected,
    blockers,
  );
  const status = blockers.length === 0 ? 'ready' : 'not_ready';

  return {
    schemaVersion:PRODUCTION_READINESS_SCHEMA,
    status,
    readOnly:true,
    checks:{
      health,
      campaign,
      selectors:{ candidate, frozen },
      profileLease,
      productionProvider,
    },
    blockers,
    nextAction:nextAction(blockers),
  };
}

function inspectHealth(value, blockers) {
  const body = value?.body;
  const result = {
    port:value?.port === PUBLISHER_PORT ? PUBLISHER_PORT : null,
    reachable:value?.reachable === true,
    httpStatus:Number.isInteger(value?.httpStatus) ? value.httpStatus : null,
    status:['disabled', 'ok'].includes(body?.status) ? body.status : 'unknown',
    mode:['disabled', 'fake', 'real'].includes(body?.mode) ? body.mode : 'unknown',
    hardStop:body?.hardStop === true,
    realConnectorsConfigured:body?.realConnectorsConfigured === true,
  };
  const ready = result.port === PUBLISHER_PORT
    && result.reachable
    && result.httpStatus === 200
    && result.status === 'ok'
    && result.mode === 'real'
    && !result.hardStop
    && result.realConnectorsConfigured;
  if (!ready) {
    blockers.push(blocker(
      'publisher_health_not_production_ready',
      'health',
      '4390 health 未同时满足 real、无 hard stop 和真实 connector 已配置。',
    ));
  }
  return { ...result, ready };
}

function normalizeInputSnapshot(value, blockers) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    blockers.push(blocker(
      'campaign_snapshot_missing',
      'campaign',
      '缺少 Campaign draft/approved 输入快照。',
    ));
    return null;
  }
  if (containsForbiddenKey(value)) {
    blockers.push(blocker(
      'readiness_snapshot_contains_secret',
      'input_snapshot',
      '生产预检输入只能包含状态和引用，不能包含 Secret 字段。',
    ));
  }
  return value;
}

function inspectCampaign(snapshot, blockers) {
  if (!snapshot) {
    return { snapshotPresent:false, status:'missing', approved:false };
  }
  const status = ['draft', 'approved'].includes(snapshot?.campaign?.status)
    ? snapshot.campaign.status
    : 'unknown';
  const approved = status === 'approved';
  if (!approved) {
    blockers.push(blocker(
      'campaign_not_approved',
      'campaign',
      'Campaign 输入快照不是 approved。',
    ));
  }
  return { snapshotPresent:true, status, approved };
}

async function inspectSelectorFile(value, kind, fileSystem, blockers) {
  const missingCode = `selector_${kind}_missing`;
  const unsafeCode = `selector_${kind}_unsafe`;
  if (typeof value !== 'string' || !value) {
    blockers.push(blocker(
      missingCode,
      `selector_${kind}`,
      `${kind} selector 文件引用不存在。`,
    ));
    return { present:false, safe:false, kind:null };
  }
  const file = path.resolve(value);
  if (!path.isAbsolute(value) || file === path.parse(file).root) {
    blockers.push(blocker(
      unsafeCode,
      `selector_${kind}`,
      `${kind} selector 必须是明确的安全普通文件。`,
    ));
    return { present:true, safe:false, kind:'unsafe' };
  }
  try {
    const stat = await fileSystem.lstat(file);
    const safe = stat.isFile()
      && !stat.isSymbolicLink()
      && stat.size > 0
      && (stat.mode & 0o022) === 0
      && await fileSystem.realpath(file) === file;
    if (!safe) {
      blockers.push(blocker(
        unsafeCode,
        `selector_${kind}`,
        `${kind} selector 必须是不可由组或其他用户写入的普通非链接文件。`,
      ));
    }
    return {
      present:true,
      safe,
      kind:safe ? 'regular_file' : 'unsafe',
    };
  } catch {
    blockers.push(blocker(
      unsafeCode,
      `selector_${kind}`,
      `${kind} selector 文件不存在、不可读或无法安全核验。`,
    ));
    return { present:false, safe:false, kind:null };
  }
}

function inspectProfileLeaseReference(value, blockers) {
  if (value === null || value === undefined || value === '') {
    blockers.push(blocker(
      'profile_lease_reference_missing',
      'profile_lease',
      '缺少 Paperclip Profile lease 引用。',
    ));
    return { present:false, safe:false, source:null };
  }
  const safe = typeof value === 'string'
    && value.startsWith('paperclip:')
    && !FORBIDDEN_REFERENCE.test(value);
  if (!safe) {
    blockers.push(blocker(
      'profile_lease_reference_invalid',
      'profile_lease',
      'Profile lease 只能提供不含 Secret 的 Paperclip 引用。',
    ));
  }
  return {
    present:true,
    safe,
    source:safe ? 'paperclip_reference' : null,
  };
}

function inspectProductionProvider(value, blockers) {
  const injected = value === true;
  if (!injected) {
    blockers.push(blocker(
      'production_provider_not_injected',
      'production_provider',
      'production provider 尚未由可信 composition 显式注入。',
    ));
  }
  return { injected };
}

function containsForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  return Object.entries(value).some(([key, item]) => (
    FORBIDDEN_KEY.test(key) || containsForbiddenKey(item)
  ));
}

function blocker(code, check, message) {
  return { code, check, message };
}

function nextAction(blockers) {
  const codes = new Set(blockers.map((item) => item.code));
  for (const [reason, action] of [
    ['readiness_snapshot_contains_secret', 'replace-snapshot-with-reference-only-fields'],
    ['campaign_snapshot_missing', 'provide-campaign-status-snapshot'],
    ['campaign_not_approved', 'obtain-approved-campaign-snapshot'],
    ['selector_candidate_missing', 'prepare-safe-selector-candidate'],
    ['selector_candidate_unsafe', 'prepare-safe-selector-candidate'],
    ['selector_frozen_missing', 'freeze-approved-selector-bundle'],
    ['selector_frozen_unsafe', 'freeze-approved-selector-bundle'],
    ['profile_lease_reference_missing', 'obtain-paperclip-profile-lease-reference'],
    ['profile_lease_reference_invalid', 'replace-profile-lease-with-safe-reference'],
    ['production_provider_not_injected', 'inject-approved-production-provider'],
    ['publisher_health_not_production_ready', 'verify-production-health-on-4390'],
  ]) {
    if (codes.has(reason)) return { action, reason };
  }
  return {
    action:'request-controlled-real-publish-approval',
    reason:'production_preflight_passed',
  };
}
