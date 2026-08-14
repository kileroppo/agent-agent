import fs from 'node:fs/promises';
import path from 'node:path';
import { coded, safeRelativePath, sha256 } from './policy.ts';
import { mediaProviderLineage } from './media-provider-lineage.ts';
import { mediaRuntime } from './media-runtime.ts';
const { existing: existingWorkspacePath, writeArtifact: writeArtifactBytes, } = mediaRuntime.workspace;
const { coverPng: coverPngBytes } = mediaRuntime.ffmpeg;
const { fromConfirmedActions: buildStepFunArtifactLineageFromConfirmedActions, fromLedger: buildStepFunArtifactLineage, } = mediaProviderLineage;
const REQUIRED_ARTIFACTS = Object.freeze([
    'master.mp4',
    'douyin.mp4',
    'xiaohongshu.mp4',
    'douyin.copy.json',
    'xiaohongshu.copy.json',
    'cover.png',
    'sources.json',
    'review.json',
    'lineage.json'
]);
async function writeM5ArtifactPackage(ctx: any, params: any, run: any, options: any = {}) {
    const outputDir = safeRelativePath(params.outputDir);
    let sources = structuredClone(params.sources);
    let lineage = structuredClone(params.lineage);
    let providerBinding = null;
    if (params.providerActionRefs != null
        && (params.providerLedgerPath != null || params.providerThemeId != null)) {
        throw coded('provider_lineage_binding_conflict', '逐阶段 confirmed action 与七主题 Provider ledger 不能同时绑定。');
    }
    if (params.providerLedgerPath != null || params.providerThemeId != null) {
        if (!params.providerLedgerPath || !params.providerThemeId) {
            throw coded('provider_lineage_binding_invalid', 'providerLedgerPath 与 providerThemeId 必须同时提供。');
        }
        const providerLedger = await existingWorkspacePath(ctx, run.companyId, params.providerLedgerPath);
        const providerLedgerBytes = await fs.readFile(providerLedger.absolute);
        let ledger;
        try {
            ledger = JSON.parse(providerLedgerBytes.toString('utf8'));
        }
        catch {
            throw coded('provider_ledger_invalid', 'StepFun Provider ledger 不是有效 JSON。');
        }
        const built = buildStepFunArtifactLineage({
            ledger,
            ledgerPath: providerLedger.relative,
            ledgerChecksum: sha256(providerLedgerBytes),
            themeId: params.providerThemeId,
            sources,
            lineage,
        });
        sources = built.sources;
        lineage = built.lineage;
        providerBinding = built.providerBinding;
    }
    if (params.providerActionRefs != null) {
        const built = await buildStepFunArtifactLineageFromConfirmedActions({
            ctx,
            run,
            actionRefs: params.providerActionRefs,
            sources,
            lineage,
        });
        sources = built.sources;
        lineage = built.lineage;
        providerBinding = built.providerBinding;
    }
    const videoInputs = {
        'master.mp4': params.videos?.master,
        'douyin.mp4': params.videos?.douyin,
        'xiaohongshu.mp4': params.videos?.xiaohongshu,
    };
    const jsonInputs = {
        'douyin.copy.json': params.copies?.douyin,
        'xiaohongshu.copy.json': params.copies?.xiaohongshu,
        'sources.json': sources,
        'review.json': params.review,
        'lineage.json': lineage,
    };
    const structuralErrors: string[] = [];
    validatePlatformCopy(jsonInputs['douyin.copy.json'], 'douyin.copy.json', structuralErrors);
    validatePlatformCopy(jsonInputs['xiaohongshu.copy.json'], 'xiaohongshu.copy.json', structuralErrors);
    validateSourcesLedger(jsonInputs['sources.json'], structuralErrors);
    validateReviewReport(jsonInputs['review.json'], structuralErrors);
    validateLineageDocument(jsonInputs['lineage.json'], lineage, structuralErrors);
    validateProviderLineageBinding(jsonInputs['sources.json'], lineage, structuralErrors);
    if (structuralErrors.length)
        throw coded('artifact_package_invalid', structuralErrors.join(' '));
    const files: Record<string, any> = {};
    for (const [fileName, input] of Object.entries(videoInputs)) {
        if (!input || !/^sha256:[a-f0-9]{64}$/.test(String(input.checksum || ''))) {
            throw coded('artifact_video_receipt_invalid', `${fileName} 缺少可信来源路径或哈希。`);
        }
        const source = await existingWorkspacePath(ctx, run.companyId, input.path);
        const bytes = await fs.readFile(source.absolute);
        if (sha256(bytes) !== input.checksum) {
            throw coded('artifact_video_checksum_mismatch', `${fileName} 来源文件哈希不匹配。`);
        }
        files[fileName] = await writeArtifactBytes(ctx, run, path.posix.join(outputDir, fileName), bytes);
    }
    const coverSource = await existingWorkspacePath(ctx, run.companyId, params.coverSourcePath);
    const coverBytes = await coverPngBytes(coverSource.absolute, options.executeFile || undefined);
    files['cover.png'] = await writeArtifactBytes(ctx, run, path.posix.join(outputDir, 'cover.png'), coverBytes);
    for (const [fileName, value] of Object.entries(jsonInputs)) {
        files[fileName] = await writeArtifactBytes(ctx, run, path.posix.join(outputDir, fileName), Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    }
    const manifest = {
        schemaVersion: 1,
        files: Object.fromEntries(Object.entries(files).map(([fileName, entry]: any) => [
            fileName,
            { path: fileName, checksum: entry.checksum },
        ])),
        lineage,
    };
    const manifestEntry = await writeArtifactBytes(ctx, run, path.posix.join(outputDir, 'artifact-manifest.tson'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    return {
        content: '固定产物包已写入受控内容工作区。',
        data: {
            manifestPath: manifestEntry.relativePath,
            manifestChecksum: manifestEntry.checksum,
            ...(providerBinding ? { providerBinding } : {}),
            files: Object.fromEntries(Object.entries(files).map(([fileName, entry]: any) => [
                fileName,
                {
                    relativePath: entry.relativePath,
                    checksum: entry.checksum,
                    bytes: entry.bytes,
                },
            ])),
        },
    };
}
async function validateArtifactLineage(ctx: any, params: any, run: any) {
    const manifestFile = await existingWorkspacePath(ctx, run.companyId, params.manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestFile.absolute, 'utf8'));
    const manifestDirectory = path.posix.dirname(manifestFile.relative);
    const errors = [];
    const artifacts: Record<string, any> = {};
    if (manifest.schemaVersion !== 1)
        errors.push('产物清单 schemaVersion 必须为 1。');
    for (const fileName of REQUIRED_ARTIFACTS) {
        const entry = manifest.files?.[fileName];
        if (!entry || entry.path !== fileName || !/^sha256:[a-f0-9]{64}$/.test(String(entry.checksum || ''))) {
            errors.push(`${fileName} 缺少固定路径或有效哈希。`);
            continue;
        }
        try {
            const file = await existingWorkspacePath(ctx, run.companyId, manifestDirectory === '.'
                ? entry.path
                : path.posix.join(manifestDirectory, entry.path));
            const bytes = await fs.readFile(file.absolute);
            artifacts[fileName] = { ...file, bytes };
            const actual = sha256(bytes);
            if (actual !== entry.checksum)
                errors.push(`${fileName} 文件哈希与清单不一致。`);
        }
        catch {
            errors.push(`${fileName} 文件不存在或越界。`);
        }
    }
    const lineage = manifest.lineage;
    if (!lineage?.contentVersionId || !lineage?.sourceTaskId || !lineage?.generatedBy || !Date.parse(lineage?.createdAt)) {
        errors.push('缺少 contentVersionId、sourceTaskId、generatedBy 或 createdAt 血缘字段。');
    }
    if (!Array.isArray(lineage?.parents))
        errors.push('血缘 parents 必须是数组。');
    const douyinCopy = parseJsonArtifact(artifacts['douyin.copy.json'], 'douyin.copy.json', errors);
    const xiaohongshuCopy = parseJsonArtifact(artifacts['xiaohongshu.copy.json'], 'xiaohongshu.copy.json', errors);
    validatePlatformCopy(douyinCopy, 'douyin.copy.json', errors);
    validatePlatformCopy(xiaohongshuCopy, 'xiaohongshu.copy.json', errors);
    const sources = parseJsonArtifact(artifacts['sources.json'], 'sources.json', errors);
    validateSourcesLedger(sources, errors);
    const review = parseJsonArtifact(artifacts['review.json'], 'review.json', errors);
    validateReviewReport(review, errors);
    const lineageDocument = parseJsonArtifact(artifacts['lineage.json'], 'lineage.json', errors);
    validateLineageDocument(lineageDocument, lineage, errors);
    validateProviderLineageBinding(sources, lineageDocument, errors);
    return {
        content: errors.length ? '固定产物与血缘检查未通过。' : '固定产物与血缘检查通过。',
        data: { passed: errors.length === 0, errors, requiredArtifacts: REQUIRED_ARTIFACTS, manifestPath: manifestFile.relative }
    };
}
function parseJsonArtifact(artifact: any, fileName: any, errors: any) {
    if (!artifact?.bytes)
        return null;
    try {
        const parsed = JSON.parse(artifact.bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('not_object');
        return parsed;
    }
    catch {
        errors.push(`${fileName} 必须是有效 JSON 对象。`);
        return null;
    }
}
function validatePlatformCopy(value: any, fileName: any, errors: any) {
    if (!value)
        return;
    if (!textWithin(value.title, 1, 100) || !textWithin(value.body, 1, 2000)
        || !Array.isArray(value.tags) || value.tags.length < 1 || value.tags.length > 10
        || value.tags.some((tag: any) => !textWithin(tag, 1, 40))) {
        errors.push(`${fileName} 必须包含非空 title、body 和 1–10 个有效 tags。`);
    }
}
function validateSourcesLedger(value: any, errors: any) {
    if (!value)
        return;
    if (!Array.isArray(value.sources) || value.sources.length < 2
        || value.sources.some((source: any) => !textWithin(source?.ref, 1, 500) || !textWithin(source?.kind, 1, 80))) {
        errors.push('sources.json 必须包含至少两个带 ref 和 kind 的来源。');
    }
    if (!Array.isArray(value.thirdPartyMedia) || !Array.isArray(value.aiGeneratedMedia)) {
        errors.push('sources.json 必须明确提供 thirdPartyMedia 和 aiGeneratedMedia 版权账本数组。');
        return;
    }
    if (value.thirdPartyMedia.some((item: any) => !textWithin(item?.ref, 1, 500) || !textWithin(item?.rightsBasis, 1, 200))) {
        errors.push('sources.json 的第三方素材必须记录 ref 和 rightsBasis。');
    }
    if (value.aiGeneratedMedia.some((item: any) => !textWithin(item?.model, 1, 120)
        || !textWithin(item?.sourceTaskId, 1, 160)
        || !/^sha256:[a-f0-9]{64}$/.test(String(item?.checksum || ''))
        || !/^sha256:[a-f0-9]{64}$/.test(String(item?.promptChecksum || '')))) {
        errors.push('sources.json 的 AI 素材必须记录模型、来源任务、文件哈希和 Prompt 哈希。');
    }
    if (value.narration?.provider === 'StepFun'
        && (!textWithin(value.narration?.model, 1, 120)
            || !textWithin(value.narration?.sourceTaskId, 1, 160)
            || !/^sha256:[a-f0-9]{64}$/.test(String(value.narration?.checksum || ''))
            || !/^sha256:[a-f0-9]{64}$/.test(String(value.narration?.promptChecksum || ''))
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value.narration?.costEventId || '')))) {
        errors.push('sources.json 的 StepFun 旁白必须记录模型、来源任务、文件哈希、Prompt 哈希和费用事件。');
    }
}
function validateProviderLineageBinding(sources: any, lineage: any, errors: any) {
    if (!sources)
        return;
    const generated = Array.isArray(sources.aiGeneratedMedia)
        ? sources.aiGeneratedMedia
        : [];
    const stepFunNarration = sources.narration?.provider === 'StepFun'
        ? sources.narration
        : null;
    if (!generated.length && !stepFunNarration)
        return;
    const bindingChecksums = new Set([
        ...generated.map((item: any) => item?.providerBindingChecksum || item?.providerLedgerChecksum),
        stepFunNarration?.providerBindingChecksum || stepFunNarration?.providerLedgerChecksum,
    ].filter(Boolean));
    if (bindingChecksums.size !== 1
        || generated.some((item: any) => !/^sha256:[a-f0-9]{64}$/.test(String(item?.providerBindingChecksum || item?.providerLedgerChecksum || ''))
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(item?.costEventId || ''))
            || !textWithin(item?.vision?.sourceTaskId, 1, 160)
            || !textWithin(item?.vision?.model, 1, 120)
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(item?.vision?.costEventId || ''))
            || !/^sha256:[a-f0-9]{64}$/.test(String(item?.vision?.observationChecksum || '')))
        || (stepFunNarration
            && (!/^sha256:[a-f0-9]{64}$/.test(String(stepFunNarration.providerBindingChecksum
                || stepFunNarration.providerLedgerChecksum
                || ''))
                || (stepFunNarration.providerBindingChecksum
                    || stepFunNarration.providerLedgerChecksum) !== [...bindingChecksums][0]))) {
        errors.push('StepFun 素材必须绑定图像、视觉、TTS action/costEvent 和同一 Provider 证明。');
        return;
    }
    const [bindingChecksum] = bindingChecksums;
    const parent = Array.isArray(lineage?.parents)
        ? lineage.parents.find((item: any) => (item?.kind === 'stepfun_provider_ledger'
            && item?.checksum === bindingChecksum
            && textWithin(item?.path, 1, 500)
            && textWithin(item?.themeId, 1, 120))
            || (item?.kind === 'stepfun_confirmed_actions'
                && item?.checksum === bindingChecksum
                && Array.isArray(item?.actionIds)
                && item.actionIds.length === 3
                && new Set(item.actionIds).size === 3
                && item.actionIds.every((actionId: any) => textWithin(actionId, 8, 160))))
        : null;
    if (!parent) {
        errors.push('内容血缘缺少与 StepFun 素材一致的 Provider 父引用。');
    }
}
function validateReviewReport(value: any, errors: any) {
    if (!value)
        return;
    if (value.schemaVersion !== 1 || value.passed !== true
        || !Array.isArray(value.failures) || value.failures.length
        || value.checks?.subtitleLayout?.passed !== true) {
        errors.push('review.json 必须 passed=true、failures 为空且字幕布局门禁通过。');
    }
}
function validateLineageDocument(value: any, manifestLineage: any, errors: any) {
    if (!value)
        return;
    if (value.schemaVersion !== 1
        || !Date.parse(value.createdAt)
        || !Array.isArray(value.parents)
        || value.contentVersionId !== manifestLineage?.contentVersionId
        || value.sourceTaskId !== manifestLineage?.sourceTaskId
        || value.generatedBy !== manifestLineage?.generatedBy
        || JSON.stringify(value.parents) !== JSON.stringify(manifestLineage?.parents)) {
        errors.push('lineage.json 必须与产物清单中的内容版本、来源任务、生成者和父版本一致。');
    }
}
function textWithin(value: any, minimum: any, maximum: any) {
    const length = [...String(value || '').trim()].length;
    return length >= minimum && length <= maximum;
}
export const mediaArtifactPackage = Object.freeze({
    write: writeM5ArtifactPackage,
    validate: validateArtifactLineage,
});
