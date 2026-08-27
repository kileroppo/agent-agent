export type RuntimeSource = Readonly<{
  mode: string;
  sourceIdentity: unknown;
  verify: () => Promise<unknown>;
}>;

export type LocalExecutionCompositionInput = Readonly<{
  configuration: Readonly<{
    paths: Readonly<{ root: string }>;
    deployment: Readonly<{ mode: string }>;
  }>;
  store: Readonly<{ list(): Promise<Array<Record<string, any>>> }>;
}>;

export type RoleResearchExecutionCompositionInput = Readonly<{
  environment: Readonly<{ AGENT_ARMY_GROK_ACCESS?: string }>;
  hermesProfileRoot: string;
  taskRunEvents: unknown;
}>;

export type TaskRunEventStore = Readonly<{
  appendTaskRunEvent(event: Readonly<Record<string, unknown>>): unknown;
}>;

export type LocalAiClient = Readonly<{
  invoke(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  controlService(serviceId: string, action: string): Promise<unknown>;
}>;

export type RoleContentExecutionCompositionInput = Readonly<{
  paths: Readonly<{
    autoWorkRoot: string;
    dataDir: string;
    xiaodArtifactRoot: string;
    contentWorkspaceDir: string;
    hermesProfileRoot: string;
  }>;
  store: Readonly<{ list(): Promise<Array<Record<string, any>>> }>;
  governance: unknown;
  registry: Readonly<{
    get(agentId: string): Promise<Readonly<{
      runtimeCapabilities?: Readonly<{ localAiCapabilities?: readonly string[] }>;
    }> | null>;
  }>;
  localAi: LocalAiClient;
  taskRunEvents: TaskRunEventStore;
  contentCampaign: Readonly<{ templateResolver: unknown }>;
  research: Readonly<{
    publicWebSearch: unknown;
    publicWebFetch: unknown;
    publicDynamicWebReader: unknown;
    publicPdfReader: unknown;
    githubSearch: unknown;
    intelResearcher: unknown;
  }>;
}>;

export type RoleTechnicalExecutionCompositionInput = Readonly<{
  paths: Readonly<{
    sourceProjectRoot: string;
    repairWorktreeParent: string;
  }>;
  runtimeSource: RuntimeSource;
}>;

export type TechnicalRepairWatchdogInput = Readonly<{
  store: unknown;
  governance: unknown;
}>;

export type RoleExecutionCompositionInput = Readonly<{
  environment: Readonly<{
    AGENT_ARMY_EMPLOYEE_ASSIGNMENT_WAIT_MS?: string | number;
    AGENT_ARMY_GROK_ACCESS?: string;
  }>;
  paths: RoleContentExecutionCompositionInput['paths']
    & RoleTechnicalExecutionCompositionInput['paths']
    & Readonly<{ runtimeRoot?: string }>;
  runtimeSource: RuntimeSource;
  registry: RoleContentExecutionCompositionInput['registry'];
  store: Readonly<{ list(): Promise<Array<Record<string, any>>> }>;
  governance: unknown;
  contentCampaign: RoleContentExecutionCompositionInput['contentCampaign'] & Readonly<{
    executeProviderVision: unknown;
    campaigns(): Promise<Readonly<{
      assertReplayableM5WorkProduct(input: unknown): unknown;
    }>>;
  }>;
  xiaod: unknown;
  localAi: LocalAiClient & Readonly<{ health(): unknown }>;
  taskRunEvents: TaskRunEventStore;
  port: number;
  missionChildPolicy?: unknown;
}>;

export type RuntimeBackgroundLifecycle = Readonly<{
  missions: unknown;
  macWorker: Readonly<{ snapshot(tasks: unknown): unknown }>;
  boomMonitor: unknown;
  services: Readonly<Record<string, unknown>>;
  close(): void;
}>;

export type CreateRuntimeInput = Readonly<{
  environment?: NodeJS.ProcessEnv;
  logger?: Console;
}>;

export type BackgroundLifecycleCompositionInput = Readonly<{
  configuration: Readonly<{
    paths: Readonly<{
      contentWorkspaceDir: string;
      repairWorktreeParent: string;
      dataDir: string;
    }>;
    bootedAt: string;
    deployment: Readonly<{ mode: string }>;
    features: Readonly<{
      m5RuntimeEnabled: boolean;
      boomMonitorEnabled: boolean;
      boomMonitorAutoScheduleEnabled: boolean;
      boomAnalysisDailyLimit: number;
    }>;
  }>;
  runtimeSource: Readonly<{
    sourceProjectRoot: string;
    verifyIdentity: unknown;
  }>;
  store: Readonly<{ list(): Promise<Array<Record<string, any>>> }>;
  governance: unknown;
  localExecution: Readonly<{
    registry: unknown;
    localXiaod: Readonly<{ collectMetrics(input: unknown): unknown }>;
    xiaod: unknown;
    bindXiaodReconciler(reconciler: unknown): void;
  }>;
  tasks: Readonly<{
    deliveryQuality: Readonly<{
      continue(task: Record<string, any>): Promise<Record<string, any>>;
    }>;
    taskLifecycleEvents: unknown;
  }>;
  taskRunEvents?: unknown;
  roleExecution: Readonly<{
    failureRecovery: Readonly<{ handle(task: unknown): unknown }>;
    executeVideoAnalysisFallback: unknown;
    technicalRepairWatchdog: unknown;
  }>;
  missionChildPolicy?: unknown;
  logger?: Pick<Console, 'warn'>;
}>;

export type ContentCampaignServiceInterface = Readonly<{
  caseChain(caseId: string): Promise<Array<Readonly<{
    id?: string;
    parentCaseId?: unknown;
    fields?: Readonly<{ campaignGrant?: unknown }>;
  }>>>;
  requirePipeline(): Promise<Readonly<{ projectId: unknown }>>;
  executeTool(input: unknown, authentication: unknown): Promise<unknown>;
  assertReplayableM5WorkProduct(input: unknown): unknown;
  activateScheduledDay(): unknown;
  reconcileParallelWork(caseId: unknown): unknown;
  onM5WorkProductSynced(event: unknown): unknown;
  list(): Promise<unknown[]>;
  getDailyRoutineTrigger(): Promise<unknown>;
}>;

export type ContentCampaignCompositionInput = Readonly<{
  enabled?: boolean;
  environment: NodeJS.ProcessEnv;
  dataDir: string;
  hermesProfileRoot: string;
  contentWorkspaceDir: string;
  taskRunEvents?: TaskRunEventStore | null;
  resolveTaskIdForPaperclipCase?: ((caseId: unknown) => Promise<string | null>) | null;
}>;

export type ProviderVisionInput = Readonly<{
  caseId: string;
  parameters: unknown;
  authentication: unknown;
}>;

export type FeishuCommandCompositionInput = Readonly<{
  environment: NodeJS.ProcessEnv;
  root: string;
  privateDir: string;
  dataDir: string;
  deploymentMode: string;
  employeeFeishuOwner: string;
  hermesNativeEmployeeIds: readonly string[];
  registry: unknown;
  store: unknown;
  tasks: TaskCardService & Readonly<{
    notificationStatus(taskId: string, chatId: string): unknown;
    setFeishuChannelStatus(reader: () => unknown): void;
    setAgentChannelStates(reader: () => unknown): void;
  }>;
  proposals: ProposalService;
  missions: unknown;
  port: number;
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
}>;
import type { ProposalService, TaskCardService } from '../runtime-http-feishu.ts';
