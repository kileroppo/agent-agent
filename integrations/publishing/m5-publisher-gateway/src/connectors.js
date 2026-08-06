import crypto from 'node:crypto';
import { M5_PLATFORM_IDS } from '@agent-army/m5-contracts';
import { coded, STOP_REASONS } from './policy.js';

export class FakePlatformConnector {
  constructor(platform, scenarios = []) {
    this.platform = platform;
    this.connectorMode = 'fake';
    this.scenarios = [...scenarios];
    this.publishCalls = [];
    this.metricCalls = [];
  }

  async publish(request) {
    const { mediaLease:unusedLease, ...recordableRequest } = request;
    this.publishCalls.push(structuredClone(recordableRequest));
    const scenario = this.scenarios.shift() || { type:'success' };
    if (scenario.type === 'error') throw coded('fake_transport_failed', '假平台模拟传输失败。');
    if (scenario.type === 'stop') {
      if (!STOP_REASONS.includes(scenario.reason)) throw new Error('假平台停止原因无效。');
      return { state:'stopped', stopReason:scenario.reason, evidence:`fake://${this.platform}/stopped/${scenario.reason}` };
    }
    const suffix = crypto.createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 16);
    return {
      state:'published',
      externalContentId:`fake-${this.platform}-${suffix}`,
      evidence:`fake://${this.platform}/content/${suffix}`,
      accountRef:request.accountRef,
      publishedAt:scenario.publishedAt || new Date().toISOString()
    };
  }

  async readOwnMetrics(receipt, collectedAt) {
    this.metricCalls.push({ receiptId:receipt.receiptId, collectedAt });
    const hours = Math.max(0, Math.round((Date.parse(collectedAt) - Date.parse(receipt.publishedAt)) / 3_600_000));
    if (this.platform === M5_PLATFORM_IDS.XIAOHONGSHU) {
      return {
        views:100 + hours,
        likes:10 + Math.floor(hours / 2),
        comments:0,
        saves:5 + Math.floor(hours / 8),
      };
    }
    return {
      views:100 + hours,
      likes:10 + Math.floor(hours / 2),
      comments:0,
      shares:0,
      downloads:0,
      forwards:0,
    };
  }
}

export class DisabledRealConnector {
  constructor(platform) {
    this.platform = platform;
  }

  async publish() {
    throw coded('real_connector_disabled', `${this.platform} 真实发布连接器尚未获得单独批准。`);
  }

  async readOwnMetrics() {
    throw coded('real_connector_disabled', `${this.platform} 真实指标连接器尚未获得单独批准。`);
  }
}
