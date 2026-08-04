import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from './agent-registry.js';
import { ProposalAgentRegistry } from './proposal-agent-registry.js';
import { createTaskStore } from './create-task-store.js';
import { TaskService } from './task-service.js';
import { SkillExecutionRegistry } from './skill-execution-registry.js';
import { PaperclipBridge } from './paperclip-bridge.js';
import { PaperclipRosterReconciler } from './paperclip-roster-reconciler.js';
import { ApprovalExpiryReconciler } from './approval-expiry-reconciler.js';
import { PaperclipRepairReconciler } from './paperclip-repair-reconciler.js';
import { PaperclipHermesTaskReconciler } from './paperclip-hermes-task-reconciler.js';
import { TechnicalRepairEvidenceRelay } from './technical-repair-evidence-relay.js';
import { LocalHealthOperator } from './local-health-operator.js';
import { LocalAjunCoordinator } from './local-ajun-coordinator.js';
import { CrossAgentMissionService } from './cross-agent-mission-service.js';
import { CrossAgentMissionReconciler } from './cross-agent-mission-reconciler.js';
import { LocalReviewer } from './local-reviewer.js';
import { LocalArchitect } from './local-architect.js';
import { XiaodDelegate } from './xiaod-delegate.js';
import { CloudXiaodExecutor } from './cloud-xiaod-executor.js';
import { XiaodReconciler } from './xiaod-reconciler.js';
import { MacWorkerTaskBridge } from './mac-worker-task-bridge.js';
import { HermesIntentPlanner } from './hermes-intent-planner.js';
import { HermesConversationAdvisor } from './hermes-conversation-advisor.js';
import { HermesTaskAdvisor } from './hermes-task-advisor.js';
import { HermesPublicComparisonAdvisor } from './hermes-public-comparison-advisor.js';
import { HermesPublicSummaryAdvisor } from './hermes-public-summary-advisor.js';
import { HermesIntelResearchAdvisor } from './hermes-intel-research-advisor.js';
import { LocalTechnicalExpert } from './local-technical-expert.js';
import { IsolatedRepairWorkspace } from './isolated-repair-workspace.js';
import { TechnicalExpertRunner } from './technical-expert-runner.js';
import { TechnicalRepairPromotion } from './technical-repair-promotion.js';
import { TechnicalRepairWatchdog } from './technical-repair-watchdog.js';
import { TechnicalRepairDiagnoser } from './technical-repair-diagnoser.js';
import { FailureRecoveryCoordinator } from './failure-recovery-coordinator.js';
import {
  PaperclipCampaignDailyHandler,
  PaperclipHeartbeatHandler,
  PaperclipParallelWorkHandler,
} from './paperclip-heartbeat.js';
import { PaperclipMetricMonitorHandler } from './paperclip-metric-monitor.js';
import {
  PaperclipPublisherController,
} from './paperclip-publisher-controller.js';
import {
  canonicalPaperclipHeartbeat,
  PaperclipPublisherRunContext,
} from './paperclip-publisher-run-context.js';
import { PaperclipRetrospectiveHandler } from './paperclip-retrospective.js';
import { PaperclipLearningLifecycleHandler } from './paperclip-learning-lifecycle.js';
import { AgentProposalService } from './agent-proposal-service.js';
import { LocalCreator } from './local-creator.js';
import { PublicWebFetch } from './public-web-fetch.js';
import { PublicWebSearch } from './public-web-search.js';
import { PublicWebTransport } from './public-web-transport.js';
import { PublicDynamicWebReader } from './public-dynamic-web-reader.js';
import { PublicPdfReader } from './public-pdf-reader.js';
import { LocalPublicReport } from './local-public-report.js';
import { GithubSearch } from './github-search.js';
import { LocalGithubResearch } from './local-github-research.js';
import { LocalIntelResearcher } from './local-intel-researcher.js';
import { GrokConsultMcpAdapter } from './grok-consult-mcp-adapter.js';
import { LocalOfficeAssistant } from './local-office-assistant.js';
import { createM5RoleToolAdapters } from './m5-role-tool-adapters.js';
import { OfficeDocumentAdapter, officeBinariesAvailable } from './office-document-adapter.js';
import { KnowledgeArchiveWriter } from './knowledge-archive-writer.js';
import { LocalContentCreator, LocalVideoContentAnalyst } from './local-content-growth.js';
import { LocalVideoScriptPackage } from './local-video-script-package.js';
import { M5ProductionTemplateResolver } from './m5-production-template-resolver.js';
import { HermesContentGrowthAdvisor } from './hermes-content-growth-advisor.js';
import { ProposalAcceptanceRunner } from './proposal-acceptance-runner.js';
import { WeChatLocalVaultAcceptance } from './wechat-local-vault-acceptance.js';
import { LocalWeChatChatRetriever } from './local-wechat-chat-retriever.js';
import { LocalAiCapabilityClient } from './local-ai-capability-client.js';
import { FeishuCommander } from './feishu-commander.js';
import { FeishuChannelBridge } from './feishu-channel-bridge.js';
import { OfficialFeishuChannelRunner } from './official-feishu-channel-runner.js';
import { FileCompletionWatchStore, OfficialFeishuCompletionWatcher } from './official-feishu-completion-watcher.js';
import { HermesFeishuSender } from './hermes-feishu-sender.js';
import { FileAgentFeishuAppStore } from './agent-feishu-app-store.js';
import { ContentCampaignService } from './content-campaign-service.js';
import {
  createM5ServerPublisherComposition,
  PaperclipCurrentRunScope,
} from './m5-server-publisher-composition.js';
import {
  M5ToolExecutorRouter,
  PaperclipContentToolExecutor,
} from './paperclip-content-tool-executor.js';
import { LocalBudgetTicketAuthority } from './local-budget-ticket-authority.js';
import { AgentFeishuChannelFleet, employeeFeishuChannelsEnabled, feishuChannelStartupPlan } from './agent-feishu-channel-fleet.js';
import { EmployeeFeishuConnectionService } from './employee-feishu-connection-service.js';
import { HermesModelSetupService } from './hermes-model-setup-service.js';
import { createHermesModelProfileResolver } from './hermes-model-profile-resolver.js';
import { AccessConnectionService } from './access-connection-service.js';
import { isLoopbackHost, loadLanShareKey } from './lan-access.js';
import { taskDetailBaseUrl } from './task-presentation.js';
import { createFeishuApprovalResolver } from './runtime-http-feishu.js';
import { createAjunHttpHandler } from './runtime-http-handler.js';
import { resolveRuntimeSourceRoot } from './runtime-source-root.js';
import { defaultDefinition, HttpPaperclipAdapter } from '@agent-army/m5-content-pipeline';

