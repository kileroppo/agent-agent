import {
  CUA_SELECTOR_BUNDLE_SCHEMA,
  selectorBundleChecksum,
  validateApprovedProfileLease,
} from './cua-trust-contracts.js';
import {
  XHS_OWN_METRIC_CONTEXT_SCHEMA,
  XHS_OWN_METRIC_OBSERVATION_SCHEMA,
  XHS_OWN_METRIC_PAGE_KIND,
  normalizeXhsOwnMetricObservation,
  xhsOwnMetricCollectionKey,
} from './xhs-own-metrics-contract.js';
import { coded } from './policy.js';

export const XHS_OWN_METRICS_CUA_RUNNER_SCHEMA =
  'agent.army/xhs-own-metrics-cua-runner/v1';
export const XHS_OWN_METRICS_CUA_ACTIONS = Object.freeze([
  'navigate',
  'read',
  'filter',
  'open_detail',
  'read_metrics',
]);

const PLATFORM = 'xiaohongshu';
const ALLOWED_ORIGINS = new Set([
  'https://creator.xiaohongshu.com',
  'https://pro.xiaohongshu.com',
]);
const HARD_STOP_REASONS = new Set([
  'captcha',
  'login',
  'login_required',
  'identity_verification',
  'risk',
  'risk_control',
  'account_switch',
  'unknown_page',
]);
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const EXTERNAL_CONTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SEMVER = /^[1-9]\d*\.\d+\.\d+$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

const PAGE_STATES = Object.freeze({
  navigate:'content_list',
  read:'account_verified',
  filter:'content_filtered',
  open_detail:XHS_OWN_METRIC_PAGE_KIND,
  read_metrics:XHS_OWN_METRIC_PAGE_KIND,
});
const METRIC_SELECTOR_KEYS = Object.freeze([
  'actions',
  'identity',
  'metrics',
  'path',
]);
const METRIC_SELECTOR_IDENTITY_KEYS = Object.freeze([
  'accountTextPattern',
  'contentIdPattern',
]);
const METRIC_SELECTOR_ACTION_KEYS = Object.freeze(['label']);
const METRIC_SELECTOR_ARRAY_KEYS = Object.freeze(['0', '1', '2', '3']);
const SECRET_LIKE_KEY =
  /(?:api.?key|authorization|bearer|cookie|credential|login.?state|password|secret|storage|token)/i;

export class XhsOwnMetricsCuaConnector {
  constructor({
    runner,
    selectorBundle,
    profileLease,
    enabled = false,
    clock = () => new Date(),
  } = {}) {
    this.platform = PLATFORM;
    this.connectorMode = 'real:xiaohongshu_own_metrics_cua';
    this.costReportingMode = 'local_zero';
    this.runner = runner;
    this.selectorBundle = selectorBundle;
    this.profileLease = profileLease;
    this.enabled = enabled === true;
    this.clock = clock;
    if (this.enabled) this.validateTrust();
  }

  async readOwnMetrics(trustedReceipt, collectedAt, context = {}) {
    return this.collect({
      trustedReceipt,
      collectedAt,
      checkpoint:context.checkpoint,
      collectionKey:context.collectionKey,
    });
  }

