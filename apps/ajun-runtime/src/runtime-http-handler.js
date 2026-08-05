import fs from 'node:fs/promises';
import path from 'node:path';

import { ProposalValidationError } from './agent-proposal-service.js';
import { AccessConnectionError } from './access-connection-service.js';
import { ContentCampaignError } from './content-campaign-service.js';
import { EmployeeFeishuConnectionError } from './employee-feishu-connection-service.js';
import { FeishuChannelBridgeError } from './feishu-channel-bridge.js';
import { FeishuCommanderValidationError } from './feishu-commander.js';
import { HermesModelSetupError } from './hermes-model-setup-service.js';
import {
  canAccessApi,
  isLocalAddress,
  lanAddresses,
  rotateLanShareKey,
} from './lan-access.js';
import { MacWorkerBridgeError } from './mac-worker-task-bridge.js';
import { routeM5CampaignApi } from './m5-campaign-api.js';
import { M5PublisherBindingError } from './m5-publisher-bindings.js';
import { routeM5PublisherApi } from './m5-publisher-api.js';
import {
  M5LearningLifecycleError,
  PaperclipLearningLifecycleError,
} from './paperclip-learning-lifecycle.js';
import { PaperclipHeartbeatError } from './paperclip-heartbeat.js';
import { PaperclipMetricMonitorError } from './paperclip-metric-monitor.js';
import { PaperclipPublisherControllerError } from './paperclip-publisher-controller.js';
import { PaperclipPublisherRunContextError } from './paperclip-publisher-run-context.js';
import { PaperclipRetrospectiveError } from './paperclip-retrospective.js';
import { PublicWebFetchError } from './public-web-fetch.js';
import { presentCommanderReply } from './runtime-http-feishu.js';
import { ValidationError } from './task-service.js';
import { dispatchBoomSignal } from '@agent-army/boom-monitor';