export async function createRuntime({
  environment = process.env,
  logger = console,
} = {}) {
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
const budgetTicketAuthority = await LocalBudgetTicketAuthority.open(
  path.join(dataDir, 'm5-budget-ticket-ed25519.pem'),
);
const paperclipCurrentRunScope = new PaperclipCurrentRunScope();
const governance = new PaperclipBridge({
  publisherRunCredentialProvider:() => paperclipCurrentRunScope.currentCredential(),
});
const m5PublisherBindings = createM5ServerPublisherComposition({
  env:environment,
  dataDir,
  getCampaignService:campaigns,
  currentRunCredentialProvider:() => paperclipCurrentRunScope.currentCredential(),
  production:{
    enabled:true,
    paperclipAccess:governance,
    // 真实 transport/CUA runner 只能由后续受审计的不可变依赖包显式注入；空对象保持失败关闭。
    connectorDependencies:{},
  },
});
const store = createTaskStore({ dataDir, mode:environment.AGENT_ARMY_TASK_STORE || 'json' });
const registry = new ProposalAgentRegistry({ baseRegistry: new AgentRegistry({ agentsDir: path.join(root, 'agents') }), store });
const m5ProductionTemplateResolver = new M5ProductionTemplateResolver({ governance });
let contentCampaignService = null;
const paperclipRosterReconciler = new PaperclipRosterReconciler({
  registry, governance,
  onResult:(result) => { if (result.status !== 'synced') logger.warn('Paperclip 岗位同步暂未完成，将自动重试。'); }
});
const repairWorkspace = new IsolatedRepairWorkspace({
  projectRoot:sourceProjectRoot,
  parentDir:path.join(repairWorktreeParent, 'ajun-repairs'),
  sourceIdentity:runtimeSource.sourceIdentity,
  verifySourceRoot:runtimeSource.verify,
});
const technicalExpertRunner = new TechnicalExpertRunner();
const technicalRepairPromotion = new TechnicalRepairPromotion({
  projectRoot:sourceProjectRoot,
  allowedWorkspaceRoots:[repairWorktreeParent],
  sourceMode:runtimeSource.mode,
  sourceIdentity:runtimeSource.sourceIdentity,
  verifySourceRoot:runtimeSource.verify,
});
const technicalRepairWatchdog = new TechnicalRepairWatchdog({ store, governance });
const unguardedTechnicalRepairDiagnoser = new TechnicalRepairDiagnoser();
const technicalRepairDiagnoser = {
  async diagnose(...args) {
    await runtimeSource.verify();
    return unguardedTechnicalRepairDiagnoser.diagnose(...args);
  },
};
const taskAdvisor = new HermesTaskAdvisor();
const publicComparisonAdvisor = new HermesPublicComparisonAdvisor();
const publicSummaryAdvisor = new HermesPublicSummaryAdvisor();
const intelResearchAdvisor = new HermesIntelResearchAdvisor({ hermesHome:path.join(hermesProfileRoot, 'intel-researcher') });
const videoContentAdvisor = new HermesContentGrowthAdvisor({ hermesHome:path.join(hermesProfileRoot, 'video-content-analyst'), timeoutMs:720_000 });
const contentCreatorAdvisor = new HermesContentGrowthAdvisor({ hermesHome:path.join(hermesProfileRoot, 'content-creator'), timeoutMs:300_000 });
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
const paperclipHermesTaskReconciler = new PaperclipHermesTaskReconciler({ store, governance });
const operator = new LocalHealthOperator({ governance });
const publicWebTransport = new PublicWebTransport();
const publicWebFetch = new PublicWebFetch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) });
const publicWebSearch = new PublicWebSearch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) });
const publicDynamicWebReader = new PublicDynamicWebReader();
const publicPdfReader = new PublicPdfReader({ transport:publicWebTransport });
const githubSearch = new GithubSearch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) });
const publicReport = new LocalPublicReport({ publicWebFetch, publicWebSearch, comparisonAdvisor:publicComparisonAdvisor, refineAdvisor:publicSummaryAdvisor });
const githubResearch = new LocalGithubResearch({ githubSearch });
const intelResearcher = new LocalIntelResearcher({ publicWebFetch, publicWebSearch, githubSearch, publicReport, githubResearch, researchAdvisor:intelResearchAdvisor, grokConsult:new GrokConsultMcpAdapter({ accessMode:environment.AGENT_ARMY_GROK_ACCESS }) });
const knowledgeArchive = new KnowledgeArchiveWriter({
  autoWorkRoot
});
const officeAssistant = new LocalOfficeAssistant({ store, artifactsDir:path.join(dataDir, 'office-artifacts'), knowledgeArchive });
const officeDocuments = await officeBinariesAvailable()
  ? new OfficeDocumentAdapter()
  : null;
