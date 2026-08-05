import crypto from 'node:crypto';
import { CAPABILITY_OPERATIONS } from './connection-broker.js';

export class ContentAcquisitionCenter {
  constructor({ adapters, connectionBroker, operations }) {
    this.adapters = [...adapters];
    this.connectionBroker = connectionBroker;
    this.operations = operations;
  }

  async fetch({ requestId = crypto.randomUUID(), taskId, source, requestedCapabilities, connectionId = null, requestingAgentId, workspace, runtimeRequirement = null, onProgress = null }) {
    const requested = normalizeCapabilities(requestedCapabilities);
    const candidates = this.findCandidates(source, requested, runtimeRequirement);
    if (candidates.length === 0) return failure('capability_not_available', '当前没有可用通道提供所需内容能力。', 'manual_review');
    let lastFailure = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const adapter = candidates[index];
      let connectionUse = null;
      if (adapter.accessMode === 'authorized' || (adapter.accessMode === 'either' && connectionId)) {
        const access = await this.connectionBroker.authorize({
          connectionId, provider: adapter.providerFor(source), operations: operationsFor(requested.filter((capability) => adapter.capabilities.includes(capability))), requestingAgentId
        });
        if (!access.ok) {
          // An "either" adapter is allowed to retry the same public source
          // without credentials. An authorized-only adapter may be skipped
          // when a later public candidate can still satisfy the request.
          if (adapter.accessMode === 'either') {
            connectionUse = null;
          } else {
            await this.operations.record({ subjectType: 'connection', subjectRef: connectionId || adapter.providerFor(source), eventType: access.code, severity: 'warning', safeMessage: access.safeMessage, recommendedAction: access.recommendedAction, taskRefs: taskId ? [taskId] : [] });
            lastFailure = { code: access.code, safeMessage: access.safeMessage, recommendedAction: access.recommendedAction };
            if (index < candidates.length - 1) continue;
            return failure(access.code, access.safeMessage, access.recommendedAction);
          }
        } else {
          connectionUse = access.connectionUse;
        }
      }
      try {
        const acquired = await adapter.acquire({ source, requestedCapabilities: requested, connectionUse, workspace, runtimeRequirement, onProgress, requestingAgentId, taskId, requestId });
        const providedCapabilities = normalizeCapabilities(acquired.providedCapabilities);
        if (providedCapabilities.length === 0) throw Object.assign(new Error('适配器没有返回可用内容。'), { code: 'adapter_empty_result' });
        if (connectionUse) {
          await this.connectionBroker.connectionStore.recordVerification(connectionUse.connectionId, {
            status:'succeeded',
            adapterId:adapter.id,
            capabilities:providedCapabilities
          });
        }
        if (index > 0) await this.operations.record({ subjectType: 'adapter', subjectRef: adapter.id, eventType: 'fallback_used', severity: 'info', safeMessage: '已切换到允许的通用内容获取通道。', recommendedAction: 'none', taskRefs: taskId ? [taskId] : [] });
        return {
          ok: true,
          contentPackage: {
            schemaVersion: '3.0', packageId: crypto.randomUUID(), requestId, taskId, provider: adapter.providerFor(source), sourceRef: safeSourceRef(source),
            acquisitionPath: adapter.priorityClass, providedCapabilities, capabilityNotes: acquired.capabilityNotes || null,
            contentItems: acquired.contentItems || {}, adapterRef: { adapterId: adapter.id, versionRef: adapter.versionRef },
            validation: acquired.validation || { exists: true, readable: true, accessScope: connectionUse ? 'authorized_read' : 'public_read' },
            access: safeAccessEvidence(this.connectionBroker?.connectionStore, connectionUse),
            createdAt: new Date().toISOString()
          },
          runtime: acquired.runtime || {}
        };
      } catch (error) {
        lastFailure = safeAdapterFailure(error);
        if (connectionUse) {
          await this.connectionBroker.connectionStore.recordVerification(connectionUse.connectionId, {
            status:'failed',
            adapterId:adapter.id,
            capabilities:requested.filter((capability) => adapter.capabilities.includes(capability)),
            failureCode:lastFailure.code
          });
        }
        await this.operations.record({ subjectType: 'adapter', subjectRef: adapter.id, eventType: lastFailure.code, severity: 'warning', safeMessage: lastFailure.safeMessage, recommendedAction: lastFailure.recommendedAction, taskRefs: taskId ? [taskId] : [] });
      }
    }
    return failure(lastFailure?.code || 'adapter_unavailable', lastFailure?.safeMessage || '内容获取通道当前不可用。', lastFailure?.recommendedAction || 'retry');
  }

  async collectMetrics({ taskId = null, source, connectionId = null, requestingAgentId, historyLimit = 20 }) {
    const adapter = this.adapters.find((candidate) => (
      candidate.healthStatus === 'healthy'
      && typeof candidate.collectMetrics === 'function'
      && candidate.matches(source)
    ));
    if (!adapter) return failure('capability_not_available', '当前没有可用的作品指标采集通道。', 'manual_review');
    const access = await this.connectionBroker.authorize({
      connectionId,
      provider:adapter.providerFor(source),
      operations:['read_media_metadata'],
      requestingAgentId
    });
    if (!access.ok) return failure(access.code, access.safeMessage, access.recommendedAction);
    try {
      const metricsBundle = await adapter.collectMetrics({
        source,
        connectionUse:access.connectionUse,
        historyLimit
      });
      await this.connectionBroker.connectionStore.recordVerification(access.connectionUse.connectionId, {
        status:'succeeded',
        adapterId:adapter.id,
        capabilities:['creator_metrics']
      });
      return { ok:true, metricsBundle };
    } catch (error) {
      const safe = safeAdapterFailure(error);
      await this.connectionBroker.connectionStore.recordVerification(access.connectionUse.connectionId, {
        status:'failed',
        adapterId:adapter.id,
        capabilities:['creator_metrics'],
        failureCode:safe.code
      });
      await this.operations.record({
        subjectType:'adapter',
        subjectRef:adapter.id,
        eventType:safe.code,
        severity:'warning',
        safeMessage:safe.safeMessage,
        recommendedAction:safe.recommendedAction,
        taskRefs:taskId ? [taskId] : []
      });
      return failure(safe.code, safe.safeMessage, safe.recommendedAction);
    }
  }

  findCandidates(source, requestedCapabilities, runtimeRequirement = null) {
    return this.adapters
      .filter((adapter) => adapter.matches(source) && adapter.healthStatus === 'healthy')
      .filter((adapter) => requestedCapabilities.some((capability) => adapter.capabilities.includes(capability)))
      .filter((adapter) => !runtimeRequirement || (adapter.runtimeRequirements || []).includes(runtimeRequirement))
      .sort((a, b) => priority(a.priorityClass) - priority(b.priorityClass));
  }
}

