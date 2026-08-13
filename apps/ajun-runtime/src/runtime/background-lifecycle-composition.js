import path from 'node:path';
import { dispatchBoomSignal } from '@agent-army/boom-monitor';
import { ApprovalExpiryReconciler } from '../approval-expiry-reconciler.ts';
import { createBoomMonitorService } from '../boom-monitor/index.js';
import { CrossAgentMissionReconciler } from '../cross-agent-mission-reconciler.ts';
import { CrossAgentMissionService } from '../cross-agent-mission-service.js';
import { InterruptedLocalExecutionReconciler } from '../interrupted-local-execution-reconciler.ts';
import { MacWorkerTaskBridge } from '../mac-worker-task-bridge.js';
import { PaperclipHermesTaskReconciler } from '../paperclip-hermes-task-reconciler.js';
import { PaperclipRepairReconciler } from '../paperclip-repair-reconciler.ts';
import { PaperclipRosterReconciler } from '../paperclip-roster-reconciler.js';
import { TechnicalRepairEvidenceRelay } from '../technical-repair-evidence-relay.js';
import { XiaodReconciler } from '../xiaod-reconciler.js';
import { DeliveryQualityReconciler } from '../workflow/delivery-quality-reconciler.ts';

export function createBackgroundLifecycleComposition({
  configuration,
  runtimeSource,
  store,
  governance,
  localExecution,
  tasks,
  roleExecution,
  missionChildPolicy = null,
  logger = console,
} = {}) {
  const { paths, bootedAt, features } = configuration;
  const interruptedLocalExecutionReconciler = new InterruptedLocalExecutionReconciler({
    store,
    bootedAt,
    onResult:(result) => {
      if (result.status !== 'reconciled') {
        logger.warn('重启前中断的本地任务暂时无法整理，将保留原状态。');
      }
    },
  });
  const paperclipRosterReconciler = new PaperclipRosterReconciler({
    registry:localExecution.registry,
    governance,
    onResult:(result) => {
      if (result.status !== 'synced') logger.warn('Paperclip 岗位同步暂未完成，将自动重试。');
    },
  });
  const xiaodReconciler = new XiaodReconciler({
    store,
    xiaod:localExecution.localXiaod,
    governance,
    contentWorkspaceDir:paths.contentWorkspaceDir,
  });
  xiaodReconciler.deliveryQuality = tasks.deliveryQuality;
  xiaodReconciler.lifecycleEvents = tasks.taskLifecycleEvents;
  xiaodReconciler.onFailure = (task) => roleExecution.failureRecovery.handle(task);
  localExecution.bindXiaodReconciler(xiaodReconciler);

  const paperclipRepairReconciler = new PaperclipRepairReconciler({
    store,
    governance,
    evidenceRelay:new TechnicalRepairEvidenceRelay({
      governance,
      projectRoot:runtimeSource.sourceProjectRoot,
      allowedWorkspaceRoots:[paths.repairWorktreeParent],
      verifySourceRoot:runtimeSource.verifyIdentity,
    }),
  });
  const paperclipHermesTaskReconciler = new PaperclipHermesTaskReconciler({
    store,
    governance,
    fallback:roleExecution.executeVideoAnalysisFallback,
  });
  const deliveryQualityReconciler = new DeliveryQualityReconciler({
    store,
    deliveryQuality:tasks.deliveryQuality,
    onResult:(result) => {
      if (result.status !== 'reconciled') {
        logger.warn('待启动的交付质量复核暂未全部恢复，将在下个周期继续。');
      }
    },
  });
  const macWorker = new MacWorkerTaskBridge({
    store,
    governance,
    onFailure:(task) => roleExecution.failureRecovery?.handle(task),
  });
  const approvalExpiryReconciler = new ApprovalExpiryReconciler({
    tasks,
    onResult:(result) => {
      if (result.status !== 'synced') logger.warn('过期确认暂时无法自动整理，将自动重试。');
    },
  });
  const missions = new CrossAgentMissionService({ tasks, store, governance, missionChildPolicy });
  const missionReconciler = new CrossAgentMissionReconciler({ store, missions });
  const boomMonitor = features.boomMonitorEnabled ? createBoomMonitorService({
    dbPath:path.join(paths.dataDir, 'boom-monitor.sqlite'),
    dataDir:path.join(paths.dataDir, 'boom-monitor'),
    collectMetrics:(input) => localExecution.xiaod.collectMetrics(input),
    dispatchBoomSignal:(input) => dispatchBoomSignal(input, { missions }),
    analysisDailyLimit:features.boomAnalysisDailyLimit,
  }) : null;

  return Object.freeze({
    macWorker,
    missions,
    boomMonitor,
    services:Object.freeze({
      interruptedLocalExecutionReconciler,
      deliveryQualityReconciler,
      paperclipRosterReconciler,
      approvalExpiryReconciler,
      xiaodReconciler,
      paperclipRepairReconciler,
      paperclipHermesTaskReconciler,
      missionReconciler,
      boomMonitor:features.boomMonitorEnabled ? boomMonitor : null,
      technicalRepairWatchdog:roleExecution.technicalRepairWatchdog,
    }),
    close() {
      boomMonitor?.close();
    },
  });
}
