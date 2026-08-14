import crypto from 'node:crypto';
import { CAPABILITY_OPERATIONS } from './connection-broker.ts';
import type { ConnectionUse } from './connection-broker.ts';
import type {
  AcquisitionAttempt,
  AcquisitionFailureBase,
  AcquisitionOutcome,
  AcquisitionReceipt,
  ConnectionBrokerInterface,
  ContentAcquisitionAdapter,
  ContentAcquisitionFailure,
  ContentAcquisitionRequest,
  ContentAcquisitionResult,
  ContentAcquisitionSuccess,
  ContentCapability,
  MetricsRequest,
  OperationsRecorder,
  RuntimeRequirement,
  SafeAdapterFailure,
} from './content-acquisition-contracts.ts';

type SuccessWithoutReceipt = Omit<ContentAcquisitionSuccess, 'acquisitionReceipt'>;
type ReceiptInput = Readonly<{
  requestId: string;
  taskId?: string | null;
  requestingAgentId: string;
  source: string;
  requested: readonly ContentCapability[];
  runtimeRequirement: RuntimeRequirement | null;
  routeAttempts: readonly AcquisitionAttempt[];
  result?: SuccessWithoutReceipt | null;
  failureCode?: string | null;
  startedAt: string;
}>;

export class ContentAcquisitionCenter {
  readonly adapters: readonly ContentAcquisitionAdapter[];
  private readonly connectionBroker: ConnectionBrokerInterface | null;
  private readonly operations: OperationsRecorder;

  constructor({ adapters, connectionBroker, operations }: Readonly<{
    adapters: readonly ContentAcquisitionAdapter[];
    connectionBroker: ConnectionBrokerInterface | null;
    operations: OperationsRecorder;
  }>) {
    this.adapters = [...adapters];
    this.connectionBroker = connectionBroker;
    this.operations = operations;
  }

