import crypto from 'node:crypto';
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
} from './lan-access.ts';
import { MacWorkerBridgeError } from './mac-worker-task-bridge.js';
import { routeM5CampaignApi } from './m5-campaign-api.js';
import { M5PublisherBindingError } from './m5-publisher-bindings.js';
import { routeM5PublisherApi } from './m5-publisher-api.js';
import { PublicWebFetchError } from './public-web-fetch.js';
import { OfficialFeishuCompletionWatcherError } from './official-feishu-completion-watcher.js';
import { assertTaskCardOwnership, presentCommanderReply, presentTaskStatus, resolveTaskCardAction } from './runtime-http-feishu.ts';
import {
  createMissionHttpResult,
  createTaskHttpResult,
} from './contracts/agent-army-adapter-projection.ts';
import { ValidationError } from './task-service.js';
import { AgentArmyTaskInputError } from './contracts/agent-army-task-input.js';
import {
  normalizeMissionHttpInput,
  normalizeTaskHttpInput,
} from './contracts/agent-army-http-input.ts';
import { dispatchBoomSignal } from '@agent-army/boom-monitor';
import { routeBoomMonitorApi } from './boom-monitor/index.js';
import { isPaperclipHttpError, routePaperclipHttp } from './runtime-http-paperclip.ts';
import { routeProductMaturityApi } from './runtime-http-product-maturity.ts';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const OWNER_ACTION_NONCE_TTL_MS = 10 * 60 * 1000;

