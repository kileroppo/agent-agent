import path from 'node:path';
import { TaskService } from '../task-service.js';
import { SkillExecutionRegistry } from '../skill-execution-registry.js';
import { LocalHealthOperator } from '../local-health-operator.js';
import { LocalAjunCoordinator } from '../local-ajun-coordinator.ts';
import { LocalReviewer } from '../local-reviewer.ts';
import { LocalArchitect } from '../local-architect.js';
import { HermesTaskAdvisor } from '../hermes-task-advisor.js';
import { HermesPublicComparisonAdvisor } from '../hermes-public-comparison-advisor.js';
import { HermesPublicSummaryAdvisor } from '../hermes-public-summary-advisor.js';
import { HermesIntelResearchAdvisor } from '../hermes-intel-research-advisor.js';
import { LocalTechnicalExpert } from '../local-technical-expert.ts';
import { IsolatedRepairWorkspace } from '../isolated-repair-workspace.js';
import { TechnicalExpertRunner } from '../technical-expert-runner.ts';
import { TechnicalRepairPromotion } from '../technical-repair-promotion.js';
import { TechnicalRepairWatchdog } from '../technical-repair-watchdog.ts';
import { TechnicalRepairDiagnoser } from '../technical-repair-diagnoser.ts';
import { FailureRecoveryCoordinator } from '../failure-recovery-coordinator.js';
import { AgentProposalService } from '../agent-proposal-service.js';
import { LocalCreator } from '../local-creator.ts';
import { PublicWebFetch } from '../public-web-fetch.js';
import { PublicWebSearch } from '../public-web-search.js';
import { PublicWebTransport } from '../public-web-transport.js';
import { PublicDynamicWebReader } from '../public-dynamic-web-reader.js';
import { PublicPdfReader } from '../public-pdf-reader.js';
import { LocalPublicReport } from '../local-public-report.js';
import { GithubSearch } from '../github-search.js';
import { LocalGithubResearch } from '../local-github-research.js';
import { LocalIntelResearcher } from '../local-intel-researcher.js';
import { GrokConsultMcpAdapter } from '../grok-consult-mcp-adapter.js';
import { LocalOfficeAssistant } from '../local-office-assistant.js';
import { createM5RoleToolAdapters } from '../m5-role-tool-adapters.js';
import { OfficeDocumentAdapter, officeBinariesAvailable } from '../office-document-adapter.js';
import { OpenKimiPptAdapter } from '../open-kimi-ppt-adapter.js';
import { LocalPptxAdapter, OfficePresentationAdapter } from '../local-pptx-adapter.js';
import { KnowledgeArchiveWriter } from '../knowledge-archive-writer.js';
import { LocalContentCreator, LocalVideoContentAnalyst } from '../local-content-growth.js';
import { LocalVideoScriptPackage } from '../local-video-script-package.js';
import { HermesContentGrowthAdvisor } from '../hermes-content-growth-advisor.js';
import { HermesUsageLedger } from '../hermes-usage-ledger.js';
import { ProposalAcceptanceRunner } from '../proposal-acceptance-runner.ts';
import { WeChatLocalVaultAcceptance } from '../wechat-local-vault-acceptance.js';
import { LocalWeChatChatRetriever } from '../local-wechat-chat-retriever.js';
import { taskDetailBaseUrl } from '../task-presentation.js';
import { CapabilityExecutionEngine } from '../workflow/capability-execution.ts';
import { createControlledVisionExecution } from '../workflow/controlled-vision.ts';
import { createLocalAiCapabilityAdapter } from '../adapters/local-ai-capability-adapter.ts';

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
  port,
  missionChildPolicy,
}) {
  const {
    root,
    dataDir,
    sourceProjectRoot,
    repairWorktreeParent,
    hermesProfileRoot,
    autoWorkRoot,
    xiaodArtifactRoot,
    contentWorkspaceDir,
  } = paths;
  const repairWorkspace = new IsolatedRepairWorkspace({
    projectRoot:sourceProjectRoot,
    parentDir:path.join(repairWorktreeParent, 'ajun-repairs'),
    sourceIdentity:runtimeSource.sourceIdentity,
    verifySourceRoot:runtimeSource.verify,
  });
  const technicalRepairPromotion = new TechnicalRepairPromotion({
    projectRoot:sourceProjectRoot,
    allowedWorkspaceRoots:[repairWorktreeParent, path.join(sourceProjectRoot, 'work', 'acceptance-runs')],
    sourceMode:runtimeSource.mode,
    sourceIdentity:runtimeSource.sourceIdentity,
    verifySourceRoot:runtimeSource.verify,
  });
  const unguardedTechnicalRepairDiagnoser = new TechnicalRepairDiagnoser();
  const technicalRepairDiagnoser = {
    async diagnose(...args) {
      await runtimeSource.verify();
      return unguardedTechnicalRepairDiagnoser.diagnose(...args);
    },
  };
  const publicWebTransport = new PublicWebTransport();
  const publicWebFetch = new PublicWebFetch({
    fetchImpl:(...args) => publicWebTransport.fetch(...args),
  });
  const publicWebSearch = new PublicWebSearch({
    fetchImpl:(...args) => publicWebTransport.fetch(...args),
  });
  const publicDynamicWebReader = new PublicDynamicWebReader();
  const publicPdfReader = new PublicPdfReader({ transport:publicWebTransport });
  const githubSearch = new GithubSearch({
    fetchImpl:(...args) => publicWebTransport.fetch(...args),
  });
  const publicReport = new LocalPublicReport({
    publicWebFetch,
    publicWebSearch,
    comparisonAdvisor:new HermesPublicComparisonAdvisor(),
    refineAdvisor:new HermesPublicSummaryAdvisor(),
  });
  const githubResearch = new LocalGithubResearch({ githubSearch });
  const intelResearcher = new LocalIntelResearcher({
    publicWebFetch,
    publicWebSearch,
    githubSearch,
    publicReport,
    githubResearch,
    researchAdvisor:new HermesIntelResearchAdvisor({
      hermesHome:path.join(hermesProfileRoot, 'intel-researcher'),
    }),
    grokConsult:new GrokConsultMcpAdapter({ accessMode:environment.AGENT_ARMY_GROK_ACCESS }),
  });
  const knowledgeArchive = new KnowledgeArchiveWriter({ autoWorkRoot });
  const officeAssistant = new LocalOfficeAssistant({
    store,
    artifactsDir:path.join(dataDir, 'office-artifacts'),
    knowledgeArchive,
  });
  const officeDocuments = await officeBinariesAvailable()
    ? new OfficeDocumentAdapter()
    : null;
  const officePresentations = new OfficePresentationAdapter({
    pptdAdapter:new OpenKimiPptAdapter(),
    pptxAdapter:new LocalPptxAdapter(),
  });
  const roleToolAdapters = createM5RoleToolAdapters({
    publicWebSearch,
    publicWebFetch,
    publicDynamicWebReader,
    publicPdfReader,
    githubSearch,
    officeDocuments,
    officePresentations,
    governance,
    store,
    knowledgeArchive,
  });
  const contentArtifactRoots = [dataDir, xiaodArtifactRoot, contentWorkspaceDir];
  const videoContentAgent = await registry.get('video-content-analyst');
  const localAiExecution = new CapabilityExecutionEngine({
    adapter:createLocalAiCapabilityAdapter(localAi),
  });
  const controlledVision = createControlledVisionExecution({
    engine:localAiExecution,
    manifestCapabilities:videoContentAgent?.runtimeCapabilities?.localAiCapabilities || [],
    maxCostUsd:0,
  });
  const videoContentAdvisor = new HermesContentGrowthAdvisor({
    hermesHome:path.join(hermesProfileRoot, 'video-content-analyst'),
    timeoutMs:720_000,
  });
  const contentCreatorAdvisor = new HermesContentGrowthAdvisor({
    hermesHome:path.join(hermesProfileRoot, 'content-creator'),
    timeoutMs:300_000,
  });
  const videoContentAnalyst = new LocalVideoContentAnalyst({
    store,
    artifactsDir:path.join(dataDir, 'content-growth-artifacts'),
    allowedArtifactRoots:contentArtifactRoots,
    advisor:videoContentAdvisor,
    visionExecution:controlledVision,
  });
  const videoScriptPackage = new LocalVideoScriptPackage({
    store,
    artifactsDir:path.join(dataDir, 'content-growth-artifacts'),
    advisor:contentCreatorAdvisor,
    researcher:intelResearcher,
    templateResolver:contentCampaign.templateResolver,
  });
  const contentCreator = new LocalContentCreator({
    store,
    artifactsDir:path.join(dataDir, 'content-growth-artifacts'),
    allowedArtifactRoots:contentArtifactRoots,
    advisor:contentCreatorAdvisor,
    scriptPackage:videoScriptPackage,
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
      wechatLocalVault:new WeChatLocalVaultAcceptance({
        artifactsDir:path.join(dataDir, 'proposal-acceptance-artifacts'),
      }),
      artifactsDir:path.join(dataDir, 'proposal-acceptance-artifacts'),
    }),
  });
  const operator = new LocalHealthOperator({ governance });
  let failureRecovery = null;
  const tasks = new TaskService({
    registry,
    store,
    governance,
    roleToolAdapters,
    officePresentationWorkspaceRoot:path.join(dataDir, 'office-presentation-workspaces'),
    usageLedger:new HermesUsageLedger({ profileRoot:hermesProfileRoot }),
    missionChildPolicy,
    m5ProviderVision:contentCampaign.executeProviderVision,
    m5WorkProductValidator:async (input) => (
      await contentCampaign.campaigns()
    ).assertReplayableM5WorkProduct(input),
    executors:{
      operator,
      xiaod,
      ajun:new LocalAjunCoordinator({ advisor:new HermesTaskAdvisor(), registry }),
      creator:new LocalCreator({ proposals }),
      reviewer:new LocalReviewer(),
      architect:new LocalArchitect({ registry, store }),
      'technical-expert':new LocalTechnicalExpert({
        workspace:repairWorkspace,
        runner:new TechnicalExpertRunner(),
        promotion:technicalRepairPromotion,
      }),
      'intel-researcher':intelResearcher,
      'office-assistant':officeAssistant,
      'video-content-analyst':videoContentAnalyst,
      'content-creator':contentCreator,
      'wechat-chat-retriever':new LocalWeChatChatRetriever({
        store,
        ensureAnalysisReady:() => localAi.controlService('qwen35', 'start'),
      }),
    },
    fallbackExecutor:publicReport,
    onTaskFailed:(task, options) => failureRecovery?.handle(task, options),
    taskDetailBaseUrl:taskDetailBaseUrl('', `http://127.0.0.1:${port}`),
    skillExecutionRegistry:new SkillExecutionRegistry({
      grokAccessMode:environment.AGENT_ARMY_GROK_ACCESS,
      readinessProbes:{ 'open-kimi-ppt':() => officePresentations.readiness() },
    }),
    localAiCapabilityStatus:() => localAi.health(),
  });
  failureRecovery = new FailureRecoveryCoordinator({
    tasks,
    store,
    diagnoser:technicalRepairDiagnoser,
    projectRoot:sourceProjectRoot,
  });
  proposals.taskService = tasks;

  return Object.freeze({
    tasks,
    proposals,
    operator,
    failureRecovery,
    publicWebFetch,
    executeVideoAnalysisFallback:async (task) => videoContentAnalyst.execute(
      task,
      { allowAdvisor:false },
    ),
    technicalRepairWatchdog:new TechnicalRepairWatchdog({ store, governance }),
  });
}