  async collect(input = {}) {
    if (!this.enabled) {
      throw coded(
        'xhs_metrics_cua_connector_disabled',
        '小红书本人指标 CUA connector 默认关闭，尚未获得单独启用批准。',
      );
    }
    const request = validateCollectionRequest(input);
    const trust = this.validateTrust(request.trustedReceipt.accountRef);
    if (request.trustedReceipt.accountRef !== trust.profile.accountRef) {
      throw coded(
        'xhs_metrics_cua_account_mismatch',
        '小红书本人指标回执账号与获批命名 Profile 不一致。',
      );
    }

    const session = await this.runner.beginSession({
      platform:PLATFORM,
      origin:trust.selector.origin,
      accountRef:trust.profile.accountRef,
      externalContentId:request.trustedReceipt.externalContentId,
      profile:{
        mode:'isolated_named',
        name:trust.profile.profileName,
        identityClaim:{ ...trust.profile.identityClaim },
      },
      selectorBundle:{
        bundleVersion:trust.selector.bundleVersion,
        selectorChecksum:trust.selector.selectorChecksum,
        approvalRef:trust.selector.approvalRef,
        selectorMap:structuredClone(trust.selector.selectorMap),
      },
      allowedActions:[...XHS_OWN_METRICS_CUA_ACTIONS],
      readOnly:true,
    });
    const sessionId = String(session?.sessionId || '');
    if (!sessionId) hardStop('unknown_page');

    try {
      inspectBaseObservation(
        session.observation,
        trust.selector.origin,
        'ready',
      );
      let finalObservation;
      for (const step of metricSteps(request, trust.selector)) {
        const observation = await this.runner.perform({
          sessionId,
          platform:PLATFORM,
          expectedOrigin:trust.selector.origin,
          action:step.action,
          input:step.input,
        });
        inspectStepObservation({
          observation,
          action:step.action,
          request,
          trust,
        });
        finalObservation = observation;
      }

      return normalizeXhsOwnMetricObservation({
        ...request,
        trustedContext:{
          schemaVersion:XHS_OWN_METRIC_CONTEXT_SCHEMA,
          source:'paperclip',
          approvalRef:trust.selector.approvalRef,
          origin:trust.selector.origin,
          pageKind:XHS_OWN_METRIC_PAGE_KIND,
          accountRef:trust.profile.accountRef,
          selectorBundleVersion:trust.selector.bundleVersion,
          selectorChecksum:trust.selector.selectorChecksum,
        },
        observation:{
          schemaVersion:XHS_OWN_METRIC_OBSERVATION_SCHEMA,
          kind:'ok',
          origin:finalObservation.origin,
          pageKind:XHS_OWN_METRIC_PAGE_KIND,
          accountRef:finalObservation.accountRef,
          externalContentId:finalObservation.externalContentId,
          selectorBundleVersion:finalObservation.selectorBundleVersion,
          selectorChecksum:finalObservation.selectorChecksum,
          capturedAt:finalObservation.observedAt,
          metrics:structuredClone(finalObservation.metrics),
        },
      });
    } finally {
      await this.runner.endSession({
        sessionId,
        platform:PLATFORM,
        readOnly:true,
      });
    }
  }

  validateTrust(accountRef = this.profileLease?.accountRef) {
    const checkedAt = normalizeClock(this.clock);
    const checkedClock = () => checkedAt;
    const selector = validateMetricSelectorBundle(
      this.selectorBundle,
      checkedClock,
    );
    const profile = validateApprovedProfileLease(this.profileLease, {
      platform:PLATFORM,
      accountRef,
      clock:checkedClock,
    });
    validateRunner(this.runner, selector, profile);
    return { selector, profile };
  }
}

function validateCollectionRequest(input) {
  const receipt = input?.trustedReceipt;
  if (
    !receipt
    || receipt.platform !== PLATFORM
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
      .test(String(receipt.receiptId || ''))
    || !REFERENCE.test(String(receipt.accountRef || ''))
    || !EXTERNAL_CONTENT_ID.test(String(receipt.externalContentId || ''))
    || !REFERENCE.test(String(receipt.contentVersionId || ''))
  ) {
    throw coded(
      'xhs_metrics_cua_request_invalid',
      '小红书本人指标 CUA 只能读取结构完整的可信 PublishReceipt。',
    );
  }
  const expectedCollectionKey = xhsOwnMetricCollectionKey(
    receipt.receiptId,
    input.checkpoint,
  );
  if (input.collectionKey !== expectedCollectionKey) {
    throw coded(
      'xhs_metrics_cua_request_invalid',
      '小红书本人指标 CUA collectionKey 与 receiptId/checkpoint 不一致。',
    );
  }
  canonicalTimestamp(
    input.collectedAt,
    'xhs_metrics_cua_request_invalid',
  );
  return {
    trustedReceipt:structuredClone(receipt),
    checkpoint:input.checkpoint,
    collectionKey:input.collectionKey,
    collectedAt:input.collectedAt,
  };
}

