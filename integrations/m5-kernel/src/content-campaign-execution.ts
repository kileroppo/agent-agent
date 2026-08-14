import {
  ContentCampaignError,
  requireActiveCampaignGrant as requireActiveGrant,
} from './campaign-domain.ts';
export { ContentCampaignError } from './campaign-domain.ts';
import { safeReceiptId } from './content-campaign-primitives.ts';
import { campaignExecutionRouteMethods } from './campaign-execution-router.ts';
import { campaignExecutionReplayMethods } from './campaign-execution-replay.ts';
import { campaignExecutionPlanningMethods } from './campaign-execution-planning.ts';
type DynamicRecord = Record<string, any>;
type CampaignExecutionMethod = (this: DynamicRecord, ...args: any[]) => any;

export const contentCampaignExecutionMethods: Record<string, CampaignExecutionMethod> = {
  async executeTool(input = {}, authentication = {}) {
    if (!this.toolExecutor?.execute) throw new ContentCampaignError('内容插件尚未通过安装门禁，工具调用保持关闭。');
    const caseItem = await this.getRawCase(input.campaignId);
    requireActiveGrant(caseItem, this.now());
    const {
      campaignId:_campaignId,
      campaignCaseId:_campaignCaseId,
      campaignCase:_campaignCase,
      campaignGrant:_campaignGrant,
      ...toolInput
    } = input;
    return this.toolExecutor.execute({
      ...toolInput,
      campaignCaseId:caseItem.id,
    }, authentication);
  },

  ...campaignExecutionRouteMethods,
  ...campaignExecutionReplayMethods,
  ...campaignExecutionPlanningMethods,
  async getPublishReceipt(receiptId) {
    if (!this.publisher?.getReceipt) throw new ContentCampaignError('Publisher Gateway 尚未启用，当前没有可读取的发布凭证。');
    return this.publisher.getReceipt(safeReceiptId(receiptId));
  }
};
