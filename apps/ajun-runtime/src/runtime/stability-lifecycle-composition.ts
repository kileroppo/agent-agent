import path from 'node:path';
import { ArtifactStorageGcReconciler } from '../artifact-storage-gc.ts';
import { CrossServiceHealthMesh } from '../cross-service-health-mesh.ts';
import { FeedbackEvalDatasetService } from '../feedback-eval-dataset.ts';
import { ProactiveAnomalyAlerting } from '../proactive-anomaly-alerting.ts';
import { reconciliationJob } from '../reconciliation-coordinator.ts';
import { TaskLivenessWatchdog } from '../task-liveness-watchdog.ts';
import { DeliveryUnknownReconciler } from '../workflow/delivery-unknown-reconciler.ts';

export function createStabilityLifecycleComposition({
  store,
  paths,
  roleExecution,
}: {
  store: any;
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

  const stabilityJobs = [
    reconciliationJob('task-liveness-watchdog', taskLivenessWatchdog, { maxIntervalMs: 60_000 }),
    reconciliationJob('artifact-storage-gc', artifactStorageGc, { maxIntervalMs: 30 * 60_000 }),
    reconciliationJob('delivery-unknown', deliveryUnknownReconciler, { maxIntervalMs: 60_000 }),
    reconciliationJob('health-mesh', healthMesh, { maxIntervalMs: 30_000 }),
    reconciliationJob('anomaly-alerting', anomalyAlerting, { maxIntervalMs: 60_000 }),
    reconciliationJob('feedback-eval-dataset', feedbackEvalDataset, { maxIntervalMs: 15 * 60_000 }),
  ];

  return Object.freeze({
    taskLivenessWatchdog,
    artifactStorageGc,
    deliveryUnknownReconciler,
    healthMesh,
    anomalyAlerting,
    feedbackEvalDataset,
    stabilityJobs,
  });
}