function validateMetricSelectorBundle(bundle, clock) {
  const now = normalizeClock(clock);
  const selectorChecksum = selectorBundleChecksum(bundle);
  const expiresAt = Date.parse(bundle?.approval?.expiresAt);
  if (
    bundle?.schemaVersion !== CUA_SELECTOR_BUNDLE_SCHEMA
    || bundle?.platform !== PLATFORM
    || !ALLOWED_ORIGINS.has(bundle?.origin)
    || !SEMVER.test(String(bundle?.bundleVersion || ''))
    || bundle?.approval?.source !== 'paperclip'
    || bundle?.approval?.status !== 'approved'
    || !String(bundle?.approval?.approvalRef || '').startsWith('paperclip:')
    || bundle?.approval?.platform !== PLATFORM
    || bundle?.approval?.bundleVersion !== bundle.bundleVersion
    || bundle?.approval?.selectorChecksum !== selectorChecksum
    || !Number.isFinite(expiresAt)
    || expiresAt <= now.getTime()
    || !validMetricSelectorMap(bundle?.selectorMap)
  ) {
    throw coded(
      'xhs_metrics_cua_selector_invalid',
      '小红书本人指标 CUA 缺少获批、未过期且哈希绑定的只读 selector bundle。',
    );
  }
  return Object.freeze({
    origin:bundle.origin,
    bundleVersion:bundle.bundleVersion,
    selectorChecksum,
    approvalRef:bundle.approval.approvalRef,
    selectorMap:canonicalMetricSelectorMap(bundle.selectorMap),
  });
}

function validMetricSelectorMap(selectorMap) {
  try {
    if (
      containsSecretLikeField(selectorMap)
      || !hasExactKeys(selectorMap, METRIC_SELECTOR_KEYS)
      || typeof selectorMap.path !== 'string'
      || !selectorMap.path.startsWith('/')
      || !hasExactKeys(selectorMap.identity, METRIC_SELECTOR_IDENTITY_KEYS)
      || typeof selectorMap.identity.accountTextPattern !== 'string'
      || typeof selectorMap.identity.contentIdPattern !== 'string'
      || !hasExactKeys(selectorMap.actions, XHS_OWN_METRICS_CUA_ACTIONS)
      || XHS_OWN_METRICS_CUA_ACTIONS.some(
        (action) => (
          !hasExactKeys(selectorMap.actions[action], METRIC_SELECTOR_ACTION_KEYS)
          || typeof selectorMap.actions[action].label !== 'string'
          || !selectorMap.actions[action].label.trim()
        ),
      )
      || !Array.isArray(selectorMap.metrics)
      || !hasExactArrayKeys(selectorMap.metrics, METRIC_SELECTOR_ARRAY_KEYS)
      || selectorMap.metrics.join('\n') !== 'views\nlikes\nsaves\ncomments'
    ) {
      return false;
    }
    const account = new RegExp(selectorMap.identity.accountTextPattern, 'i');
    const content = new RegExp(selectorMap.identity.contentIdPattern);
    return Boolean(account.source && content.source && !content.flags.includes('g'));
  } catch {
    return false;
  }
}

function hasExactKeys(value, expectedKeys) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const canonicalExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === canonicalExpectedKeys.length
    && actualKeys.every((key, index) => key === canonicalExpectedKeys[index]);
}

function hasExactArrayKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const canonicalExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === canonicalExpectedKeys.length
    && actualKeys.every((key, index) => key === canonicalExpectedKeys[index]);
}

function containsSecretLikeField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    SECRET_LIKE_KEY.test(key) || containsSecretLikeField(item)
  ));
}

function canonicalMetricSelectorMap(selectorMap) {
  return deepFreeze({
    path:selectorMap.path,
    identity:{
      accountTextPattern:selectorMap.identity.accountTextPattern,
      contentIdPattern:selectorMap.identity.contentIdPattern,
    },
    actions:Object.fromEntries(
      XHS_OWN_METRICS_CUA_ACTIONS.map((action) => [
        action,
        { label:selectorMap.actions[action].label },
      ]),
    ),
    metrics:[...selectorMap.metrics],
  });
}

