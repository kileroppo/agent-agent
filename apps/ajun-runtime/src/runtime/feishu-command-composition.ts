import path from 'node:path';
// @ts-expect-error -- transitional JS Adapter; removed with the Hermes planner batch.
import { HermesIntentPlanner } from '../hermes-intent-planner.js';
// @ts-expect-error -- transitional JS Adapter; removed with the Hermes advisor batch.
import { HermesConversationAdvisor } from '../hermes-conversation-advisor.js';
// @ts-expect-error -- transitional JS Module; removed with the Feishu command batch.
import { FeishuCommander } from '../feishu-commander.js';
// @ts-expect-error -- transitional JS Adapter; removed with the Feishu channel batch.
import { FeishuChannelBridge } from '../feishu-channel-bridge.js';
// @ts-expect-error -- transitional JS Adapter; removed with the Feishu channel batch.
import { OfficialFeishuChannelRunner } from '../official-feishu-channel-runner.js';
// @ts-expect-error -- transitional JS Module; removed with the completion-watch batch.
import { FileCompletionWatchStore, OfficialFeishuCompletionWatcher } from '../official-feishu-completion-watcher.js';
// @ts-expect-error -- transitional JS Adapter; removed with the Feishu sender batch.
import { HermesFeishuSender } from '../hermes-feishu-sender.js';
// @ts-expect-error -- transitional JS Module; removed with the employee-channel batch.
import { FileAgentFeishuAppStore } from '../agent-feishu-app-store.js';
// @ts-expect-error -- transitional JS Module; removed with the employee-channel batch.
import { AgentFeishuChannelFleet, employeeFeishuChannelsEnabled, feishuChannelStartupPlan } from '../agent-feishu-channel-fleet.js';
// @ts-expect-error -- transitional JS Module; removed with the employee-channel batch.
import { EmployeeFeishuConnectionService } from '../employee-feishu-connection-service.js';
// @ts-expect-error -- transitional JS Adapter; removed with the Hermes model batch.
import { HermesModelSetupService } from '../hermes-model-setup-service.js';
// @ts-expect-error -- transitional JS Adapter; removed with the Hermes model batch.
import { createHermesModelProfileResolver } from '../hermes-model-profile-resolver.js';
// @ts-expect-error -- transitional JS presentation Adapter; removed with the task-view batch.
import { taskDetailBaseUrl } from '../task-presentation.js';
import { createFeishuApprovalResolver } from '../runtime-http-feishu.ts';
import type { FeishuCommandCompositionInput } from './composition-contracts.ts';

type LarkChannelOptions = Parameters<
  (typeof import('@larksuite/channel'))['createLarkChannel']
>[0];

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
}: FeishuCommandCompositionInput) {
  const dynamicTaskCardEnabled = dynamicTaskCardRolloutEnabled(environment);
  const detailBaseUrl = taskDetailBaseUrl(environment.AJUN_TASK_DETAIL_BASE_URL);
  const resolveApproval = createFeishuApprovalResolver({ proposals, tasks });
  const sender = new HermesFeishuSender();
  const hermesNativeCompletionWatcher = new OfficialFeishuCompletionWatcher({
    taskStatus:(taskId: string, chatId: string) => tasks.notificationStatus(taskId, chatId),
    send:(chatId: string, payload: unknown) => sender.send(chatId, payload),
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
    taskStatus:(taskId: string, chatId: string) => tasks.notificationStatus(taskId, chatId),
    completionWatchStore:new FileCompletionWatchStore(
      path.join(dataDir, 'official-feishu-completion-watches.json'),
    ),
    completionWatcherFactory:(input: Readonly<Record<string, unknown>>) => new OfficialFeishuCompletionWatcher({
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
    taskStatus:(taskId: string, chatId: string) => tasks.notificationStatus(taskId, chatId),
    completionWatchStoreFactory:(agentId: string) => new FileCompletionWatchStore(
      path.join(dataDir, `official-feishu-${agentId}-completion-watches.json`),
    ),
    completionWatcherFactory:(input: Readonly<Record<string, unknown>>) => new OfficialFeishuCompletionWatcher({
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

export function dynamicTaskCardRolloutEnabled(environment: NodeJS.ProcessEnv = {}) {
  return String(environment.AJUN_FEISHU_DYNAMIC_TASK_CARD || '').trim().toLowerCase() === 'true'
    && String(environment.AJUN_HERMES_NATIVE_FEISHU || '').trim().toLowerCase() === 'true';
}

async function asyncChannelFactory(options: LarkChannelOptions) {
  const { createLarkChannel } = await import('@larksuite/channel');
  return createLarkChannel(options);
}