const m5RoleToolAdapters = createM5RoleToolAdapters({
  publicWebSearch,
  publicWebFetch,
  publicDynamicWebReader,
  publicPdfReader,
  githubSearch,
  officeDocuments,
  governance,
  store,
  knowledgeArchive,
});
const contentArtifactRoots = [
  dataDir,
  xiaodArtifactRoot,
  m5ContentWorkspaceDir,
];
const videoContentAnalyst = new LocalVideoContentAnalyst({
  store,
  artifactsDir:path.join(dataDir, 'content-growth-artifacts'),
  allowedArtifactRoots:contentArtifactRoots,
  advisor:videoContentAdvisor
});
const videoScriptPackage = new LocalVideoScriptPackage({
  store,
  artifactsDir:path.join(dataDir, 'content-growth-artifacts'),
  advisor:contentCreatorAdvisor,
  researcher:intelResearcher,
  templateResolver:m5ProductionTemplateResolver,
});
const contentCreator = new LocalContentCreator({
  store,
  artifactsDir:path.join(dataDir, 'content-growth-artifacts'),
  allowedArtifactRoots:contentArtifactRoots,
  advisor:contentCreatorAdvisor,
  scriptPackage:videoScriptPackage
});
const proposals = new AgentProposalService({
  store,
  registry,
  governance,
  restrictedAcceptanceRunner:new ProposalAcceptanceRunner({
    publicReport,
    intelResearcher,
    videoContentAnalyst,
    contentCreator,
    wechatLocalVault:new WeChatLocalVaultAcceptance({
      artifactsDir:path.join(dataDir, 'proposal-acceptance-artifacts')
    }),
    artifactsDir:path.join(dataDir, 'proposal-acceptance-artifacts')
  })
});
const port = Number(environment.PORT || 4321);
const host = environment.AJUN_HOST || '0.0.0.0';
const detailBaseUrl = taskDetailBaseUrl(environment.AJUN_TASK_DETAIL_BASE_URL, `http://127.0.0.1:${port}`);
let failureRecovery;
const localAi = new LocalAiCapabilityClient();
const tasks = new TaskService({ registry, store, governance, roleToolAdapters:m5RoleToolAdapters, m5ProviderVision:executeM5ProviderVision, m5WorkProductValidator:async (input) => (await campaigns()).assertReplayableM5WorkProduct(input), executors: { operator, xiaod, ajun: new LocalAjunCoordinator({ advisor:taskAdvisor, registry }), creator: new LocalCreator({ proposals }), reviewer: new LocalReviewer(), architect: new LocalArchitect({ registry, store }), 'technical-expert':new LocalTechnicalExpert({ workspace:repairWorkspace, runner:technicalExpertRunner, promotion:technicalRepairPromotion }), 'intel-researcher':intelResearcher, 'office-assistant':officeAssistant, 'video-content-analyst':videoContentAnalyst, 'content-creator':contentCreator, 'wechat-chat-retriever':new LocalWeChatChatRetriever({ store }) }, fallbackExecutor:publicReport, onTaskFailed:(task) => failureRecovery?.handle(task), taskDetailBaseUrl:detailBaseUrl, skillExecutionRegistry:new SkillExecutionRegistry({ grokAccessMode:environment.AGENT_ARMY_GROK_ACCESS }), localAiCapabilityStatus:() => localAi.health() });
const resolveFeishuApproval = createFeishuApprovalResolver({ proposals, tasks });
const macWorker = new MacWorkerTaskBridge({ store, governance, onFailure:(task) => failureRecovery?.handle(task) });
const approvalExpiryReconciler = new ApprovalExpiryReconciler({ tasks, onResult:(result) => { if (result.status !== 'synced') logger.warn('过期确认暂时无法自动整理，将自动重试。'); } });
proposals.taskService = tasks;
const missions = new CrossAgentMissionService({ tasks, store, governance });
const missionReconciler = new CrossAgentMissionReconciler({ store, missions });
const hermesFeishuSender = new HermesFeishuSender();
const hermesNativeCompletionWatcher = new OfficialFeishuCompletionWatcher({
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  send:(chatId, payload) => hermesFeishuSender.send(chatId, payload),
  store:new FileCompletionWatchStore(path.join(dataDir, 'hermes-native-completion-watches.json')),
  detailBaseUrl
});
failureRecovery = new FailureRecoveryCoordinator({ tasks, store, diagnoser:technicalRepairDiagnoser, projectRoot:sourceProjectRoot });
xiaodReconciler.onFailure = (task) => failureRecovery.handle(task);
const commander = new FeishuCommander({ tasks, proposals, missions, store, planner: new HermesIntentPlanner(), conversationAdvisor:new HermesConversationAdvisor(), ajunBaseUrl: `http://127.0.0.1:${port}` });
const officialFeishuChannel = new FeishuChannelBridge({ commander, resolveApproval: resolveFeishuApproval });
const officialFeishuChannelRunner = new OfficialFeishuChannelRunner({
  bridge:officialFeishuChannel,
  createChannel: asyncChannelFactory,
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  completionWatchStore:new FileCompletionWatchStore(path.join(dataDir, 'official-feishu-completion-watches.json')),
  completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher({ ...input, detailBaseUrl }),
  logger
});
const agentFeishuAppStore = new FileAgentFeishuAppStore({ directory:privateDir });
const agentFeishuChannelFleet = new AgentFeishuChannelFleet({
  store:agentFeishuAppStore, bridge:officialFeishuChannel, createChannel:asyncChannelFactory,
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  completionWatchStoreFactory:(agentId) => new FileCompletionWatchStore(path.join(dataDir, `official-feishu-${agentId}-completion-watches.json`)),
  completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher({ ...input, detailBaseUrl }),
  enabled:employeeFeishuChannelsEnabled({ deploymentMode, owner:employeeFeishuOwner }),
  externalAgentIds:hermesNativeEmployeeIds,
  logger
});
const employeeFeishuConnections = new EmployeeFeishuConnectionService({
  registry,
  store:agentFeishuAppStore,
  fleet:agentFeishuChannelFleet
});
const employeeModelSetup = new HermesModelSetupService({
  resolveProfile:createHermesModelProfileResolver({ registry, proposalStore:store, root })
});
const accessConnections = new AccessConnectionService();
const feishuChannelStartup = feishuChannelStartupPlan({
  apps:await agentFeishuAppStore.listApps(),
  legacyAJunEnabled:officialFeishuChannelRunner.enabled(),
  hermesNativeAJunEnabled:String(environment.AJUN_HERMES_NATIVE_FEISHU || '').trim().toLowerCase() === 'true',
  hermesNativeEmployeeIds
});
tasks.setFeishuChannelStatus(() => feishuChannelStartup.startLegacyAJun
  ? officialFeishuChannelRunner.snapshot()
  : feishuChannelStartup.ajunOwner === 'hermes-native'
    ? { status:'external', message:'A君飞书入口已交由 Hermes 原生 Gateway；连接真相以 Hermes Gateway 为准。' }
    : agentFeishuChannelFleet.snapshot().ajun || { status:'connecting', message:'A君智能体入口正在连接。' });
