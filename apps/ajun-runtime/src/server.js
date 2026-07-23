import http from 'node:http';
import fs from 'node:fs/promises';
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
import { TechnicalRepairEvidenceRelay } from './technical-repair-evidence-relay.js';
import { LocalHealthOperator } from './local-health-operator.js';
import { LocalTaskCoordinator } from './local-task-coordinator.js';
import { CrossAgentMissionService } from './cross-agent-mission-service.js';
import { CrossAgentMissionReconciler } from './cross-agent-mission-reconciler.js';
import { LocalReviewer } from './local-reviewer.js';
import { LocalArchitect } from './local-architect.js';
import { XiaodDelegate } from './xiaod-delegate.js';
import { XiaodReconciler } from './xiaod-reconciler.js';
import { HermesIntentPlanner } from './hermes-intent-planner.js';
import { HermesConversationAdvisor } from './hermes-conversation-advisor.js';
import { HermesTaskAdvisor } from './hermes-task-advisor.js';
import { HermesPublicComparisonAdvisor } from './hermes-public-comparison-advisor.js';
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
import { ProposalAcceptanceRunner } from './proposal-acceptance-runner.js';
import { FeishuCommander, FeishuCommanderValidationError } from './feishu-commander.js';
import { FeishuChannelBridge, FeishuChannelBridgeError } from './feishu-channel-bridge.js';
import { OfficialFeishuChannelRunner } from './official-feishu-channel-runner.js';
import { FileCompletionWatchStore, OfficialFeishuCompletionWatcher } from './official-feishu-completion-watcher.js';
import { FileAgentFeishuAppStore } from './agent-feishu-app-store.js';
import { AgentFeishuChannelFleet, feishuChannelStartupPlan } from './agent-feishu-channel-fleet.js';
import { canAccessApi, isLocalAddress, isLoopbackHost, lanAddresses, loadLanShareKey, rotateLanShareKey } from './lan-access.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicDir = path.join(root, 'apps/ajun-runtime/public');
const store = new TaskStore(path.join(root, 'apps/ajun-runtime/data/runtime.json'));
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
const xiaod = new XiaodDelegate({ onStarted: () => void xiaodReconciler.reconcile() });
const xiaodReconciler = new XiaodReconciler({ store, xiaod, governance });
const paperclipRepairReconciler = new PaperclipRepairReconciler({ store, governance, evidenceRelay:new TechnicalRepairEvidenceRelay({ governance, projectRoot:root, allowedWorkspaceRoots:[process.env.PAPERCLIP_REPAIR_WORKTREE_PARENT || '/Users/pengaro/.paperclip/agent-army-worktrees'] }) });
const operator = new LocalHealthOperator({ governance });
const publicWebTransport = new PublicWebTransport();
const publicWebFetch = new PublicWebFetch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) });
const publicReport = new LocalPublicReport({ publicWebFetch, publicWebSearch:new PublicWebSearch({ fetchImpl: (...args) => publicWebTransport.fetch(...args) }), comparisonAdvisor:publicComparisonAdvisor });
const proposals = new AgentProposalService({ store, registry, governance, restrictedAcceptanceRunner:new ProposalAcceptanceRunner({ publicReport }) });
const port = Number(process.env.PORT || 4321);
const host = process.env.AJUN_HOST || '0.0.0.0';
let failureRecovery;
const tasks = new TaskService({ registry, store, governance, executors: { operator, xiaod, creator: new LocalCreator({ proposals }), 'task-coordinator': new LocalTaskCoordinator({ advisor:taskAdvisor, registry }), reviewer: new LocalReviewer(), architect: new LocalArchitect({ registry, store }), 'technical-expert': new LocalTechnicalExpert({ workspace:repairWorkspace, runner:technicalExpertRunner, promotion:technicalRepairPromotion }) }, fallbackExecutor: publicReport, onTaskFailed: (task) => failureRecovery?.handle(task) });
const approvalExpiryReconciler = new ApprovalExpiryReconciler({ tasks, onResult:(result) => { if (result.status !== 'synced') console.warn('过期确认暂时无法自动整理，将自动重试。'); } });
proposals.taskService = tasks;
const missions = new CrossAgentMissionService({ tasks, store, governance });
const missionReconciler = new CrossAgentMissionReconciler({ store, missions });
failureRecovery = new FailureRecoveryCoordinator({ tasks, store, diagnoser:technicalRepairDiagnoser, projectRoot:root });
xiaodReconciler.onFailure = (task) => failureRecovery.handle(task);
const commander = new FeishuCommander({ tasks, proposals, missions, store, planner: new HermesIntentPlanner(), conversationAdvisor:new HermesConversationAdvisor(), ajunBaseUrl: `http://127.0.0.1:${port}` });
const officialFeishuChannel = new FeishuChannelBridge({ commander, resolveApproval: resolveFeishuApproval });
const officialFeishuChannelRunner = new OfficialFeishuChannelRunner({
  bridge:officialFeishuChannel,
  createChannel: asyncChannelFactory,
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  completionWatchStore:new FileCompletionWatchStore(path.join(root, 'apps/ajun-runtime/data/official-feishu-completion-watches.json')),
  completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher(input),
  logger:console
});
const agentFeishuAppStore = new FileAgentFeishuAppStore();
const agentFeishuChannelFleet = new AgentFeishuChannelFleet({
  store:agentFeishuAppStore, bridge:officialFeishuChannel, createChannel:asyncChannelFactory,
  taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
  completionWatchStoreFactory:(agentId) => new FileCompletionWatchStore(path.join(root, 'apps/ajun-runtime/data', `official-feishu-${agentId}-completion-watches.json`)),
  completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher(input), logger:console
});
const feishuChannelStartup = feishuChannelStartupPlan({
  apps:await agentFeishuAppStore.listApps(),
  legacyAJunEnabled:officialFeishuChannelRunner.enabled()
});
tasks.setFeishuChannelStatus(() => feishuChannelStartup.startLegacyAJun
  ? officialFeishuChannelRunner.snapshot()
  : agentFeishuChannelFleet.snapshot().ajun || { status:'connecting', message:'A君智能体入口正在连接。' });
