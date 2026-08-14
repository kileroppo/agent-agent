import type { ConnectionUse } from './connection-broker.ts';

export type ContentCapability = string;
export type RuntimeRequirement = string;
export type AccessMode = 'public' | 'authorized' | 'either' | 'private_scoped';
export type PriorityClass = 'specialized' | 'general';
export type AdapterHealthStatus = 'healthy' | 'degraded' | 'unavailable';
export type AcquisitionOutcome = 'success' | 'confirmed_failure';

export type AcquisitionProgress = Readonly<{
  stage: string;
  progress: number;
  message: string;
}>;

export type AcquisitionRuntime = Record<string, unknown> & Readonly<{
  kind?: string;
  path?: string;
  url?: string;
}>;

export type AdapterAcquireInput = Readonly<{
  source: string;
  requestedCapabilities: readonly ContentCapability[];
  connectionUse: ConnectionUse | null;
  workspace: string;
  runtimeRequirement: RuntimeRequirement | null;
  onProgress: ((progress: AcquisitionProgress) => void | Promise<void>) | null;
  requestingAgentId: string;
  taskId?: string | null;
  requestId: string;
}>;

export type AdapterAcquireResult = Readonly<{
  providedCapabilities: readonly ContentCapability[];
  contentItems?: Readonly<Record<string, unknown>>;
  runtime?: AcquisitionRuntime;
  validation?: Readonly<Record<string, unknown>>;
  capabilityNotes?: string | null;
}>;

export type AdapterMetricsInput = Readonly<{
  source: string;
  connectionUse: ConnectionUse;
  historyLimit: number;
}>;

export interface ContentAcquisitionAdapter {
  readonly id: string;
  readonly versionRef: string;
  readonly capabilities: readonly ContentCapability[];
  readonly accessMode: AccessMode;
  readonly priorityClass: PriorityClass;
  readonly healthStatus: AdapterHealthStatus;
  readonly runtimeRequirements?: readonly RuntimeRequirement[];
  matches(source: string): boolean;
  providerFor(source: string): string | null;
  acquire(input: AdapterAcquireInput): Promise<AdapterAcquireResult>;
  collectMetrics?(input: AdapterMetricsInput): Promise<unknown>;
}

export type ContentAcquisitionRequest = Readonly<{
  requestId?: string;
  taskId?: string | null;
  source: string;
  requestedCapabilities: readonly ContentCapability[];
  connectionId?: string | null;
  requestingAgentId: string;
  workspace: string;
  runtimeRequirement?: RuntimeRequirement | null;
  onProgress?: ((progress: AcquisitionProgress) => void | Promise<void>) | null;
}>;

export type AcquisitionAttempt = Readonly<{
  routeId: string;
  adapterId: string;
  attempts: number;
  recovered: false;
  outcome: AcquisitionOutcome;
  failureCode: string | null;
}>;

export type AcquisitionReceipt = Readonly<{
  schemaVersion: 'agent.army/execution-receipt/v2';
  receiptId: string;
  requestId: string;
  workflowId: string;
  stepId: string;
  taskId: string;
  agentId: string;
  capabilityId: 'content.acquire';
  policyDecisionId: string;
  routeId: string;
  adapterId: string;
  provider: string;
  model: null;
  inputHash: string;
  outputHash: string | null;
  outcome: AcquisitionOutcome;
  fallbackFrom: string | null;
  routeAttempts: readonly AcquisitionAttempt[];
  attempts: number;
  totalAttempts: number;
  recovered: false;
  failureCode: string | null;
  costUsd: 0;
  startedAt: string;
  completedAt: string;
}>;

export type ContentPackage = Readonly<{
  schemaVersion: '3.0';
  packageId: string;
  requestId: string;
  taskId?: string | null;
  provider: string | null;
  sourceRef: string;
  acquisitionPath: PriorityClass;
  providedCapabilities: readonly ContentCapability[];
  capabilityNotes: string | null;
  contentItems: Readonly<Record<string, unknown>>;
  adapterRef: Readonly<{ adapterId: string; versionRef: string }>;
  validation: Readonly<Record<string, unknown>>;
  access: Readonly<{ mode: string; connectionId: string | null; accountAlias: string | null }>;
  createdAt: string;
}>;

export type AcquisitionFailureCategory = 'needs_input' | 'retryable' | 'manual';
export type AcquisitionFailureBase = Readonly<{
  ok: false;
  code: string;
  safeMessage: string;
  recommendedAction: string;
  category: AcquisitionFailureCategory;
}>;
export type ContentAcquisitionFailure = AcquisitionFailureBase & Readonly<{
  acquisitionReceipt: AcquisitionReceipt;
}>;
export type ContentAcquisitionSuccess = Readonly<{
  ok: true;
  contentPackage: ContentPackage;
  runtime: AcquisitionRuntime;
  acquisitionReceipt: AcquisitionReceipt;
}>;
export type ContentAcquisitionResult = ContentAcquisitionSuccess | ContentAcquisitionFailure;

export type MetricsRequest = Readonly<{
  taskId?: string | null;
  source: string;
  connectionId?: string | null;
  requestingAgentId: string;
  historyLimit?: number;
}>;

export type SafeAdapterFailure = Readonly<{
  code: string;
  safeMessage: string;
  recommendedAction: string;
}>;

export interface ConnectionStoreInterface {
  getSafe(connectionId: string): Readonly<{ accountAlias?: string | null }> | null;
  recordVerification(connectionId: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ConnectionBrokerInterface {
  readonly connectionStore: ConnectionStoreInterface;
  authorize(input: Readonly<{
    connectionId?: string | null;
    provider: string;
    operations: readonly string[];
    requestingAgentId: string;
  }>): Promise<
    | Readonly<{ ok: true; connectionUse: ConnectionUse }>
    | Readonly<{ ok: false; code: string; safeMessage: string; recommendedAction: string }>
  >;
}

export interface OperationsRecorder {
  record(input: Readonly<{
    subjectType: string;
    subjectRef: string;
    eventType: string;
    severity?: string;
    safeMessage: string;
    recommendedAction?: string;
    taskRefs?: readonly string[];
  }>): Promise<unknown>;
}