tasks.setAgentChannelStates(() => agentFeishuChannelFleet.snapshot());
tasks.setWorkerStatus((currentTasks) => deploymentMode === 'cloud'
  ? macWorker.snapshot(currentTasks)
  : { status:'ready', detail:'当前由这台 Mac 直接承接本机文件、私人账号和音视频工作。' });
tasks.setM5WorkProductObserver(
  async (event) => (await campaigns()).onM5WorkProductSynced(event),
);
const paperclipHeartbeat = new PaperclipHeartbeatHandler({ operator, governance });
const paperclipCampaignDaily = new PaperclipCampaignDailyHandler({
  governance,
  campaignActivator:async () => (await campaigns()).activateScheduledDay(),
});
const paperclipParallelWork = new PaperclipParallelWorkHandler({
  governance,
  reconcileParallelWork:async (caseId) => (await campaigns()).reconcileParallelWork(caseId),
});
const paperclipRunAuthenticationAdapter = {
  async authenticateRun(input) {
    const company = await governance.companyForRuntime();
    return new HttpPaperclipAdapter({
      apiBase:governance.baseUrl,
      companyId:company.id,
    }).authenticateRun(input);
  },
};
const paperclipPublisherRunContext = new PaperclipPublisherRunContext({
  paperclipAdapter:paperclipRunAuthenticationAdapter,
  governance,
  systemRole:'m5-publisher-controller',
});
const paperclipMetricRunContext = new PaperclipPublisherRunContext({
  paperclipAdapter:paperclipRunAuthenticationAdapter,
  governance,
  systemRole:'m5-metrics-controller',
});
const paperclipMetricMonitor = new PaperclipMetricMonitorHandler({
  governance,
  publisher:m5PublisherBindings.publisher,
});
const paperclipPublisherController = new PaperclipPublisherController({
  governance,
  publisher:m5PublisherBindings.publisher,
});
const paperclipRetrospective = new PaperclipRetrospectiveHandler({ governance });
const paperclipLearningLifecycle = new PaperclipLearningLifecycleHandler({ governance });
const lanEnabled = !isLoopbackHost(host);
const lanAccess = { enabled: lanEnabled, key: await loadLanShareKey(path.join(dataDir, 'lan-share-key'), lanEnabled) };