  async fetch({ requestId = crypto.randomUUID(), taskId, source, requestedCapabilities, connectionId = null, requestingAgentId, workspace, runtimeRequirement = null, onProgress = null }: ContentAcquisitionRequest): Promise<ContentAcquisitionResult> {
    const startedAt = new Date().toISOString();
    const requested = normalizeCapabilities(requestedCapabilities);
    const candidates = this.findCandidates(source, requested, runtimeRequirement);
    if (candidates.length === 0) {
      const result = failure('capability_not_available', '当前没有可用通道提供所需内容能力。', 'manual_review');
      return withAcquisitionReceipt(result, acquisitionReceipt({
        requestId, taskId, requestingAgentId, source, requested,
        runtimeRequirement, routeAttempts:[], failureCode:result.code, startedAt,
      }));
    }
    let lastFailure = null;
    const routeAttempts = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const adapter = candidates[index];
      let connectionUse = null;
      if (adapter.accessMode === 'authorized' || (adapter.accessMode === 'either' && connectionId)) {
        if (!this.connectionBroker) {
          const unavailable = failure('connection_broker_unavailable', '当前没有可用的授权连接通道。', 'manual_review');
          routeAttempts.push(acquisitionAttempt(adapter, 'confirmed_failure', unavailable.code, 0));
          if (adapter.accessMode === 'either') continue;
          return withAcquisitionReceipt(unavailable, acquisitionReceipt({
            requestId, taskId, requestingAgentId, source, requested,
            runtimeRequirement, routeAttempts, failureCode:unavailable.code, startedAt,
          }));
        }
        const access = await this.connectionBroker.authorize({
          connectionId, provider: adapter.providerFor(source) || adapter.id, operations: operationsFor(requested.filter((capability) => adapter.capabilities.includes(capability))), requestingAgentId
        });
        if (!access.ok) {
          // An "either" adapter is allowed to retry the same public source
          // without credentials. An authorized-only adapter may be skipped
          // when a later public candidate can still satisfy the request.
          if (adapter.accessMode === 'either') {
            connectionUse = null;
          } else {
            await this.operations.record({ subjectType: 'connection', subjectRef: connectionId || adapter.providerFor(source) || adapter.id, eventType: access.code, severity: 'warning', safeMessage: access.safeMessage, recommendedAction: access.recommendedAction, taskRefs: taskId ? [taskId] : [] });
            lastFailure = { code: access.code, safeMessage: access.safeMessage, recommendedAction: access.recommendedAction };
            routeAttempts.push(acquisitionAttempt(adapter, 'confirmed_failure', access.code, 0));
            if (index < candidates.length - 1) continue;
            return withAcquisitionReceipt(
              failure(access.code, access.safeMessage, access.recommendedAction),
              acquisitionReceipt({
                requestId, taskId, requestingAgentId, source, requested,
                runtimeRequirement, routeAttempts, failureCode:access.code, startedAt,
              }),
            );
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
          await this.connectionBroker?.connectionStore.recordVerification(connectionUse.connectionId, {
            status:'succeeded',
            adapterId:adapter.id,
            capabilities:providedCapabilities
          });
        }
        routeAttempts.push(acquisitionAttempt(adapter, 'success'));
        if (index > 0) await this.operations.record({ subjectType: 'adapter', subjectRef: adapter.id, eventType: 'fallback_used', severity: 'info', safeMessage: '已切换到允许的通用内容获取通道。', recommendedAction: 'none', taskRefs: taskId ? [taskId] : [] });
        const result: SuccessWithoutReceipt = {
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
        return withAcquisitionReceipt(result, acquisitionReceipt({
          requestId, taskId, requestingAgentId, source, requested,
          runtimeRequirement, routeAttempts, result, startedAt,
        }));
      } catch (error) {
        lastFailure = safeAdapterFailure(error);
        routeAttempts.push(acquisitionAttempt(adapter, 'confirmed_failure', lastFailure.code));
        if (connectionUse) {
          await this.connectionBroker?.connectionStore.recordVerification(connectionUse.connectionId, {
            status:'failed',
            adapterId:adapter.id,
            capabilities:requested.filter((capability) => adapter.capabilities.includes(capability)),
            failureCode:lastFailure.code
          });
        }
        await this.operations.record({ subjectType: 'adapter', subjectRef: adapter.id, eventType: lastFailure.code, severity: 'warning', safeMessage: lastFailure.safeMessage, recommendedAction: lastFailure.recommendedAction, taskRefs: taskId ? [taskId] : [] });
      }
    }
    const result = failure(lastFailure?.code || 'adapter_unavailable', lastFailure?.safeMessage || '内容获取通道当前不可用。', lastFailure?.recommendedAction || 'retry');
    return withAcquisitionReceipt(result, acquisitionReceipt({
      requestId, taskId, requestingAgentId, source, requested,
      runtimeRequirement, routeAttempts, failureCode:result.code, startedAt,
    }));
  }

  async collectMetrics({ taskId = null, source, connectionId = null, requestingAgentId, historyLimit = 20 }: MetricsRequest) {
    const adapter = this.adapters.find((candidate) => (
      candidate.healthStatus === 'healthy'
      && typeof candidate.collectMetrics === 'function'
      && candidate.matches(source)
    ));
    const collectMetrics = adapter?.collectMetrics;
    if (!adapter || !collectMetrics) return failure('capability_not_available', '当前没有可用的作品指标采集通道。', 'manual_review');
    if (!this.connectionBroker) return failure('connection_broker_unavailable', '当前没有可用的授权连接通道。', 'manual_review');
    const access = await this.connectionBroker.authorize({
      connectionId,
      provider:adapter.providerFor(source) || adapter.id,
      operations:['read_media_metadata'],
      requestingAgentId
    });
    if (!access.ok) return failure(access.code, access.safeMessage, access.recommendedAction);
    try {
      const metricsBundle = await collectMetrics.call(adapter, {
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

  findCandidates(source: string, requestedCapabilities: readonly ContentCapability[], runtimeRequirement: RuntimeRequirement | null = null): ContentAcquisitionAdapter[] {
    return this.adapters
      .filter((adapter) => adapter.matches(source) && adapter.healthStatus === 'healthy')
      .filter((adapter) => requestedCapabilities.some((capability) => adapter.capabilities.includes(capability)))
      .filter((adapter) => !runtimeRequirement || (adapter.runtimeRequirements || []).includes(runtimeRequirement))
      .sort((a, b) => priority(a.priorityClass) - priority(b.priorityClass));
  }
}

export class ContentAcquisitionError extends Error {
  readonly accessFailure: AcquisitionFailureBase | ContentAcquisitionFailure;

  constructor(result: AcquisitionFailureBase | ContentAcquisitionFailure) {
    super(result.safeMessage);
    this.name = 'ContentAcquisitionError';
    this.accessFailure = result;
  }
}

function normalizeCapabilities(value: readonly unknown[]): ContentCapability[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('至少需要请求一项内容能力。');
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function operationsFor(capabilities: readonly ContentCapability[]): string[] {
  return [...new Set(capabilities.map((capability) => CAPABILITY_OPERATIONS[capability]).filter(Boolean))];
}

function priority(priorityClass: ContentAcquisitionAdapter['priorityClass']): number { return priorityClass === 'specialized' ? 0 : 1; }
function safeSourceRef(source: string): string { const parsed = new URL(source); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
function safeAccessEvidence(connectionStore: ConnectionBrokerInterface['connectionStore'] | undefined, connectionUse: ConnectionUse | null) {
  if (!connectionUse) return { mode:'public_read', connectionId:null, accountAlias:null };
  if (!connectionStore) throw new Error('授权连接证据缺少 ConnectionStore。');
  const connection = connectionStore.getSafe(connectionUse.connectionId);
  return {
    mode:'authorized_read',
    connectionId:connectionUse.connectionId,
    accountAlias:connection?.accountAlias || null
  };
}
function failure(code: string, safeMessage: string, recommendedAction: string): AcquisitionFailureBase {
  const category = code.includes('connection') || code.includes('approval') || code.includes('scope') || code.includes('granted') || code === 'agent_not_allowed' || code === 'browser_session_forbidden'
    ? 'needs_input'
    : recommendedAction === 'retry'
      ? 'retryable'
      : 'manual';
  return { ok: false, code, safeMessage, recommendedAction, category };
}

function safeAdapterFailure(error: unknown): SafeAdapterFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  if (['approval_required', 'approval_expired', 'scope_not_granted', 'scope_violation'].includes(code)) {
    return {
      code,
      safeMessage:raw.slice(0, 300),
      recommendedAction:code === 'approval_expired' ? 'reauthorize' : 'manual_review'
    };
  }
  if (code === 'browser_session_forbidden') {
    return { code, safeMessage: '不能读取浏览器登录态。请改用公开视频读取、已批准的受控连接器或本地文件。', recommendedAction: 'reauthorize' };
  }
  if (code === 'source_rate_limited' || /\b429\b|too many requests|rate limit/i.test(raw)) {
    return { code: 'source_rate_limited', safeMessage: '视频站临时限制读取，请稍后重试或改用本地文件。', recommendedAction: 'retry' };
  }
  if (code === 'tool_unavailable') {
    return { code: 'tool_unavailable', safeMessage: '本机缺少读取公开视频所需工具，请由运维官检查。', recommendedAction: 'repair' };
  }
  if (/private|login|sign in|cookies|403|401|authorization/i.test(raw)) return { code: 'authorization_required', safeMessage: '素材需要登录或额外授权；请在 A君中重新授权，或改用本地文件。', recommendedAction: 'reauthorize' };
  if (code === 'capability_not_available') return { code, safeMessage: '当前通道不能提供所需内容能力。', recommendedAction: 'manual_review' };
  return { code: 'adapter_unavailable', safeMessage: '内容获取通道当前不可用，请稍后重试或改用本地文件。', recommendedAction: 'retry' };
}

function acquisitionAttempt(adapter: ContentAcquisitionAdapter | null, outcome: AcquisitionOutcome, failureCode: string | null = null, attempts = 1): AcquisitionAttempt {
  return Object.freeze({
    routeId:String(adapter?.id || 'content-acquisition-route').slice(0, 160),
    adapterId:String(adapter?.id || 'content-acquisition-adapter').slice(0, 120),
    attempts,
    recovered:false,
    outcome,
    failureCode:failureCode ? String(failureCode).slice(0, 120) : null,
  });
}

function acquisitionReceipt({
  requestId, taskId, requestingAgentId, source, requested, runtimeRequirement,
  routeAttempts, result = null, failureCode = null, startedAt,
}: ReceiptInput): AcquisitionReceipt {
  const completedAt = new Date().toISOString();
  const finalAttempt = routeAttempts.at(-1) || acquisitionAttempt(null, 'confirmed_failure', failureCode, 0);
  const successful = result?.ok === true && finalAttempt.outcome === 'success';
  const inputHash = digest({ source:safeSourceRef(source), requested, runtimeRequirement });
  const outputHash = successful ? digest({
    provider:result.contentPackage?.provider,
    acquisitionPath:result.contentPackage?.acquisitionPath,
    providedCapabilities:result.contentPackage?.providedCapabilities,
    adapterRef:result.contentPackage?.adapterRef,
    runtimeKind:result.runtime?.kind,
  }) : null;
  const receiptId = `receipt:content-acquisition:${digest({ requestId, taskId, inputHash, outputHash, completedAt }).slice(0, 32)}`;
  return Object.freeze({
    schemaVersion:'agent.army/execution-receipt/v2',
    receiptId,
    requestId:String(requestId || ''),
    workflowId:`workflow:xiaod-media:${String(taskId || 'unknown-task')}`,
    stepId:`step:content.acquire:${String(taskId || 'unknown-task')}`,
    taskId:String(taskId || 'unknown-task'),
    agentId:String(requestingAgentId || 'xiaod'),
    capabilityId:'content.acquire',
    policyDecisionId:`policy:content-acquisition:${digest({ requestId, requested, runtimeRequirement }).slice(0, 32)}`,
    routeId:finalAttempt.routeId,
    adapterId:finalAttempt.adapterId,
    provider:successful ? String(result.contentPackage?.provider || finalAttempt.adapterId).slice(0, 120) : providerFromAdapter(finalAttempt.adapterId),
    model:null,
    inputHash:`sha256:${inputHash}`,
    outputHash:outputHash ? `sha256:${outputHash}` : null,
    outcome:successful ? 'success' : 'confirmed_failure',
    fallbackFrom:routeAttempts.length > 1 ? routeAttempts.at(-2)!.routeId : null,
    routeAttempts:Object.freeze([...routeAttempts]),
    attempts:routeAttempts.reduce((total, attempt) => total + Number(attempt.attempts || 0), 0),
    totalAttempts:routeAttempts.reduce((total, attempt) => total + Number(attempt.attempts || 0), 0),
    recovered:false,
    failureCode:successful ? null : String(failureCode || finalAttempt.failureCode || 'capability_not_available').slice(0, 120),
    costUsd:0,
    startedAt,
    completedAt,
  });
}

function withAcquisitionReceipt(result: SuccessWithoutReceipt, receipt: AcquisitionReceipt): ContentAcquisitionSuccess;
function withAcquisitionReceipt(result: AcquisitionFailureBase, receipt: AcquisitionReceipt): ContentAcquisitionFailure;
function withAcquisitionReceipt(result: SuccessWithoutReceipt | AcquisitionFailureBase, receipt: AcquisitionReceipt): ContentAcquisitionResult {
  return Object.freeze({ ...result, acquisitionReceipt:receipt }) as ContentAcquisitionResult;
}

function providerFromAdapter(adapterId: string): string {
  if (adapterId === 'mediacrawlerpro-specialized-content') return 'mediacrawlerpro';
  if (adapterId === 'yt-dlp-general-media') return 'yt-dlp';
  if (adapterId === 'bilibili-native-subtitles') return 'bilibili';
  return String(adapterId || 'content-acquisition').slice(0, 120);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : '';
}
