import path from 'node:path';

import { createLocalAiCapabilityAdapter } from '../adapters/local-ai-capability-adapter.ts';
import { HermesContentGrowthAdvisor } from '../hermes-content-growth-advisor.ts';
import { KnowledgeArchiveWriter } from '../knowledge-archive-writer.ts';
import { LocalContentCreator, LocalVideoContentAnalyst } from '../local-content-growth.ts';
import { LocalOfficeAssistant } from '../local-office-assistant.ts';
import { LocalPptxAdapter, OfficePresentationAdapter } from '../local-pptx-adapter.ts';
import { LocalVideoScriptPackage } from '../local-video-script-package.ts';
import { createM5RoleToolAdapters } from '../m5-role-tool-adapters.ts';
import { OfficeDocumentAdapter, officeBinariesAvailable } from '../office-document-adapter.ts';
import { OpenKimiPptAdapter } from '../open-kimi-ppt-adapter.ts';
import { CapabilityExecutionEngine } from '../workflow/capability-execution.ts';
import { createCapabilityEventRecorder } from '../workflow/capability-event-recorder.ts';
import { createControlledVisionExecution } from '../workflow/controlled-vision.ts';
import type { RoleContentExecutionCompositionInput } from './composition-contracts.ts';

export async function createRoleContentExecutionComposition({
  paths,
  store,
  governance,
  registry,
  localAi,
  taskRunEvents,
  contentCampaign,
  research,
}: RoleContentExecutionCompositionInput) {
  const knowledgeArchive = new KnowledgeArchiveWriter({ autoWorkRoot:paths.autoWorkRoot });
  const officeAssistant = new LocalOfficeAssistant({
    store,
    artifactsDir:path.join(paths.dataDir, 'office-artifacts'),
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
    publicWebSearch:research.publicWebSearch,
    publicWebFetch:research.publicWebFetch,
    publicDynamicWebReader:research.publicDynamicWebReader,
    publicPdfReader:research.publicPdfReader,
    githubSearch:research.githubSearch,
    officeDocuments,
    officePresentations,
    governance,
    store,
    knowledgeArchive,
    onRunEvent:(event: Readonly<Record<string, unknown>>) => taskRunEvents.appendTaskRunEvent(event),
  });
  const contentArtifactRoots = [
    paths.dataDir,
    paths.xiaodArtifactRoot,
    paths.contentWorkspaceDir,
  ];
  const videoContentAgent = await registry.get('video-content-analyst');
  const localAiExecution = new CapabilityExecutionEngine({
    routes:[{ routeId:'local-ai', adapter:createLocalAiCapabilityAdapter(localAi), maxCostUsd:0 }],
    plan:{ primaryRouteId:'local-ai', fallbackRouteIds:[], maxRoutes:1 },
    onReceipt:createCapabilityEventRecorder(taskRunEvents),
  });
  const controlledVision = createControlledVisionExecution({
    engine:localAiExecution,
    manifestCapabilities:videoContentAgent?.runtimeCapabilities?.localAiCapabilities || [],
    maxCostUsd:0,
  });
  const videoContentAdvisor = new HermesContentGrowthAdvisor({
    hermesHome:path.join(paths.hermesProfileRoot, 'video-content-analyst'),
    timeoutMs:720_000,
  });
  const contentCreatorAdvisor = new HermesContentGrowthAdvisor({
    hermesHome:path.join(paths.hermesProfileRoot, 'content-creator'),
    timeoutMs:300_000,
  });
  const videoContentAnalyst = new LocalVideoContentAnalyst({
    store,
    artifactsDir:path.join(paths.dataDir, 'content-growth-artifacts'),
    allowedArtifactRoots:contentArtifactRoots,
    advisor:videoContentAdvisor,
    visionExecution:controlledVision,
  });
  const videoScriptPackage = new LocalVideoScriptPackage({
    store,
    artifactsDir:path.join(paths.dataDir, 'content-growth-artifacts'),
    advisor:contentCreatorAdvisor,
    researcher:research.intelResearcher,
    templateResolver:contentCampaign.templateResolver,
  });
  const contentCreator = new LocalContentCreator({
    store,
    artifactsDir:path.join(paths.dataDir, 'content-growth-artifacts'),
    allowedArtifactRoots:contentArtifactRoots,
    advisor:contentCreatorAdvisor,
    scriptPackage:videoScriptPackage,
  });

  return {
    officeAssistant,
    officePresentations,
    roleToolAdapters,
    videoContentAnalyst,
    contentCreator,
  };
}
