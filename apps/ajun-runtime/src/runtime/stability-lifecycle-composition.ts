import path from 'node:path';
import { ApprovalEscalationGovernor } from '../approval-escalation-governor.ts';
import { ArtifactStorageGcReconciler } from '../artifact-storage-gc.ts';
import { CredentialDecayWarner } from '../credential-decay-warner.ts';
import { CrossServiceHealthMesh } from '../cross-service-health-mesh.ts';
import { FeedbackEvalDatasetService } from '../feedback-eval-dataset.ts';
import { ProactiveAnomalyAlerting } from '../proactive-anomaly-alerting.ts';
import { reconciliationJob } from '../reconciliation-coordinator.ts';
import { SqliteWalGovernorReconciler } from '../sqlite-wal-governor.ts';
import { TaskLivenessWatchdog } from '../task-liveness-watchdog.ts';
import { DeliveryUnknownReconciler } from '../workflow/delivery-unknown-reconciler.ts';
import { DataLifecycleGovernanceReconciler } from '../data-lifecycle-governance.ts';

export function createStabilityLifecycleComposition({
  store,
  taskRunEvents,
  paths,
  roleExecution,
}: {
  store: any;
  taskRunEvents?: any;
  paths: { contentWorkspaceDir: string; dataDir: string };
  roleExecution: any;
}) {
  const taskLivenessWatchdog = new TaskLivenessWatchdog({
    store,
    onTaskStalled: (task: any) => roleExecution.failureRecovery.handle(task),
  });
  const artifactStorageGc = new ArtifactStorageGcReconciler({
    store,
    workspaceDirs: [paths.contentWorkspaceDir, paths.dataDir],
  });
  const deliveryUnknownReconciler = new DeliveryUnknownReconciler({ store });
  const healthMesh = new CrossServiceHealthMesh();
  const anomalyAlerting = new ProactiveAnomalyAlerting({ store });
  const feedbackEvalDataset = new FeedbackEvalDatasetService({
    store,
    datasetFilePath: path.join(paths.dataDir, 'eval-cases.json'),
  });
  const sqliteWalGovernor = new SqliteWalGovernorReconciler({ database: store?.database });
  const credentialDecayWarner = new CredentialDecayWarner();
  const approvalEscalationGovernor = new ApprovalEscalationGovernor({ store });
  const dataLifecycleGovernance = new DataLifecycleGovernanceReconciler({
    store,
    taskRunEvents,
    artifactStorageGc,
    feedbackEvalDataset,
    dataDir: paths.dataDir,
    contentWorkspaceDir: paths.contentWorkspaceDir,
  });

  const stabilityJobs = [
    reconciliationJob('task-liveness-watchdog', taskLivenessWatchdog, { maxIntervalMs: 60_000 }),
    reconciliationJob('artifact-storage-gc', artifactStorageGc, { maxIntervalMs: 30 * 60_000 }),
    reconciliationJob('data-lifecycle-governance', dataLifecycleGovernance, { maxIntervalMs: 60 * 60_000 }),
    reconciliationJob('delivery-unknown', deliveryUnknownReconciler, { maxIntervalMs: 60_000 }),
    reconciliationJob('health-mesh', healthMesh, { maxIntervalMs: 30_000 }),
    reconciliationJob('anomaly-alerting', anomalyAlerting, { maxIntervalMs: 60_000 }),
    reconciliationJob('feedback-eval-dataset', feedbackEvalDataset, { maxIntervalMs: 15 * 60_000 }),
    reconciliationJob('sqlite-wal-governor', sqliteWalGovernor, { maxIntervalMs: 5 * 60_000 }),
    reconciliationJob('credential-decay-warner', credentialDecayWarner, { maxIntervalMs: 60 * 60_000 }),
    reconciliationJob('approval-escalation', approvalEscalationGovernor, { maxIntervalMs: 60_000 }),
  ];

  return Object.freeze({
    taskLivenessWatchdog,
    artifactStorageGc,
    dataLifecycleGovernance,
    deliveryUnknownReconciler,
    healthMesh,
    anomalyAlerting,
    feedbackEvalDataset,
    sqliteWalGovernor,
    credentialDecayWarner,
    approvalEscalationGovernor,
    stabilityJobs,
  });
}