export function createAjunHttpHandler({
  environment,
  publicDir,
  dataDir,
  detailBaseUrl,
  development = {},
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
    tasks,
    store,
    proposals,
    missions,
    macWorker,
    xiaod,
    boomMonitor,
    boomMonitorEnabled,
    taskTimeline,
    productMaturity,
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
  const ownerActionSession = createOwnerActionSession();

  return async function ajunHttpHandler(request, response) {
    try {
      if (request.method === 'GET' && request.url === '/api/dev/hot-reload') {
        if (!development.hotReload?.enabled) return sendJson(response, 404, { error:'开发热更新未启用。' });
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'开发热更新只能在本机使用。' });
        return sendJson(response, 200, {
          enabled:true,
          revision:development.hotReload.revision,
        });
      }
      const paperclipResult = await routePaperclipHttp({
        request,
        paperclip,
        local:isLocalAddress(request.socket.remoteAddress),
        readBody:() => readJsonBody(request),
      });
      if (paperclipResult) return sendJson(response, paperclipResult.status, paperclipResult.payload);

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
      if (request.method === 'GET' && request.url === '/api/owner-action-session') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'本机动作会话只能由老板在这台设备上获取。' });
        return sendJson(response, 200, ownerActionSession.issue());
      }
      const productMaturityResult = await routeProductMaturityApi({
        request, service:productMaturity, local:isLocalAddress(request.socket.remoteAddress),
        sameOrigin:hasSameOrigin(request),
        authorize:ownerActionSession.authorize(request.headers['x-ajun-owner-action']),
        readBody:() => readJsonBody(request),
      });
      if (productMaturityResult) return sendJson(response, productMaturityResult.status, productMaturityResult.payload);
      const recoveryRequestMatch = request.url?.match(/^\/api\/tasks\/([0-9a-f-]+)\/recovery-actions\/(use_confirmed_transcript_only|request_safe_recovery|request_read_only_diagnosis|retry_visual_analysis_after_recovery)$/i);
      if (request.method === 'POST' && recoveryRequestMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'任务恢复只能由老板在本机发起。' });
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          return sendJson(response, 415, { error:'任务恢复请求必须使用 application/json。' });
        }
        if (!hasSameOrigin(request)) return sendJson(response, 403, { error:'任务恢复请求必须来自当前 A君 控制台。' });
        if (!ownerActionSession.authorize(request.headers['x-ajun-owner-action'])) {
          return sendJson(response, 403, { error:'本机动作会话无效或已过期，请刷新任务详情后重试。' });
        }
        const input = await readJsonBody(request);
        const requestId = String(request.headers['idempotency-key'] || '').trim();
        const result = await tasks.requestRecovery(recoveryRequestMatch[1], {
          actionKey:recoveryRequestMatch[2],
          expectedUpdatedAt:input.expectedUpdatedAt,
          requestId,
        }, { kind:'local-owner', ref:'A君' });
        return sendJson(response, result.status === 'accepted' ? 202 : 200, result);
      }
      if (request.url?.startsWith('/api/')
        && !isBoomLegacyIntegrationPath(request.url)
        && !canAccessApi(request, lanAccess)) return sendJson(response, 401, { error:'请输入局域网共享口令。' });
      const boomMonitorResult = await routeBoomMonitorApi({
        method:request.method,
        url:request.url,
        local:isLocalAddress(request.socket.remoteAddress),
        enabled:boomMonitorEnabled,
        readBody:() => readJsonBody(request),
        getService:() => boomMonitor,
      });
      if (boomMonitorResult) return sendJson(response, boomMonitorResult.status, boomMonitorResult.payload);
      if (request.method === 'GET' && request.url === '/api/overview') return sendJson(response, 200, await tasks.overview());
      if (request.method === 'GET' && request.url === '/api/console-overview') return sendJson(response, 200, await tasks.consoleOverview());
      const taskRecordUrl = request.method === 'GET' && request.url?.startsWith('/api/task-records')
        ? new URL(request.url, 'http://127.0.0.1')
        : null;
      if (taskRecordUrl?.pathname === '/api/task-records') {
        const audience = isLocalAddress(request.socket.remoteAddress) ? 'local-owner' : 'lan';
        return sendJson(response, 200, await tasks.listTaskRecords(Object.fromEntries(taskRecordUrl.searchParams.entries()), { audience }));
      }
      const taskTimelineUrl = request.method === 'GET' && request.url?.startsWith('/api/tasks/')
        ? new URL(request.url, 'http://127.0.0.1')
        : null;
      const taskTimelineMatch = taskTimelineUrl?.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/timeline$/i);
      if (taskTimelineMatch) {
        const task = await store.getTask(taskTimelineMatch[1]);
        if (!task) return sendJson(response, 404, { error:'没有找到这条任务。' });
        const audience = isLocalAddress(request.socket.remoteAddress) ? 'local-owner' : 'lan';
        return sendJson(response, 200, await taskTimeline.read(task.taskId, {
          audience,
          cursor:taskTimelineUrl.searchParams.get('cursor'),
          limit:taskTimelineUrl.searchParams.get('limit'),
          filters:taskTimelineUrl.searchParams.getAll('filter'),
        }));
      }
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
        const audience = isLocalAddress(request.socket.remoteAddress) ? 'local-owner' : 'lan';
        const task = await tasks.taskRecordDetail(taskDetailMatch[1], { audience });
        if (!task) return sendJson(response, 404, { error:'没有找到这条任务。' });
        return sendJson(response, 200, { task });
      }
      const transcriptRevisionMatch = request.url?.match(/^\/api\/tasks\/([0-9a-f-]{36})\/transcript-revision$/i);
      if (request.method === 'GET' && transcriptRevisionMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'任务字幕只能由老板在本机查看。' });
        if (!hasSameOrigin(request)) return sendJson(response, 403, { error:'字幕读取请求必须来自当前 A君 控制台。' });
        if (!ownerActionSession.authorize(request.headers['x-ajun-owner-action'])) {
          return sendJson(response, 403, { error:'本机动作会话无效或已过期，请刷新任务详情后重试。' });
        }
        return sendJson(response, 200, { revision:await tasks.getTranscriptRevision(transcriptRevisionMatch[1]) });
      }
      const transcriptRevisionsMatch = request.url?.match(/^\/api\/tasks\/([0-9a-f-]{36})\/transcript-revisions$/i);
      if (request.method === 'POST' && transcriptRevisionsMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'任务字幕只能由老板在本机补正。' });
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          return sendJson(response, 415, { error:'字幕补正请求必须使用 application/json。' });
        }
        if (!hasSameOrigin(request)) return sendJson(response, 403, { error:'字幕补正请求必须来自当前 A君 控制台。' });
        if (!ownerActionSession.authorize(request.headers['x-ajun-owner-action'])) {
          return sendJson(response, 403, { error:'本机动作会话无效或已过期，请刷新任务详情后重试。' });
        }
        return sendJson(response, 200, await tasks.reviseTranscript(transcriptRevisionsMatch[1], await readJsonBody(request)));
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
        const result = await commander.handle(await readJsonBody(request));
        const task = result?.task || result?.mission || null;
        const taskCardContext = task?.taskId
          ? await loadTaskCardContext({ store, tasks }, task)
          : {};
        return sendJson(response, 202, presentCommanderReply(result, detailBaseUrl, taskCardContext));
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
        const taskId = String(input.taskId || '').trim();
        const task = (await store.list()).find((item) => item.taskId === taskId);
        const cardIdentity = assertTaskCardOwnership(task, input);
        const chatRef = String(input.chatId || input.chatRef || '').trim();
        const notification = await tasks.notificationStatus(taskId, chatRef);
        return sendJson(response, 200, presentTaskStatus(
          notification,
          task,
          { ...(await loadTaskCardContext({ store, tasks }, task)), ...cardIdentity },
        ));
      }
      if (request.method === 'POST' && request.url === '/api/feishu/task-card-actions') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书任务卡动作只能由本机 Hermes 适配器调用。' });
        return sendJson(response, 200, await resolveTaskCardAction(await readJsonBody(request), {
          store,
          tasks,
          resolveApproval:resolveFeishuApproval,
        }));
      }
      if (request.method === 'POST' && request.url === '/api/mcp/completion-watches/resolve') {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'飞书投递核对只能由本机执行。' });
        const input = await readJsonBody(request);
        const taskId = String(input.taskId || '').trim();
        const chatRef = String(input.chatRef || '').trim();
        const task = (await store.list()).find((item) => item.taskId === taskId);
        if (!task) throw new ValidationError('找不到要核对的任务。');
        if (task.source?.channel !== 'feishu' || String(task.source?.chatRef || '').trim() !== chatRef) throw new ValidationError('只能核对任务原飞书会话的投递。');
        return sendJson(response, 200, await hermesNativeCompletionWatcher.resolveDelivery({
          taskId,
          chatId:chatRef,
          outcome:String(input.outcome || '').trim()
        }));
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
        ['/api/mcp/local-ai-run-event', ['recordPaperclipLocalAiRunEvent', '本机 AI 运行事件只能由本机 Hermes MCP 写入。']],
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
        return sendJson(response, 201, await createTaskHttpResult(normalizeTaskHttpInput(input), {
          tasks,
          completionWatcher:hermesNativeCompletionWatcher,
        }));
      }
      if (request.method === 'GET' && request.url === '/api/integrations/boom-monitor/health') {
        if (boomMonitorEnabled !== false) return sendJson(response, 503, { error:'旧版爆款雷达回滚桥仅在 native writer 已关闭时开放。' });
        if (!isBoomLegacyIntegrationAuthorized({
          remoteAddress:request.socket.remoteAddress,
          authorization:request.headers.authorization,
          expectedToken:environment.BOOM_MONITOR_BEARER_TOKEN,
        })) return sendJson(response, 401, { error:'旧版爆款雷达回滚桥认证失败。' });
        return sendJson(response, 200, { status:'ready', mode:'legacy_rollback_bridge' });
      }
      if (request.method === 'POST' && request.url === '/api/integrations/boom-monitor/dispatch') {
        if (boomMonitorEnabled !== false) return sendJson(response, 503, { error:'旧版爆款雷达回滚桥仅在 native writer 已关闭时开放。' });
        if (!isBoomLegacyIntegrationAuthorized({
          remoteAddress:request.socket.remoteAddress,
          authorization:request.headers.authorization,
          expectedToken:environment.BOOM_MONITOR_BEARER_TOKEN,
        })) return sendJson(response, 403, { error:'旧版爆款雷达派发兼容入口需要本机访问或回滚凭据。' });
        return sendJson(response, 201, await dispatchBoomSignal(await readJsonBody(request), { missions }));
      }
      if (request.method === 'POST' && request.url === '/api/integrations/boom-monitor/metrics') {
        if (boomMonitorEnabled !== false) return sendJson(response, 503, { error:'旧版爆款雷达回滚桥仅在 native writer 已关闭时开放。' });
        if (!isBoomLegacyIntegrationAuthorized({
          remoteAddress:request.socket.remoteAddress,
          authorization:request.headers.authorization,
          expectedToken:environment.BOOM_MONITOR_BEARER_TOKEN,
        })) return sendJson(response, 403, { error:'旧版爆款雷达指标兼容入口需要本机访问或回滚凭据。' });
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
        const input = await readJsonBody(request);
        return sendJson(response, 201, await createMissionHttpResult(normalizeMissionHttpInput(input), {
          missions,
          completionWatcher:hermesNativeCompletionWatcher,
        }));
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
      const mcpTaskFeedbackMatch = request.url?.match(/^\/api\/mcp\/tasks\/([0-9a-f-]+)\/feedback$/i);
      if (request.method === 'POST' && mcpTaskFeedbackMatch) {
        if (!isLocalAddress(request.socket.remoteAddress)) return sendJson(response, 403, { error:'Hermes MCP 任务评价只能由本机调用。' });
        const input = await readJsonBody(request);
        const task = await store.getTask(mcpTaskFeedbackMatch[1]);
        if (!task) throw new ValidationError('找不到要评价的工作。');
        const chatRef = String(input.chatRef || '').trim();
        if (task.source?.channel !== 'feishu' || !chatRef || task.source?.chatRef !== chatRef) {
          return sendJson(response, 403, { error:'只能在创建该任务的原飞书会话记录评价。' });
        }
        return sendJson(response, 200, { task:await tasks.recordFeedback(task.taskId, input) });
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

      const publicPath = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && (publicPath === '/' || publicPath === '/index.html' || /^\/tasks\/[0-9a-f-]{36}$/i.test(publicPath))) return sendFile(response, publicDir, 'index.html', 'text/html; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/app.js') return sendFile(response, publicDir, 'app.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/hot-reload-client.js') return sendFile(response, publicDir, 'hot-reload-client.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/app-access-views.js') return sendFile(response, publicDir, 'app-access-views.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/app-interactions.js') return sendFile(response, publicDir, 'app-interactions.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/refresh-scheduler.js') return sendFile(response, publicDir, 'refresh-scheduler.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/boom-monitor-console.js') return sendFile(response, publicDir, 'boom-monitor-console.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/billing-entry-filter.js') return sendFile(response, publicDir, 'billing-entry-filter.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/console-navigation.js') return sendFile(response, publicDir, 'console-navigation.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/disclosure-state.js') return sendFile(response, publicDir, 'disclosure-state.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/task-record-filter.js') return sendFile(response, publicDir, 'task-record-filter.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/task-record-detail-view.js') return sendFile(response, publicDir, 'task-record-detail-view.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/task-record-workbench.js') return sendFile(response, publicDir, 'task-record-workbench.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/task-timeline-view.js') return sendFile(response, publicDir, 'task-timeline-view.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && publicPath === '/styles.css') return sendFile(response, publicDir, 'styles.css', 'text/css; charset=utf-8');
      return sendJson(response, 404, { error:'未找到该入口。' });
    } catch (error) {
      return sendJson(response, errorStatus(error), { error:error.message || '运行台暂时不可用。' });
    }
  };
}

