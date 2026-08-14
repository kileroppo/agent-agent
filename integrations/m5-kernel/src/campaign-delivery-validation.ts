import crypto from 'node:crypto';
import { M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
import { ContentCampaignError, } from './campaign-domain.ts';
import { M5ProductionTemplateResolutionError, defaultM5ProductionTemplateBinding, validM5ProductionTemplateBinding, } from './production-template-binding.ts';
import { asList, safeText } from './content-campaign-primitives.ts';
import { campaignWorkProductLineage } from './campaign-work-product-lineage.ts';
const { workspace: { safeRelativePath: safeWorkspaceRelativePath, visualAssets: verifiedM5VisualAssets, generatedVisual: verifiedM5GeneratedVisual, }, provider: { confirmReceipt: confirmedM5ProviderReceipt, validFixture: validM5FixtureProvenance, }, drift: m5WorkProductDrift, } = campaignWorkProductLineage;
const CASE_ID = /^[0-9a-f-]{8,80}$/i;
function renderPlatformKey(composition: any) {
    if (composition === 'M5Master')
        return 'master';
    if (composition === 'M5Douyin')
        return 'douyin';
    if (composition === 'M5Xiaohongshu')
        return 'xiaohongshu';
    throw new ContentCampaignError('M5 RenderPackage 包含未知 Composition。');
}
function optionalM5GrayScriptVariants(scriptPackage: any) {
    const variants = scriptPackage?.variants;
    if (variants == null)
        return null;
    if (!variants || typeof variants !== 'object' || Array.isArray(variants)) {
        throw new ContentCampaignError('ScriptPackage variants 必须是受控对象。');
    }
    const keys = Object.keys(variants).sort();
    if (keys.length === 1 && keys[0] === 'baseline')
        return null;
    return requireM5GrayScriptVariants(scriptPackage);
}
function requireM5GrayScriptVariants(scriptPackage: any) {
    const variants = scriptPackage?.variants;
    if (!variants
        || typeof variants !== 'object'
        || Array.isArray(variants)
        || JSON.stringify(Object.keys(variants).sort())
            !== JSON.stringify(['baseline', 'gray_douyin'])) {
        throw new ContentCampaignError('灰度 ScriptPackage 必须且只能包含 baseline 与 gray_douyin 两条完整变体。');
    }
    const baseline = validM5ScriptVariant(variants.baseline, 'baseline');
    const gray = validM5ScriptVariant(variants.gray_douyin, 'gray_douyin');
    const topLevelBinding = scriptPackage?.templateLifecycle?.templateBinding;
    if (scriptPackage.fullScript !== baseline.fullScript
        || !sameTemplateBinding(topLevelBinding, baseline.templateBinding)
        || baseline.templateBinding.source === 'approved_single_gray'
        || baseline.templateBinding.grayRelease === true
        || gray.templateBinding.source !== 'approved_single_gray'
        || gray.templateBinding.grayRelease !== true
        || gray.templateBinding.applicationScope !== 'full_content_variant'
        || baseline.scriptHash === gray.scriptHash
        || baseline.templateBinding.bindingHash === gray.templateBinding.bindingHash) {
        throw new ContentCampaignError('灰度 ScriptPackage 的 baseline 顶层兼容、模板范围或真实脚本差异不符合契约。');
    }
    return { baseline, gray_douyin: gray };
}
function validM5ScriptVariant(value: any, expectedKey: any) {
    const fullScript = String(value?.fullScript || '');
    const expectedHash = m5ScriptHash(fullScript);
    if (value?.variantKey !== expectedKey
        || !safeText(fullScript, 1000)
        || value?.scriptHash !== expectedHash
        || !validM5ProductionTemplateBinding(value?.templateBinding)) {
        throw new ContentCampaignError(`ScriptPackage ${expectedKey} 变体缺少可信脚本、哈希或模板绑定。`);
    }
    return value;
}
function m5ScriptHash(fullScript: any) {
    return `sha256:${crypto.createHash('sha256')
        .update(String(fullScript || ''))
        .digest('hex')}`;
}
function assertM5GrayTargetBinding(binding: any, targetCase: any) {
    if (binding?.source !== 'approved_single_gray'
        || binding?.grayRelease !== true
        || binding?.applicationScope !== 'full_content_variant'
        || binding?.grayTargetPlatform !== 'douyin'
        || binding?.grayTargetDayCaseId !== targetCase?.id
        || binding?.grayTargetScheduledDate !== String(targetCase?.scheduledDate || '')
        || !CASE_ID.test(String(binding?.grayTargetCaseId || ''))) {
        throw new ContentCampaignError('gray_douyin 模板没有同时绑定当前日期 Case、预约日期和抖音平台 Case。');
    }
}
function confirmedM5VoiceVariant(value: any, expected: any) {
    const data = value?.data && typeof value.data === 'object' ? value.data : value;
    const providerReceipt = confirmedM5ProviderReceipt(data, 'tts');
    if (providerReceipt.actionId !== expected.actionId
        || data?.model !== 'stepaudio-2.5-tts'
        || data?.voice !== expected.voice
        || data?.relativePath !== expected.outputPath
        || !/^sha256:[0-9a-f]{64}$/i.test(String(data?.checksum || ''))
        || !Number.isInteger(Number(data?.bytes))
        || Number(data.bytes) <= 0) {
        throw new ContentCampaignError(`${expected.variantKey} 配音没有返回匹配动作、官方音色、路径、哈希或字节数。`);
    }
    return {
        variantKey: expected.variantKey,
        scriptHash: expected.scriptHash,
        templateBinding: expected.templateBinding,
        model: data.model,
        voice: data.voice,
        relativePath: data.relativePath,
        checksum: String(data.checksum).toLowerCase(),
        audioHash: String(data.checksum).toLowerCase(),
        bytes: Number(data.bytes),
        providerReceipt,
    };
}
function assertCompleteM5GrayVoiceVariants(variants: any, scriptVariants: any = null) {
    if (!variants
        || typeof variants !== 'object'
        || Array.isArray(variants)
        || JSON.stringify(Object.keys(variants).sort())
            !== JSON.stringify(['baseline', 'gray_douyin'])) {
        throw new ContentCampaignError('灰度 VoicePackage 必须且只能包含 baseline 与 gray_douyin 两条独立音频。');
    }
    for (const variantKey of ['baseline', 'gray_douyin']) {
        const voice = variants[variantKey];
        const script = scriptVariants?.[variantKey];
        let providerReceipt = null;
        try {
            providerReceipt = confirmedM5ProviderReceipt(voice?.providerReceipt, 'tts');
        }
        catch {
            // 统一由下面的变体契约错误关闭，避免接受无Provider费用血缘的音频。
        }
        if (voice?.variantKey !== variantKey
            || !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.scriptHash || ''))
            || !safeWorkspaceRelativePath(voice?.relativePath)
            || !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.checksum || ''))
            || voice.audioHash !== voice.checksum
            || !Number.isInteger(Number(voice?.bytes))
            || Number(voice.bytes) <= 0
            || voice.model !== 'stepaudio-2.5-tts'
            || !String(voice.voice || '').trim()
            || !validM5ProductionTemplateBinding(voice.templateBinding)
            || providerReceipt?.actionId !== voice.providerReceipt?.actionId
            || (script && (voice.scriptHash !== script.scriptHash
                || !sameTemplateBinding(voice.templateBinding, script.templateBinding)))) {
            throw new ContentCampaignError(`VoicePackage ${variantKey} 无法回到同一脚本、模板、音频哈希和Provider回执。`);
        }
    }
    if (variants.baseline.scriptHash === variants.gray_douyin.scriptHash
        || variants.baseline.audioHash === variants.gray_douyin.audioHash
        || variants.baseline.providerReceipt?.actionId
            === variants.gray_douyin.providerReceipt?.actionId) {
        throw new ContentCampaignError('灰度 VoicePackage 两条变体没有独立脚本、音频或Provider动作。');
    }
    return variants;
}
function optionalM5GrayRenderLineage(scriptPackage: any, voicePackage: any) {
    const scriptVariants = optionalM5GrayScriptVariants(scriptPackage);
    const hasVoiceVariants = voicePackage?.variants != null;
    if (!scriptVariants && !hasVoiceVariants)
        return null;
    if (!scriptVariants || !hasVoiceVariants) {
        throw new ContentCampaignError('灰度渲染要求 ScriptPackage 与 VoicePackage 同时包含完整双变体，禁止半包或跨接。');
    }
    const voiceVariants = assertCompleteM5GrayVoiceVariants(voicePackage.variants, scriptVariants);
    if (voicePackage.variantKey !== 'baseline'
        || voicePackage.scriptHash !== voiceVariants.baseline.scriptHash
        || voicePackage.audioHash !== voiceVariants.baseline.audioHash
        || voicePackage.checksum !== voiceVariants.baseline.checksum) {
        throw new ContentCampaignError('VoicePackage 顶层必须精确镜像 baseline 以保持普通链兼容。');
    }
    const item = (variantKey: 'baseline' | 'gray_douyin') => ({
        variantKey,
        script: scriptVariants[variantKey],
        scriptHash: scriptVariants[variantKey].scriptHash,
        voiceoverSrc: voiceVariants[variantKey].relativePath,
        audioHash: voiceVariants[variantKey].audioHash,
        templateBinding: scriptVariants[variantKey].templateBinding,
        voiceProviderActionId: voiceVariants[variantKey].providerReceipt.actionId,
    });
    return {
        master: item('baseline'),
        xiaohongshu: item('baseline'),
        douyin: item('gray_douyin'),
    };
}
function optionalM5BaselineRenderLineage(scriptPackage: any, voicePackage: any) {
    if (!scriptPackage?.fullScript || !voicePackage)
        return null;
    const templateBinding = scriptPackage?.templateLifecycle?.templateBinding
        || scriptPackage?.templateBinding;
    if (!validM5ProductionTemplateBinding(templateBinding))
        return null;
    return m5BaselineRenderLineage({
        script: scriptPackage,
        voice: voicePackage,
        templateBinding,
    });
}
function m5BaselineRenderLineage({ script, voice, templateBinding }: any) {
    const voiceoverSrc = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
    const audioHash = String(voice?.audioHash || voice?.checksum || '').trim();
    const scriptHash = String(script?.scriptHash || '').trim() || m5ScriptHash(script?.fullScript);
    const voiceProviderActionId = String(voice?.providerReceipt?.actionId || voice?.actionId || '').trim() || null;
    if (!script?.fullScript
        || !voiceoverSrc
        || !/^sha256:[0-9a-f]{64}$/i.test(scriptHash)
        || !/^sha256:[0-9a-f]{64}$/i.test(audioHash)
        || !validM5ProductionTemplateBinding(templateBinding)) {
        throw new ContentCampaignError('baseline 渲染缺少脚本、音频或模板的稳定血缘。');
    }
    return {
        variantKey: 'baseline',
        script,
        scriptHash,
        voiceoverSrc,
        audioHash,
        templateBinding,
        voiceProviderActionId,
    };
}
function m5RenderVariantDescriptor({ composition, grayLineage, fallback }: any) {
    if (!grayLineage)
        return fallback;
    return grayLineage[renderPlatformKey(composition)];
}
function hasM5VariantLineage(value: any) {
    return [
        'variantKey',
        'scriptHash',
        'audioHash',
        'templateBindingHash',
        'voiceProviderActionId',
    ].some((key: any) => value?.[key] != null);
}
function assertM5RenderOutputLineage(output: any, expected: any, platform: any) {
    if (!expected
        || output?.variantKey !== expected.variantKey
        || output?.scriptHash !== expected.scriptHash
        || output?.audioHash !== expected.audioHash
        || output?.templateBindingHash !== expected.templateBinding.bindingHash
        || output?.voiceProviderActionId !== expected.voiceProviderActionId) {
        throw m5WorkProductDrift({ stageKey: 'render' }, `${platform} 成片的脚本、音频或模板变体血缘发生跨接`);
    }
}
function buildM5RenderProps({ script, voiceoverSrc, composition, visualAssets, templateBinding, variantLineage = null, }: any) {
    const platform = composition === 'M5Douyin'
        ? 'douyin'
        : composition === 'M5Xiaohongshu' ? 'xiaohongshu' : 'master';
    const sourceShots = Array.isArray(script?.shots) ? script.shots.slice(0, 12) : [];
    const fallbackText = safeText(script?.fullScript, 240);
    const normalizedShots = sourceShots.length
        ? sourceShots
        : [{ startSeconds: 0, endSeconds: 45, narration: fallbackText, visual: '受控本机口播画面' }];
    const scenes = normalizedShots.map((shot: any, index: any) => {
        const startFrame = Math.max(0, Math.min(1349, Math.round(Number(shot?.startSeconds || 0) * 30)));
        const requestedEnd = Math.round(Number(shot?.endSeconds || ((index + 1) * 45 / normalizedShots.length)) * 30);
        const endFrame = Math.max(startFrame + 1, Math.min(1350, requestedEnd));
        return {
            id: `scene-${index + 1}`,
            startFrame,
            durationInFrames: endFrame - startFrame,
            headline: safeText(index === 0 ? script?.hook || script?.headline : `要点 ${index + 1}`, 80) || `要点 ${index + 1}`,
            body: safeText(shot?.narration || fallbackText, 240) || '等待可信脚本内容。',
            imageSrc: visualAssets[index % visualAssets.length].relativePath,
            evidenceRef: visualAssets[index % visualAssets.length].frameId,
        };
    });
    const captions = scenes.map((scene: any) => ({
        startFrame: scene.startFrame,
        endFrame: scene.startFrame + scene.durationInFrames,
        text: captionSafeText(scene.body),
    }));
    return {
        platform,
        title: safeText(script?.headline || script?.topic || 'AI Agent 实战', 80) || 'AI Agent 实战',
        subtitle: safeText(script?.hook || '从目标到真实产物', 120) || '从目标到真实产物',
        sourceLabel: '公开来源与本机自产素材',
        voiceoverSrc,
        coverSrc: visualAssets[0].relativePath,
        assetLedger: visualAssets.map((asset: any) => ({
            relativePath: asset.relativePath,
            checksum: asset.checksum,
        })),
        templateBinding,
        ...(variantLineage ? { variantLineage } : {}),
        scenes,
        captions,
    };
}
function buildM5SocialCardProps({ script, visualAssets, templateBinding, rightsBasis, }: any) {
    const ledger = visualAssets.slice(0, 12).map((asset: any) => ({
        relativePath: asset.relativePath,
        checksum: asset.checksum,
    }));
    const shotBullets = asList(script?.shots)
        .map((shot: any) => safeText(shot?.narration || shot?.visual, 24))
        .filter(Boolean)
        .slice(0, 3);
    const keyPoints = shotBullets.length
        ? shotBullets
        : ['明确任务边界', '保留真实回执', '由人工决定发布'];
    return {
        platform: 'xiaohongshu',
        title: safeText(script?.headline || script?.topic || 'AI Agent 实战', 40) || 'AI Agent 实战',
        subtitle: safeText(script?.hook || '从目标到真实产物', 120) || '从目标到真实产物',
        sourceLabel: '公开来源与本机自产素材',
        rightsBasis: safeText(rightsBasis, 500),
        templateBinding,
        assetLedger: ledger,
        cards: [
            {
                id: 'cover',
                kind: 'cover',
                headline: safeText(script?.headline || script?.topic || '别把运行当完成', 14) || '别把运行当完成',
                body: safeText(script?.hook || script?.fullScript || '完成必须落到可核验的真实产物。', 60),
                bullets: keyPoints,
            },
            {
                id: 'evidence',
                kind: 'evidence',
                headline: '证据进入同一条链',
                body: '素材、模板和输出都绑定到同一 Case，可按路径与哈希复核。',
                bullets: keyPoints,
                imageSrc: ledger[0].relativePath,
            },
            {
                id: 'checklist',
                kind: 'checklist',
                headline: '交付前逐项核对',
                body: '静态卡只是候选产物；审批、启用和发布仍是彼此独立的门禁。',
                bullets: ['代码与测试已通过', '素材与版权依据可追溯', '输出尺寸和哈希已核验', '发布需要负责人批准'],
            },
        ],
    };
}
function validM5SocialCardPackageReceipt(value: any) {
    const outputDir = safeWorkspaceRelativePath(value?.outputDir);
    const cards = asList(value?.cards);
    const checks = value?.checks;
    return value?.schemaVersion === M5_SCHEMA_IDS.SOCIAL_CARD_PACKAGE
        && value?.platform === 'xiaohongshu'
        && outputDir
        && safeWorkspaceRelativePath(value?.propsPath)
        && String(value.propsPath).endsWith('/social-card.props.json')
        && validM5Sha256(value?.propsChecksum)
        && safeWorkspaceRelativePath(value?.manifestPath)
        && String(value.manifestPath).endsWith('/social-card-render-manifest.json')
        && validM5Sha256(value?.manifestChecksum)
        && validM5Sha256(value?.templateBindingHash)
        && safeText(value?.rightsBasis, 500)
        && value?.rightsBasisHash === m5TextHash(value.rightsBasis)
        && cards.length >= 3
        && cards.length <= 9
        && cards.every((card: any) => /^[a-z0-9][a-z0-9-]{1,48}$/i.test(String(card?.id || ''))
            && safeWorkspaceRelativePath(card?.relativePath)
            && String(card.relativePath).startsWith(`${outputDir}/`)
            && String(card.relativePath).toLowerCase().endsWith('.png')
            && Number(card?.width) === 1080
            && Number(card?.height) === 1440
            && Number.isInteger(Number(card?.bytes))
            && Number(card.bytes) > 0
            && validM5Sha256(card?.checksum))
        && checks?.dimensions === true
        && checks?.fileHashes === true
        && checks?.assetLineage === true
        && checks?.rightsBasis === true
        && checks?.externalNetworkUsed === false;
}
function validM5Sha256(value: any) {
    return /^sha256:[0-9a-f]{64}$/i.test(String(value || ''));
}
function m5TextHash(value: any) {
    return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}
