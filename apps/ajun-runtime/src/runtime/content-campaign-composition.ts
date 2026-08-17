import { PaperclipBridge } from '../paperclip-bridge.ts';
import { StepFunModelPolicyService } from '../stepfun-model-policy-service.ts';
import type { ContentCampaignCompositionInput } from './composition-contracts.ts';
import { createEnabledM5ContentCampaignComposition } from './m5-content-campaign-composition.ts';

export async function createContentCampaignComposition({
  enabled = true,
  environment,
  dataDir,
  hermesProfileRoot,
  contentWorkspaceDir,
  taskRunEvents = null,
  resolveTaskIdForPaperclipCase = null,
}: ContentCampaignCompositionInput) {
  const modelPolicy = await StepFunModelPolicyService.open({ dataDir, profileRoot:hermesProfileRoot });
  if (!enabled) {
    const governance = new PaperclipBridge({ modelPolicy });
    const disabled = () => Promise.reject(new M5RuntimeDisabledError());
    return Object.freeze({
      enabled:false,
      governance,
      modelPolicy,
      campaigns:disabled,
      executeProviderVision:disabled,
      paperclipCurrentRunScope:null,
      publisherBindings:null,
      templateResolver:null,
    });
  }

  const governance = new PaperclipBridge({ modelPolicy });
  return createEnabledM5ContentCampaignComposition({
    enabled:true,
    environment,
    dataDir,
    hermesProfileRoot,
    contentWorkspaceDir,
    taskRunEvents,
    resolveTaskIdForPaperclipCase,
    governance,
    modelPolicy,
  });
}

export class M5RuntimeDisabledError extends Error {
  httpStatus = 503;

  code = 'm5_runtime_disabled';

  constructor() {
    super('M5 内容活动当前未启用。需要使用时，请显式设置 AJUN_M5_RUNTIME_ENABLED=true 后重新发布 A君。');
    this.name = 'M5RuntimeDisabledError';
  }
}