const paperclipHeartbeat = new PaperclipHeartbeatHandler({ operator, governance });
const lanEnabled = !isLoopbackHost(host);
const lanAccess = { enabled: lanEnabled, key: await loadLanShareKey(path.join(root, 'apps/ajun-runtime/data/lan-share-key'), lanEnabled) };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/paperclip/heartbeat') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'Paperclip heartbeat 只能由本机服务调用。' });
      return json(res, 202, await paperclipHeartbeat.handle(await body(req)));
    }
    if (req.method === 'GET' && req.url === '/api/local-share') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '共享口令只能在本机查看。' });
      return json(res, 200, { enabled: lanEnabled, addresses: lanEnabled ? lanAddresses() : [], accessKey: lanAccess.key });
    }
    if (req.method === 'POST' && req.url === '/api/local-share/rotate') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '共享口令只能在本机轮换。' });
      lanAccess.key = await rotateLanShareKey(path.join(root, 'apps/ajun-runtime/data/lan-share-key'), lanEnabled);
      return json(res, 200, { enabled: lanEnabled, addresses: lanEnabled ? lanAddresses() : [], accessKey: lanAccess.key });
    }
    if (req.url?.startsWith('/api/') && !canAccessApi(req, lanAccess)) return json(res, 401, { error: '请输入局域网共享口令。' });
    if (req.method === 'GET' && req.url === '/api/overview') return json(res, 200, await tasks.overview());
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
    const feishuProposalApprovalMatch = req.url?.match(/^\/api\/feishu\/proposal-approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
    if (req.method === 'POST' && feishuProposalApprovalMatch) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'飞书岗位审批回调只能由本机 Hermes 适配器调用。' });
      const [, proposalId, action] = feishuProposalApprovalMatch; const input = await body(req);
      return json(res, 200, await resolveFeishuApproval({ approvalId:proposalId, action, governanceMode:'proposal', chatRef:input.chatRef, requesterRef:input.requesterRef }));
    }
    const proposalAction = req.url?.match(/^\/api\/agent-proposals\/([0-9a-f-]+)\/(submit|approve-for-test|reject|test-instance|test-evidence|acceptance|run-acceptance)$/i);
    if (req.method === 'POST' && proposalAction) {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '草案审核与测试操作只能由本机主人发起。' });
      const [, proposalId, action] = proposalAction; const input = await body(req);
      if (action === 'submit') return json(res, 200, { proposal: await proposals.submit(proposalId) });
      if (action === 'approve-for-test') return json(res, 200, { proposal: await proposals.approveForTest(proposalId) });
      if (action === 'reject') return json(res, 200, { proposal: await proposals.reject(proposalId) });
      if (action === 'test-instance') return json(res, 201, { testInstance: await proposals.createTestInstance(proposalId, { hermesProfileName: String(input.hermesProfileName || '').trim() || null }) });
      if (action === 'test-evidence') return json(res, 200, { proposal: await proposals.recordTestEvidence(proposalId, input) });
      if (action === 'run-acceptance') return json(res, 200, { proposal: await proposals.runRestrictedAcceptance(proposalId, input) });
      return json(res, 200, { proposal: await proposals.recordAcceptance(proposalId, input) });
    }
    if (req.method === 'POST' && req.url === '/api/tasks') { const input = await body(req); if (!isLocalAddress(req.socket.remoteAddress) && !String(input.requesterName || '').trim()) throw new ValidationError('局域网协作者请先填写自己的称呼。'); return json(res, 201, { task: await tasks.create(input) }); }
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
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return file(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/app.js') return file(res, 'app.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/styles.css') return file(res, 'styles.css', 'text/css; charset=utf-8');
    json(res, 404, { error: '未找到该入口。' });
  } catch (error) { json(res, error instanceof ValidationError || error instanceof ProposalValidationError || error instanceof PublicWebFetchError || error instanceof FeishuCommanderValidationError || error instanceof FeishuChannelBridgeError ? 422 : 500, { error: error.message || '运行台暂时不可用。' }); }
});
server.listen(port, host, () => console.log(`A君运行台：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}${lanEnabled ? '（局域网共享已开启）' : ''}`));
paperclipRosterReconciler.start();
approvalExpiryReconciler.start();
xiaodReconciler.start();
paperclipRepairReconciler.start();
missionReconciler.start();
technicalRepairWatchdog.start();
if (feishuChannelStartup.startLegacyAJun) {
  void officialFeishuChannelRunner.start().catch((error) => console.warn(`官方飞书入口没有启用：${String(error?.message || '未知问题')}`));
}
void agentFeishuChannelFleet.start({ skipAgentIds:feishuChannelStartup.skipAgentIds }).catch((error) => console.warn(`员工飞书智能体应用没有启用：${String(error?.message || '未知问题')}`));

async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; }
async function file(res, name, type) { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(await fs.readFile(path.join(publicDir, name))); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }

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