async function loadTaskCardContext({ store, tasks }, task) {
  const [approvals, recoveryView] = await Promise.all([
    store.listApprovals(),
    tasks.recoveryView(task),
  ]);
  return {
    approvals,
    recoveryView,
    agentId:String(task?.source?.targetAgentId || '').trim() || null,
    profileId:String(task?.source?.profileId || '').trim() || null,
    chatId:String(task?.source?.chatRef || '').trim() || null,
    taskCardPolicy:String(task?.source?.taskCardPolicy || '').trim() || null,
  };
}

export function createOwnerActionSession({ clock = () => Date.now(), ttlMs = OWNER_ACTION_NONCE_TTL_MS } = {}) {
  let nonce = '';
  let expiresAtMs = 0;
  function issue() {
    const now = Number(clock());
    if (!nonce || now >= expiresAtMs) {
      nonce = crypto.randomBytes(24).toString('base64url');
      expiresAtMs = now + Math.max(1_000, Number(ttlMs) || OWNER_ACTION_NONCE_TTL_MS);
    }
    return { nonce, expiresAt:new Date(expiresAtMs).toISOString() };
  }
  function authorize(value) {
    const supplied = String(value || '');
    const now = Number(clock());
    if (!nonce || now >= expiresAtMs || supplied.length !== nonce.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(nonce));
  }
  return Object.freeze({ issue, authorize });
}

