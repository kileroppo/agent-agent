import path from 'node:path';
import { AgentProposalService } from '../agent-proposal-service.ts';
import { FailureRecoveryCoordinator } from '../failure-recovery-coordinator.ts';
import { HermesTaskAdvisor } from '../hermes-task-advisor.ts';
import { HermesUsageLedger } from '../hermes-usage-ledger.ts';
import { LocalAjunCoordinator } from '../local-ajun-coordinator.ts';
import { LocalArchitect } from '../local-architect.ts';
import { LocalCreator } from '../local-creator.ts';
import { LocalHealthOperator } from '../local-health-operator.ts';
import { LocalReviewer } from '../local-reviewer.ts';
import { LocalWeChatChatRetriever } from '../local-wechat-chat-retriever.ts';
import { ProposalAcceptanceRunner } from '../proposal-acceptance-runner.ts';
import { SkillExecutionRegistry } from '../skill-execution-registry.ts';
import { taskDetailBaseUrl } from '../task-presentation.ts';
import { TaskService } from '../task-service.ts';
import { WeChatLocalVaultAcceptance } from '../wechat-local-vault-acceptance.ts';
import { MaturityExecutionGuard } from '../maturity-execution-guard.ts';
import { createRoleContentExecutionComposition } from './role-content-execution-composition.ts';
import { createRoleResearchExecutionComposition } from './role-research-execution-composition.ts';
import {
  createRoleTechnicalExecutionComposition,
  createTechnicalRepairWatchdog,
} from './role-technical-execution-composition.ts';
import type { RoleExecutionCompositionInput } from './composition-contracts.ts';

export async function createRoleExecutionComposition({
  environment,
  paths,
  runtimeSource,
  registry,
  store,
  governance,
  contentCampaign,
  xiaod,
  localAi,
  taskRunEvents,
  port,
  missionChildPolicy = null,
}: RoleExecutionCompositionInput) {
  const technical = createRoleTechnicalExecutionComposition({ paths, runtimeSource });
  const research = createRoleResearchExecutionComposition({
    environment,
    hermesProfileRoot:paths.hermesProfileRoot,
    taskRunEvents,
  });
  const content = await createRoleContentExecutionComposition({
    paths,
    store,
    governance,
    registry,
    localAi,
    taskRunEvents,
    contentCampaign,
    research,
  });
  const proposals = new AgentProposalService({
    store,
    registry,
    governance,
    restrictedAcceptanceRunner:new ProposalAcceptanceRunner({
      publicReport:research.publicReport,
      intelResearcher:research.intelResearcher,
      videoContentAnalyst:content.videoContentAnalyst,
      contentCreator:content.contentCreator,
      wechatLocalVault:new WeChatLocalVaultAcceptance({
        artifactsDir:path.join(paths.dataDir, 'proposal-acceptance-artifacts'),
      }),
      artifactsDir:path.join(paths.dataDir, 'proposal-acceptance-artifacts'),
    }),
  });
  const operator = new LocalHealthOperator({ governance });
  let failureRecovery: Readonly<{
    handle(task: unknown, options: unknown): unknown;
  }> | null = null;
  const tasks = new TaskService({
    registry,
    store,
    governance,
    roleToolAdapters:content.roleToolAdapters,
    employeeAssignmentWaitMs:environment.AGENT_ARMY_EMPLOYEE_ASSIGNMENT_WAIT_MS || 240_000,
    officePresentationWorkspaceRoot:path.join(paths.dataDir, 'office-presentation-workspaces'),
    usageLedger:new HermesUsageLedger({ profileRoot:paths.hermesProfileRoot }),
    m5ProviderVision:contentCampaign.executeProviderVision,
    m5WorkProductValidator:async (input: unknown) => (
      await contentCampaign.campaigns()
    ).assertReplayableM5WorkProduct(input),
    executors:{
      operator,
      xiaod,
      ajun:new LocalAjunCoordinator({ advisor:new HermesTaskAdvisor(), registry }),
      creator:new LocalCreator({ proposals }),
      reviewer:new LocalReviewer(),
      architect:new LocalArchitect({ registry, store }),
      'technical-expert':technical.technicalExpert,
      'intel-researcher':research.intelResearcher,
      'office-assistant':content.officeAssistant,
      'video-content-analyst':content.videoContentAnalyst,
      'content-creator':content.contentCreator,
      'wechat-chat-retriever':new LocalWeChatChatRetriever({
        store,
        ensureAnalysisReady:() => localAi.controlService('qwen35', 'start'),
      }),
    },
    fallbackExecutor:research.publicReport,
    onTaskFailed:(task: unknown, options: unknown) => failureRecovery?.handle(task, options),
    taskDetailBaseUrl:taskDetailBaseUrl('', `http://127.0.0.1:${port}`),
    skillExecutionRegistry:new SkillExecutionRegistry({
      grokAccessMode:environment.AGENT_ARMY_GROK_ACCESS,
      readinessProbes:{ 'open-kimi-ppt':() => content.officePresentations.readiness() },
    }),
    localAiCapabilityStatus:() => localAi.health(),
    taskRunEvents,
    missionChildPolicy,
    runtimeDataDir:paths.dataDir,
    runtimeRoot:paths.runtimeRoot || null,
  });
  const maturityExecutionGuard = missionChildPolicy
    ? new MaturityExecutionGuard({ store, policy:missionChildPolicy })
    : null;
  tasks.maturityExecutionGuard = maturityExecutionGuard;
  tasks.executionCoordinator.maturityExecutionGuard = maturityExecutionGuard;
  tasks.intake.maturityExecutionGuard = maturityExecutionGuard;
  const recovery = new FailureRecoveryCoordinator({
    tasks,
    store,
    diagnoser:technical.technicalRepairDiagnoser,
    projectRoot:paths.sourceProjectRoot,
  });
  failureRecovery = recovery;
  proposals.taskService = tasks;

  return Object.freeze({
    tasks,
    proposals,
    operator,
    failureRecovery:recovery,
    publicWebFetch:research.publicWebFetch,
    executeVideoAnalysisFallback:async (task: unknown) => content.videoContentAnalyst.execute(
      task,
      { allowAdvisor:false },
    ),
    technicalRepairWatchdog:createTechnicalRepairWatchdog({ store, governance }),
  });
}
