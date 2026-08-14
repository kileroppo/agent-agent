import { M5_STEPFUN_MODELS, } from '@agent-army/m5-contracts';
import { ContentCampaignError, } from './campaign-domain.ts';
import { asList, safeText } from './content-campaign-primitives.ts';
const RECEIPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';
const M5_PROVIDER_MODELS = M5_STEPFUN_MODELS;
function workProductArtifact(output: any) {
    const artifactHash = String(output?.artifactHash || '');
    const sourceTaskId = String(output?.sourceTaskId || '').trim();
    const sourceArtifactId = String(output?.sourceArtifactId || '').trim();
    if (output?.recordKind !== 'work_product'
        || output?.type !== 'artifact'
        || !['agent-army.ajun-runtime', 'agent-army.content-autonomy', 'agent-army.publisher-gateway']
            .includes(output?.provider)
        || output?.sourceTrust != null
        || output?.status !== 'active'
        || output?.healthStatus !== 'healthy'
        || !/^agent\.army\/[a-z0-9-]+\/v\d+$/i.test(String(output?.schemaVersion || ''))
        || sourceTaskId.length === 0
        || sourceTaskId.length > 240
        || sourceArtifactId.length === 0
        || sourceArtifactId.length > 240
        || !/^sha256:[0-9a-f]{64}$/i.test(artifactHash)
        || (output.externalId && output.externalId !== artifactHash))
        return null;
    const value = output?.artifact?.data || output?.artifact || output?.receipt;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return {
        kind: String(output.artifactKind
            || output.artifact?.type
            || snakeKind(output.kind)).trim(),
        data: value,
    };
}
function replayM5StageWorkProduct(contract: any, product: any) {
    const artifactKind = contract.expectedWorkProduct.artifactKinds[0];
    const data = structuredClone(product?.artifact
        || product?.contentVersion
        || product?.reviewReport
        || {});
    return {
        toolId: contract.deterministicEntry === 'publish_receipt_verify'
            ? 'agent-army.m5:publish_receipt_verify'
            : `${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
        pluginId: contract.deterministicEntry === 'publish_receipt_verify'
            ? 'agent-army.m5-deterministic'
            : CONTENT_AUTONOMY_PLUGIN_KEY,
        content: `已复用当前 Case 的已验证 ${contract.expectedWorkProduct.type}，未再次执行阶段工具。`,
        artifact: {
            type: artifactKind,
            schemaVersion: contract.expectedWorkProduct.schemaVersion,
            data,
            validation: {
                exists: true,
                readable: true,
                nonEmpty: true,
                paperclipWorkProductVerified: true,
            },
        },
        replayed: true,
    };
}
function artifactData(artifacts: any, kinds: any) {
    const accepted = new Set(kinds);
    return artifacts.find((artifact: any) => accepted.has(artifact.kind))?.data || null;
}
function verifyPublishReceiptArtifact({ contract, targetCase, outputs }: any) {
    const receipts = outputs
        .filter((output: any) => output?.recordKind === 'work_product'
        && output?.type === 'artifact'
        && output?.provider === 'agent-army.publisher-gateway'
        && output?.sourceTrust == null
        && output?.status === 'active'
        && output?.healthStatus === 'healthy'
        && output?.schemaVersion === 'agent.army/publish-receipt/v1'
        && output?.kind === 'PublishReceipt')
        .map((output: any) => output.receipt)
        .filter((receipt: any) => receipt && typeof receipt === 'object' && !Array.isArray(receipt));
    if (receipts.length !== 1) {
        throw new ContentCampaignError(`发布核验必须且只能读取一个可信 PublishReceipt，当前为 ${receipts.length} 个。`);
    }
    const receipt = receipts[0];
    const platform = String(targetCase?.platform || '').trim();
    const scheduledDate = String(targetCase?.scheduledDate || '').trim();
    if (!RECEIPT_ID.test(String(receipt.receiptId || ''))
        || receipt.platform !== platform
        || receipt.scheduledDate !== scheduledDate
        || !String(receipt.contentVersionId || '').trim()
        || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(receipt.contentChecksum || ''))
        || !String(receipt.externalContentId || '').trim()
        || !String(receipt.evidence || '').trim()
        || !Number.isFinite(Date.parse(receipt.publishedAt))) {
        throw new ContentCampaignError('PublishReceipt 与当前 Case 不一致或缺少平台内容ID、成功证据、版本血缘。');
    }
    const data = {
        status: 'passed',
        receiptId: receipt.receiptId,
        platform,
        scheduledDate,
        contentVersionId: receipt.contentVersionId,
        contentChecksum: receipt.contentChecksum,
        externalContentId: receipt.externalContentId,
        evidence: receipt.evidence,
        publishedAt: receipt.publishedAt,
    };
    return {
        toolId: 'agent-army.m5:publish_receipt_verify',
        pluginId: 'agent-army.m5-deterministic',
        content: '发布凭证与当前 Case 已完成确定性核验。',
        artifact: {
            type: contract.expectedWorkProduct.artifactKinds[0],
            schemaVersion: contract.expectedWorkProduct.schemaVersion,
            data,
            validation: { exists: true, readable: true, nonEmpty: true, receiptVerified: true },
        },
    };
}
function snakeKind(value: any) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-z0-9]+/gi, '_')
        .toLowerCase()
        .replace(/^_+|_+$/g, '');
}
function safeWorkspaceRelativePath(value: any) {
    const relative = String(value || '').trim().replaceAll('\\', '/');
    if (!relative
        || relative.startsWith('/')
        || relative.split('/').some((segment: any) => !segment || segment === '.' || segment === '..'))
        return null;
    return relative;
}
function verifiedM5VisualAssets(assetPackage: any) {
    const assets = Array.isArray(assetPackage?.assets) ? assetPackage.assets : [];
    return assets.slice(0, 12).flatMap((asset: any) => {
        const relativePath = safeWorkspaceRelativePath(asset?.relativePath);
        const checksum = String(asset?.checksum || '').trim().toLowerCase();
        if (!relativePath
            || !/\.(?:jpe?g|png|webp)$/i.test(relativePath)
            || !/^sha256:[0-9a-f]{64}$/i.test(checksum)
            || !Number.isInteger(Number(asset?.bytes))
            || Number(asset.bytes) <= 0)
            return [];
        return [{
                frameId: safeText(asset?.frameId, 80) || 'verified-frame',
                relativePath,
                checksum,
                bytes: Number(asset.bytes),
            }];
    });
}
function verifiedM5GeneratedVisual(generatedImage: any) {
    const relativePath = safeWorkspaceRelativePath(generatedImage?.relativePath);
    const checksum = String(generatedImage?.checksum || '').trim().toLowerCase();
    if (generatedImage?.model !== 'step-image-edit-2'
        || !relativePath
        || !/\.(?:jpe?g|png|webp)$/i.test(relativePath)
        || !/^sha256:[0-9a-f]{64}$/i.test(checksum)
        || !Number.isInteger(Number(generatedImage?.bytes))
        || Number(generatedImage.bytes) <= 0)
        return null;
    return {
        frameId: 'stepfun-generated-visual',
        relativePath,
        checksum,
        bytes: Number(generatedImage.bytes),
    };
}
function m5ArtifactPackageVideos(renderPackage: any) {
    const expected = ['master', 'douyin', 'xiaohongshu'];
    const videos = Object.fromEntries(expected.map((platform: any) => {
        const render = renderPackage?.outputs?.[platform];
        const relativePath = safeWorkspaceRelativePath(render?.relativePath || render?.outputPath);
        const checksum = String(render?.checksum || '').trim().toLowerCase();
        if (!relativePath || !/^sha256:[0-9a-f]{64}$/i.test(checksum)) {
            throw new ContentCampaignError(`固定产物包缺少可信 ${platform} 成片回执。`);
        }
        return [platform, { path: relativePath, checksum }];
    }));
    return videos;
}
function m5SourcesLedger({ evidence, assetPackage, generatedImage, voice, fixtureProvenance = null, }: any) {
    const sources = asList(evidence?.sources).slice(0, 50).map((source: any, index: any) => ({
        ref: safeText(source?.url || source?.source || source?.ref || source?.sourceId || `source-${index + 1}`, 500),
        kind: safeText(source?.kind || source?.sourceType || 'verified_source', 80),
        fetchedAt: safeText(source?.fetchedAt, 120),
        contentHash: safeText(source?.contentHash, 80),
    })).filter((source: any) => source.ref && source.kind);
    if (sources.length < 2
        || sources.some((source: any) => source.kind === 'github_metadata'
            || !Number.isFinite(Date.parse(source.fetchedAt))
            || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(source.contentHash))) {
        throw new ContentCampaignError('固定产物来源账本至少需要两个可信来源。');
    }
    const sourceUrl = safeText(assetPackage?.sourceUrl, 500);
    const rightsBasis = safeText(assetPackage?.rightsBasis, 200);
    const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
    const narrationPath = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
    if (!generatedVisual || !narrationPath) {
        throw new ContentCampaignError('固定产物来源账本缺少可信生成图片或旁白路径。');
    }
    if (fixtureProvenance) {
        return {
            sources,
            thirdPartyMedia: sourceUrl
                ? [{ ref: sourceUrl, rightsBasis }]
                : [],
            aiGeneratedMedia: [],
            fixtureProvenance,
        };
    }
    return {
        sources,
        thirdPartyMedia: sourceUrl
            ? [{ ref: sourceUrl, rightsBasis }]
            : [],
        aiGeneratedMedia: [{
                ref: generatedVisual.relativePath,
                sourceChecksum: generatedVisual.checksum,
                model: generatedImage.model,
            }],
        narration: {
            provider: 'StepFun',
            model: voice.model,
            checksum: String(voice.checksum || '').trim().toLowerCase(),
            ref: narrationPath,
        },
    };
}
function m5ProviderProvenance({ generatedImage, visualAnalysis, voice, allowLocalFixtureProvenance, }: any) {
    const stepFunDeclared = generatedImage?.model === 'step-image-edit-2'
        || voice?.model === 'stepaudio-2.5-tts'
        || asList(visualAnalysis?.insights).some((item: any) => item?.evidenceKind === 'stepfun_vision_frame')
        || visualAnalysis?.providerReceipt?.model === 'step-3.7-flash';
    if (!stepFunDeclared)
        return { actionRefs: null, fixtureProvenance: null };
    const fixtureEntries = [generatedImage, visualAnalysis, voice]
        .map((item: any) => item?.fixtureProvenance);
    if (allowLocalFixtureProvenance
        && fixtureEntries.every(validM5FixtureProvenance)
        && new Set(fixtureEntries.map((item: any) => item.fixtureId)).size === 1) {
        return {
            actionRefs: null,
            fixtureProvenance: {
                kind: 'local_fixture',
                fixtureId: fixtureEntries[0].fixtureId,
                externalSideEffects: 0,
            },
        };
    }
    let image;
    let vision;
    let tts;
    try {
        image = confirmedM5ProviderReceipt(generatedImage?.providerReceipt, 'image_generate');
        vision = confirmedM5ProviderReceipt(visualAnalysis?.providerReceipt, 'vision');
        tts = confirmedM5ProviderReceipt(voice?.providerReceipt || voice, 'tts');
    }
    catch {
        throw new ContentCampaignError('机器审核发现 StepFun 图片、视觉或配音，但缺少可由内容插件同 Project 状态反查的三条 confirmed action/cost 血缘；活动保持 blocked。');
    }
    return {
        actionRefs: {
            image: image.actionId,
            vision: vision.actionId,
            tts: tts.actionId,
        },
        fixtureProvenance: null,
    };
}
function confirmedM5ProviderReceipt(value: any, expectedOperation: any) {
    const actionId = String(value?.actionId || '').trim();
    const operation = String(value?.operation || '').trim();
    const callRecord = value?.callRecord;
    const costCommit = value?.costCommit;
    const expectedModel = (M5_PROVIDER_MODELS as Record<string, string>)[expectedOperation];
    if (!expectedModel
        || !/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)
        || operation !== expectedOperation
        || value?.model !== expectedModel
        || callRecord?.actionId !== actionId
        || callRecord?.operation !== expectedOperation
        || callRecord?.model !== expectedModel
        || !/^sha256:[0-9a-f]{64}$/i.test(String(callRecord?.promptChecksum || ''))
        || costCommit?.status !== 'confirmed'
        || !RECEIPT_ID.test(String(costCommit?.costEventId || ''))
        || costCommit?.costEvent?.provider !== 'stepfun'
        || !Number.isInteger(Number(costCommit?.costEvent?.costCents))
        || Number(costCommit.costEvent.costCents) <= 0) {
        throw new ContentCampaignError(`StepFun ${expectedOperation} 回执尚未确认费用或血缘字段不完整。`);
    }
    return {
        actionId,
        operation,
        model: value.model,
        callRecord: {
            actionId,
            operation,
            model: value.model,
            promptChecksum: String(callRecord.promptChecksum).toLowerCase(),
            ...(callRecord.costEvent && typeof callRecord.costEvent === 'object' ? {
                costEvent: {
                    provider: 'stepfun',
                    projectId: String(callRecord.costEvent.projectId || '').trim(),
                    heartbeatRunId: String(callRecord.costEvent.heartbeatRunId || '').trim(),
                    costCents: Number(callRecord.costEvent.costCents),
                },
            } : {}),
        },
        costCommit: {
            status: 'confirmed',
            costEventId: String(costCommit.costEventId),
            costEvent: {
                provider: 'stepfun',
                projectId: String(costCommit.costEvent.projectId || '').trim(),
                heartbeatRunId: String(costCommit.costEvent.heartbeatRunId || '').trim(),
                costCents: Number(costCommit.costEvent.costCents),
            },
        },
    };
}
function assertReplayProviderReceipt(value: any, { operation, projectId, sourceRunId }: any) {
    let receipt;
    try {
        receipt = confirmedM5ProviderReceipt(value, operation);
    }
    catch {
        throw m5WorkProductDrift({ stageKey: operation }, `StepFun ${operation} action 不是 confirmed`);
    }
    const callCost = receipt.callRecord?.costEvent;
    const commitCost = receipt.costCommit?.costEvent;
    if (callCost?.provider !== 'stepfun'
        || commitCost?.provider !== 'stepfun'
        || callCost.projectId !== projectId
        || commitCost.projectId !== projectId
        || callCost.heartbeatRunId !== sourceRunId
        || commitCost.heartbeatRunId !== sourceRunId
        || callCost.costCents !== commitCost.costCents) {
        throw m5WorkProductDrift({ stageKey: operation }, `StepFun ${operation} action 的 Project、source Run 或费用状态漂移`);
    }
    return receipt;
}
function m5WorkProductDrift(contract: any, detail: any) {
    const error = new ContentCampaignError(`M5 ${contract?.stageKey || '阶段'} Work Product 漂移：${detail}；禁止重放或覆盖。`);
    (error as any).code = 'work_product_drift';
    (error as any).retryable = false;
    return error;
}
function validM5FixtureProvenance(value: any) {
    return value?.kind === 'local_fixture'
        && /^[A-Za-z0-9:_-]{8,120}$/.test(String(value?.fixtureId || ''))
        && value?.externalSideEffects === 0;
}
export const campaignWorkProductLineage = Object.freeze({
    artifacts: Object.freeze({
        read: workProductArtifact,
        replay: replayM5StageWorkProduct,
        data: artifactData,
    }),
    publishing: Object.freeze({
        verifyReceipt: verifyPublishReceiptArtifact,
    }),
    workspace: Object.freeze({
        safeRelativePath: safeWorkspaceRelativePath,
        visualAssets: verifiedM5VisualAssets,
        generatedVisual: verifiedM5GeneratedVisual,
    }),
    manifest: Object.freeze({
        videos: m5ArtifactPackageVideos,
        sources: m5SourcesLedger,
    }),
    provider: Object.freeze({
        provenance: m5ProviderProvenance,
        confirmReceipt: confirmedM5ProviderReceipt,
        assertReplayReceipt: assertReplayProviderReceipt,
        validFixture: validM5FixtureProvenance,
    }),
    drift: m5WorkProductDrift,
});