export class ContentAcquisitionError extends Error {
  constructor(result) {
    super(result.safeMessage);
    this.name = 'ContentAcquisitionError';
    this.accessFailure = result;
  }
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('至少需要请求一项内容能力。');
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function operationsFor(capabilities) {
  return [...new Set(capabilities.map((capability) => CAPABILITY_OPERATIONS[capability]).filter(Boolean))];
}

function priority(priorityClass) { return priorityClass === 'specialized' ? 0 : 1; }
function safeSourceRef(source) { const parsed = new URL(source); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
function safeAccessEvidence(connectionStore, connectionUse) {
  if (!connectionUse) return { mode:'public_read', connectionId:null, accountAlias:null };
  const connection = connectionStore.getSafe(connectionUse.connectionId);
  return {
    mode:'authorized_read',
    connectionId:connectionUse.connectionId,
    accountAlias:connection?.accountAlias || null
  };
}
function failure(code, safeMessage, recommendedAction) {
  const category = code.includes('connection') || code.includes('approval') || code.includes('scope') || code.includes('granted') || code === 'agent_not_allowed' || code === 'browser_session_forbidden'
    ? 'needs_input'
    : recommendedAction === 'retry'
      ? 'retryable'
      : 'manual';
  return { ok: false, code, safeMessage, recommendedAction, category };
}

function safeAdapterFailure(error) {
  const raw = error instanceof Error ? error.message : String(error);
  if (['approval_required', 'approval_expired', 'scope_not_granted', 'scope_violation'].includes(error?.code)) {
    return {
      code:error.code,
      safeMessage:raw.slice(0, 300),
      recommendedAction:error.code === 'approval_expired' ? 'reauthorize' : 'manual_review'
    };
  }
  if (error?.code === 'browser_session_forbidden') {
    return { code: error.code, safeMessage: '不能读取浏览器登录态。请改用公开视频读取、已批准的受控连接器或本地文件。', recommendedAction: 'reauthorize' };
  }
  if (error?.code === 'source_rate_limited' || /\b429\b|too many requests|rate limit/i.test(raw)) {
    return { code: 'source_rate_limited', safeMessage: '视频站临时限制读取，请稍后重试或改用本地文件。', recommendedAction: 'retry' };
  }
  if (error?.code === 'tool_unavailable') {
    return { code: 'tool_unavailable', safeMessage: '本机缺少读取公开视频所需工具，请由运维官检查。', recommendedAction: 'repair' };
  }
  if (/private|login|sign in|cookies|403|401|authorization/i.test(raw)) return { code: 'authorization_required', safeMessage: '素材需要登录或额外授权；请在 A君中重新授权，或改用本地文件。', recommendedAction: 'reauthorize' };
  if (error?.code === 'capability_not_available') return { code: error.code, safeMessage: '当前通道不能提供所需内容能力。', recommendedAction: 'manual_review' };
  return { code: 'adapter_unavailable', safeMessage: '内容获取通道当前不可用，请稍后重试或改用本地文件。', recommendedAction: 'retry' };
}
