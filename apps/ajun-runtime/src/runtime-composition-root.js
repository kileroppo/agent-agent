import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from './agent-registry.js';
import { ProposalAgentRegistry } from './proposal-agent-registry.ts';
import { createTaskStore } from './create-task-store.js';
import { PaperclipRosterReconciler } from './paperclip-roster-reconciler.js';
import { ApprovalExpiryReconciler } from './approval-expiry-reconciler.ts';
import { PaperclipRepairReconciler } from './paperclip-repair-reconciler.ts';
import { PaperclipHermesTaskReconciler } from './paperclip-hermes-task-reconciler.js';
import { TechnicalRepairEvidenceRelay } from './technical-repair-evidence-relay.js';
import { CrossAgentMissionService } from './cross-agent-mission-service.js';
import { CrossAgentMissionReconciler } from './cross-agent-mission-reconciler.ts';
import { XiaodDelegate } from './xiaod-delegate.js';
import { CloudXiaodExecutor } from './cloud-xiaod-executor.js';
import { XiaodReconciler } from './xiaod-reconciler.js';
import { MacWorkerTaskBridge } from './mac-worker-task-bridge.js';
import { InterruptedLocalExecutionReconciler } from './interrupted-local-execution-reconciler.ts';
import { LocalAiCapabilityClient } from './local-ai-capability-client.js';
import { AccessConnectionService } from './access-connection-service.js';
import { isLoopbackHost, loadLanShareKey } from './lan-access.js';
import { createAjunHttpHandler } from './runtime-http-handler.js';
import { createBoomMonitorService } from './boom-monitor/index.js';
import { resolveRuntimeSourceRoot } from './runtime-source-root.js';
import { createContentCampaignComposition } from './runtime/content-campaign-composition.js';
import { createFeishuCommandComposition } from './runtime/feishu-command-composition.js';
import { createPaperclipSystemControlComposition } from './runtime/paperclip-system-control-composition.js';
import { createRoleExecutionComposition } from './runtime/role-execution-composition.js';
import { dispatchBoomSignal } from '@agent-army/boom-monitor';
import { MissionChildPolicy } from './workflow/mission-child-policy.ts';
import { CapabilityAcceptanceBundle } from './workflow/capability-acceptance-bundle.ts';

