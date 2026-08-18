import path from 'node:path';
import { HermesIntentPlanner } from '../hermes-intent-planner.ts';
import { HermesConversationAdvisor } from '../hermes-conversation-advisor.ts';
import { FeishuCommander } from '../feishu-commander.ts';
import { FeishuChannelBridge } from '../feishu-channel-bridge.ts';
import { OfficialFeishuChannelRunner } from '../official-feishu-channel-runner.ts';
import { FileCompletionWatchStore, OfficialFeishuCompletionWatcher } from '../official-feishu-completion-watcher.ts';
import { HermesFeishuSender } from '../hermes-feishu-sender.ts';
import { FileAgentFeishuAppStore } from '../agent-feishu-app-store.ts';
import { AgentFeishuChannelFleet, employeeFeishuChannelsEnabled, feishuChannelStartupPlan } from '../agent-feishu-channel-fleet.ts';
import { EmployeeFeishuConnectionService } from '../employee-feishu-connection-service.ts';
import { HermesModelSetupService } from '../hermes-model-setup-service.ts';
import { createHermesModelProfileResolver } from '../hermes-model-profile-resolver.ts';
import { taskDetailBaseUrl } from '../task-presentation.ts';
import { createFeishuApprovalResolver } from '../runtime-http-feishu.ts';
import { createFeishuCommanderChainEvidenceLedger } from '../feishu-commander-chain-evidence.ts';
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
      ? hermesNativeCompletionWatcher.snapshot().status === 'ready'
        ? {
          status:'external',
          message:'A君飞书入口已交由 Hermes 原生 Gateway；连接真相以 Hermes Gateway 为准。',
        }
        : hermesNativeCompletionWatcher.snapshot()
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
      // 403 拒绝与「有意不建任务」的本机可判定证据（需求 2.5 / 2.8）。
      commanderChainEvidence:createFeishuCommanderChainEvidenceLedger({ dataDir }),
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
