import { HttpPaperclipAdapter } from '@agent-army/m5-content-pipeline';
import { createOperationsHealthIncidentDispatcher, PaperclipCampaignDailyHandler, PaperclipHeartbeatHandler, PaperclipParallelWorkHandler } from '../paperclip-heartbeat.ts';
import { PaperclipMetricMonitorHandler } from '../paperclip-metric-monitor.ts';
import { PaperclipPublisherController } from '../paperclip-publisher-controller.ts';
import { canonicalPaperclipHeartbeat, PaperclipPublisherRunContext } from '../paperclip-publisher-run-context.ts';
import { PaperclipRetrospectiveHandler } from '../paperclip-retrospective.ts';
import { PaperclipLearningLifecycleHandler } from '../paperclip-learning-lifecycle.ts';

type PaperclipControlCampaigns = Readonly<{
  activateScheduledDay(): unknown;
  reconcileParallelWork(caseId: unknown): unknown;
}>;

export type PaperclipSystemControlCompositionInput = Readonly<{
  governance: Readonly<{
    baseUrl: string;
    companyForRuntime(): Promise<Readonly<{ id: string }>>;
  }>;
  tasks: unknown;
  operator: unknown;
  campaigns(): Promise<PaperclipControlCampaigns>;
  publisherBindings: Readonly<{ publisher: unknown }>;
  paperclipCurrentRunScope: unknown;
}>;

export function createPaperclipSystemControlComposition({
  governance,
  tasks,
  operator,
  campaigns,
  publisherBindings,
  paperclipCurrentRunScope,
}: PaperclipSystemControlCompositionInput) {
  const paperclipHeartbeat = new PaperclipHeartbeatHandler({
    operator,
    governance,
    incidentDispatcher:createOperationsHealthIncidentDispatcher({ tasks }),
  });
  const paperclipCampaignDaily = new PaperclipCampaignDailyHandler({
    governance,
    campaignActivator:async () => (await campaigns()).activateScheduledDay(),
  });
  const paperclipParallelWork = new PaperclipParallelWorkHandler({
    governance,
    reconcileParallelWork:async (caseId: unknown) => (await campaigns()).reconcileParallelWork(caseId),
  });
  const paperclipRunAuthenticationAdapter = {
    async authenticateRun(input: unknown) {
      const company = await governance.companyForRuntime();
      return new HttpPaperclipAdapter({
        apiBase:governance.baseUrl,
        companyId:company.id,
      }).authenticateRun(input);
    },
  };
  const paperclipPublisherRunContext = new PaperclipPublisherRunContext({
    paperclipAdapter:paperclipRunAuthenticationAdapter,
    governance,
    systemRole:'m5-publisher-controller',
  });
  const paperclipMetricRunContext = new PaperclipPublisherRunContext({
    paperclipAdapter:paperclipRunAuthenticationAdapter,
    governance,
    systemRole:'m5-metrics-controller',
  });

  return Object.freeze({
    paperclipHeartbeat,
    paperclipCampaignDaily,
    paperclipParallelWork,
    paperclipMetricRunContext,
    paperclipMetricMonitor:new PaperclipMetricMonitorHandler({
      governance,
      publisher:publisherBindings.publisher,
    }),
    paperclipCurrentRunScope,
    paperclipPublisherRunContext,
    paperclipPublisherController:new PaperclipPublisherController({
      governance,
      publisher:publisherBindings.publisher,
    }),
    paperclipRetrospective:new PaperclipRetrospectiveHandler({ governance }),
    paperclipLearningLifecycle:new PaperclipLearningLifecycleHandler({ governance }),
    canonicalPaperclipHeartbeat,
  });
}