function validateRunner(runner, selector, profile) {
  const contract = runner?.contract;
  const allowedActions = Array.isArray(contract?.allowedActions)
    ? contract.allowedActions
    : [];
  if (
    contract?.schemaVersion !== XHS_OWN_METRICS_CUA_RUNNER_SCHEMA
    || contract?.readOnly !== true
    || contract?.arbitraryDesktop !== false
    || contract?.profileMode !== 'isolated_named'
    || contract?.profileName !== profile.profileName
    || contract?.selectorTrust !== 'approved_bundle'
    || contract?.accountIdentityVerification !== 'page_identity_sha256'
    || contract?.origin !== selector.origin
    || allowedActions.length !== XHS_OWN_METRICS_CUA_ACTIONS.length
    || allowedActions.some(
      (action, index) => action !== XHS_OWN_METRICS_CUA_ACTIONS[index],
    )
    || typeof runner?.beginSession !== 'function'
    || typeof runner?.perform !== 'function'
    || typeof runner?.endSession !== 'function'
  ) {
    throw coded(
      'xhs_metrics_cua_runner_contract_mismatch',
      '小红书本人指标 runner 必须是命名 Profile、获批 selector、无桌面权限且只有五个只读动作。',
    );
  }
}

function metricSteps(request, selector) {
  const externalContentId = request.trustedReceipt.externalContentId;
  return [
    { action:'navigate', input:{ path:selector.selectorMap.path } },
    { action:'read', input:{ target:'account_identity' } },
    { action:'filter', input:{ externalContentId } },
    { action:'open_detail', input:{ externalContentId } },
    {
      action:'read_metrics',
      input:{
        externalContentId,
        metricNames:['views', 'likes', 'saves', 'comments'],
      },
    },
  ];
}

function inspectStepObservation({ observation, action, request, trust }) {
  inspectBaseObservation(
    observation,
    trust.selector.origin,
    PAGE_STATES[action],
  );
  if (action === 'read') {
    if (
      observation.accountRef !== trust.profile.accountRef
      || observation.identityClaim?.kind !== 'page_identity_sha256'
      || observation.identityClaim?.value !== trust.profile.identityClaim.value
    ) {
      hardStop('account_switch');
    }
    return;
  }
  if (['filter', 'open_detail', 'read_metrics'].includes(action)) {
    if (observation.accountRef !== trust.profile.accountRef) {
      hardStop('account_switch');
    }
    if (
      observation.externalContentId
      !== request.trustedReceipt.externalContentId
    ) hardStop('unknown_page');
  }
  if (action === 'read_metrics') {
    if (
      observation.identityClaim?.kind !== 'page_identity_sha256'
      || observation.identityClaim?.value !== trust.profile.identityClaim.value
      || observation.selectorBundleVersion !== trust.selector.bundleVersion
      || observation.selectorChecksum !== trust.selector.selectorChecksum
      || !observation.metrics
      || typeof observation.metrics !== 'object'
      || Array.isArray(observation.metrics)
    ) {
      hardStop('unknown_page');
    }
    canonicalTimestamp(
      observation.observedAt,
      'xhs_metrics_cua_observation_invalid',
    );
  }
}

function inspectBaseObservation(observation, expectedOrigin, expectedPageState) {
  if (observation?.kind === 'stop') {
    hardStop(
      HARD_STOP_REASONS.has(observation.reason)
        ? observation.reason
        : 'unknown_page',
    );
  }
  if (
    observation?.kind !== 'ok'
    || observation.origin !== expectedOrigin
    || observation.pageState !== expectedPageState
  ) {
    hardStop('unknown_page');
  }
}

function hardStop(reason) {
  const error = coded(
    `xhs_metrics_cua_stopped_${reason}`,
    `小红书本人指标 CUA 已硬停：${reason}。`,
  );
  error.stopReason = reason;
  error.hardStop = true;
  throw error;
}

function normalizeClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw coded('xhs_metrics_cua_clock_invalid', '小红书本人指标 CUA 时钟无效。');
  }
  return date;
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string') {
    throw coded(code, '小红书本人指标 CUA 时间必须是规范 UTC 时间戳。');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw coded(code, '小红书本人指标 CUA 时间必须是规范 UTC 时间戳。');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
