import fs from 'node:fs';
import path from 'node:path';

export type TaskStoreGovernance = {
  inspectCounts?: () => Promise<Record<string, number>>;
  pruneExpiredRecords?: (options: { now?: number; dryRun?: boolean }) => Promise<Record<string, unknown>>;
};

export type TaskRunEventStoreGovernance = {
  inspectCounts?: () => { totalEvents: number; byClass: Record<string, number>; incidentSummaries: number };
  previewExpiredEvents?: (options: { now?: number }) => { expiringEvents: number; expiringByClass: Record<string, number> };
  cleanupExpiredDetails?: (options: { now?: number }) => { deletedEvents: number; incidentSummariesCreated: number };
};

export type ArtifactStorageGcGovernance = {
  runGc?: (options: { dryRun?: boolean; now?: number }) => Promise<{ cleanedFilesCount: number; cleanedBytes: number }>;
};

export type FeedbackEvalDatasetGovernance = {
  listCases?: () => Array<unknown>;
  prune?: (options: { now?: number }) => { beforeCount: number; afterCount: number; prunedCount: number };
};

export type OperationsEventStoreGovernance = {
  list?: () => Array<unknown>;
  prune?: (options: { now?: number }) => Promise<{ beforeCount: number; afterCount: number; prunedCount: number }>;
};

export type DataLifecycleGovernanceOptions = {
  store?: TaskStoreGovernance;
  taskRunEvents?: TaskRunEventStoreGovernance;
  artifactStorageGc?: ArtifactStorageGcGovernance;
  feedbackEvalDataset?: FeedbackEvalDatasetGovernance;
  operationsEventStore?: OperationsEventStoreGovernance;
  dataDir?: string;
  contentWorkspaceDir?: string;
  now?: () => number;
};

export type StorageOverview = {
  inspectedAt: string;
  tasksCount: Record<string, number>;
  eventsCount: {
    totalEvents: number;
    byClass: Record<string, number>;
    incidentSummaries: number;
  };
  evalCasesCount: number;
  dataDirSizeBytes: number;
  contentWorkspaceSizeBytes: number;
  retentionPolicies: {
    routineTasksDays: number;
    terminalTasksDays: number;
    conversationContextsDays: number;
    transientEventsDays: number;
    detailEventsDays: number;
    auditEventsDays: number;
    mediaRetentionDays: number;
  };
  lastReconcileResult: unknown;
};

export class DataLifecycleGovernanceReconciler {
  private store?: TaskStoreGovernance;
  private taskRunEvents?: TaskRunEventStoreGovernance;
  private artifactStorageGc?: ArtifactStorageGcGovernance;
  private feedbackEvalDataset?: FeedbackEvalDatasetGovernance;
  private operationsEventStore?: OperationsEventStoreGovernance;
  private dataDir?: string;
  private contentWorkspaceDir?: string;
  private now: () => number;
  private lastReconcileResult: unknown = null;

  constructor(options: DataLifecycleGovernanceOptions = {}) {
    this.store = options.store;
    this.taskRunEvents = options.taskRunEvents;
    this.artifactStorageGc = options.artifactStorageGc;
    this.feedbackEvalDataset = options.feedbackEvalDataset;
    this.operationsEventStore = options.operationsEventStore;
    this.dataDir = options.dataDir;
    this.contentWorkspaceDir = options.contentWorkspaceDir;
    this.now = options.now ?? (() => Date.now());
  }

  async inspectStorageStatus(): Promise<StorageOverview> {
    const inspectedAt = new Date(this.now()).toISOString();
    let tasksCount: Record<string, number> = {};
    if (this.store && typeof this.store.inspectCounts === 'function') {
      try {
        tasksCount = await this.store.inspectCounts();
      } catch {}
    }

    let eventsCount = { totalEvents: 0, byClass: {}, incidentSummaries: 0 };
    if (this.taskRunEvents && typeof this.taskRunEvents.inspectCounts === 'function') {
      try {
        eventsCount = this.taskRunEvents.inspectCounts();
      } catch {}
    }

    let evalCasesCount = 0;
    if (this.feedbackEvalDataset && typeof this.feedbackEvalDataset.listCases === 'function') {
      try {
        evalCasesCount = this.feedbackEvalDataset.listCases().length;
      } catch {}
    }

    const dataDirSizeBytes = this.dataDir ? getDirectorySizeBytes(this.dataDir) : 0;
    const contentWorkspaceSizeBytes = this.contentWorkspaceDir ? getDirectorySizeBytes(this.contentWorkspaceDir) : 0;

    return {
      inspectedAt,
      tasksCount,
      eventsCount,
      evalCasesCount,
      dataDirSizeBytes,
      contentWorkspaceSizeBytes,
      retentionPolicies: {
        routineTasksDays: 7,
        terminalTasksDays: 90,
        conversationContextsDays: 30,
        transientEventsDays: 7,
        detailEventsDays: 30,
        auditEventsDays: 365,
        mediaRetentionDays: 7,
      },
      lastReconcileResult: this.lastReconcileResult,
    };
  }

