import {
  PUBLISHER_COST_REPORTER_SCHEMA,
} from '../src/cost-reporting.js';

export function deterministicCostReporter({
  allowed = true,
  remainingAmountUsd = 6.25,
  budgetError = null,
  reportError = null,
} = {}) {
  const budgetCalls = [];
  const reportCalls = [];
  return {
    contract:{
      schemaVersion:PUBLISHER_COST_REPORTER_SCHEMA,
      deterministic:true,
      source:'paperclip-test',
    },
    budgetCalls,
    reportCalls,
    async assertCampaignBudget(input) {
      budgetCalls.push(structuredClone(input));
      if (budgetError) throw budgetError;
      return {
        campaignId:input.campaignId,
        allowed,
        hardStopEnabled:true,
        remainingAmountUsd,
      };
    },
    async recordConnectorAttempt(input) {
      reportCalls.push(structuredClone(input));
      if (reportError) throw reportError;
      return { reportRef:`paperclip:${input.costRecordId}` };
    },
  };
}

export function actualCost(operation, amountUsd = 0.01, suffix = operation) {
  return {
    amountUsd,
    providerRequestId:`douyin-request-${suffix}`,
    occurredAt:'2026-07-30T04:00:00.000Z',
  };
}

export function recordingCostRecorder() {
  const calls = [];
  return {
    calls,
    async recordOfficialTransportAttempt(input) {
      calls.push(structuredClone(input));
      return {
        replayed:false,
        record:{ ...structuredClone(input), state:'reported' },
      };
    },
  };
}