const handler = createAjunHttpHandler({
  environment,
  publicDir,
  dataDir,
  detailBaseUrl,
  network:{ deploymentMode, lanEnabled, lanAccess },
  paperclip:{
    paperclipHeartbeat,
    paperclipCampaignDaily,
    paperclipParallelWork,
    paperclipMetricRunContext,
    paperclipMetricMonitor,
    paperclipCurrentRunScope,
    paperclipPublisherRunContext,
    paperclipPublisherController,
    paperclipRetrospective,
    paperclipLearningLifecycle,
    canonicalPaperclipHeartbeat,
  },
  work:{ tasks, store, proposals, missions, macWorker },
  connections:{
    employeeFeishuConnections,
    employeeModelSetup,
    accessConnections,
    publicWebFetch,
  },
  feishu:{
    commander,
    officialFeishuChannel,
    hermesNativeCompletionWatcher,
    resolveFeishuApproval,
  },
  m5:{ campaigns },
});
const server = http.createServer(handler);

async function campaigns() {
  if (contentCampaignService) return contentCampaignService;
  const company = await governance.companyForRuntime();
  const adapter = new HttpPaperclipAdapter({
    apiBase:governance.baseUrl,
    companyId:company.id,
  });
  contentCampaignService = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    activePipelineId:environment.M5_ACTIVE_PIPELINE_ID || null,
    activePipelineKey:environment.M5_ACTIVE_PIPELINE_KEY || defaultDefinition.key,
    contentWorkspaceRoot:m5ContentWorkspaceDir,
    templateResolver:m5ProductionTemplateResolver,
    publisher:m5PublisherBindings.publisher,
    toolExecutor:new M5ToolExecutorRouter({
      publisherExecutor:m5PublisherBindings.toolExecutor,
      contentExecutor:new PaperclipContentToolExecutor({ adapter, budgetTicketAuthority }),
    }),
  });
  return contentCampaignService;
}