  async runFullClosedLoop({
    dryRun = false,
    now = this.now(),
  }: {
    dryRun?: boolean;
    now?: number;
  } = {}): Promise<{
    status: string;
    mode: 'dry-run' | 'apply';
    reconciledAt: string;
    tasksPruned: unknown;
    eventsCleaned: unknown;
    artifactsCleaned: unknown;
    evalCasesPruned: unknown;
    operationsEventsPruned: unknown;
    totalReclaimedItems: number;
    totalReclaimedBytes: number;
  }> {
    const reconciledAt = new Date(now).toISOString();
    let tasksPruned: unknown = null;
    let eventsCleaned: unknown = null;
    let artifactsCleaned: unknown = null;
    let evalCasesPruned: unknown = null;
    let operationsEventsPruned: unknown = null;

    let totalReclaimedItems = 0;
    let totalReclaimedBytes = 0;

    // 1. Task Store Pruning
    if (this.store && typeof this.store.pruneExpiredRecords === 'function') {
      try {
        const pruneRes = (await this.store.pruneExpiredRecords({ now, dryRun })) as Record<string, unknown>;
        tasksPruned = pruneRes;
        totalReclaimedItems += Number(dryRun ? (pruneRes.totalExpiring || 0) : (pruneRes.totalDeleted || 0));
      } catch (err: unknown) {
        tasksPruned = { error: err instanceof Error ? err.message : 'task_store_prune_failed' };
      }
    }

    // 2. Task Run Events Retention & Incident Compaction
    if (this.taskRunEvents) {
      try {
        if (dryRun && typeof this.taskRunEvents.previewExpiredEvents === 'function') {
          const res = this.taskRunEvents.previewExpiredEvents({ now });
          eventsCleaned = res;
          totalReclaimedItems += res.expiringEvents || 0;
        } else if (!dryRun && typeof this.taskRunEvents.cleanupExpiredDetails === 'function') {
          const res = this.taskRunEvents.cleanupExpiredDetails({ now });
          eventsCleaned = res;
          totalReclaimedItems += res.deletedEvents || 0;
        }
      } catch (err: unknown) {
        eventsCleaned = { error: err instanceof Error ? err.message : 'event_store_cleanup_failed' };
      }
    }

    // 3. Artifact Storage GC (Heavy Media & Orphan Workspaces)
    if (this.artifactStorageGc && typeof this.artifactStorageGc.runGc === 'function') {
      try {
        const res = await this.artifactStorageGc.runGc({ dryRun, now });
        artifactsCleaned = res;
        totalReclaimedItems += res.cleanedFilesCount || 0;
        totalReclaimedBytes += res.cleanedBytes || 0;
      } catch (err: unknown) {
        artifactsCleaned = { error: err instanceof Error ? err.message : 'artifact_gc_failed' };
      }
    }

    // 4. Feedback Evaluation Dataset Capacity Bounding
    if (this.feedbackEvalDataset && typeof this.feedbackEvalDataset.prune === 'function') {
      try {
        if (!dryRun) {
          const res = this.feedbackEvalDataset.prune({ now });
          evalCasesPruned = res;
          totalReclaimedItems += res.prunedCount || 0;
        } else {
          const count = this.feedbackEvalDataset.listCases?.()?.length || 0;
          evalCasesPruned = { totalCases: count, expiringCount: Math.max(0, count - 200) };
          totalReclaimedItems += Math.max(0, count - 200);
        }
      } catch (err: unknown) {
        evalCasesPruned = { error: err instanceof Error ? err.message : 'eval_dataset_prune_failed' };
      }
    }

    // 5. Operations Event Store Pruning
    if (this.operationsEventStore && typeof this.operationsEventStore.prune === 'function') {
      try {
        if (!dryRun) {
          const res = await this.operationsEventStore.prune({ now });
          operationsEventsPruned = res;
          totalReclaimedItems += res.prunedCount || 0;
        } else {
          operationsEventsPruned = { mode: 'dry-run', totalEvents: this.operationsEventStore.list?.()?.length || 0 };
        }
      } catch (err: unknown) {
        operationsEventsPruned = { error: err instanceof Error ? err.message : 'operations_event_prune_failed' };
      }
    }

    const result = {
      status: 'reconciled',
      mode: (dryRun ? 'dry-run' : 'apply') as 'dry-run' | 'apply',
      reconciledAt,
      tasksPruned,
      eventsCleaned,
      artifactsCleaned,
      evalCasesPruned,
      operationsEventsPruned,
      totalReclaimedItems,
      totalReclaimedBytes,
    };

    if (!dryRun) {
      this.lastReconcileResult = result;
    }

    return result;
  }

  async reconcile(): Promise<{ status: string; changed: boolean; workCount: number; result: unknown }> {
    const result = await this.runFullClosedLoop({ dryRun: false });
    return {
      status: 'reconciled',
      changed: result.totalReclaimedItems > 0 || result.totalReclaimedBytes > 0,
      workCount: result.totalReclaimedItems,
      result,
    };
  }
}

function getDirectorySizeBytes(dirPath: string): number {
  let total = 0;
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirectorySizeBytes(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  } catch {
    return 0;
  }
  return total;
}
