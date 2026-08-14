import { ContentCampaignError } from './campaign-domain.ts';
import { buildM5PlatformCopy, deriveM5ContentVersionId, } from './content-version.ts';
import { asList, safeText } from './content-campaign-primitives.ts';
import { workProductArtifact, artifactData, safeWorkspaceRelativePath, positiveVersion, boundedDurationSeconds, selectRenderOutput, verifiedM5VisualAssets, verifiedM5GeneratedVisual, m5ArtifactPackageVideos, m5SourcesLedger, m5ProviderProvenance, optionalM5GrayScriptVariants, m5ScriptHash, assertM5GrayTargetBinding, optionalM5GrayRenderLineage, optionalM5BaselineRenderLineage, m5BaselineRenderLineage, m5RenderVariantDescriptor, hasM5VariantLineage, assertM5RenderOutputLineage, buildM5RenderProps, buildM5SocialCardProps, resolveM5TemplateForRender, deterministicM5ReviewChecks, } from './content-campaign-execution-support.ts';
const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';
type CampaignMethod = (this: Record<string, any>, ...args: any[]) => any;
export const campaignExecutionPlanningMethods: Record<string, CampaignMethod> = {
    async m5StageToolParameters({ contract, campaignCase, targetCase, outputs }: any) {
        const artifacts = outputs.map(workProductArtifact).filter(Boolean);
        if (contract.stageKey === 'parallel_image_generation') {
            const topic = artifactData(artifacts, ['topic_selection']);
            const theme = safeText(topic?.theme || topic?.title || targetCase?.theme || 'AI Agent 实战', 120);
            const core = safeText(topic?.coreConclusion || topic?.coreClaim || '', 220);
            if (!theme) {
                throw new ContentCampaignError('并行生图缺少可信 TopicSelection，未调用付费生图。');
            }
            return {
                actionId: `${targetCase.id}:image:v${positiveVersion(targetCase.version)}`,
                prompt: safeText(`竖屏视频补充画面，主题：${theme}。${core ? `核心表达：${core}。` : ''}简洁信息图风格，不含品牌、水印、真人和夸大数字。`, 500),
                outputPath: `campaigns/${campaignCase.id}/${targetCase.id}/generated-visual.png`,
                seed: 0,
                textMode: false,
            };
        }
        if (contract.stageKey === 'voice') {
            const script = artifactData(artifacts, ['video_script_package', 'script_package']);
            const scriptVariants = optionalM5GrayScriptVariants(script);
            if (scriptVariants) {
                assertM5GrayTargetBinding(scriptVariants.gray_douyin.templateBinding, targetCase);
                const voice = await this.firstOfficialTtsVoice();
                return {
                    voices: (['baseline', 'gray_douyin'] as const).map((variantKey) => {
                        const variant = scriptVariants[variantKey];
                        return {
                            variantKey,
                            actionId: `${targetCase.id}:voice:${variantKey}:v${positiveVersion(targetCase.version)}`,
                            text: variant.fullScript,
                            scriptHash: variant.scriptHash,
                            templateBinding: variant.templateBinding,
                            voice,
                            speed: 1,
                            outputPath: `campaigns/${campaignCase.id}/${targetCase.id}/voice-${variantKey.replaceAll('_', '-')}.mp3`,
                        };
                    }),
                };
            }
            const text = safeText(script?.fullScript || script?.script || script?.text, 1000);
            if (!text)
                throw new ContentCampaignError('配音阶段缺少可信 ScriptPackage.fullScript，未调用付费 TTS。');
            const voice = await this.firstOfficialTtsVoice();
            return {
                actionId: `${targetCase.id}:voice:v${positiveVersion(targetCase.version)}`,
                text,
                voice,
                speed: 1,
                outputPath: `campaigns/${campaignCase.id}/${targetCase.id}/voice.mp3`,
            };
        }
        if (contract.stageKey === 'render') {
            const script = artifactData(artifacts, ['video_script_package', 'script_package']);
            const voice = artifactData(artifacts, ['voice_package']);
            const assetPackage = artifactData(artifacts, ['asset_package']);
            const generatedImage = artifactData(artifacts, ['generated_image_package']);
            const grayLineage = optionalM5GrayRenderLineage(script, voice);
            if (grayLineage) {
                assertM5GrayTargetBinding(grayLineage.douyin.templateBinding, targetCase);
            }
            const voiceoverSrc = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
            const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
            const visualAssets = [
                generatedVisual,
                ...verifiedM5VisualAssets(assetPackage),
            ].filter(Boolean);
            if (!script?.fullScript
                || (!grayLineage && !voiceoverSrc)
                || (!grayLineage && !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.checksum || '')))
                || !generatedVisual
                || visualAssets.length < 2
                || !String(assetPackage?.rightsBasis || '').trim()) {
                throw new ContentCampaignError('渲染阶段缺少可信 ScriptPackage、VoicePackage、GeneratedImagePackage 或带版权依据的真实 AssetPackage，拒绝白生成图片或用纯文字模板冒充混剪。');
            }
            const baselineScript = grayLineage?.master?.script || script;
            const templateBinding = await resolveM5TemplateForRender({
                resolver: this.templateResolver,
                pipelineCaseId: targetCase.id,
                scriptBinding: grayLineage?.master?.templateBinding
                    || script?.templateLifecycle?.templateBinding,
            });
            if (grayLineage
                && grayLineage.master.templateBinding.bindingHash !== templateBinding.bindingHash) {
                throw new ContentCampaignError('baseline 变体与当前生产模板决定不一致，拒绝以灰度模板覆盖 master 或小红书。');
            }
            const baselineLineage = m5BaselineRenderLineage({
                script: baselineScript,
                voice: grayLineage ? voice.variants.baseline : voice,
                templateBinding,
            });
            return {
                socialCard: {
                    outputDir: `campaigns/${campaignCase.id}/${targetCase.id}/social-cards`,
                    props: buildM5SocialCardProps({
                        script: baselineScript,
                        visualAssets,
                        templateBinding,
                        rightsBasis: assetPackage.rightsBasis,
                    }),
                },
                renders: [
                    ['M5Master', 'master.mp4'],
                    ['M5Douyin', 'douyin.mp4'],
                    ['M5Xiaohongshu', 'xiaohongshu.mp4'],
                ].map(([composition, outputName]: any) => {
                    const variant = m5RenderVariantDescriptor({
                        composition,
                        grayLineage,
                        fallback: baselineLineage,
                    });
                    return {
                        composition,
                        propsPath: `campaigns/${campaignCase.id}/${targetCase.id}/${composition}.props.json`,
                        outputPath: `campaigns/${campaignCase.id}/${targetCase.id}/${outputName}`,
                        variantKey: variant.variantKey,
                        scriptHash: variant.scriptHash,
                        audioHash: variant.audioHash,
                        templateBindingHash: variant.templateBinding?.bindingHash,
                        voiceProviderActionId: variant.voiceProviderActionId,
                        props: buildM5RenderProps({
                            script: variant.script,
                            voiceoverSrc: variant.voiceoverSrc,
                            composition,
                            visualAssets,
                            templateBinding: variant.templateBinding,
                            variantLineage: {
                                variantKey: variant.variantKey,
                                scriptHash: variant.scriptHash,
                                audioHash: variant.audioHash,
                                templateBindingHash: variant.templateBinding?.bindingHash,
                                voiceProviderActionId: variant.voiceProviderActionId,
                            },
                        }),
                    };
                }),
            };
        }
        if (contract.stageKey === 'machine_review') {
            const render = artifactData(artifacts, ['render_package']);
            const selectedRender = selectRenderOutput(render, String(targetCase?.platform || '').trim());
            const relativePath = safeWorkspaceRelativePath(selectedRender?.relativePath || selectedRender?.outputPath);
            if (!relativePath)
                throw new ContentCampaignError('机器审核缺少可信 RenderPackage 相对路径。');
            return {
                relativePath,
                expectedDurationSeconds: boundedDurationSeconds(selectedRender?.durationSeconds),
            };
        }
        if (contract.stageKey === 'publish_approval') {
            const rawContentVersion = artifactData(artifacts, ['platform_content_draft', 'content_version']);
            const rawReviewReport = artifactData(artifacts, ['machine_review_report', 'machine_review']);
            const contentVersion = rawContentVersion?.contentVersion || rawContentVersion;
            const reviewReport = rawReviewReport?.reviewReport || rawReviewReport;
            if (!contentVersion || !reviewReport) {
                throw new ContentCampaignError('发布审批缺少可信 ContentVersion 或 MachineReview Work Product。');
            }
            return { contentVersion, reviewReport };
        }
        throw new ContentCampaignError(`M5 阶段 ${contract.stageKey} 没有受控插件参数生成器。`);
    },
    async executeM5MachineReview({ campaignCase, targetCase, targetCaseId, outputs, parameters, sourceTaskId, }: any) {
        const artifacts = outputs.map(workProductArtifact).filter(Boolean);
        const renderPackage = artifactData(artifacts, ['render_package']);
        const scriptPackage = artifactData(artifacts, ['video_script_package', 'script_package']);
        const evidence = artifactData(artifacts, ['evidence_package']);
        const voicePackage = artifactData(artifacts, ['voice_package']);
        const assetPackage = artifactData(artifacts, ['asset_package']);
        const generatedImage = artifactData(artifacts, ['generated_image_package']);
        const visualAnalysis = artifactData(artifacts, ['visual_analysis_package']);
        const platform = String(targetCase?.platform || '').trim();
        const render = selectRenderOutput(renderPackage, platform);
        const grayLineage = optionalM5GrayRenderLineage(scriptPackage, voicePackage);
        const baselineLineage = grayLineage
            ? null
            : optionalM5BaselineRenderLineage(scriptPackage, voicePackage);
        const selectedLineage = (grayLineage as any)?.[platform]
            || (hasM5VariantLineage(render) ? baselineLineage : null);
        if (grayLineage) {
            assertM5RenderOutputLineage(render, selectedLineage, platform);
            if (platform === 'douyin'
                && (selectedLineage.templateBinding.grayTargetCaseId !== targetCaseId
                    || selectedLineage.templateBinding.grayTargetDayCaseId !== targetCase?.parentCaseId
                    || selectedLineage.templateBinding.grayTargetScheduledDate
                        !== String(targetCase?.scheduledDate || ''))) {
                throw new ContentCampaignError('抖音灰度成片没有绑定当前平台 Case、日期父 Case和预约日期，机器审核已停止。');
            }
        }
        else if (selectedLineage) {
            assertM5RenderOutputLineage(render, selectedLineage, platform);
        }
        const script = selectedLineage?.script || scriptPackage;
        const voice = selectedLineage
            ? voicePackage.variants[selectedLineage.variantKey]
            : voicePackage;
        const contentVersionId = deriveM5ContentVersionId({
            pipelineCaseId: targetCaseId,
            platform,
            mediaChecksum: render?.checksum,
        });
        const propsPath = safeWorkspaceRelativePath(render?.propsPath);
        if (!script?.fullScript
            || !evidence
            || !voice
            || !assetPackage
            || !generatedImage
            || !visualAnalysis
            || !contentVersionId
            || !propsPath) {
            throw new ContentCampaignError('机器审核缺少同一 Case 的 ScriptPackage、EvidencePackage、AssetPackage、GeneratedImagePackage、VisualAnalysisPackage、RenderPackage 哈希或 props，未生成审核产物。');
        }
        const providerProvenance = m5ProviderProvenance({
            generatedImage,
            visualAnalysis,
            voice,
            allowLocalFixtureProvenance: this.allowLocalFixtureProvenance,
        });
        const media = await this.executeTool({
            campaignId: campaignCase.id,
            caseId: targetCaseId,
            toolId: `${CONTENT_AUTONOMY_PLUGIN_KEY}:media-validate`,
            parameters,
        });
        const subtitles = await this.executeTool({
            campaignId: campaignCase.id,
            caseId: targetCaseId,
            toolId: `${CONTENT_AUTONOMY_PLUGIN_KEY}:subtitle-layout-validate`,
            parameters: { propsPath },
        });
        const checks = deterministicM5ReviewChecks({
            campaignCase,
            targetCase,
            render,
            script,
            evidence,
            voice,
            assetPackage,
            generatedImage,
            media,
            subtitles,
        });
        const failures = Object.entries(checks)
            .filter(([, passed]: any) => passed !== true)
            .map(([check]: any) => check);
        const reviewReport: any = {
            status: failures.length ? 'failed' : 'passed',
            contentVersionId,
            variantLineage: {
                variantKey: selectedLineage?.variantKey || 'baseline',
                scriptHash: selectedLineage?.scriptHash || m5ScriptHash(script.fullScript),
                templateBindingHash: selectedLineage?.templateBinding?.bindingHash
                    || script?.templateLifecycle?.templateBinding?.bindingHash
                    || script?.templateBinding?.bindingHash
                    || null,
                renderChecksum: render.checksum,
            },
            checks,
            failures,
            checkedAt: this.now().toISOString(),
            evidence: {
                mediaValidation: {
                    relativePath: media.relativePath || parameters.relativePath,
                    errors: Array.isArray(media.errors) ? media.errors.slice(0, 20) : [],
                },
                subtitleLayout: {
                    propsPath: subtitles.propsPath || propsPath,
                    errors: Array.isArray(subtitles.errors) ? subtitles.errors.slice(0, 20) : [],
                },
                factBindingCount: Array.isArray(script.factBindings) ? script.factBindings.length : 0,
                sourceCount: Array.isArray(evidence.sources) ? evidence.sources.length : 0,
                renderPolicy: 'm5-verified-assets-and-official-voice-v2',
            },
        };
        if (!failures.length) {
            const copies = {
                douyin: platform === 'douyin'
                    ? buildM5PlatformCopy(script, 'douyin')
                    : null,
                xiaohongshu: platform === 'xiaohongshu'
                    ? buildM5PlatformCopy(script, 'xiaohongshu')
                    : null,
            };
            const lineage = {
                schemaVersion: 1,
                contentVersionId,
                sourceTaskId: String(sourceTaskId || targetCaseId),
                generatedBy: 'reviewer',
                createdAt: this.now().toISOString(),
                parents: [],
            };
            const packageResult = await this.executeTool({
                campaignId: campaignCase.id,
                caseId: targetCaseId,
                toolId: `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-package-write`,
                parameters: {
                    outputDir: `campaigns/${campaignCase.id}/${targetCaseId}/package`,
                    videos: m5ArtifactPackageVideos(renderPackage),
                    copies,
                    coverSourcePath: generatedImage.relativePath,
                    sources: m5SourcesLedger({
                        evidence,
                        assetPackage,
                        generatedImage,
                        voice,
                        fixtureProvenance: providerProvenance.fixtureProvenance,
                    }),
                    review: {
                        schemaVersion: 1,
                        passed: true,
                        failures: [],
                        checks: {
                            ...checks,
                            subtitleLayout: { passed: subtitles?.passed === true },
                        },
                    },
                    lineage,
                    ...(providerProvenance.actionRefs
                        ? { providerActionRefs: providerProvenance.actionRefs }
                        : {}),
                },
            });
            if (!safeWorkspaceRelativePath(packageResult?.manifestPath)
                || !/^sha256:[0-9a-f]{64}$/i.test(String(packageResult?.manifestChecksum || ''))) {
                throw new ContentCampaignError('固定产物包没有返回可信 manifest 路径和哈希。');
            }
            const lineageValidation = await this.executeTool({
                campaignId: campaignCase.id,
                caseId: targetCaseId,
                toolId: `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-lineage-validate`,
                parameters: { manifestPath: packageResult.manifestPath },
            });
            if (lineageValidation?.passed !== true) {
                throw new ContentCampaignError(`固定产物清单或血缘校验失败：${asList(lineageValidation?.errors).join('；') || '未知错误'}。`);
            }
            reviewReport.evidence.artifactPackage = {
                manifestPath: packageResult.manifestPath,
                manifestChecksum: packageResult.manifestChecksum,
                requiredArtifacts: asList(lineageValidation.requiredArtifacts),
            };
        }
        return {
            toolId: `${CONTENT_AUTONOMY_PLUGIN_KEY}:media-validate`,
            pluginId: CONTENT_AUTONOMY_PLUGIN_KEY,
            content: failures.length
                ? `机器审核未通过：${failures.join('、')}。`
                : '机器审核七项门禁全部通过。',
            artifact: {
                type: 'machine_review_report',
                schemaVersion: 'agent.army/machine-review/v1',
                data: { reviewReport },
                validation: {
                    exists: true,
                    readable: true,
                    nonEmpty: true,
                    allChecksPassed: failures.length === 0,
                },
            },
        };
    },
    async firstOfficialTtsVoice() {
        const voice = safeText(await this.controlPlane.getOfficialTtsVoice().catch(() => null), 120);
        if (!voice || /clone|克隆|复刻/i.test(voice)) {
            throw new ContentCampaignError('内容插件没有登记可用的官方 TTS 音色。');
        }
        return voice;
    },
};
