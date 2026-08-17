import crypto from 'node:crypto';
import path from 'node:path';

const SCHEMA_VERSION = 'agent.army/product-maturity-runtime-boundary/v1';

export function productMaturityDisabledState() {
  return Object.freeze({
    status:'disabled',
    code:'m5_runtime_disabled',
    detail:'产品成熟度验证属于 M5 管理工具，当前未启用。',
    recommendedAction:'需要运行验证时，请显式设置 AJUN_M5_RUNTIME_ENABLED=true 后重新发布 A君。',
  });
}

export async function createProductMaturityRuntime({
  store,
  missions,
  policy,
  dataDir,
  projectRoot,
  campaigns,
  publisher,
}: any) {
  const { CapabilityAcceptanceBundle } = await import('../workflow/capability-acceptance-bundle.ts');
  return new CapabilityAcceptanceBundle({
    store,
    missions,
    policy,
    ledgerPath:path.join(dataDir, 'product-maturity-validation-batches.json'),
    projectRoot,
    runtimeBoundarySnapshot:() => readProductMaturityRuntimeBoundary({ campaigns, publisher }),
  });
}

export async function readProductMaturityRuntimeBoundary({ campaigns, publisher }: any = {}) {
  if (typeof campaigns !== 'function'
    || typeof publisher?.getSafetyStatus !== 'function') {
    throw new Error('产品成熟度运行边界缺少活动或发布器只读状态接口。');
  }
  const campaignService = await campaigns();
  if (typeof campaignService?.list !== 'function'
    || typeof campaignService?.getDailyRoutineTrigger !== 'function') {
    throw new Error('产品成熟度运行边界缺少活动列表或每日触发器只读接口。');
  }
  const [campaignRows, dailyRoutine, publisherStatus] = await Promise.all([
    campaignService.list(),
    campaignService.getDailyRoutineTrigger(),
    publisher.getSafetyStatus(),
  ]);
  if (!Array.isArray(campaignRows)
    || typeof dailyRoutine?.enabled !== 'boolean'
    || typeof publisherStatus?.active !== 'boolean') {
    throw new Error('产品成熟度运行边界状态未知，已停止验收。');
  }
  const revision = crypto.createHash('sha256').update(JSON.stringify({
    publisher:{
      active:publisherStatus.active,
      reason:String(publisherStatus.reason || ''),
      activatedAt:String(publisherStatus.activatedAt || ''),
    },
    campaigns:campaignRows.map((campaign: any) => ({
      id:String(campaign?.campaignId || campaign?.caseKey || ''),
      status:String(campaign?.status || 'unknown'),
    })).sort((left: any, right: any) => `${left.id}:${left.status}`.localeCompare(`${right.id}:${right.status}`)),
    cron:{
      id:String(dailyRoutine.id || ''),
      enabled:dailyRoutine.enabled,
    },
  })).digest('hex');
  return Object.freeze({
    schemaVersion:SCHEMA_VERSION,
    revision,
    publisher:Object.freeze({ disabled:publisherStatus.active === false }),
    campaigns:Object.freeze({
      activeCount:campaignRows.filter((campaign: any) => campaign?.status === 'active').length,
    }),
    cron:Object.freeze({ disabled:dailyRoutine.enabled === false }),
  });
}
