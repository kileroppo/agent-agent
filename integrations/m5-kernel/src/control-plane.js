/**
 * Canonical M5 control-plane interface.
 *
 * Implementations must return normalized records. Kernel callers never need to
 * know Paperclip URL paths, response envelopes, `fields`, or `metadata`.
 */
export class M5ControlPlane {
  constructor() {
    if (new.target === M5ControlPlane) {
      throw new TypeError('M5ControlPlane 只能由具体 Adapter 实现。');
    }
  }
}

export function assertM5ControlPlane(value) {
  const required = [
    'findPipelineByKey',
    'getPipeline',
    'listPipelineCases',
    'getCase',
    'getCaseOutputs',
    'transitionCase',
    'updateCampaignGrant',
    'ingestCampaignDraft',
    'ingestCampaignExecution',
    'ensureParallelWorkCases',
    'listIssueRuns',
    'verifyProviderAction',
    'findCostActivity',
    'getBudgetOverview',
    'inspectExecutionReadiness',
    'getDailySchedule',
    'setDailyScheduleEnabled',
  ];
  const missing = required.filter((name) => typeof value?.[name] !== 'function');
  if (missing.length) {
    throw new TypeError(`M5ControlPlane 缺少 Interface：${missing.join('、')}。`);
  }
  return value;
}

export function createFakeM5ControlPlane(overrides = {}) {
  const unsupported = (name) => async () => {
    throw new Error(`Fake M5ControlPlane 未实现 ${name}`);
  };
  const methods = [
    'findPipelineByKey', 'getPipeline', 'listPipelineCases', 'getCase',
    'getCaseOutputs', 'transitionCase', 'updateCampaignGrant',
    'ingestCampaignDraft', 'ingestCampaignExecution', 'ensureParallelWorkCases',
    'listIssueRuns', 'verifyProviderAction', 'findCostActivity',
    'getBudgetOverview', 'inspectExecutionReadiness', 'getDailySchedule',
    'setDailyScheduleEnabled', 'getCaseChildren', 'listCaseEvents',
    'getOfficialTtsVoice', 'getPublishReceipt',
  ];
  return Object.assign(
    Object.fromEntries(methods.map((name) => [name, unsupported(name)])),
    { companyId:'fake-company', ...overrides },
  );
}
