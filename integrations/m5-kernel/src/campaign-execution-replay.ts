import { M5_STEPFUN_MODELS } from '@agent-army/m5-contracts';
import { ContentCampaignError } from './campaign-domain.ts';
import { assertM5WorkspaceArtifact, M5WorkspaceArtifactError, validM5WorkProductArtifactHash, } from './work-product-integrity.ts';
import { asList } from './content-campaign-primitives.ts';
import { workProductArtifact, artifactData, safeWorkspaceRelativePath, verifiedM5GeneratedVisual, assertReplayProviderReceipt, m5WorkProductDrift, requireM5GrayScriptVariants, optionalM5GrayRenderLineage, optionalM5BaselineRenderLineage, hasM5VariantLineage, assertM5RenderOutputLineage, assertCompleteM5GrayVoiceVariants, validM5SocialCardPackageReceipt, } from './content-campaign-execution-support.ts';
const RECEIPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const M5_PROVIDER_MODELS = M5_STEPFUN_MODELS;
type CampaignMethod = (this: Record<string, any>, ...args: any[]) => any;
export const campaignExecutionReplayMethods: Record<string, CampaignMethod> = {
    async caseChain(caseId: any) {
        const chain = [];
        const visited = new Set();
        let current = await this.getAnyCase(caseId);
        for (let depth = 0; depth < 32 && current?.id && !visited.has(current.id); depth += 1) {
            chain.push(current);
            visited.add(current.id);
            if (!current.parentCaseId)
                return chain;
            current = await this.getAnyCase(current.parentCaseId);
        }
        throw new ContentCampaignError('M5 Pipeline Case 父子链无效或存在循环。');
    },
    async assertReplayableM5WorkProduct({ contract, product, targetCaseId, projectId, assignment, task, outputs = [], paperclipRuns = null, }: any) {
        const data = product?.artifact;
        const sourceRunId = String(product?.sourceRunId || '').trim();
        const sourceTaskId = String(product?.sourceTaskId || '').trim();
        const sourceIssueId = String(product?.sourceIssueId || '').trim();
        if (!product
            || !data
            || typeof data !== 'object'
            || Array.isArray(data)
            || product.pipelineCaseId !== targetCaseId
            || !String(projectId || '').trim()
            || product.projectId !== projectId
            || !sourceRunId
            || product?.createdByRunId !== sourceRunId
            || !sourceTaskId
            || sourceTaskId !== String(task?.taskId || '').trim()
            || !sourceIssueId
            || sourceIssueId !== String(assignment?.issueId || '').trim()
            || !validM5WorkProductArtifactHash(product)) {
            throw m5WorkProductDrift(contract, 'Issue、Case、Project、source Run 或 artifactHash 不一致');
        }
        const sourceRuns = paperclipRuns == null
            ? await this.controlPlane.listIssueRuns(sourceIssueId).catch(() => [])
            : asList(paperclipRuns);
        const sourceRun = sourceRuns.find((run: any) => String(run?.id || run?.runId || '').trim() === sourceRunId);
        if (!sourceRun || !['running', 'succeeded', 'completed'].includes(String(sourceRun.status || '').trim().toLowerCase())) {
            throw m5WorkProductDrift(contract, 'source Run 不属于同一 Issue 或状态不可复用');
        }
        const stageKey = contract.stageKey;
        if (stageKey === 'parallel_image_generation') {
            if (!verifiedM5GeneratedVisual(data)) {
                throw m5WorkProductDrift(contract, 'GeneratedImagePackage 字段无效');
            }
            await this.assertReplayProviderReceipt(data.providerReceipt, {
                operation: 'image_generate',
                projectId,
                sourceRunId,
                sourceRun,
                contract,
            });
            await this.assertWorkspaceReplayFile(data.relativePath, data.checksum, data.bytes, contract);
        }
        else if (stageKey === 'voice') {
            if (data.model !== 'stepaudio-2.5-tts'
                || !safeWorkspaceRelativePath(data.relativePath)
                || !/^sha256:[0-9a-f]{64}$/i.test(String(data.checksum || ''))) {
                throw m5WorkProductDrift(contract, 'VoicePackage 文件回执无效');
            }
            await this.assertReplayProviderReceipt(data.providerReceipt || data, {
                operation: 'tts',
                projectId,
                sourceRunId,
                sourceRun,
                contract,
            });
            await this.assertWorkspaceReplayFile(data.relativePath, data.checksum, data.bytes, contract);
            if (data.variants != null) {
                const scriptPackage = artifactData(outputs.map(workProductArtifact).filter(Boolean), ['video_script_package', 'script_package']);
                const scriptVariants = requireM5GrayScriptVariants(scriptPackage);
                assertCompleteM5GrayVoiceVariants(data.variants, scriptVariants);
                for (const variantKey of ['baseline', 'gray_douyin']) {
                    const voiceVariant = data.variants[variantKey];
                    await this.assertReplayProviderReceipt(voiceVariant.providerReceipt, {
                        operation: 'tts',
                        projectId,
                        sourceRunId,
                        sourceRun,
                        contract,
                    });
                    await this.assertWorkspaceReplayFile(voiceVariant.relativePath, voiceVariant.checksum, voiceVariant.bytes, contract);
                }
            }
        }
        else if (stageKey === 'assets') {
            const assets = asList(data.assets);
            if (!assets.length) {
                throw m5WorkProductDrift(contract, 'AssetPackage 缺少可核验的真实资产');
            }
            for (const asset of assets as any[]) {
                await this.assertWorkspaceReplayFile(asset?.relativePath, asset?.checksum, asset?.bytes, contract);
            }
        }
        else if (stageKey === 'visual_analysis') {
            await this.assertReplayProviderReceipt(data.providerReceipt, {
                operation: 'vision',
                projectId,
                sourceRunId,
                sourceRun,
                contract,
            });
            await this.assertWorkspaceReplayFile(data.providerReceipt?.sourcePath, data.providerReceipt?.sourceChecksum, null, contract);
        }
        else if (stageKey === 'render') {
            const artifacts = outputs.map(workProductArtifact).filter(Boolean);
            const scriptPackage = artifactData(artifacts, ['video_script_package', 'script_package']);
            const voicePackage = artifactData(artifacts, ['voice_package']);
            const grayLineage = optionalM5GrayRenderLineage(scriptPackage, voicePackage);
            const baselineLineage = grayLineage
                ? null
                : optionalM5BaselineRenderLineage(scriptPackage, voicePackage);
            for (const platform of ['master', 'douyin', 'xiaohongshu']) {
                const output = data.outputs?.[platform];
                if (!output)
                    throw m5WorkProductDrift(contract, `缺少 ${platform} 成片`);
                if (grayLineage) {
                    assertM5RenderOutputLineage(output, (grayLineage as any)[platform], platform);
                }
                else if (hasM5VariantLineage(output)) {
                    assertM5RenderOutputLineage(output, baselineLineage, platform);
                }
                await this.assertWorkspaceReplayFile(output.outputPath || output.relativePath, output.checksum, output.bytes, contract);
            }
            if (data.socialCardPackage != null) {
                const socialCards = data.socialCardPackage;
                if (!validM5SocialCardPackageReceipt(socialCards)) {
                    throw m5WorkProductDrift(contract, 'SocialCardPackage 字段无效');
                }
                await this.assertWorkspaceReplayFile(socialCards.propsPath, socialCards.propsChecksum, null, contract);
                await this.assertWorkspaceReplayFile(socialCards.manifestPath, socialCards.manifestChecksum, null, contract);
                for (const card of socialCards.cards) {
                    await this.assertWorkspaceReplayFile(card.relativePath, card.checksum, card.bytes, contract);
                }
            }
        }
        else if (stageKey === 'machine_review') {
            const review = data.reviewReport;
            const manifest = review?.evidence?.artifactPackage;
            if (review?.status !== 'passed' || asList(review?.failures).length) {
                throw m5WorkProductDrift(contract, 'MachineReview 未通过');
            }
            await this.assertWorkspaceReplayFile(manifest?.manifestPath, manifest?.manifestChecksum, null, contract);
        }
        else if (stageKey === 'platform_adapt') {
            const version = data.contentVersion || data;
            await this.assertWorkspaceReplayFile(version.mediaPath, version.checksum, null, contract);
        }
    },
    async assertWorkspaceReplayFile(relativePath: any, checksum: any, declaredBytes: any, contract: any) {
        try {
            return await assertM5WorkspaceArtifact({
                workspaceRoot: this.contentWorkspaceRoot,
                relativePath,
                checksum,
                declaredBytes,
            });
        }
        catch (error) {
            if (error instanceof M5WorkspaceArtifactError) {
                throw m5WorkProductDrift(contract, error.message);
            }
            throw error;
        }
    },
    async assertReplayProviderReceipt(value: any, { operation, projectId, sourceRunId, sourceRun, contract, }: any) {
        const receipt = assertReplayProviderReceipt(value, {
            operation,
            projectId,
            sourceRunId,
        });
        const expectedModel = (M5_PROVIDER_MODELS as Record<string, string>)[operation];
        const sourceAgentId = String(sourceRun?.agentId || '').trim();
        if (!expectedModel || !sourceAgentId || receipt.model !== expectedModel) {
            throw m5WorkProductDrift(contract, `StepFun ${operation} action 的固定模型或 source Agent 漂移`);
        }
        let verified;
        try {
            verified = await this.controlPlane.verifyProviderAction({
                actionId: receipt.actionId,
                costEventId: receipt.costCommit.costEventId,
                operation,
                runContext: {
                    agentId: sourceAgentId,
                    runId: sourceRunId,
                    companyId: this.controlPlane.companyId,
                    projectId,
                },
            });
        }
        catch {
            throw m5WorkProductDrift(contract, `StepFun ${operation} action 无法由内容插件原 Run 的只读 confirmed 状态证明`);
        }
        const expectedCost = receipt.costCommit.costEvent.costCents;
        if (verified?.confirmed !== true
            || verified.actionId !== receipt.actionId
            || verified.costEventId !== receipt.costCommit.costEventId
            || verified.operation !== operation
            || verified.provider !== 'stepfun'
            || verified.model !== expectedModel
            || verified.projectId !== projectId
            || verified.heartbeatRunId !== sourceRunId
            || verified.costCents !== expectedCost) {
            throw m5WorkProductDrift(contract, `StepFun ${operation} action 的权威 confirmed 回执不一致`);
        }
        let activity;
        try {
            activity = await this.controlPlane.findCostActivity({
                costEventId: receipt.costCommit.costEventId,
            });
        }
        catch {
            throw m5WorkProductDrift(contract, `StepFun ${operation} action 无法从 Paperclip 核心费用活动反查`);
        }
        if (!RECEIPT_ID.test(String(activity?.id || ''))
            || activity?.companyId !== this.controlPlane.companyId
            || !['user', 'agent'].includes(activity?.actorType)
            || !String(activity?.actorId || '').trim()
            || activity?.entityType !== 'cost_event'
            || activity?.entityId !== receipt.costCommit.costEventId
            || activity?.model !== expectedModel
            || Number(activity?.costCents) !== expectedCost
            || !Number.isFinite(Date.parse(String(activity?.createdAt || '')))) {
            throw m5WorkProductDrift(contract, `StepFun ${operation} action 缺少唯一匹配的 Paperclip 核心费用事件`);
        }
        return receipt;
    },
};
