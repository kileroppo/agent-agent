import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from './agent-registry.js';
import { ProposalAgentRegistry } from './proposal-agent-registry.js';
import { TaskStore } from './task-store.js';
import { TaskService, ValidationError } from './task-service.js';
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
import { MacWorkerTaskBridge, MacWorkerBridgeError } from './mac-worker-task-bridge.js';
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
import { PaperclipHeartbeatHandler } from './paperclip-heartbeat.js';
import { AgentProposalService, ProposalValidationError } from './agent-proposal-service.js';
import { LocalCreator } from './local-creator.js';
import { PublicWebFetch, PublicWebFetchError } from './public-web-fetch.js';
import { PublicWebSearch } from './public-web-search.js';
import { PublicWebTransport } from './public-web-transport.js';
import { LocalPublicReport } from './local-public-report.js';
import { GithubSearch } from './github-search.js';
import { LocalGithubResearch } from './local-github-research.js';
import { LocalIntelResearcher } from './local-intel-researcher.js';
import { LocalOfficeAssistant } from './local-office-assistant.js';
import { KnowledgeArchiveWriter } from './knowledge-archive-writer.js';
import { LocalContentCreator, LocalVideoContentAnalyst } from './local-content-growth.js';
import { LocalVideoScriptPackage } from './local-video-script-package.js';
import { HermesContentGrowthAdvisor } from './hermes-content-growth-advisor.js';
import { ProposalAcceptanceRunner } from './proposal-acceptance-runner.js';
import { FeishuCommander, FeishuCommanderValidationError } from './feishu-commander.js';
import { FeishuChannelBridge, FeishuChannelBridgeError } from './feishu-channel-bridge.js';
import { OfficialFeishuChannelRunner } from './official-feishu-channel-runner.js';
import { FileCompletionWatchStore, OfficialFeishuCompletionWatcher } from './official-feishu-completion-watcher.js';
import { HermesFeishuSender } from './hermes-feishu-sender.js';
import { FileAgentFeishuAppStore } from './agent-feishu-app-store.js';
import { AgentFeishuChannelFleet, employeeFeishuChannelsEnabled, feishuChannelStartupPlan } from './agent-feishu-channel-fleet.js';
import { EmployeeFeishuConnectionError, EmployeeFeishuConnectionService } from './employee-feishu-connection-service.js';
import { HermesModelSetupError, HermesModelSetupService } from './hermes-model-setup-service.js';
import { createHermesModelProfileResolver } from './hermes-model-profile-resolver.js';
import { AccessConnectionError, AccessConnectionService } from './access-connection-service.js';
import { canAccessApi, isLocalAddress, isLoopbackHost, lanAddresses, loadLanShareKey, rotateLanShareKey } from './lan-access.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicDir = path.join(root, 'apps/ajun-runtime/public');
const dataDir = path.resolve(process.env.AGENT_ARMY_DATA_DIR || path.join(root, 'apps/ajun-runtime/data'));
const store = new TaskStore(path.join(dataDir, 'runtime.json'));
const registry = new ProposalAgentRegistry({ baseRegistry: new AgentRegistry({ agentsDir: path.join(root, 'agents') }), store });
const governance = new PaperclipBridge();
const paperclipRosterReconciler = new PaperclipRosterReconciler({
  registry, governance,
  onResult:(result) => { if (result.status !== 'synced') console.warn('Paperclip 岗位同步暂未完成，将自动重试。'); }
});
const repairWorkspace = new IsolatedRepairWorkspace({ projectRoot:root });
const technicalExpertRunner = new TechnicalExpertRunner();
const technicalRepairPromotion = new TechnicalRepairPromotion({ projectRoot:root });
const technicalRepairWatchdog = new TechnicalRepairWatchdog({ store, governance });
const technicalRepairDiagnoser = new TechnicalRepairDiagnoser();
const taskAdvisor = new HermesTaskAdvisor();
const publicComparisonAdvisor = new HermesPublicComparisonAdvisor();
const publicSummaryAdvisor = new HermesPublicSummaryAdvisor();
const hermesProfileRoot = process.env.AGENT_ARMY_HERMES_PROFILE_ROOT || path.join(os.homedir(), '.hermes', 'profiles');
const intelResearchAdvisor = new HermesIntelResearchAdvisor({ hermesHome:path.join(hermesProfileRoot, 'intel-researcher') });
const videoContentAdvisor = new HermesContentGrowthAdvisor({ hermesHome:path.join(hermesProfileRoot, 'video-content-analyst'), timeoutMs:720_000 });
const contentCreatorAdvisor = new HermesContentGrowthAdvisor({ hermesHome:path.join(hermesProfileRoot, 'content-creator'), timeoutMs:300_000 });
const deploymentMode = String(process.env.AGENT_ARMY_DEPLOYMENT_MODE || 'local').trim().toLowerCase();
const employeeFeishuOwner = String(process.env.AGENT_ARMY_EMPLOYEE_FEISHU_OWNER || 'local').trim().toLowerCase();
const hermesNativeEmployeeIds = String(process.env.AJUN_HERMES_NATIVE_EMPLOYEE_IDS || '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => /^[a-z][a-z0-9-]{0,63}$/.test(item));
let xiaodReconciler;
const localXiaod = new XiaodDelegate({ onStarted: () => void xiaodReconciler?.reconcile() });
const xiaod = deploymentMode === 'cloud' ? new CloudXiaodExecutor() : localXiaod;
xiaodReconciler = new XiaodReconciler({ store, xiaod:localXiaod, governance });
const paperclipRepairReconciler = new PaperclipRepairReconciler({ store, governance, evidenceRelay:new TechnicalRepairEvidenceRelay({ governance, projectRoot:root, allowedWorkspaceRoots:[process.env.PAPERCLIP_REPAIR_WORKTREE_PARENT || '/Users/pengaro/.paperclip/agent-army-worktrees'] }) });
const paperclipHermesTaskReconciler = new PaperclipHermesTaskReconciler({ store, governance });
const operator = new LocalHealthOperator({ governance });
const publicWebTransport = new PublicWebTransport();
const publicWebFetch = new PublicWebFetch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) });
const publicWebSearch = new PublicWebSearch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) });
const githubSearch = new GithubSearch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) });
const publicReport = new LocalPublicReport({ publicWebFetch, publicWebSearch, comparisonAdvisor:publicComparisonAdvisor, refineAdvisor:publicSummaryAdvisor });
const githubResearch = new LocalGithubResearch({ githubSearch });
const intelResearcher = new LocalIntelResearcher({ publicWebFetch, publicWebSearch, githubSearch, publicReport, githubResearch, researchAdvisor:intelResearchAdvisor });
const knowledgeArchive = new KnowledgeArchiveWriter({
  autoWorkRoot:process.env.AUTO_WORK_ROOT || path.resolve(root, '../auto-work')
});
const officeAssistant = new LocalOfficeAssistant({ store, artifactsDir:path.join(dataDir, 'office-artifacts'), knowledgeArchive });
const contentArtifactRoots = [
  dataDir,
  path.resolve(process.env.XIAOD_ARTIFACT_ROOT || path.join(root, 'apps/xiaod-media-transcriber/data'))
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
  researcher:intelResearcher
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
    artifactsDir:path.join(dataDir, 'proposal-acceptance-artifacts')
  })
});
const port = Number(process.env.PORT || 4321);
const host = process.env.AJUN_HOST || '0.0.0.0';
let failureRecovery;
const tasks = new TaskService({ registry, store, governance, executors: { operator, xiaod, ajun: new LocalAjunCoordinator({ advisor:taskAdvisor, registry }), creator: new LocalCreator({ proposals }), reviewer: new LocalReviewer(), architect: new LocalArchitect({ registry, store }), 'technical-expert': new LocalTechnicalExpert({ workspace:repairWorkspace, runner:technicalExpertRunner, promotion:technicalRepairPromotion }), 'intel-researcher':intelResearcher, 'office-assistant':officeAssistant, 'video-content-analyst':videoContentAnalyst, 'content-creator':contentCreator }, fallbackExecutor: publicReport, onTaskFailed: (task) => failureRecovery?.handle(task) });
const macWorker = new MacWorkerTaskBridge({ store, governance, onFailure:(task) => failureRecovery?.handle(task) });
const approvalExpiryReconciler = new ApprovalExpiryReconciler({ tasks, onResult:(result) => { if (result.status !== 'synced') console.warn('过期确认暂时无法自动整理，将自动重试。'); } });
proposals.taskService = tasks;
const missions = new CrossAgentMissionService({ tasks, store, governance });
const missionReconciler = new CrossAgentMissionReconciler({ store, missions });
const hermesFeishuSender = new HermesFeishuSender();
const hermesNativeCompletionWatcher = new OfficialFeishuCompletionWatcher({
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  send:(chatId, payload) => hermesFeishuSender.send(chatId, payload),
  store:new FileCompletionWatchStore(path.join(dataDir, 'hermes-native-completion-watches.json'))
});
failureRecovery = new FailureRecoveryCoordinator({ tasks, store, diagnoser:technicalRepairDiagnoser, projectRoot:root });
xiaodReconciler.onFailure = (task) => failureRecovery.handle(task);
const commander = new FeishuCommander({ tasks, proposals, missions, store, planner: new HermesIntentPlanner(), conversationAdvisor:new HermesConversationAdvisor(), ajunBaseUrl: `http://127.0.0.1:${port}` });
const officialFeishuChannel = new FeishuChannelBridge({ commander, resolveApproval: resolveFeishuApproval });
const officialFeishuChannelRunner = new OfficialFeishuChannelRunner({
  bridge:officialFeishuChannel,
  createChannel: asyncChannelFactory,
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  completionWatchStore:new FileCompletionWatchStore(path.join(dataDir, 'official-feishu-completion-watches.json')),
  completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher(input),
  logger:console
});
const agentFeishuAppStore = new FileAgentFeishuAppStore();
const agentFeishuChannelFleet = new AgentFeishuChannelFleet({
  store:agentFeishuAppStore, bridge:officialFeishuChannel, createChannel:asyncChannelFactory,
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  completionWatchStoreFactory:(agentId) => new FileCompletionWatchStore(path.join(dataDir, `official-feishu-${agentId}-completion-watches.json`)),
  completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher(input),
  enabled:employeeFeishuChannelsEnabled({ deploymentMode, owner:employeeFeishuOwner }),
  externalAgentIds:hermesNativeEmployeeIds,
  logger:console
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
  hermesNativeAJunEnabled:String(process.env.AJUN_HERMES_NATIVE_FEISHU || '').trim().toLowerCase() === 'true',
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
const paperclipHeartbeat = new PaperclipHeartbeatHandler({ operator, governance });
const lanEnabled = !isLoopbackHost(host);
const lanAccess = { enabled: lanEnabled, key: await loadLanShareKey(path.join(dataDir, 'lan-share-key'), lanEnabled) };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/paperclip/heartbeat') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'Paperclip heartbeat 只能由本机服务调用。' });
      return json(res, 202, await paperclipHeartbeat.handle(await body(req)));
    }
    if (req.url?.startsWith('/api/worker/')) {
      if (deploymentMode !== 'cloud') return json(res, 404, { error:'当前运行台不是云端办公室。' });
      if (!macWorker.enabled()) return json(res, 503, { error:'云端尚未配置 Mac 工作间令牌。' });
      if (!macWorker.authorize(req.headers.authorization)) return json(res, 401, { error:'Mac 工作间身份校验失败。' });
      if (req.method === 'POST' && req.url === '/api/worker/lease') return json(res, 200, await macWorker.lease(await body(req)));
      const workerTaskMatch = req.url.match(/^\/api\/worker\/tasks\/([0-9a-f-]+)\/(heartbeat|complete)$/i);
      if (req.method === 'POST' && workerTaskMatch) {
        const [, taskId, action] = workerTaskMatch;
        return json(res, 200, action === 'heartbeat'
          ? { task:await macWorker.heartbeat(taskId, await body(req)) }
          : { task:await macWorker.complete(taskId, await body(req)) });
      }
      return json(res, 404, { error:'未找到这个 Mac 工作间入口。' });
    }
    if (req.method === 'GET' && req.url === '/api/local-share') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '共享口令只能在本机查看。' });
      return json(res, 200, { enabled: lanEnabled, addresses: lanEnabled ? lanAddresses() : [], accessKey: lanAccess.key });
    }
    if (req.method === 'POST' && req.url === '/api/local-share/rotate') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '共享口令只能在本机轮换。' });
      lanAccess.key = await rotateLanShareKey(path.join(dataDir, 'lan-share-key'), lanEnabled);
      return json(res, 200, { enabled: lanEnabled, addresses: lanEnabled ? lanAddresses() : [], accessKey: lanAccess.key });
    }
    if (req.url?.startsWith('/api/') && !canAccessApi(req, lanAccess)) return json(res, 401, { error: '请输入局域网共享口令。' });
    if (req.method === 'GET' && req.url === '/api/overview') return json(res, 200, await tasks.overview());
    if (req.method === 'GET' && req.url === '/api/employee-feishu-connections') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'员工飞书接线资料只能在老板这台设备上查看。' });
      return json(res, 200, { employees:await employeeFeishuConnections.list() });
    }
    if (req.method === 'GET' && req.url === '/api/access-connections') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'账号连接状态只能在老板这台设备上查看。' });
      return json(res, 200, await accessConnections.list());
    }
    if (req.method === 'GET' && req.url === '/api/access-login/options') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'账号登录只能由老板在本机完成。' });
      return json(res, 200, await accessConnections.loginOptions());
    }
    if (req.method === 'POST' && req.url === '/api/access-login/open') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'账号登录只能由老板在本机打开。' });
      return json(res, 200, { login:await accessConnections.openLogin((await body(req)).provider) });
    }
    if (req.method === 'POST' && req.url === '/api/access-connections') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'账号连接只能由老板在本机创建。' });
      return json(res, 201, { connection:await accessConnections.create(await body(req)) });
    }
    const accessConnectionRevokeMatch = req.url?.match(/^\/api\/access-connections\/([0-9a-f-]{36})\/revoke$/i);
    if (req.method === 'POST' && accessConnectionRevokeMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'账号连接只能由老板在本机撤销。' });
      return json(res, 200, { connection:await accessConnections.revoke(accessConnectionRevokeMatch[1]) });
    }
    const accessConnectionDisableMatch = req.url?.match(/^\/api\/access-connections\/([0-9a-f-]{36})\/disable$/i);
    if (req.method === 'POST' && accessConnectionDisableMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'账号连接只能由老板在本机禁用。' });
      return json(res, 200, { connection:await accessConnections.disable(accessConnectionDisableMatch[1]) });
    }
    const accessConnectionReauthorizeMatch = req.url?.match(/^\/api\/access-connections\/([0-9a-f-]{36})\/reauthorize$/i);
    if (req.method === 'POST' && accessConnectionReauthorizeMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'账号连接只能由老板在本机重新授权。' });
      return json(res, 200, { connection:await accessConnections.reauthorize(accessConnectionReauthorizeMatch[1], await body(req)) });
    }
    const employeeFeishuConnectionMatch = req.url?.match(/^\/api\/employee-feishu-connections\/([a-z][a-z0-9-]{0,63})$/);
    if (req.method === 'POST' && employeeFeishuConnectionMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'员工飞书接线只能由老板在本机完成。' });
      return json(res, 200, { employee:await employeeFeishuConnections.connect(employeeFeishuConnectionMatch[1], await body(req)) });
    }
    const employeeModelSetupMatch = req.url?.match(/^\/api\/employee-model-setup\/([a-z][a-z0-9-]{0,63})$/);
    if (req.method === 'POST' && employeeModelSetupMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'员工模型授权只能由老板在本机打开。' });
      return json(res, 200, { setup:await employeeModelSetup.open(employeeModelSetupMatch[1]) });
    }
    if (req.method === 'POST' && req.url === '/api/capabilities/public-web-fetch') return json(res, 200, { content: await publicWebFetch.acquire(await body(req)) });
    if (req.method === 'GET' && req.url === '/api/agent-proposals') return json(res, 200, { proposals: await store.listProposals(), testInstances: await store.listTestInstances() });
    if (req.method === 'POST' && req.url === '/api/agent-proposals') return json(res, 201, { proposal: await proposals.create(await body(req)) });
    if (req.method === 'POST' && req.url === '/api/feishu/agent-proposals') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '飞书入口只能由本机 Hermes 适配器调用。' });
      const proposal = await proposals.create(await body(req), { source: 'feishu' });
      return json(res, 202, { proposal: proposal.status === 'draft' ? await proposals.submit(proposal.proposalId) : proposal, reply: '已生成岗位草案并提交审核；通过受限测试前不会上线。' });
    }
    if (req.method === 'POST' && req.url === '/api/feishu/commander') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '飞书军团总管入口只能由本机 Hermes 适配器调用。' });
      return json(res, 202, await commander.handle(await body(req)));
    }
    if (req.method === 'POST' && req.url === '/api/feishu/channel/messages') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '飞书官方收发入口只能由本机适配器调用。' });
      return json(res, 202, await officialFeishuChannel.handleMessage(await body(req)));
    }
    if (req.method === 'POST' && req.url === '/api/feishu/channel/cards') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '飞书官方卡片回调只能由本机适配器调用。' });
      return json(res, 200, await officialFeishuChannel.handleCardAction(await body(req)));
    }
    if (req.method === 'POST' && req.url === '/api/feishu/task-status') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'飞书任务状态只能由本机 Hermes 适配器读取。' });
      const input = await body(req);
      return json(res, 200, await tasks.notificationStatus(String(input.taskId || ''), String(input.chatRef || '')));
    }
    if (req.method === 'POST' && req.url === '/api/mcp/completion-watches') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'Hermes 任务跟进只能由本机 MCP 登记。' });
      const input = await body(req);
      const taskId = String(input.taskId || '').trim();
      const chatRef = String(input.chatRef || '').trim();
      const task = (await store.list()).find((item) => item.taskId === taskId);
      if (!task) throw new ValidationError('找不到要跟进的任务。');
      if (task.source?.channel !== 'feishu' || String(task.source?.chatRef || '').trim() !== chatRef) {
        throw new ValidationError('只能为任务原飞书会话登记跟进。');
      }
      await hermesNativeCompletionWatcher.watch({ taskId, chatId:chatRef });
      return json(res, 200, { registered:true, taskId });
    }
    if (req.method === 'POST' && req.url === '/api/mcp/paperclip-assignment') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'Paperclip 指派只能由本机 Hermes MCP 读取。' });
      return json(res, 200, await tasks.getPaperclipAssignment({
        ...await body(req),
        paperclipApiKey:bearerToken(req.headers.authorization)
      }));
    }
    if (req.method === 'POST' && req.url === '/api/mcp/paperclip-assignment/complete') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'Paperclip 指派结果只能由本机 Hermes MCP 回报。' });
      return json(res, 200, await tasks.completePaperclipAssignment({
        ...await body(req),
        paperclipApiKey:bearerToken(req.headers.authorization)
      }));
    }
    if (req.method === 'POST' && req.url === '/api/mcp/technical-repair-execute') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'受控技术修复只能由本机技术专家 Hermes MCP 调用。' });
      return json(res, 200, await tasks.executeTechnicalRepairAssignment({
        ...await body(req),
        paperclipApiKey:bearerToken(req.headers.authorization)
      }));
    }
    if (req.method === 'POST' && req.url === '/api/mcp/content-growth-execute') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'内容增长执行只能由本机受限 Hermes MCP 调用。' });
      return json(res, 200, await tasks.executeContentGrowthAssignment({
        ...await body(req),
        paperclipApiKey:bearerToken(req.headers.authorization)
      }));
    }
    const feishuProposalApprovalMatch = req.url?.match(/^\/api\/feishu\/proposal-approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
    if (req.method === 'POST' && feishuProposalApprovalMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'飞书岗位审批回调只能由本机 Hermes 适配器调用。' });
      const [, proposalId, action] = feishuProposalApprovalMatch; const input = await body(req);
      return json(res, 200, await resolveFeishuApproval({ approvalId:proposalId, action, governanceMode:'proposal', chatRef:input.chatRef, requesterRef:input.requesterRef }));
    }
    const proposalAction = req.url?.match(/^\/api\/agent-proposals\/([0-9a-f-]+)\/(submit|approve-for-test|activate|reject|archive|test-instance|test-evidence|acceptance|run-acceptance)$/i);
    if (req.method === 'POST' && proposalAction) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '草案审核与测试操作只能由本机主人发起。' });
      const [, proposalId, action] = proposalAction; const input = await body(req);
      if (action === 'submit') return json(res, 200, { proposal: await proposals.submit(proposalId) });
      if (action === 'approve-for-test') return json(res, 200, { proposal: await proposals.approveForTest(proposalId) });
      if (action === 'activate') return json(res, 200, { proposal: await proposals.activate(proposalId) });
      if (action === 'reject') return json(res, 200, { proposal: await proposals.reject(proposalId) });
      if (action === 'archive') return json(res, 200, { proposal: await proposals.archive(proposalId, { archivedBy:'本机负责人', reason:String(input.reason || '').trim() || undefined }) });
      if (action === 'test-instance') return json(res, 201, { testInstance: await proposals.createTestInstance(proposalId, { hermesProfileName: String(input.hermesProfileName || '').trim() || null }) });
      if (action === 'test-evidence') return json(res, 200, { proposal: await proposals.recordTestEvidence(proposalId, input) });
      if (action === 'run-acceptance') return json(res, 200, { proposal: await proposals.runRestrictedAcceptance(proposalId, input) });
      return json(res, 200, { proposal: await proposals.recordAcceptance(proposalId, input) });
    }
    if (req.method === 'POST' && req.url === '/api/tasks') { const input = await body(req); if (!isLocalAddress(req.socket.remoteAddress) && !String(input.requesterName || '').trim()) throw new ValidationError('局域网协作者请先填写自己的称呼。'); return json(res, 201, { task: await tasks.create(input) }); }
    if (req.method === 'POST' && req.url === '/api/mcp/missions') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'Hermes MCP 多人任务只能由本机调用。' });
      return json(res, 201, await missions.createBusinessMission(await body(req)));
    }
    const rejectMatch = req.url?.match(/^\/api\/approvals\/([0-9a-f-]+)\/reject$/i);
    if (req.method === 'POST' && rejectMatch) { if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'只有本机主人可以拒绝审批。' }); return json(res, 200, { task: await tasks.rejectApproval(rejectMatch[1]) }); }
    const approveMatch = req.url?.match(/^\/api\/approvals\/([0-9a-f-]+)\/approve$/i);
    if (req.method === 'POST' && approveMatch) { if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'只有本机主人可以批准审批。' }); return json(res, 200, { task: await tasks.approveApproval(approveMatch[1], await body(req)) }); }
    const feishuApprovalMatch = req.url?.match(/^\/api\/feishu\/approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
    if (req.method === 'POST' && feishuApprovalMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'飞书审批回调只能由本机 Hermes 适配器调用。' });
      const [, approvalId, action] = feishuApprovalMatch; const input = await body(req);
      return json(res, 200, await resolveFeishuApproval({ approvalId, action, governanceMode:'local', chatRef:input.chatRef, requesterRef:input.requesterRef }));
    }
    const feishuGovernanceApprovalMatch = req.url?.match(/^\/api\/feishu\/governance-approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
    if (req.method === 'POST' && feishuGovernanceApprovalMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'飞书组织级审批回调只能由本机 Hermes 适配器调用。' });
      const [, approvalId, action] = feishuGovernanceApprovalMatch; const input = await body(req);
      return json(res, 200, await resolveFeishuApproval({ approvalId, action, governanceMode:'paperclip', chatRef:input.chatRef, requesterRef:input.requesterRef }));
    }
    const continueMatch = req.url?.match(/^\/api\/tasks\/([0-9a-f-]+)\/continue$/i);
    if (req.method === 'POST' && continueMatch) return json(res, 201, { task: await tasks.continueFromRecommendation(continueMatch[1]) });
    const mcpTaskControlMatch = req.url?.match(/^\/api\/mcp\/tasks\/([0-9a-f-]+)\/(pause|resume)$/i);
    if (req.method === 'POST' && mcpTaskControlMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'Hermes MCP 任务控制只能由本机调用。' });
      const [, taskId, action] = mcpTaskControlMatch;
      return json(res, 200, action === 'pause' ? await tasks.requestPause(taskId) : await tasks.requestResume(taskId));
    }
    const mcpApprovalMatch = req.url?.match(/^\/api\/mcp\/approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
    if (req.method === 'POST' && mcpApprovalMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'Hermes MCP 审批只能由本机调用。' });
      const [, approvalId, decision] = mcpApprovalMatch;
      const approval = (await store.listApprovals()).find((item) => item.approvalId === approvalId);
      if (!approval) throw new ValidationError('找不到这条审批。');
      const options = { decisionBy:'Hermes MCP 人工确认', decisionReason:'由 Hermes 当前会话的原生审批界面确认。' };
      if (approval.governanceMode === 'paperclip') return json(res, 200, { task:await tasks.resolvePaperclipApproval(approvalId, decision, options) });
      return json(res, 200, { task:decision === 'approve' ? await tasks.approveApproval(approvalId, options) : await tasks.rejectApproval(approvalId, options) });
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return file(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/app.js') return file(res, 'app.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/styles.css') return file(res, 'styles.css', 'text/css; charset=utf-8');
    json(res, 404, { error: '未找到该入口。' });
  } catch (error) { json(res, error instanceof ValidationError || error instanceof ProposalValidationError || error instanceof PublicWebFetchError || error instanceof FeishuCommanderValidationError || error instanceof FeishuChannelBridgeError || error instanceof MacWorkerBridgeError || error instanceof EmployeeFeishuConnectionError || error instanceof HermesModelSetupError || error instanceof AccessConnectionError || error?.code === 'worker_lease_mismatch' ? 422 : 500, { error: error.message || '运行台暂时不可用。' }); }
});
server.listen(port, host, () => console.log(`A君运行台：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}${lanEnabled ? '（局域网共享已开启）' : ''}`));
paperclipRosterReconciler.start();
approvalExpiryReconciler.start();
if (deploymentMode !== 'cloud') xiaodReconciler.start();
paperclipRepairReconciler.start();
paperclipHermesTaskReconciler.start();
missionReconciler.start();
void hermesNativeCompletionWatcher.start().catch(() => undefined);
technicalRepairWatchdog.start();
if (feishuChannelStartup.startLegacyAJun) {
  void officialFeishuChannelRunner.start().catch((error) => console.warn(`官方飞书入口没有启用：${String(error?.message || '未知问题')}`));
}
void agentFeishuChannelFleet.start({ skipAgentIds:feishuChannelStartup.skipAgentIds }).catch((error) => console.warn(`员工飞书智能体应用没有启用：${String(error?.message || '未知问题')}`));

async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; }
async function file(res, name, type) { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(await fs.readFile(path.join(publicDir, name))); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
function bearerToken(value) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function asyncChannelFactory(options) {
  const { createLarkChannel } = await import('@larksuite/channel');
  return createLarkChannel(options);
}

async function resolveFeishuApproval({ approvalId, action, governanceMode, chatRef, requesterRef }) {
  const decisionBy = String(requesterRef || 'feishu-approver');
  const safeChatRef = String(chatRef || '');
  if (governanceMode === 'proposal') {
    const proposal = await proposals.get(approvalId);
    if (!proposal.sourceChatRef || proposal.sourceChatRef !== safeChatRef) throw new ProposalValidationError('该草案只能在发起它的飞书会话中决定。');
    return { proposal: action === 'approve' ? await proposals.approveForTest(approvalId, decisionBy) : await proposals.reject(approvalId, decisionBy) };
  }
  const options = { decisionBy, decisionReason: '由飞书审批卡确认。', chatRef:safeChatRef };
  if (governanceMode === 'paperclip') return { task: await tasks.resolvePaperclipApproval(approvalId, action, options) };
  return { task: action === 'approve' ? await tasks.approveApproval(approvalId, options) : await tasks.rejectApproval(approvalId, options) };
}
