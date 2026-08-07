import {
  ContentCampaignError,
} from './campaign-domain.js';
export { ContentCampaignError } from './campaign-domain.js';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  validM5RouteExecution,
} from './route-execution.js';

const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';

import { campaignWorkProductLineage } from './campaign-work-product-lineage.js';
import { campaignDeliveryValidation } from './campaign-delivery-validation.js';

export const {
  artifacts:{
    read:workProductArtifact,
    replay:replayM5StageWorkProduct,
    data:artifactData,
  },
  publishing:{ verifyReceipt:verifyPublishReceiptArtifact },
  workspace:{
    safeRelativePath:safeWorkspaceRelativePath,
    visualAssets:verifiedM5VisualAssets,
    generatedVisual:verifiedM5GeneratedVisual,
  },
  manifest:{ videos:m5ArtifactPackageVideos, sources:m5SourcesLedger },
  provider:{
    provenance:m5ProviderProvenance,
    confirmReceipt:confirmedM5ProviderReceipt,
    assertReplayReceipt:assertReplayProviderReceipt,
  },
  drift:m5WorkProductDrift,
} = campaignWorkProductLineage;

export const {
  script:{
    optionalVariants:optionalM5GrayScriptVariants,
    requireVariants:requireM5GrayScriptVariants,
    hash:m5ScriptHash,
    assertGrayTarget:assertM5GrayTargetBinding,
  },
  voice:{
    confirmVariant:confirmedM5VoiceVariant,
    assertCompleteVariants:assertCompleteM5GrayVoiceVariants,
  },
  render:{
    platformKey:renderPlatformKey,
    optionalGrayLineage:optionalM5GrayRenderLineage,
    optionalBaselineLineage:optionalM5BaselineRenderLineage,
    baselineLineage:m5BaselineRenderLineage,
    variantDescriptor:m5RenderVariantDescriptor,
    hasVariantLineage:hasM5VariantLineage,
    assertOutputLineage:assertM5RenderOutputLineage,
    buildProps:buildM5RenderProps,
  },
  socialCard:{
    buildProps:buildM5SocialCardProps,
    validReceipt:validM5SocialCardPackageReceipt,
  },
  template:{ resolve:resolveM5TemplateForRender },
  review:{ checks:deterministicM5ReviewChecks },
} = campaignDeliveryValidation;

export function positiveVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

export function boundedDurationSeconds(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 1 && duration <= 600 ? duration : 45;
}

export function selectRenderOutput(renderPackage, platform) {
  const selected = renderPackage?.outputs?.[platform];
  return selected && typeof selected === 'object' && !Array.isArray(selected)
    ? selected
    : renderPackage;
}

export function m5HermesRouteExecution({
  assignment,
  task,
  contract,
  strategy,
  toolIds,
  inputs,
}) {
  const recovery = task?.input?.context?.m5Recovery || null;
  const previousExecution = validM5RouteExecution(task?.execution?.m5RouteExecution)
    ? task.execution.m5RouteExecution
    : null;
  const execution = createM5RouteExecution({
    runId:assignment?.runId || task?.execution?.paperclipRunId,
    stageKey:contract.stageKey,
    recovery,
    previousExecution,
    strategy,
    toolIds,
    inputs,
  });
  if (recovery) {
    try {
      assertChangedM5RecoveryRoute(execution, recovery);
    } catch (error) {
      if (error && typeof error === 'object') error.m5RouteExecution = execution;
      throw error;
    }
  }
  return execution;
}

export function m5HermesStrategy(task, contract) {
  return task?.input?.context?.m5Recovery?.nextRoute?.kind
    || `default:${contract.pluginEntryTool || contract.deterministicEntry}`;
}

export function m5HermesStageToolIds(contract) {
  if (contract.stageKey === 'render') {
    return [
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:remotion-props-write`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:remotion-render`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:social-card-render`,
    ];
  }
  if (contract.stageKey === 'machine_review') {
    return [
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:media-validate`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:subtitle-layout-validate`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-package-write`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-lineage-validate`,
    ];
  }
  return [`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`];
}

export async function executeM5Route(routeExecution, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === 'object') {
      error.m5RouteExecution = routeExecution;
    }
    throw error;
  }
}

export function routeCaseInput(caseItem) {
  return {
    id:String(caseItem?.id || ''),
    version:Number(caseItem?.version) || 0,
    stageKey:String(caseItem?.stageKey || ''),
    campaignId:String(caseItem?.campaignId || ''),
    scheduledDate:String(caseItem?.scheduledDate || ''),
    platform:String(caseItem?.platform || ''),
  };
}

export function routeOutputHashes(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((item) => String(
      item?.artifactHash
      || item?.externalId
      || item?.id
      || '',
    ).trim())
    .filter(Boolean)
    .sort();
}
