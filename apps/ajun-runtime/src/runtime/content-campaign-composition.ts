import path from 'node:path';
import { defaultDefinition, HttpPaperclipAdapter } from '@agent-army/m5-content-pipeline';
import { PaperclipBridge } from '../paperclip-bridge.ts';
import { ContentCampaignService } from '../content-campaign-service.ts';
import { createM5ServerPublisherComposition, PaperclipCurrentRunScope } from '../m5-server-publisher-composition.ts';
import { M5ToolExecutorRouter, PaperclipContentToolExecutor } from '../paperclip-content-tool-executor.ts';
import { LocalBudgetTicketAuthority } from '../local-budget-ticket-authority.ts';
import { M5ProductionTemplateResolver } from '../m5-production-template-resolver.ts';
import type {
  ContentCampaignCompositionInput,
  ContentCampaignServiceInterface,
  ProviderVisionInput,
} from './composition-contracts.ts';

export async function createContentCampaignComposition({
  environment,
  dataDir,
  contentWorkspaceDir,
  taskRunEvents = null,
  resolveTaskIdForPaperclipCase = null,
}: ContentCampaignCompositionInput) {
  const budgetTicketAuthority = await LocalBudgetTicketAuthority.open(
    path.join(dataDir, 'm5-budget-ticket-ed25519.pem'),
  );
  const paperclipCurrentRunScope = new PaperclipCurrentRunScope();
  const governance = new PaperclipBridge({
    publisherRunCredentialProvider:() => paperclipCurrentRunScope.currentCredential(),
  });
  const templateResolver = new M5ProductionTemplateResolver({ governance });
  let campaignService: ContentCampaignServiceInterface | null = null;
  const publisherBindings = createM5ServerPublisherComposition({
    env:environment,
    dataDir,
    getCampaignService:campaigns,
    currentRunCredentialProvider:() => paperclipCurrentRunScope.currentCredential(),
    production:{
      enabled:true,
      paperclipAccess:governance,
      // 真实 transport/CUA runner 只能由受审计的不可变依赖包显式注入。
      connectorDependencies:{},
    },
  });

  async function campaigns() {
    if (campaignService) return campaignService;
    const company = await governance.companyForRuntime();
    const adapter = new HttpPaperclipAdapter({
      apiBase:governance.baseUrl,
      companyId:company.id,
    });
    const created = new ContentCampaignService({
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
          onRunEvent:async (event: Readonly<Record<string, unknown>> & Readonly<{
            taskId?: string;
            workflowId?: string;
          }>) => {
            if (!taskRunEvents) return;
            const resolvedTaskId = typeof resolveTaskIdForPaperclipCase === 'function'
              ? await resolveTaskIdForPaperclipCase(event.taskId)
              : null;
            taskRunEvents.appendTaskRunEvent(resolvedTaskId
              ? { ...event, taskId:resolvedTaskId, workflowId:event.taskId || event.workflowId }
              : event);
          },
        }),
      }),
    }) as ContentCampaignServiceInterface;
    campaignService = created;
    return created;
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
    return {
      receipt,
      projectId:pipeline.projectId,
    };
  }

  return Object.freeze({
    governance,
    campaigns,
    executeProviderVision,
    paperclipCurrentRunScope,
    publisherBindings,
    templateResolver,
  });
}
