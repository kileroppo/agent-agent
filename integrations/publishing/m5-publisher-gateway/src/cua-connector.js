import { renderBoundedBrowserPolicy } from './cua-policy.js';
import { coded, STOP_REASONS } from './policy.js';

export const CUA_RUNNER_SCHEMA = 'agent.army/cua-publisher-runner/v1';
export const CUA_PLATFORM_ORIGINS = Object.freeze({
  douyin:'https://creator.douyin.com',
  xiaohongshu:'https://creator.xiaohongshu.com',
});
export const CUA_PUBLISH_ACTIONS = Object.freeze([
  'upload_media',
  'set_title',
  'set_body',
  'set_tags',
  'submit_publish',
  'read_result',
]);

const EXPECTED_PAGE_STATES = Object.freeze({
  upload_media:['editing'],
  set_title:['editing'],
  set_body:['editing'],
  set_tags:['editing'],
  submit_publish:['submitted', 'published'],
  read_result:['published'],
});

export class CuaPlatformConnector {
  constructor({ platform, runner, enabled = false }) {
    if (!CUA_PLATFORM_ORIGINS[platform]) {
      throw coded('unsupported_cua_platform', 'CUA 发布连接器只支持抖音和小红书。');
    }
    this.platform = platform;
    this.connectorMode = `real:${platform}_cua`;
    this.runner = runner;
    this.enabled = enabled === true;
    if (this.enabled) validateRunner(runner);
  }

  async publish(request) {
    if (!this.enabled) {
      throw coded('cua_connector_disabled', `${this.platform} CUA 发布连接器默认关闭，尚未获得单独启用批准。`);
    }
    validateRequest(request);
    const origin = CUA_PLATFORM_ORIGINS[this.platform];
    const session = await this.runner.beginSession({
      platform:this.platform,
      origin,
      accountRef:request.accountRef,
      profile:{
        mode:this.runner.contract.profileMode,
        name:this.runner.contract.profileName,
      },
      allowedActions:[...CUA_PUBLISH_ACTIONS],
    });
    const sessionId = String(session?.sessionId || '');
    if (!sessionId) {
      return stopped(origin, 'unknown_page');
    }

    try {
      const initial = inspectObservation(session.observation, origin, ['ready', 'editing']);
      if (initial.stopReason) return stopped(origin, initial.stopReason);

      let finalObservation = null;
      for (const step of buildSteps(request)) {
        const observation = await this.runner.perform({
          sessionId,
          platform:this.platform,
          expectedOrigin:origin,
          action:step.action,
          input:step.input,
        });
        const inspected = inspectObservation(
          observation,
          origin,
          EXPECTED_PAGE_STATES[step.action],
        );
        if (inspected.stopReason) return stopped(origin, inspected.stopReason);
        finalObservation = observation;
      }

      if (!validPublishedResult(finalObservation, origin)) {
        return stopped(origin, 'unknown_page');
      }
      return {
        state:'published',
        externalContentId:finalObservation.externalContentId,
        evidence:finalObservation.evidence,
        evidenceSnapshotHash:finalObservation.evidenceSnapshotHash,
        selectorBundleVersion:finalObservation.selectorBundleVersion,
        observedAt:finalObservation.observedAt,
        accountIdentityVerified:true,
        accountRef:request.accountRef,
        publishedAt:new Date(finalObservation.publishedAt).toISOString(),
      };
    } finally {
      await this.runner.endSession({ sessionId, platform:this.platform });
    }
  }

  async readOwnMetrics() {
    throw coded(
      'cua_metrics_disabled',
      `${this.platform} CUA 指标读取尚未实现和批准。`,
    );
  }
}

export function buildPlatformCuaSessionPolicy({
  platform,
  readableDirectory,
  profileMode = 'isolated_new',
  profileName = null,
}) {
  const origin = CUA_PLATFORM_ORIGINS[platform];
  if (!origin) throw coded('unsupported_cua_platform', 'CUA 发布策略只支持抖音和小红书。');
  return renderBoundedBrowserPolicy({
    origin,
    readableDirectory,
    profileMode,
    profileName,
  });
}

function validateRunner(runner) {
  const contract = runner?.contract;
  const actionsMatch = Array.isArray(contract?.allowedActions)
    && contract.allowedActions.length === CUA_PUBLISH_ACTIONS.length
    && contract.allowedActions.every((action, index) => action === CUA_PUBLISH_ACTIONS[index]);
  if (
    contract?.schemaVersion !== CUA_RUNNER_SCHEMA
    || contract?.profileMode !== 'isolated_named'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(contract?.profileName || ''))
    || contract?.selectorTrust !== 'approved_bundle'
    || contract?.accountIdentityVerification !== 'page_identity_sha256'
    || contract?.arbitraryDesktop !== false
    || !actionsMatch
    || typeof runner?.beginSession !== 'function'
    || typeof runner?.perform !== 'function'
    || typeof runner?.endSession !== 'function'
  ) {
    throw coded(
      'cua_runner_contract_mismatch',
      'CUA runner 必须使用获批的命名隔离 Profile、版本化 selector bundle、无任意桌面权限且只能执行固定发布动作。',
    );
  }
}

function validateRequest(request) {
  if (
    !request?.accountRef
    || !request?.title
    || !request?.body
    || !Array.isArray(request?.tags)
    || request?.verifiedMedia?.immutableLease !== true
    || typeof request?.mediaLease?.createReadStream !== 'function'
  ) {
    throw coded(
      'invalid_cua_publish_request',
      'CUA 发布需要账号引用、标题、正文、标签和审核哈希绑定的媒体 lease。',
    );
  }
}

function buildSteps(request) {
  return [
    {
      action:'upload_media',
      input:{
        mediaLease:request.mediaLease,
        verifiedMedia:{ ...request.verifiedMedia },
      },
    },
    { action:'set_title', input:{ text:request.title } },
    { action:'set_body', input:{ text:request.body } },
    { action:'set_tags', input:{ tags:[...request.tags] } },
    { action:'submit_publish', input:{} },
    { action:'read_result', input:{ expectedTitle:request.title } },
  ];
}

function inspectObservation(observation, expectedOrigin, allowedStates) {
  if (observation?.origin !== expectedOrigin) return { stopReason:'unknown_page' };
  if (observation?.kind === 'stop') {
    return {
      stopReason:STOP_REASONS.includes(observation.reason)
        ? observation.reason
        : 'unknown_page',
    };
  }
  if (
    observation?.kind !== 'ok'
    || !allowedStates.includes(observation.pageState)
  ) {
    return { stopReason:'unknown_page' };
  }
  return { stopReason:null };
}

function validPublishedResult(observation, expectedOrigin) {
  if (
    typeof observation?.externalContentId !== 'string'
    || !observation.externalContentId.trim()
    || observation?.accountIdentityVerified !== true
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation?.evidenceSnapshotHash || ''))
    || !/^[1-9]\d*\.\d+\.\d+$/.test(String(observation?.selectorBundleVersion || ''))
    || !Number.isFinite(Date.parse(observation?.observedAt))
    || !Number.isFinite(Date.parse(observation?.publishedAt))
  ) {
    return false;
  }
  try {
    const evidence = new URL(observation.evidence);
    return evidence.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function stopped(origin, stopReason) {
  return {
    state:'stopped',
    stopReason,
    evidence:`${origin}/`,
  };
}
