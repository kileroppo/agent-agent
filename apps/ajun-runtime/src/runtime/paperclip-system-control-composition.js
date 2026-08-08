import { HttpPaperclipAdapter } from '@agent-army/m5-content-pipeline';
import {
  createOperationsHealthIncidentDispatcher,
  PaperclipCampaignDailyHandler,
  PaperclipHeartbeatHandler,
  PaperclipParallelWorkHandler,
} from '../paperclip-heartbeat.js';
import { PaperclipMetricMonitorHandler } from '../paperclip-metric-monitor.js';
import { PaperclipPublisherController } from '../paperclip-publisher-controller.js';
import {
  canonicalPaperclipHeartbeat,
  PaperclipPublisherRunContext,
} from '../paperclip-publisher-run-context.js';
import { PaperclipRetrospectiveHandler } from '../paperclip-retrospective.js';
import { PaperclipLearningLifecycleHandler } from '../paperclip-learning-lifecycle.js';

export function createPaperclipSystemControlComposition({
  governance,
  tasks,
  operator,
  campaigns,
  publisherBindings,
  paperclipCurrentRunScope,
}) {
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
    reconcileParallelWork:async (caseId) => (await campaigns()).reconcileParallelWork(caseId),
  });
  const paperclipRunAuthenticationAdapter = {
    async authenticateRun(input) {
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
