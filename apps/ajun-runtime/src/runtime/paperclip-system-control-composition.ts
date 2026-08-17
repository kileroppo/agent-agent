import { createOperationsHealthIncidentDispatcher, PaperclipHeartbeatHandler } from '../paperclip-heartbeat.ts';
import { M5RuntimeDisabledError } from './content-campaign-composition.ts';
import { createEnabledM5PaperclipSystemControl } from './m5-paperclip-system-control-composition.ts';

type PaperclipControlCampaigns = Readonly<{
  activateScheduledDay(): unknown;
  reconcileParallelWork(caseId: unknown): unknown;
}>;

export type PaperclipSystemControlCompositionInput = Readonly<{
  m5RuntimeEnabled?: boolean;
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

export async function createPaperclipSystemControlComposition({
  m5RuntimeEnabled = true,
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
  if (!m5RuntimeEnabled) {
    return disabledM5ControlPlane(paperclipHeartbeat);
  }

  return createEnabledM5PaperclipSystemControl({
    governance,
    campaigns,
    publisherBindings,
    paperclipCurrentRunScope,
    paperclipHeartbeat,
  });
}

function disabledM5ControlPlane(paperclipHeartbeat: unknown) {
  const reject = async () => { throw new M5RuntimeDisabledError(); };
  const handler = Object.freeze({ handle:reject });
  const runContext = Object.freeze({ resolve:reject });
  const runScope = Object.freeze({ run:reject });
  return Object.freeze({
    paperclipHeartbeat,
    paperclipCampaignDaily:handler,
    paperclipParallelWork:handler,
    paperclipMetricRunContext:runContext,
    paperclipMetricMonitor:handler,
    paperclipCurrentRunScope:runScope,
    paperclipPublisherRunContext:runContext,
    paperclipPublisherController:handler,
    paperclipRetrospective:handler,
    paperclipLearningLifecycle:handler,
    canonicalPaperclipHeartbeat:(heartbeat: unknown) => heartbeat,
  });
}