export function createAjunHttpHandler({
  environment,
  publicDir,
  dataDir,
  detailBaseUrl,
  network,
  paperclip,
  work,
  connections,
  localAi,
  feishu,
  m5,
}) {
  const {
    deploymentMode,
    lanEnabled,
    lanAccess,
  } = network;
  const {
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
  } = paperclip;
  const {
    tasks,
    store,
    proposals,
    missions,
    macWorker,
    xiaod,
  } = work;
  const {
    employeeFeishuConnections,
    employeeModelSetup,
    accessConnections,
    publicWebFetch,
  } = connections;
  const {
    commander,
    officialFeishuChannel,
    hermesNativeCompletionWatcher,
    resolveFeishuApproval,
  } = feishu;
  const { campaigns } = m5;

  return async function ajunHttpHandler(request, response) {
    try {
      if (request.method === 'POST' && request.url === '/api/paperclip/heartbeat') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'Paperclip heartbeat 只能由本机服务调用。' });
        return sendJson(response, 202, await paperclipHeartbeat.handle(await readJsonBody(request)));
      }
      if (request.method === 'POST' && request.url === '/api/paperclip/m5-daily-heartbeat') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'M5 每日 heartbeat 只能由本机 Paperclip 调用。' });
        return sendJson(response, 202, await paperclipCampaignDaily.handle(await readJsonBody(request)));
      }
      if (request.method === 'POST' && request.url === '/api/paperclip/m5-parallel-heartbeat') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'M5 并行 heartbeat 只能由本机 Paperclip 调用。' });
        return sendJson(response, 202, await paperclipParallelWork.handle(await readJsonBody(request)));
      }
      if (request.method === 'POST' && request.url === '/api/paperclip/m5-metrics-heartbeat') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'M5 指标 heartbeat 只能由本机 Paperclip 调用。' });
        const heartbeat = await readJsonBody(request);
        const runJwt = bearerToken(request.headers.authorization);
        const canonical = await paperclipMetricRunContext.resolve({ heartbeat, bearerToken:runJwt });
        const approvalId = String(heartbeat?.context?.approvalId || '').trim();
        return sendJson(response, 202, await paperclipCurrentRunScope.run({
          apiKey:runJwt,
          runId:canonical.runId,
          issueId:canonical.issueId,
          agentId:canonical.agentId,
          companyId:canonical.companyId,
          ...(approvalId ? { approvalId } : {}),
        }, () => paperclipMetricMonitor.handle(canonicalPaperclipHeartbeat(heartbeat, canonical))));
      }
      if (request.method === 'POST' && request.url === '/api/paperclip/m5-publisher-heartbeat') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'M5 发布 heartbeat 只能由本机 Paperclip 调用。' });
        const heartbeat = await readJsonBody(request);
        const runJwt = bearerToken(request.headers.authorization);
        const canonical = await paperclipPublisherRunContext.resolve({ heartbeat, bearerToken:runJwt });
        return sendJson(response, 202, await paperclipCurrentRunScope.run({
          apiKey:runJwt,
          runId:canonical.runId,
          issueId:canonical.issueId,
          agentId:canonical.agentId,
          companyId:canonical.companyId,
        }, () => paperclipPublisherController.handle(canonicalPaperclipHeartbeat(heartbeat, canonical))));
      }
      if (request.method === 'POST' && request.url === '/api/paperclip/m5-retrospective-heartbeat') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'M5 复盘 heartbeat 只能由本机 Paperclip 调用。' });
        return sendJson(response, 202, await paperclipRetrospective.handle(await readJsonBody(request)));
      }
      if (request.method === 'POST' && request.url === '/api/paperclip/m5-learning-heartbeat') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'M5 学习 heartbeat 只能由本机 Paperclip 调用。' });
        return sendJson(response, 202, await paperclipLearningLifecycle.handle(await readJsonBody(request)));
      }

      if (request.url?.startsWith('/api/worker/')) {
        if (deploymentMode !== 'cloud') return sendJson(response, 404, { error:'当前运行台不是云端办公室。' });
        if (!macWorker.enabled()) return sendJson(response, 503, { error:'云端尚未配置 Mac 工作间令牌。' });
        if (!macWorker.authorize(request.headers.authorization)) return sendJson(response, 401, { error:'Mac 工作间身份校验失败。' });
        if (request.method === 'POST' && request.url === '/api/worker/lease') return sendJson(response, 200, await macWorker.lease(await readJsonBody(request)));
        const workerTaskMatch = request.url.match(/^\/api\/worker\/tasks\/([0-9a-f-]+)\/(heartbeat|complete)$/i);
        if (request.method === 'POST' && workerTaskMatch) {
          const [, taskId, action] = workerTaskMatch;
          return sendJson(response, 200, action === 'heartbeat'
            ? { task:await macWorker.heartbeat(taskId, await readJsonBody(request)) }
            : { task:await macWorker.complete(taskId, await readJsonBody(request)) });
        }
        return sendJson(response, 404, { error:'未找到这个 Mac 工作间入口。' });
      }

      if (request.method === 'GET' && request.url === '/api/local-share') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'共享口令只能在本机查看。' });
        return sendJson(response, 200, { enabled:lanEnabled, addresses:lanEnabled ? lanAddresses() : [], accessKey:lanAccess.key });
      }
      if (request.method === 'POST' && request.url === '/api/local-share/rotate') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'共享口令只能在本机轮换。' });
        lanAccess.key = await rotateLanShareKey(path.join(dataDir, 'lan-share-key'), lanEnabled);
        return sendJson(response, 200, { enabled:lanEnabled, addresses:lanEnabled ? lanAddresses() : [], accessKey:lanAccess.key });
      }
      if (request.url?.startsWith('/api/') && !canAccessApi(request, lanAccess)) return sendJson(response, 401, { error:'请输入局域网共享口令。' });
      if (request.method === 'GET' && request.url === '/api/overview') return sendJson(response, 200, await tasks.overview());
      if (request.method === 'GET' && request.url === '/api/local-ai/control') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'AI 能力控制只能由老板在本机查看。' });
        if (!localAi) return sendJson(response, 503, { error:'本机 AI 控制入口尚未接入。' });
        return sendJson(response, 200, await localAi.controlOverview());
      }
      const localAiActionMatch = request.url?.match(/^\/api\/local-ai\/services\/([a-z0-9-]+)\/(start|stop|restart|reconnect)$/);
      if (request.method === 'POST' && localAiActionMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'AI 服务只能由老板在本机控制。' });
        if (!localAi) return sendJson(response, 503, { error:'本机 AI 控制入口尚未接入。' });
        return sendJson(response, 200, await localAi.controlService(localAiActionMatch[1], localAiActionMatch[2]));
      }
      const localAiPolicyMatch = request.url?.match(/^\/api\/local-ai\/services\/([a-z0-9-]+)\/policy$/);
      if (request.method === 'PUT' && localAiPolicyMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'AI 服务策略只能由老板在本机修改。' });
        if (!localAi) return sendJson(response, 503, { error:'本机 AI 控制入口尚未接入。' });
        return sendJson(response, 200, await localAi.updateServicePolicy(localAiPolicyMatch[1], await readJsonBody(request)));
      }
      const taskDetailMatch = request.url?.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
      if (request.method === 'GET' && taskDetailMatch) {
        const task = (await tasks.overview()).tasks.find((item) => item.taskId === taskDetailMatch[1]);
        if (!task) return sendJson(response, 404, { error:'没有找到这条任务。' });
        return sendJson(response, 200, { task });
      }

      if (request.method === 'GET' && request.url === '/api/employee-feishu-connections') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'员工飞书接线资料只能在老板这台设备上查看。' });
        return sendJson(response, 200, { employees:await employeeFeishuConnections.list() });
      }
      if (request.method === 'GET' && request.url === '/api/access-connections') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'账号连接状态只能在老板这台设备上查看。' });
        return sendJson(response, 200, await accessConnections.overview());
      }
      if (request.method === 'GET' && request.url === '/api/access-login/options') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'账号登录只能由老板在本机完成。' });
        return sendJson(response, 200, await accessConnections.loginOptions());
      }
      if (request.method === 'POST' && request.url === '/api/access-login/open') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'账号登录只能由老板在本机打开。' });
        return sendJson(response, 200, { login:await accessConnections.openLogin((await readJsonBody(request)).provider) });
      }
      if (request.method === 'POST' && request.url === '/api/access-connections') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'账号连接只能由老板在本机创建。' });
        return sendJson(response, 201, { connection:await accessConnections.create(await readJsonBody(request)) });
      }
      const accessConnectionRevokeMatch = request.url?.match(/^\/api\/access-connections\/([0-9a-f-]{36})\/revoke$/i);
      if (request.method === 'POST' && accessConnectionRevokeMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'账号连接只能由老板在本机撤销。' });
        return sendJson(response, 200, { connection:await accessConnections.revoke(accessConnectionRevokeMatch[1]) });
      }
      const accessConnectionDisableMatch = request.url?.match(/^\/api\/access-connections\/([0-9a-f-]{36})\/disable$/i);
      if (request.method === 'POST' && accessConnectionDisableMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'账号连接只能由老板在本机禁用。' });
        return sendJson(response, 200, { connection:await accessConnections.disable(accessConnectionDisableMatch[1]) });
      }
      const accessConnectionDefaultMatch = request.url?.match(/^\/api\/access-connections\/([0-9a-f-]{36})\/default$/i);
      if (request.method === 'POST' && accessConnectionDefaultMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'默认账号只能由老板在本机设置。' });
        return sendJson(response, 200, { connection:await accessConnections.setDefault(accessConnectionDefaultMatch[1]) });
      }
      const accessConnectionReauthorizeMatch = request.url?.match(/^\/api\/access-connections\/([0-9a-f-]{36})\/reauthorize$/i);
      if (request.method === 'POST' && accessConnectionReauthorizeMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'账号连接只能由老板在本机重新授权。' });
        return sendJson(response, 200, { connection:await accessConnections.reauthorize(accessConnectionReauthorizeMatch[1], await readJsonBody(request)) });
      }
      const employeeFeishuConnectionMatch = request.url?.match(/^\/api\/employee-feishu-connections\/([a-z][a-z0-9-]{0,63})$/);
      if (request.method === 'POST' && employeeFeishuConnectionMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'员工飞书接线只能由老板在本机完成。' });
        return sendJson(response, 200, { employee:await employeeFeishuConnections.connect(employeeFeishuConnectionMatch[1], await readJsonBody(request)) });
      }
      const employeeModelSetupMatch = request.url?.match(/^\/api\/employee-model-setup\/([a-z][a-z0-9-]{0,63})$/);
      if (request.method === 'POST' && employeeModelSetupMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'员工模型授权只能由老板在本机打开。' });
        return sendJson(response, 200, { setup:await employeeModelSetup.open(employeeModelSetupMatch[1]) });
      }

      if (request.method === 'POST' && request.url === '/api/capabilities/public-web-fetch') return sendJson(response, 200, { content:await publicWebFetch.acquire(await readJsonBody(request)) });
      if (request.method === 'GET' && request.url === '/api/agent-proposals') return sendJson(response, 200, { proposals:await store.listProposals(), testInstances:await store.listTestInstances() });
      if (request.method === 'POST' && request.url === '/api/agent-proposals') return sendJson(response, 201, { proposal:await proposals.create(await readJsonBody(request)) });
      if (request.method === 'POST' && request.url === '/api/feishu/agent-proposals') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书入口只能由本机 Hermes 适配器调用。' });
        const proposal = await proposals.create(await readJsonBody(request), { source:'feishu' });
        return sendJson(response, 202, { proposal:proposal.status === 'draft' ? await proposals.submit(proposal.proposalId) : proposal, reply:'已生成岗位草案并提交审核；通过受限测试前不会上线。' });
      }
      if (request.method === 'POST' && request.url === '/api/feishu/commander') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书军团总管入口只能由本机 Hermes 适配器调用。' });
        return sendJson(response, 202, presentCommanderReply(await commander.handle(await readJsonBody(request)), detailBaseUrl));
      }
      if (request.method === 'POST' && request.url === '/api/feishu/channel/messages') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书官方收发入口只能由本机适配器调用。' });
        return sendJson(response, 202, await officialFeishuChannel.handleMessage(await readJsonBody(request)));
      }
      if (request.method === 'POST' && request.url === '/api/feishu/channel/cards') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书官方卡片回调只能由本机适配器调用。' });
        return sendJson(response, 200, await officialFeishuChannel.handleCardAction(await readJsonBody(request)));
      }
      if (request.method === 'POST' && request.url === '/api/feishu/task-status') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书任务状态只能由本机 Hermes 适配器读取。' });
        const input = await readJsonBody(request);
        return sendJson(response, 200, await tasks.notificationStatus(String(input.taskId || ''), String(input.chatRef || '')));
      }
      if (request.method === 'POST' && request.url === '/api/mcp/completion-watches') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'Hermes 任务跟进只能由本机 MCP 登记。' });
        const input = await readJsonBody(request);
        const taskId = String(input.taskId || '').trim();
        const chatRef = String(input.chatRef || '').trim();
        const task = (await store.list()).find((item) => item.taskId === taskId);
        if (!task) throw new ValidationError('找不到要跟进的任务。');
        if (task.source?.channel !== 'feishu' || String(task.source?.chatRef || '').trim() !== chatRef) throw new ValidationError('只能为任务原飞书会话登记跟进。');
        await hermesNativeCompletionWatcher.watch({ taskId, chatId:chatRef });
        return sendJson(response, 200, { registered:true, taskId });
      }

      const assignmentRoutes = new Map([
        ['/api/mcp/paperclip-assignment', ['getPaperclipAssignment', 'Paperclip 指派只能由本机 Hermes MCP 读取。']],
        ['/api/mcp/paperclip-assignment/complete', ['completePaperclipAssignment', 'Paperclip 指派结果只能由本机 Hermes MCP 回报。']],
        ['/api/mcp/agent-proposal-execute', ['executeAgentProposalAssignment', '岗位草案只能由本机创建官 Hermes MCP 创建。']],
        ['/api/mcp/technical-repair-execute', ['executeTechnicalRepairAssignment', '受控技术修复只能由本机技术专家 Hermes MCP 调用。']],
        ['/api/mcp/operations-health-execute', ['executeOperationsHealthAssignment', '确定性健康检查只能由本机运维官 Hermes MCP 调用。']],
        ['/api/mcp/employee-assignment-execute', ['executeEmployeeAssignment', '员工指派执行只能由本机受限 Hermes MCP 调用。']],
        ['/api/mcp/content-growth-execute', ['executeContentGrowthAssignment', '内容增长执行只能由本机受限 Hermes MCP 调用。']],
      ]);
      if (request.method === 'POST' && assignmentRoutes.has(request.url)) {
        const [method, forbiddenMessage] = assignmentRoutes.get(request.url);
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:forbiddenMessage });
        return sendJson(response, 200, await tasks[method]({
          ...await readJsonBody(request),
          paperclipApiKey:bearerToken(request.headers.authorization),
        }));
      }

      const m5CampaignResult = await routeM5CampaignApi({
        method:request.method,
        url:request.url,
        local:isLocalAddress(request.socket.remoteAddress),
        readBody:() => readJsonBody(request),
        getService:campaigns,
        tasks,
        paperclipApiKey:bearerToken(request.headers.authorization),
      });
      if (m5CampaignResult) return sendJson(response, m5CampaignResult.status, m5CampaignResult.payload);
      const m5PublisherResult = await routeM5PublisherApi({
        method:request.method,
        url:request.url,
        local:isLocalAddress(request.socket.remoteAddress),
        getService:campaigns,
        readBody:() => readJsonBody(request),
        paperclipApiKey:bearerToken(request.headers.authorization),
      });
      if (m5PublisherResult) return sendJson(response, m5PublisherResult.status, m5PublisherResult.payload);

      const feishuProposalApprovalMatch = request.url?.match(/^\/api\/feishu\/proposal-approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
      if (request.method === 'POST' && feishuProposalApprovalMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书岗位审批回调只能由本机 Hermes 适配器调用。' });
        const [, proposalId, action] = feishuProposalApprovalMatch;
        const input = await readJsonBody(request);
        return sendJson(response, 200, await resolveFeishuApproval({ approvalId:proposalId, action, governanceMode:'proposal', chatRef:input.chatRef, requesterRef:input.requesterRef }));
      }
      const proposalAction = request.url?.match(/^\/api\/agent-proposals\/([0-9a-f-]+)\/(submit|approve-for-test|activate|reject|archive|test-instance|test-evidence|acceptance|run-acceptance)$/i);
      if (request.method === 'POST' && proposalAction) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'草案审核与测试操作只能由本机主人发起。' });
        const [, proposalId, action] = proposalAction;
        const input = await readJsonBody(request);
        if (action === 'submit') return sendJson(response, 200, { proposal:await proposals.submit(proposalId) });
        if (action === 'approve-for-test') return sendJson(response, 200, { proposal:await proposals.approveForTest(proposalId) });
        if (action === 'activate') return sendJson(response, 200, { proposal:await proposals.activate(proposalId) });
        if (action === 'reject') return sendJson(response, 200, { proposal:await proposals.reject(proposalId) });
        if (action === 'archive') return sendJson(response, 200, { proposal:await proposals.archive(proposalId, { archivedBy:'本机负责人', reason:String(input.reason || '').trim() || undefined }) });
        if (action === 'test-instance') return sendJson(response, 201, { testInstance:await proposals.createTestInstance(proposalId, { hermesProfileName:String(input.hermesProfileName || '').trim() || null }) });
        if (action === 'test-evidence') return sendJson(response, 200, { proposal:await proposals.recordTestEvidence(proposalId, input) });
        if (action === 'run-acceptance') return sendJson(response, 200, { proposal:await proposals.runRestrictedAcceptance(proposalId, input) });
        return sendJson(response, 200, { proposal:await proposals.recordAcceptance(proposalId, input) });
      }
      if (request.method === 'POST' && request.url === '/api/tasks') {
        const input = await readJsonBody(request);
        if (!isLocalAddress(request.socket.remoteAddress) && !String(input.requesterName || '').trim()) throw new ValidationError('局域网协作者请先填写自己的称呼。');
        return sendJson(response, 201, { task:await tasks.create(input) });
      }
      if (request.method === 'POST' && request.url === '/api/integrations/boom-monitor/dispatch') {
        const local = isLocalAddress(request.socket.remoteAddress);
        const expectedToken = String(environment.BOOM_MONITOR_BEARER_TOKEN || '').trim();
        const providedToken = bearerToken(request.headers.authorization);
        if (!local && (!expectedToken || providedToken !== expectedToken)) return sendJson(response, 403, { error:'爆款雷达派发需要本机访问或有效 Bearer Token。' });
        return sendJson(response, 201, await dispatchBoomSignal(await readJsonBody(request), { missions }));
      }
      if (request.method === 'POST' && request.url === '/api/integrations/boom-monitor/metrics') {
        const local = isLocalAddress(request.socket.remoteAddress);
        const expectedToken = String(environment.BOOM_MONITOR_BEARER_TOKEN || '').trim();
        const providedToken = bearerToken(request.headers.authorization);
        if (!local && (!expectedToken || providedToken !== expectedToken)) return sendJson(response, 403, { error:'爆款雷达指标读取需要本机访问或有效 Bearer Token。' });
        try {
          return sendJson(response, 200, { metrics:await xiaod.collectMetrics(await readJsonBody(request)) });
        } catch (error) {
          return sendJson(response, Number(error?.status) || 502, {
            error:String(error?.message || '小D指标读取失败。').slice(0, 300),
            code:error?.code || 'metrics_unavailable',
            recommendedAction:error?.recommendedAction || 'retry'
          });
        }
      }
      if (request.method === 'POST' && request.url === '/api/mcp/missions') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'Hermes MCP 多人任务只能由本机调用。' });
        return sendJson(response, 201, await missions.createBusinessMission(await readJsonBody(request)));
      }
      const rejectMatch = request.url?.match(/^\/api\/approvals\/([0-9a-f-]+)\/reject$/i);
      if (request.method === 'POST' && rejectMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'只有本机主人可以拒绝审批。' });
        return sendJson(response, 200, { task:await tasks.rejectApproval(rejectMatch[1]) });
      }
      const approveMatch = request.url?.match(/^\/api\/approvals\/([0-9a-f-]+)\/approve$/i);
      if (request.method === 'POST' && approveMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'只有本机主人可以批准审批。' });
        return sendJson(response, 200, { task:await tasks.approveApproval(approveMatch[1], await readJsonBody(request)) });
      }
      const privateGrantRevokeMatch = request.url?.match(/^\/api\/approvals\/([0-9a-f-]+)\/revoke-private-read-grant$/i);
      if (request.method === 'POST' && privateGrantRevokeMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'只有本机主人可以撤销微信临时授权。' });
        return sendJson(response, 200, { approval:await tasks.revokePrivateReadGrant(privateGrantRevokeMatch[1], await readJsonBody(request)) });
      }
      const feishuPrivateGrantRevokeMatch = request.url?.match(/^\/api\/feishu\/approvals\/([0-9a-f-]+)\/revoke-private-read-grant$/i);
      if (request.method === 'POST' && feishuPrivateGrantRevokeMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书微信授权回调只能由本机 Hermes 适配器调用。' });
        const input = await readJsonBody(request);
        return sendJson(response, 200, { approval:await tasks.revokePrivateReadGrant(feishuPrivateGrantRevokeMatch[1], {
          revokedBy:input.requesterRef || 'A君',
          chatRef:input.chatRef,
        }) });
      }
      const feishuApprovalMatch = request.url?.match(/^\/api\/feishu\/approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
      if (request.method === 'POST' && feishuApprovalMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书审批回调只能由本机 Hermes 适配器调用。' });
        const [, approvalId, action] = feishuApprovalMatch;
        const input = await readJsonBody(request);
        return sendJson(response, 200, await resolveFeishuApproval({ approvalId, action, governanceMode:'local', chatRef:input.chatRef, requesterRef:input.requesterRef }));
      }
      const feishuGovernanceApprovalMatch = request.url?.match(/^\/api\/feishu\/governance-approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
      if (request.method === 'POST' && feishuGovernanceApprovalMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书组织级审批回调只能由本机 Hermes 适配器调用。' });
        const [, approvalId, action] = feishuGovernanceApprovalMatch;
        const input = await readJsonBody(request);
        return sendJson(response, 200, await resolveFeishuApproval({ approvalId, action, governanceMode:'paperclip', chatRef:input.chatRef, requesterRef:input.requesterRef }));
      }
      const continueMatch = request.url?.match(/^\/api\/tasks\/([0-9a-f-]+)\/continue$/i);
      if (request.method === 'POST' && continueMatch) return sendJson(response, 201, { task:await tasks.continueFromRecommendation(continueMatch[1]) });
      const mcpTaskControlMatch = request.url?.match(/^\/api\/mcp\/tasks\/([0-9a-f-]+)\/(pause|resume)$/i);
      if (request.method === 'POST' && mcpTaskControlMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'Hermes MCP 任务控制只能由本机调用。' });
        const [, taskId, action] = mcpTaskControlMatch;
        return sendJson(response, 200, action === 'pause' ? await tasks.requestPause(taskId) : await tasks.requestResume(taskId));
      }
      const mcpApprovalMatch = request.url?.match(/^\/api\/mcp\/approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
      if (request.method === 'POST' && mcpApprovalMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'Hermes MCP 审批只能由本机调用。' });
        const [, approvalId, decision] = mcpApprovalMatch;
        const approval = (await store.listApprovals()).find((item) => item.approvalId === approvalId);
        if (!approval) throw new ValidationError('找不到这条审批。');
        const options = { decisionBy:'Hermes MCP 人工确认', decisionReason:'由 Hermes 当前会话的原生审批界面确认。' };
        if (approval.governanceMode === 'paperclip') return sendJson(response, 200, { task:await tasks.resolvePaperclipApproval(approvalId, decision, options) });
        return sendJson(response, 200, { task:decision === 'approve' ? await tasks.approveApproval(approvalId, options) : await tasks.rejectApproval(approvalId, options) });
      }

      if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html' || /^\/tasks\/[0-9a-f-]{36}$/i.test(request.url || ''))) return sendFile(response, publicDir, 'index.html', 'text/html; charset=utf-8');
      if (request.method === 'GET' && request.url === '/app.js') return sendFile(response, publicDir, 'app.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && request.url === '/disclosure-state.js') return sendFile(response, publicDir, 'disclosure-state.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && request.url === '/styles.css') return sendFile(response, publicDir, 'styles.css', 'text/css; charset=utf-8');
      return sendJson(response, 404, { error:'未找到该入口。' });
    } catch (error) {
      return sendJson(response, errorStatus(error), { error:error.message || '运行台暂时不可用。' });
    }
  };
}

