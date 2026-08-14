import http from 'node:http';
import path from 'node:path';
import { loadLanShareKey } from './lan-access.ts';
import { createAjunHttpHandler } from './runtime-http-handler.ts';
import { resolveRuntimeSourceRoot } from './runtime-source-root.ts';
import { createBackgroundLifecycleComposition } from './runtime/background-lifecycle-composition.ts';
import { createContentCampaignComposition } from './runtime/content-campaign-composition.ts';
import { createFeishuCommandComposition } from './runtime/feishu-command-composition.ts';
import { createLocalExecutionComposition } from './runtime/local-execution-composition.ts';
import { createPaperclipSystemControlComposition } from './runtime/paperclip-system-control-composition.ts';
import { createRoleExecutionComposition } from './runtime/role-execution-composition.ts';
import { readProductMaturityRuntimeBoundary } from './runtime/product-maturity-runtime-boundary.ts';
import { createRuntimeConfiguration } from './runtime/runtime-configuration.ts';
import { createRuntimeStateComposition } from './runtime/runtime-state-composition.ts';
import { CapabilityAcceptanceBundle } from './workflow/capability-acceptance-bundle.ts';
import { MissionChildPolicy } from './workflow/mission-child-policy.ts';
import type { CreateRuntimeInput, RuntimeBackgroundLifecycle } from './runtime/composition-contracts.ts';
export async function createRuntime({
  environment = process.env,
  logger = console,
}: CreateRuntimeInput = {}) {
  const configuration = createRuntimeConfiguration({
    environment,
    compositionRootUrl:import.meta.url,
  });
  const { paths, network, deployment, features, bootedAt } = configuration;
  const runtimeSource = await resolveRuntimeSourceRoot({
    runtimeRoot:paths.root,
    configuredSourceRoot:configuration.source.configuredSourceRoot,
    dataDir:paths.dataDir,
    privateDir:paths.privateDir,
    worktreeParent:paths.repairWorktreeParent,
    externalStatePaths:configuration.source.externalStatePaths,
  });
  const sourceProjectRoot = runtimeSource.sourceProjectRoot;
  const runtimeState = createRuntimeStateComposition({ configuration, logger });
  let backgroundLifecycle: RuntimeBackgroundLifecycle | null = null;
  try {
    const contentCampaign = await createContentCampaignComposition({
      environment,
      dataDir:paths.dataDir,
      hermesProfileRoot:paths.hermesProfileRoot,
      contentWorkspaceDir:paths.contentWorkspaceDir,
      taskRunEvents:runtimeState.taskRunEvents,
      resolveTaskIdForPaperclipCase:async (caseId: unknown) => {
        const task = (await runtimeState.store.list()).find((item: any) =>
          String(item?.input?.context?.pipelineCaseId || '').trim() === String(caseId || '').trim());
        return task?.taskId || null;
      },
    });
    const { governance, modelPolicy, campaigns, paperclipCurrentRunScope, publisherBindings:m5PublisherBindings } = contentCampaign;
    const missionChildPolicy = await MissionChildPolicy.open({
      keyPath:path.join(paths.privateDir, 'product-maturity-child-policy.key'),
    });
    const localExecution = createLocalExecutionComposition({
      configuration,
      store:runtimeState.store,
    });
    const roleExecution = await createRoleExecutionComposition({
      environment,
      paths:{
        dataDir:paths.dataDir,
        sourceProjectRoot,
        repairWorktreeParent:paths.repairWorktreeParent,
        hermesProfileRoot:paths.hermesProfileRoot,
        autoWorkRoot:paths.autoWorkRoot,
        xiaodArtifactRoot:paths.xiaodArtifactRoot,
        contentWorkspaceDir:paths.contentWorkspaceDir,
      },
      runtimeSource,
      registry:localExecution.registry,
      store:runtimeState.store,
      governance,
      contentCampaign,
      xiaod:localExecution.xiaod,
      localAi:localExecution.localAi,
      taskRunEvents:runtimeState.taskRunEvents,
      port:network.port,
      missionChildPolicy,
    });
    const { tasks, proposals, operator, publicWebFetch } = roleExecution;
    const lifecycle = createBackgroundLifecycleComposition({
      configuration,
      runtimeSource,
      store:runtimeState.store,
      governance,
      localExecution,
      tasks,
      roleExecution,
      missionChildPolicy,
      logger,
    }) as RuntimeBackgroundLifecycle;
    backgroundLifecycle = lifecycle;
    const productMaturity = new CapabilityAcceptanceBundle({
      store:runtimeState.store,
      missions:lifecycle.missions,
      policy:missionChildPolicy,
      ledgerPath:path.join(paths.dataDir, 'product-maturity-validation-batches.json'),
      projectRoot:sourceProjectRoot,
      runtimeBoundarySnapshot:() => readProductMaturityRuntimeBoundary({
        campaigns,
        publisher:m5PublisherBindings.publisher,
      }),
    });
    const feishuCommand = await createFeishuCommandComposition({
      environment,
      root:paths.root,
      privateDir:paths.privateDir,
      dataDir:paths.dataDir,
      deploymentMode:deployment.mode,
      employeeFeishuOwner:deployment.employeeFeishuOwner,
      hermesNativeEmployeeIds:deployment.hermesNativeEmployeeIds,
      registry:localExecution.registry,
      store:runtimeState.store,
      tasks,
      proposals,
      missions:lifecycle.missions,
      port:network.port,
      logger,
    });
    tasks.setWorkerStatus((currentTasks: unknown) => deployment.mode === 'cloud'
      ? lifecycle.macWorker.snapshot(currentTasks)
      : { status:'ready', detail:'当前由这台 Mac 直接承接本机文件、私人账号和音视频工作。' });
    tasks.setM5WorkProductObserver(
      async (event: unknown) => (await campaigns()).onM5WorkProductSynced(event),
    );
    const paperclipSystemControl = createPaperclipSystemControlComposition({
      governance,
      tasks,
      operator,
      campaigns,
      publisherBindings:m5PublisherBindings,
      paperclipCurrentRunScope,
    });
    const lanEnabled = network.lanEnabled;
    const lanAccess = {
      enabled:lanEnabled,
      key:await loadLanShareKey(paths.lanShareKeyPath, lanEnabled),
    };
    const handler = createAjunHttpHandler({
      environment,
      publicDir:paths.publicDir,
      dataDir:paths.dataDir,
      detailBaseUrl:feishuCommand.detailBaseUrl,
      development:{
        hotReload:{
          enabled:features.developmentHotReload,
          revision:`boot:${bootedAt}:${process.pid}`,
        },
      },
      network:{ deploymentMode:deployment.mode, lanEnabled, lanAccess },
      paperclip:paperclipSystemControl,
      work:{
        tasks,
        store:runtimeState.store,
        proposals,
        missions:lifecycle.missions,
        macWorker:lifecycle.macWorker,
        xiaod:localExecution.xiaod,
        boomMonitor:lifecycle.boomMonitor,
        boomMonitorEnabled:features.boomMonitorEnabled,
        taskTimeline:runtimeState.taskTimeline,
        productMaturity,
      },
      connections:{
        ...feishuCommand.connections,
        modelPolicy:{ service:modelPolicy, registry:localExecution.registry, governance },
        accessConnections:localExecution.accessConnections,
        publicWebFetch,
      },
      localAi:localExecution.localAi,
      feishu:feishuCommand.handler,
      m5:{ campaigns },
    });
    const server = http.createServer(handler);
    server.once('close', () => {
      try {
        lifecycle.close();
      } finally {
        runtimeState.close();
      }
    });
    return Object.freeze({
      server,
      port:network.port,
      host:network.host,
      lanEnabled,
      deploymentMode:deployment.mode,
      feishuChannelStartup:feishuCommand.feishuChannelStartup,
      logger,
      source:Object.freeze({
        projectRoot:sourceProjectRoot,
        mode:runtimeSource.mode,
        integrityLevel:runtimeSource.integrityLevel,
      }),
      services:Object.freeze({
        ...lifecycle.services,
        taskRunEventRetention:runtimeState.taskRunEventRetention,
        ...feishuCommand.services,
      }),
    });
  } catch (error) {
    try {
      backgroundLifecycle?.close();
    } finally {
      runtimeState.close();
    }
    throw error;
  }
}