async function resolveM5TemplateForRender({ resolver, pipelineCaseId, scriptBinding, }: any) {
    let resolved: any = defaultM5ProductionTemplateBinding('resolver_unavailable');
    if (typeof resolver?.resolve === 'function') {
        try {
            resolved = await resolver.resolve(pipelineCaseId);
        }
        catch (error) {
            if (error instanceof M5ProductionTemplateResolutionError
                || (error as any)?.code === 'm5_production_template_blocked')
                throw error;
            resolved = defaultM5ProductionTemplateBinding('resolver_read_failed');
        }
    }
    if (!scriptBinding) {
        if (resolved.source === 'built_in_default')
            return resolved;
        throw new ContentCampaignError('渲染阶段发现已批准生产模板，但 ScriptPackage 没有模板绑定，必须从脚本阶段恢复。');
    }
    if (!sameTemplateBinding(scriptBinding, resolved)) {
        throw new ContentCampaignError('ScriptPackage 模板绑定与当前只读生产模板决定不一致，必须从脚本阶段恢复。');
    }
    return resolved;
}
function sameTemplateBinding(left: any, right: any) {
    return validM5ProductionTemplateBinding(left)
        && validM5ProductionTemplateBinding(right)
        && left.bindingHash === right.bindingHash;
}
function captionSafeText(value: any) {
    const compact = String(value || '').replace(/\s+/g, '').trim().slice(0, 60);
    if (!compact)
        return '等待可信字幕';
    const lines = [];
    for (let index = 0; index < compact.length && lines.length < 3; index += 20) {
        lines.push(compact.slice(index, index + 20));
    }
    return lines.join('\n');
}
function deterministicM5ReviewChecks({ campaignCase, targetCase, render, script, evidence, voice, assetPackage, generatedImage, media, subtitles, }: any) {
    const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
    const sourceById = new Map(sources
        .filter(validM5ReviewSource)
        .map((source: any) => [String(source.sourceId), source]));
    const bindings = Array.isArray(script?.factBindings) ? script.factBindings : [];
    const evidenceClaims = new Map((Array.isArray(evidence?.claims) ? evidence.claims : [])
        .map((claim: any) => [String(claim?.claimId || ''), claim])
        .filter(([claimId]: any) => claimId));
    const facts = evidence?.schemaVersion === 'agent.army/evidence-package/v2'
        && sources.length >= 2
        && sourceById.size === sources.length
        && bindings.length >= 1
        && bindings.every((binding: any) => String(binding?.statement || '').trim()
            && String(script.fullScript || '').includes(String(binding.statement))
            && Array.isArray(binding.sourceIds)
            && binding.sourceIds.length >= 2
            && binding.sourceIds.every((sourceId: any) => sourceById.has(String(sourceId)))
            && bindingMatchesEvidenceClaim(binding, evidenceClaims.get(String(binding.claimId || ''))));
    const privacy = !containsSensitiveM5Text([
        script?.headline,
        script?.hook,
        script?.fullScript,
    ].join('\n'));
    const rights = render?.composition
        && safeWorkspaceRelativePath(render?.propsPath)
        && voice?.model === 'stepaudio-2.5-tts'
        && String(voice?.voice || '').trim()
        && !/clone|克隆|复刻/i.test(String(voice.voice));
    const visualAssets = verifiedM5VisualAssets(assetPackage);
    const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
    const claims = facts
        && !containsUnsupportedPromise(script?.fullScript)
        && (!Array.isArray(script?.qualityReview?.unresolved) || script.qualityReview.unresolved.length === 0);
    const grant = campaignCase?.campaignGrant;
    const platform = String(targetCase?.platform || '').trim();
    const scheduledDate = String(targetCase?.scheduledDate || '').trim();
    const grantScope = grant?.status === 'active'
        && Array.isArray(grant.platforms)
        && grant.platforms.includes(platform)
        && /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate);
    const receipts = Array.isArray(grant?.receipts) ? grant.receipts : [];
    const duplicate = /^sha256:[0-9a-f]{64}$/i.test(String(render?.checksum || ''))
        && !receipts.some((receipt: any) => receipt?.platform === platform
            && receipt?.contentChecksum === render.checksum);
    return {
        facts,
        privacy,
        rights: Boolean(rights
            && generatedVisual
            && visualAssets.length
            && String(assetPackage?.rightsBasis || '').trim()),
        media: media?.passed === true && subtitles?.passed === true,
        claims,
        grantScope,
        duplicate,
    };
}
function validM5ReviewSource(source: any) {
    let url;
    try {
        url = new URL(String(source?.url || ''));
    }
    catch {
        return false;
    }
    return Boolean(String(source?.sourceId || '').trim()
        && ['http:', 'https:'].includes(url.protocol)
        && !url.username
        && !url.password
        && source?.kind !== 'github_metadata'
        && Number.isFinite(Date.parse(String(source?.fetchedAt || '')))
        && /^(?:sha256:)?[0-9a-f]{64}$/i.test(String(source?.contentHash || ''))
        && Array.isArray(source?.evidenceFragments)
        && source.evidenceFragments.some((fragment: any) => String(fragment?.fragmentId || '').trim()
            && String(fragment?.text || '').trim()));
}
function bindingMatchesEvidenceClaim(binding: any, claim: any) {
    if (!claim
        || String(binding?.statement || '').trim() !== String(claim?.text || '').trim()
        || !sameStringSet(binding?.sourceIds, claim?.sourceIds)
        || !Array.isArray(binding?.evidenceFragments)
        || !Array.isArray(claim?.evidenceFragments))
        return false;
    const claimFragments = new Set(claim.evidenceFragments.map(evidenceFragmentKey));
    const bindingFragments = new Set(binding.evidenceFragments.map(evidenceFragmentKey));
    if (!claimFragments.size || !sameStringSet([...bindingFragments], [...claimFragments]))
        return false;
    const fragmentSources = new Set(binding.evidenceFragments.map((fragment: any) => String(fragment?.sourceId || '')));
    return binding.sourceIds.every((sourceId: any) => fragmentSources.has(String(sourceId)));
}
function evidenceFragmentKey(fragment: any) {
    return [
        String(fragment?.sourceId || '').trim(),
        String(fragment?.fragmentId || '').trim(),
        String(fragment?.text || '').replace(/\s+/g, ' ').trim(),
    ].join('\u0000');
}
function sameStringSet(left: any, right: any) {
    if (!Array.isArray(left) || !Array.isArray(right))
        return false;
    const a = new Set(left.map(String));
    const b = new Set(right.map(String));
    return a.size === b.size && [...a].every((item: any) => b.has(item));
}
function containsSensitiveM5Text(value: any) {
    const text = String(value || '');
    return /(?:\b(?:sk|api)[-_][A-Za-z0-9]{12,}\b|Bearer\s+[A-Za-z0-9._-]{12,}|(?:token|cookie|password|secret|api[_ -]?key)\s*[:=]\s*\S{6,}|file:\/\/|\/Users\/|[A-Za-z]:\\|聊天原文|客户数据|内部账号)/i.test(text);
}
function containsUnsupportedPromise(value: any) {
    return /(?:保证|必然|百分之百|100%|稳赚|无风险|一定能|立刻暴涨|播放量翻倍)/i.test(String(value || ''));
}
export const campaignDeliveryValidation = Object.freeze({
    script: Object.freeze({
        optionalVariants: optionalM5GrayScriptVariants,
        requireVariants: requireM5GrayScriptVariants,
        hash: m5ScriptHash,
        assertGrayTarget: assertM5GrayTargetBinding,
    }),
    voice: Object.freeze({
        confirmVariant: confirmedM5VoiceVariant,
        assertCompleteVariants: assertCompleteM5GrayVoiceVariants,
    }),
    render: Object.freeze({
        platformKey: renderPlatformKey,
        optionalGrayLineage: optionalM5GrayRenderLineage,
        optionalBaselineLineage: optionalM5BaselineRenderLineage,
        baselineLineage: m5BaselineRenderLineage,
        variantDescriptor: m5RenderVariantDescriptor,
        hasVariantLineage: hasM5VariantLineage,
        assertOutputLineage: assertM5RenderOutputLineage,
        buildProps: buildM5RenderProps,
    }),
    socialCard: Object.freeze({
        buildProps: buildM5SocialCardProps,
        validReceipt: validM5SocialCardPackageReceipt,
    }),
    template: Object.freeze({
        resolve: resolveM5TemplateForRender,
    }),
    review: Object.freeze({
        checks: deterministicM5ReviewChecks,
    }),
});