async function readJsonBody(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function sendFile(response, publicDir, name, type) {
  response.writeHead(200, { 'content-type':type, 'cache-control':'no-store' });
  response.end(await fs.readFile(path.join(publicDir, name)));
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
  response.end(JSON.stringify(data));
}

function bearerToken(value) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function errorStatus(error) {
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599) return error.httpStatus;
  return error instanceof ValidationError
    || error instanceof ProposalValidationError
    || error instanceof PublicWebFetchError
    || error instanceof FeishuCommanderValidationError
    || error instanceof FeishuChannelBridgeError
    || error instanceof MacWorkerBridgeError
    || error instanceof EmployeeFeishuConnectionError
    || error instanceof HermesModelSetupError
    || error instanceof AccessConnectionError
    || error instanceof ContentCampaignError
    || error instanceof M5PublisherBindingError
    || error instanceof PaperclipHeartbeatError
    || error instanceof PaperclipMetricMonitorError
    || error instanceof PaperclipPublisherControllerError
    || error instanceof PaperclipPublisherRunContextError
    || error instanceof PaperclipRetrospectiveError
    || error instanceof PaperclipLearningLifecycleError
    || error instanceof M5LearningLifecycleError
    || error?.isPublisherError === true
    || error?.isM5ToolExecutionError === true
    || error?.code === 'worker_lease_mismatch'
    ? 422
    : 500;
}