export async function createRuntime({
  environment = process.env,
  logger = console,
} = {}) {
const bootedAt = new Date().toISOString();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicDir = path.join(root, 'apps/ajun-runtime/public');
const dataDir = path.resolve(environment.AGENT_ARMY_DATA_DIR || path.join(root, 'apps/ajun-runtime/data'));
const privateDir = path.resolve(
  environment.AGENT_ARMY_PRIVATE_DIR || path.join(os.homedir(), '.agent-army'),
);
const repairWorktreeParent = path.resolve(
  environment.PAPERCLIP_REPAIR_WORKTREE_PARENT
    || path.join(os.homedir(), '.paperclip', 'agent-army-worktrees'),
);
const m5ContentWorkspaceDir = path.resolve(
  environment.AGENT_ARMY_CONTENT_WORKSPACE_DIR || path.join(root, 'work/m5-content-autonomy'),
);
const hermesProfileRoot = path.resolve(
  environment.AGENT_ARMY_HERMES_PROFILE_ROOT
    || path.join(os.homedir(), '.hermes', 'profiles'),
);
const autoWorkRoot = path.resolve(environment.AUTO_WORK_ROOT || path.resolve(root, '../auto-work'));
const xiaodArtifactRoot = path.resolve(
  environment.XIAOD_ARTIFACT_ROOT || path.join(root, 'apps/xiaod-media-transcriber/data'),
);
const runtimeSource = await resolveRuntimeSourceRoot({
  runtimeRoot:root,
  configuredSourceRoot:environment.AGENT_ARMY_SOURCE_PROJECT_ROOT,
  dataDir,
  privateDir,
  worktreeParent:repairWorktreeParent,
  externalStatePaths:{
    AGENT_ARMY_CONTENT_WORKSPACE_DIR:m5ContentWorkspaceDir,
    AGENT_ARMY_HERMES_PROFILE_ROOT:hermesProfileRoot,
    AUTO_WORK_ROOT:autoWorkRoot,
    XIAOD_ARTIFACT_ROOT:xiaodArtifactRoot,
  },
});
const sourceProjectRoot = runtimeSource.sourceProjectRoot;
const contentCampaign = await createContentCampaignComposition({
  environment,
  dataDir,
  contentWorkspaceDir:m5ContentWorkspaceDir,
});
const {
  governance,
  campaigns,
  paperclipCurrentRunScope,
  publisherBindings:m5PublisherBindings,
} = contentCampaign;
const store = createTaskStore({ dataDir, mode:environment.AGENT_ARMY_TASK_STORE || 'json' });
const missionChildPolicy = await MissionChildPolicy.open({ keyPath:path.join(privateDir, 'product-maturity-child-policy.key') });
const interruptedLocalExecutionReconciler = new InterruptedLocalExecutionReconciler({
  store,
  bootedAt,
  onResult:(result) => {
    if (result.status !== 'reconciled') logger.warn('重启前中断的本地任务暂时无法整理，将保留原状态。');
  },
});
const registry = new ProposalAgentRegistry({ baseRegistry: new AgentRegistry({ agentsDir: path.join(root, 'agents') }), store });
const paperclipRosterReconciler = new PaperclipRosterReconciler({
  registry, governance,
  onResult:(result) => { if (result.status !== 'synced') logger.warn('Paperclip 岗位同步暂未完成，将自动重试。'); }
});
const deploymentMode = String(environment.AGENT_ARMY_DEPLOYMENT_MODE || 'local').trim().toLowerCase();
const employeeFeishuOwner = String(environment.AGENT_ARMY_EMPLOYEE_FEISHU_OWNER || 'local').trim().toLowerCase();
const hermesNativeEmployeeIds = String(environment.AJUN_HERMES_NATIVE_EMPLOYEE_IDS || '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => /^[a-z][a-z0-9-]{0,63}$/.test(item));
let xiaodReconciler;
const localXiaod = new XiaodDelegate({ onStarted: () => void xiaodReconciler?.reconcile() });
const xiaod = deploymentMode === 'cloud' ? new CloudXiaodExecutor() : localXiaod;
xiaodReconciler = new XiaodReconciler({
  store,
  xiaod:localXiaod,
  governance,
  contentWorkspaceDir:m5ContentWorkspaceDir,
});
const paperclipRepairReconciler = new PaperclipRepairReconciler({ store, governance, evidenceRelay:new TechnicalRepairEvidenceRelay({ governance, projectRoot:sourceProjectRoot, allowedWorkspaceRoots:[repairWorktreeParent], verifySourceRoot:runtimeSource.verifyIdentity }) });
let executeVideoAnalysisFallback = null;
const paperclipHermesTaskReconciler = new PaperclipHermesTaskReconciler({
  store,
  governance,
  fallback:(task, context) => executeVideoAnalysisFallback?.(task, context),
});
const port = Number(environment.PORT || 4321);
const host = environment.AJUN_HOST || '0.0.0.0';
const localAi = new LocalAiCapabilityClient();
const roleExecution = await createRoleExecutionComposition({
  environment,
  paths:{
    root,
    dataDir,
    sourceProjectRoot,
    repairWorktreeParent,
    hermesProfileRoot,
    autoWorkRoot,
    xiaodArtifactRoot,
    contentWorkspaceDir:m5ContentWorkspaceDir,
  },
  runtimeSource,
  registry,
  store,
  governance,
  contentCampaign,
  xiaod,
  localAi,
  port,
  missionChildPolicy,
});
const {
  tasks,
  proposals,
  operator,
  failureRecovery,
  publicWebFetch,
  technicalRepairWatchdog,
} = roleExecution;
executeVideoAnalysisFallback = roleExecution.executeVideoAnalysisFallback;
const macWorker = new MacWorkerTaskBridge({ store, governance, onFailure:(task) => failureRecovery?.handle(task) });
const approvalExpiryReconciler = new ApprovalExpiryReconciler({ tasks, onResult:(result) => { if (result.status !== 'synced') logger.warn('过期确认暂时无法自动整理，将自动重试。'); } });
const missions = new CrossAgentMissionService({ tasks, store, governance, missionChildPolicy });
const productMaturity = new CapabilityAcceptanceBundle({
  store,
  missions,
  policy:missionChildPolicy,
  ledgerPath:path.join(dataDir, 'product-maturity-validation-batches.json'),
  projectRoot:sourceProjectRoot,
});
const missionReconciler = new CrossAgentMissionReconciler({ store, missions });
const boomMonitorEnabled = String(environment.AJUN_BOOM_MONITOR_ENABLED || 'true').trim().toLowerCase() !== 'false';
const boomMonitor = boomMonitorEnabled ? createBoomMonitorService({
  dbPath:path.join(dataDir, 'boom-monitor.sqlite'),
  dataDir:path.join(dataDir, 'boom-monitor'),
  collectMetrics:(input) => xiaod.collectMetrics(input),
  dispatchBoomSignal:(input) => dispatchBoomSignal(input, { missions }),
  analysisDailyLimit:Number(environment.BOOM_ANALYSIS_DAILY_LIMIT || 5),
}) : null;
xiaodReconciler.onFailure = (task) => failureRecovery.handle(task);
const feishuCommand = await createFeishuCommandComposition({
  environment,
  root,
  privateDir,
  dataDir,
  deploymentMode,
  employeeFeishuOwner,
  hermesNativeEmployeeIds,
  registry,
  store,
  tasks,
  proposals,
  missions,
  port,
  logger,
});
const accessConnections = new AccessConnectionService();
tasks.setWorkerStatus((currentTasks) => deploymentMode === 'cloud'
  ? macWorker.snapshot(currentTasks)
  : { status:'ready', detail:'当前由这台 Mac 直接承接本机文件、私人账号和音视频工作。' });
tasks.setM5WorkProductObserver(
  async (event) => (await campaigns()).onM5WorkProductSynced(event),
);
const paperclipSystemControl = createPaperclipSystemControlComposition({
  governance,
  tasks,
  operator,
  campaigns,
  publisherBindings:m5PublisherBindings,
  paperclipCurrentRunScope,
});
const lanEnabled = !isLoopbackHost(host);
const lanAccess = { enabled: lanEnabled, key: await loadLanShareKey(path.join(dataDir, 'lan-share-key'), lanEnabled) };

const handler = createAjunHttpHandler({
  environment,
  publicDir,
  dataDir,
  detailBaseUrl:feishuCommand.detailBaseUrl,
  development:{
    hotReload:{
      enabled:String(environment.AJUN_DEV_HOT_RELOAD || '').trim().toLowerCase() === 'true',
      revision:`boot:${bootedAt}:${process.pid}`,
    },
  },
  network:{ deploymentMode, lanEnabled, lanAccess },
  paperclip:paperclipSystemControl,
  work:{ tasks, store, proposals, missions, productMaturity, macWorker, xiaod, boomMonitor, boomMonitorEnabled },
  connections:{
    ...feishuCommand.connections,
    accessConnections,
    publicWebFetch,
  },
  localAi,
  feishu:feishuCommand.handler,
  m5:{ campaigns },
});
const server = http.createServer(handler);
server.once('close', () => boomMonitor?.close());

return Object.freeze({
  server,
  port,
  host,
  lanEnabled,
  deploymentMode,
  feishuChannelStartup:feishuCommand.feishuChannelStartup,
  logger,
  source:Object.freeze({
    projectRoot:sourceProjectRoot,
    mode:runtimeSource.mode,
    integrityLevel:runtimeSource.integrityLevel,
  }),
  services:Object.freeze({
    interruptedLocalExecutionReconciler,
    paperclipRosterReconciler,
    approvalExpiryReconciler,
    xiaodReconciler,
    paperclipRepairReconciler,
    paperclipHermesTaskReconciler,
    missionReconciler,
    boomMonitor:boomMonitorEnabled ? boomMonitor : null,
    technicalRepairWatchdog,
    ...feishuCommand.services,
  }),
});
}
