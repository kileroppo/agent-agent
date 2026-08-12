import path from 'node:path';
import { HermesIntentPlanner } from '../hermes-intent-planner.js';
import { HermesConversationAdvisor } from '../hermes-conversation-advisor.js';
import { FeishuCommander } from '../feishu-commander.js';
import { FeishuChannelBridge } from '../feishu-channel-bridge.js';
import { OfficialFeishuChannelRunner } from '../official-feishu-channel-runner.js';
import {
  FileCompletionWatchStore,
  OfficialFeishuCompletionWatcher,
} from '../official-feishu-completion-watcher.js';
import { HermesFeishuSender } from '../hermes-feishu-sender.js';
import { FileAgentFeishuAppStore } from '../agent-feishu-app-store.js';
import {
  AgentFeishuChannelFleet,
  employeeFeishuChannelsEnabled,
  feishuChannelStartupPlan,
} from '../agent-feishu-channel-fleet.js';
import { EmployeeFeishuConnectionService } from '../employee-feishu-connection-service.js';
import { HermesModelSetupService } from '../hermes-model-setup-service.js';
import { createHermesModelProfileResolver } from '../hermes-model-profile-resolver.js';
import { taskDetailBaseUrl } from '../task-presentation.js';
import { createFeishuApprovalResolver } from '../runtime-http-feishu.js';

export async function createFeishuCommandComposition({
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
}) {
  const dynamicTaskCardEnabled = dynamicTaskCardRolloutEnabled(environment);
  const detailBaseUrl = taskDetailBaseUrl(environment.AJUN_TASK_DETAIL_BASE_URL);
  const resolveApproval = createFeishuApprovalResolver({ proposals, tasks });
  const sender = new HermesFeishuSender();
  const hermesNativeCompletionWatcher = new OfficialFeishuCompletionWatcher({
    taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
    send:(chatId, payload) => sender.send(chatId, payload),
    store:new FileCompletionWatchStore(path.join(dataDir, 'hermes-native-completion-watches.json')),
    detailBaseUrl,
  });
  const commander = new FeishuCommander({
    tasks,
    proposals,
    missions,
    store,
    planner:new HermesIntentPlanner(),
    conversationAdvisor:new HermesConversationAdvisor(),
    ajunBaseUrl:`http://127.0.0.1:${port}`,
  });
  const officialFeishuChannel = new FeishuChannelBridge({ commander, resolveApproval });
  const officialFeishuChannelRunner = new OfficialFeishuChannelRunner({
    bridge:officialFeishuChannel,
    createChannel:asyncChannelFactory,
    taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
    completionWatchStore:new FileCompletionWatchStore(
      path.join(dataDir, 'official-feishu-completion-watches.json'),
    ),
    completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher({
      ...input,
      detailBaseUrl,
    }),
    logger,
  });
  const appStore = new FileAgentFeishuAppStore({ directory:privateDir });
  const agentFeishuChannelFleet = new AgentFeishuChannelFleet({
    store:appStore,
    bridge:officialFeishuChannel,
    createChannel:asyncChannelFactory,
    taskStatus:(taskId, chatId) => tasks.notificationStatus(taskId, chatId),
    completionWatchStoreFactory:(agentId) => new FileCompletionWatchStore(
      path.join(dataDir, `official-feishu-${agentId}-completion-watches.json`),
    ),
    completionWatcherFactory:(input) => new OfficialFeishuCompletionWatcher({
      ...input,
      detailBaseUrl,
    }),
    enabled:employeeFeishuChannelsEnabled({ deploymentMode, owner:employeeFeishuOwner }),
    externalAgentIds:hermesNativeEmployeeIds,
    logger,
  });
  const employeeFeishuConnections = new EmployeeFeishuConnectionService({
    registry,
    store:appStore,
    fleet:agentFeishuChannelFleet,
  });
  const employeeModelSetup = new HermesModelSetupService({
    resolveProfile:createHermesModelProfileResolver({ registry, proposalStore:store, root }),
  });
  const feishuChannelStartup = feishuChannelStartupPlan({
    apps:await appStore.listApps(),
    legacyAJunEnabled:officialFeishuChannelRunner.enabled(),
    hermesNativeAJunEnabled:String(environment.AJUN_HERMES_NATIVE_FEISHU || '')
      .trim()
      .toLowerCase() === 'true',
    hermesNativeEmployeeIds,
  });
  feishuChannelStartup.dynamicTaskCardEnabled = dynamicTaskCardEnabled;

  tasks.setFeishuChannelStatus(() => feishuChannelStartup.startLegacyAJun
    ? officialFeishuChannelRunner.snapshot()
    : feishuChannelStartup.ajunOwner === 'hermes-native'
      ? hermesNativeCompletionWatcher.snapshot().status === 'delivery_uncertain'
        ? hermesNativeCompletionWatcher.snapshot()
        : {
          status:'external',
          message:'A君飞书入口已交由 Hermes 原生 Gateway；连接真相以 Hermes Gateway 为准。',
        }
      : agentFeishuChannelFleet.snapshot().ajun
        || { status:'connecting', message:'A君智能体入口正在连接。' });
  tasks.setAgentChannelStates(() => agentFeishuChannelFleet.snapshot());

  return Object.freeze({
    detailBaseUrl,
    feishuChannelStartup,
    handler:Object.freeze({
      commander,
      officialFeishuChannel,
      hermesNativeCompletionWatcher,
      resolveFeishuApproval:resolveApproval,
    }),
    connections:Object.freeze({
      employeeFeishuConnections,
      employeeModelSetup,
    }),
    services:Object.freeze({
      hermesNativeCompletionWatcher,
      officialFeishuChannelRunner,
      agentFeishuChannelFleet,
    }),
  });
}

export function dynamicTaskCardRolloutEnabled(environment = {}) {
  return String(environment.AJUN_FEISHU_DYNAMIC_TASK_CARD || '').trim().toLowerCase() === 'true'
    && String(environment.AJUN_HERMES_NATIVE_FEISHU || '').trim().toLowerCase() === 'true';
}

async function asyncChannelFactory(options) {
  const { createLarkChannel } = await import('@larksuite/channel');
  return createLarkChannel(options);
}
