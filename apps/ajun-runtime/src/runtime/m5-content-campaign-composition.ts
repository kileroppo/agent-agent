import path from 'node:path';
import type {
  ContentCampaignCompositionInput,
  ContentCampaignServiceInterface,
  ProviderVisionInput,
} from './composition-contracts.ts';

export async function createEnabledM5ContentCampaignComposition({
  environment,
  dataDir,
  contentWorkspaceDir,
  taskRunEvents,
  resolveTaskIdForPaperclipCase,
  governance,
  modelPolicy,
}: ContentCampaignCompositionInput & Readonly<{ governance: any; modelPolicy: any }>) {
  const [
    { defaultDefinition, HttpPaperclipAdapter },
    { ContentCampaignService },
    { createM5ServerPublisherComposition, PaperclipCurrentRunScope },
    { M5ToolExecutorRouter, PaperclipContentToolExecutor },
    { LocalBudgetTicketAuthority },
    { M5ProductionTemplateResolver },
  ] = await Promise.all([
    import('@agent-army/m5-content-pipeline'),
    import('../content-campaign-service.ts'),
    import('../m5-server-publisher-composition.ts'),
    import('../paperclip-content-tool-executor.ts'),
    import('../local-budget-ticket-authority.ts'),
    import('../m5-production-template-resolver.ts'),
  ]);
  const budgetTicketAuthority = await LocalBudgetTicketAuthority.open(
    path.join(dataDir, 'm5-budget-ticket-ed25519.pem'),
  );
  const paperclipCurrentRunScope = new PaperclipCurrentRunScope();
  governance.publisherRunCredentialProvider = () => paperclipCurrentRunScope.currentCredential();
  const templateResolver = new M5ProductionTemplateResolver({ governance });
  let campaignService: ContentCampaignServiceInterface | null = null;
  const publisherBindings = createM5ServerPublisherComposition({
    env:environment,
    dataDir,
    getCampaignService:campaigns,
    currentRunCredentialProvider:() => paperclipCurrentRunScope.currentCredential(),
    production:{ enabled:true, paperclipAccess:governance, connectorDependencies:{} },
  });

  async function campaigns() {
    if (campaignService) return campaignService;
    const company = await governance.companyForRuntime();
    const adapter = new HttpPaperclipAdapter({ apiBase:governance.baseUrl, companyId:company.id });
    campaignService = new ContentCampaignService({
      adapter,
      definition:defaultDefinition,
      activePipelineId:environment.M5_ACTIVE_PIPELINE_ID || null,
      activePipelineKey:environment.M5_ACTIVE_PIPELINE_KEY || defaultDefinition.key,
      contentWorkspaceRoot:contentWorkspaceDir,
      templateResolver,
      publisher:publisherBindings.publisher,
      toolExecutor:new M5ToolExecutorRouter({
        publisherExecutor:publisherBindings.toolExecutor,
        contentExecutor:new PaperclipContentToolExecutor({
          adapter,
          budgetTicketAuthority,
          onRunEvent:async (event: any) => {
            if (!taskRunEvents) return;
            const taskId = typeof resolveTaskIdForPaperclipCase === 'function'
              ? await resolveTaskIdForPaperclipCase(event.taskId)
              : null;
            taskRunEvents.appendTaskRunEvent(taskId
              ? { ...event, taskId, workflowId:event.taskId || event.workflowId }
              : event);
          },
        }),
      }),
    }) as ContentCampaignServiceInterface;
    return campaignService;
  }

  async function executeProviderVision({ caseId, parameters, authentication }: ProviderVisionInput) {
    const service = await campaigns();
    const chain = await service.caseChain(caseId);
    const campaignCase = chain.at(-1);
    if (!campaignCase?.id || campaignCase.parentCaseId || !campaignCase.fields?.campaignGrant) {
      throw new Error('M5 视觉工具无法回溯到唯一活动授权父 Case。');
    }
    const pipeline = await service.requirePipeline();
    const receipt = await service.executeTool({
      campaignId:campaignCase.id,
      caseId,
      toolId:'agent-army.content-autonomy:stepfun-vision',
      parameters,
    }, authentication);
    return { receipt, projectId:pipeline.projectId };
  }

  return Object.freeze({
    enabled:true,
    governance,
    modelPolicy,
    campaigns,
    executeProviderVision,
    paperclipCurrentRunScope,
    publisherBindings,
    templateResolver,
  });
}
