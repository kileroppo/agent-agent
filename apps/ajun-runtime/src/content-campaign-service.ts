import { ContentCampaignError, ContentCampaignKernel, } from '@agent-army/m5-kernel';
import { PaperclipM5ControlPlane } from '@agent-army/m5-kernel';
import { normalizePaperclipCase, normalizePaperclipWorkProduct, } from '@agent-army/m5-kernel';
import { createFakeM5ControlPlane } from '@agent-army/m5-kernel';
import { requireActiveCampaignGrant } from '@agent-army/m5-kernel/campaign-domain';
export { ContentCampaignError };
/**
 * A君 compatibility facade. Campaign/Case ownership belongs to the M5 kernel;
 * A君 only binds its execution and Paperclip adapters to that interface.
 */
export class ContentCampaignService extends ContentCampaignKernel {
    constructor({ adapter, definition, controlPlane = null, ...ports }: any = {}) {
        const resolvedControlPlane: any = controlPlane || (typeof adapter?.request === 'function'
            ? new PaperclipM5ControlPlane({ endpoint: adapter, definition })
            : createFakeM5ControlPlane());
        super({
            ...ports,
            definition,
            controlPlane: resolvedControlPlane,
        });
    }
    m5StageToolParameters(input: any = {}): any {
        return super.m5StageToolParameters({
            ...input,
            campaignCase: normalizePaperclipCase(input.campaignCase) || input.campaignCase,
            targetCase: normalizePaperclipCase(input.targetCase) || input.targetCase,
            outputs: (input.outputs || []).map(normalizePaperclipWorkProduct).filter(Boolean),
        });
    }
    executeM5MachineReview(input: any = {}): any {
        return super.executeM5MachineReview({
            ...input,
            campaignCase: normalizePaperclipCase(input.campaignCase) || input.campaignCase,
            targetCase: normalizePaperclipCase(input.targetCase) || input.targetCase,
            outputs: (input.outputs || []).map(normalizePaperclipWorkProduct).filter(Boolean),
        });
    }
    async executeTool(input: any = {}, authentication: any = {}): Promise<any> {
        if (!this.toolExecutor?.execute) {
            throw new ContentCampaignError('内容插件尚未通过安装门禁，工具调用保持关闭。');
        }
        const rawCase: any = await this.getRawCase(input.campaignId);
        const caseItem: any = normalizePaperclipCase(rawCase) || rawCase;
        requireActiveCampaignGrant(caseItem, this.now());
        const { campaignId: _campaignId, campaignCaseId: _campaignCaseId, campaignCase: _campaignCase, campaignGrant: _campaignGrant, ...toolInput } = input;
        return this.toolExecutor.execute({ ...toolInput, campaignCaseId: caseItem.id }, authentication);
    }
    assertReplayableM5WorkProduct(input: any = {}): any {
        return super.assertReplayableM5WorkProduct({
            ...input,
            product: normalizePaperclipWorkProduct(input.product),
            outputs: (input.outputs || []).map(normalizePaperclipWorkProduct).filter(Boolean),
        });
    }
}