function hasSameOrigin(request) {
  const origin = String(request.headers.origin || '').trim();
  const host = String(request.headers.host || '').trim();
  if (!origin || !host) return false;
  const scheme = request.socket.encrypted ? 'https' : 'http';
  return origin === `${scheme}://${host}`;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(bytes);
  }
  if (tooLarge) throw new JsonBodyError(413, '请求体超过 1 MiB 限制。');
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new JsonBodyError(400, '请求体不是有效 JSON。');
  }
}

class JsonBodyError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.name = 'JsonBodyError';
    this.httpStatus = httpStatus;
  }
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

export function isBoomLegacyIntegrationAuthorized({ remoteAddress, authorization, expectedToken }) {
  if (isLocalAddress(remoteAddress)) return true;
  const supplied = bearerToken(authorization);
  const expected = String(expectedToken || '');
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function isBoomLegacyIntegrationPath(url) {
  return [
    '/api/integrations/boom-monitor/health',
    '/api/integrations/boom-monitor/dispatch',
    '/api/integrations/boom-monitor/metrics',
  ].includes(String(url || ''));
}

function errorStatus(error) {
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599) return error.httpStatus;
  return error instanceof ValidationError
    || error instanceof ProposalValidationError
    || error instanceof PublicWebFetchError
    || error instanceof FeishuCommanderValidationError
    || error instanceof FeishuChannelBridgeError
    || error instanceof OfficialFeishuCompletionWatcherError
    || error instanceof MacWorkerBridgeError
    || error instanceof EmployeeFeishuConnectionError
    || error instanceof HermesModelSetupError
    || error instanceof AgentArmyTaskInputError
    || error instanceof AccessConnectionError
    || error instanceof ContentCampaignError
    || error instanceof M5PublisherBindingError
    || isPaperclipHttpError(error)
    || error?.isPublisherError === true
    || error?.isM5ToolExecutionError === true
    || error?.code === 'worker_lease_mismatch'
    ? 422
    : 500;
}