async function executeM5ProviderVision({ caseId, parameters, authentication }) {
  const service = await campaigns();
  const chain = await service.caseChain(caseId);
  const campaignCase = chain.at(-1);
  if (!campaignCase?.id || campaignCase.parentCaseId || !campaignCase.fields?.campaignGrant) {
    throw new Error('M5 视觉工具无法回溯到唯一活动授权父 Case。');
  }
  const pipeline = await service.requirePipeline();
  const receipt = await service.executeTool({
    campaignId:campaignCase.id,
    caseId,
    toolId:'agent-army.content-autonomy:stepfun-vision',
    parameters,
  }, authentication);
  return {
    receipt,
    projectId:pipeline.projectId,
  };
}

async function asyncChannelFactory(options) {
  const { createLarkChannel } = await import('@larksuite/channel');
  return createLarkChannel(options);
}

return Object.freeze({
  server,
  port,
  host,
  lanEnabled,
  deploymentMode,
  feishuChannelStartup,
  logger,
  source:Object.freeze({
    projectRoot:sourceProjectRoot,
    mode:runtimeSource.mode,
    integrityLevel:runtimeSource.integrityLevel,
  }),
  services:Object.freeze({
    paperclipRosterReconciler,
    approvalExpiryReconciler,
    xiaodReconciler,
    paperclipRepairReconciler,
    paperclipHermesTaskReconciler,
    missionReconciler,
    hermesNativeCompletionWatcher,
    technicalRepairWatchdog,
    officialFeishuChannelRunner,
    agentFeishuChannelFleet,
  }),
});
}
