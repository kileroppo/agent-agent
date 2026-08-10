import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalContentCreator, LocalVideoContentAnalyst } from '../src/local-content-growth.js';
import {
  defaultM5ProductionTemplateBinding,
  m5ProductionTemplateBindingHash,
} from '../src/m5-production-template-resolver.js';

const M5_PIPELINE_CASE_ID = '11111111-1111-4111-8111-111111111111';
const M5_PROJECT_ID = '22222222-2222-4222-8222-222222222222';

test('M5 小拆只消费 AssetPackage，并产出逐条绑定帧、时间点和证据类型的 VisualAnalysisPackage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-visual-analysis-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const relativePath = 'campaigns/case-1/assets/frame-001.png';
  const framePath = path.join(root, relativePath);
  const frameBytes = Buffer.from('controlled-frame');
  await fs.mkdir(path.dirname(framePath), { recursive:true });
  await fs.writeFile(framePath, frameBytes);
  const assetPackage = {
    artifactId:'asset-package:task-1',
    type:'asset_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      assets:[{
        frameId:'frame-001',
        timestamp:'00:00:03',
        relativePath,
        checksum:`sha256:${crypto.createHash('sha256').update(frameBytes).digest('hex')}`,
      }],
    },
  };
  const advisor = {
    async analyze(input) {
      assert.equal(input.visualEvidence.frames[0].frameId, 'frame-001');
      assert.equal(input.providerVisionObservation, '{"visible":"task status"}');
      const data = {
        visualFindings:[
          {
            category:'opening_visual_hook',
            finding:'开场直接展示任务状态。',
            evidence:{ frameRef:'frame-001', timestamp:'00:00:03' },
            confidence:'high',
          },
          {
            category:'shot_and_pacing',
            finding:'该帧适合承接第一处流程转折。',
            evidence:{ frameRef:'frame-001', timestamp:'00:00:03' },
            confidence:'medium',
          },
          {
            category:'reusable_visual_pattern',
            finding:'可复用界面状态与旁白结论同步出现的方式。',
            evidence:{ frameRef:'frame-001', timestamp:'00:00:03' },
            confidence:'medium',
          },
        ],
      };
      assert.equal(input.validate(data), true);
      return { data, usage:{ model:{ provider:'stepfun', model:'step-1o-turbo-vision' } } };
    },
  };
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor,
  });
  const result = await analyst.execute({
    taskId:'m5-visual-task',
    taskType:'content.campaign-visual-analysis',
    assigneeAgentId:'video-content-analyst',
    input:{
      title:'AI Agent 实战',
      context:{ pipelineCaseId:M5_PIPELINE_CASE_ID },
    },
  }, {
    sourceArtifacts:[assetPackage],
    providerVision:providerVisionFixture({
      relativePath,
      checksum:assetPackage.data.assets[0].checksum,
    }),
  });
  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.type, 'visual_analysis_package');
  assert.equal(artifact.data.sourceAssetPackageId, assetPackage.artifactId);
  assert.equal(artifact.data.providerReceipt.operation, 'vision');
  assert.equal(artifact.data.providerReceipt.costCommit.status, 'confirmed');
  assert.equal(artifact.data.providerReceipt.costCommit.costEvent.projectId, M5_PROJECT_ID);
  assert.equal(artifact.validation.providerVisionConfirmed, true);
  assert.equal(artifact.validation.externalWrites, 0);
  assert.equal(artifact.data.insights.length, 3);
  assert.equal(artifact.data.insights.every((item) =>
    item.frameRef === 'frame-001'
    && item.timestamp === '00:00:03'
    && item.evidenceKind === 'stepfun_vision_frame'), true);
});

test('M5 小拆拒绝正确帧ID但错误时间点，不能静默修正后放行', async (t) => {
  const { analyst, assetPackage, providerVision } = await m5VisualFixture(t, {
    advisor:{
      async analyze() {
        return {
          data:{
            visualFindings:[
              {
                category:'opening_visual_hook',
                finding:'开场直接展示任务状态。',
                evidence:{ frameRef:'frame-001', timestamp:'00:00:09' },
                confidence:'high',
              },
              {
                category:'shot_and_pacing',
                finding:'该帧适合承接第一处流程转折。',
                evidence:{ frameRef:'frame-001', timestamp:'00:00:09' },
                confidence:'medium',
              },
              {
                category:'reusable_visual_pattern',
                finding:'界面状态与旁白结论同步。',
                evidence:{ frameRef:'frame-001', timestamp:'00:00:09' },
                confidence:'medium',
              },
            ],
          },
        };
      },
    },
  });
  await assert.rejects(
    analyst.execute({
      taskId:'m5-visual-wrong-timestamp',
      taskType:'content.campaign-visual-analysis',
      assigneeAgentId:'video-content-analyst',
      input:{
        title:'AI Agent 实战',
        context:{ pipelineCaseId:M5_PIPELINE_CASE_ID },
      },
    }, { sourceArtifacts:[assetPackage], providerVision }),
    { code:'m5_visual_analysis_evidence_invalid' },
  );
});

test('M5 小拆在模型调用前拒绝被替换的AssetPackage关键帧', async (t) => {
  let advisorCalls = 0;
  const { analyst, assetPackage, framePath, providerVision } = await m5VisualFixture(t, {
    advisor:{
      async analyze() {
        advisorCalls += 1;
        throw new Error('不应调用模型');
      },
    },
  });
  await fs.writeFile(framePath, 'tampered-frame');
  await assert.rejects(
    analyst.execute({
      taskId:'m5-visual-tampered-frame',
      taskType:'content.campaign-visual-analysis',
      assigneeAgentId:'video-content-analyst',
      input:{
        title:'AI Agent 实战',
        context:{ pipelineCaseId:M5_PIPELINE_CASE_ID },
      },
    }, { sourceArtifacts:[assetPackage], providerVision }),
    /关键帧文件与声明 sha256 不一致/,
  );
  assert.equal(advisorCalls, 0);
});

test('M5 小拆在视觉费用未确认、图片哈希错配或Project错配时不调用岗位模型且不产出包', async (t) => {
  let advisorCalls = 0;
  const { analyst, assetPackage } = await m5VisualFixture(t, {
    advisor:{
      async analyze() {
        advisorCalls += 1;
        throw new Error('Provider 视觉门禁失败后不应调用岗位模型');
      },
    },
  });
  const relativePath = assetPackage.data.assets[0].relativePath;
  const checksum = assetPackage.data.assets[0].checksum;
  for (const [label, providerVision] of [
    ['pending', providerVisionFixture({ relativePath, checksum, state:'pending_core_cost_event' })],
    ['checksum', providerVisionFixture({
      relativePath,
      checksum,
      sourceChecksum:`sha256:${'f'.repeat(64)}`,
    })],
    ['project', async (parameters) => {
      const result = await providerVisionFixture({ relativePath, checksum })(parameters);
      result.projectId = '44444444-4444-4444-8444-444444444444';
      return result;
    }],
  ]) {
    await assert.rejects(
      analyst.execute({
        taskId:`m5-visual-provider-${label}`,
        taskType:'content.campaign-visual-analysis',
        assigneeAgentId:'video-content-analyst',
        input:{
          title:'AI Agent 实战',
          context:{ pipelineCaseId:M5_PIPELINE_CASE_ID },
        },
      }, { sourceArtifacts:[assetPackage], providerVision }),
      { code:'m5_provider_vision_receipt_invalid' },
      label,
    );
  }
  assert.equal(advisorCalls, 0);
});

test('M5 小拆没有受控视觉工具授权时明确等待输入，不以Hermes advisor冒充成功', async (t) => {
  let advisorCalls = 0;
  const { analyst, assetPackage } = await m5VisualFixture(t, {
    advisor:{
      async analyze() {
        advisorCalls += 1;
        throw new Error('不应调用岗位模型');
      },
    },
  });
  const result = await analyst.execute({
    taskId:'m5-visual-no-provider-tool',
    taskType:'content.campaign-visual-analysis',
    assigneeAgentId:'video-content-analyst',
    input:{
      title:'AI Agent 实战',
      context:{ pipelineCaseId:M5_PIPELINE_CASE_ID },
    },
  }, { sourceArtifacts:[assetPackage] });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'm5_provider_vision_required');
  assert.equal(Array.isArray(result.artifactRefs) ? result.artifactRefs.length : 0, 0);
  assert.equal(advisorCalls, 0);
});

test('M5 平台适配只从同一 Case 的真实脚本和成片哈希生成 ContentVersion', async (t) => {
  const root = await sandbox(t);
  const scriptBinding = defaultM5ProductionTemplateBinding();
  const grayBinding = binding({
    schemaVersion:'agent.army/production-template-binding/v1',
    templateVersionId:'template-v2',
    source:'approved_single_gray',
    decisionStatus:'gray_ready',
    decisionWorkProductId:null,
    templateWorkProductId:'template-product-v2',
    productionDefault:false,
    grayRelease:true,
    grayTargetCaseId:'22222222-2222-4222-8222-222222222222',
    grayTargetDayCaseId:'11111111-1111-4111-8111-111111111111',
    grayTargetScheduledDate:'2026-08-09',
    grayTargetPlatform:'douyin',
    applicationScope:'full_content_variant',
    contentGuidance:['只调整抖音平台标题和正文。'],
    controls:{
      promptMutation:false,
      permissionExpansion:false,
      frequencyIncrease:false,
      paidPromotion:false,
    },
  });
  const scriptTask = taskWithArtifact('m5-script-task', {
    artifactId:'video-script:m5',
    type:'video_script_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      hook:'别再看 Agent 会不会说，先看它有没有交付。',
      fullScript:'这是一段基于真实任务结果生成的平台母版脚本。',
      templateLifecycle:{
        templateBinding:scriptBinding,
      },
      variants:{
        baseline:{
          variantKey:'baseline',
          hook:'别再看 Agent 会不会说，先看它有没有交付。',
          fullScript:'这是一段基于真实任务结果生成的平台母版脚本。',
          templateBinding:scriptBinding,
          scriptHash:scriptHash('这是一段基于真实任务结果生成的平台母版脚本。'),
        },
        gray_douyin:{
          variantKey:'gray_douyin',
          hook:'先看这次失败后有没有恢复。',
          fullScript:'这是一段只供抖音灰度的独立脚本，不会进入小红书。',
          templateBinding:grayBinding,
          templateGuidanceHash:grayBinding.bindingHash,
          scriptHash:scriptHash('这是一段只供抖音灰度的独立脚本，不会进入小红书。'),
        },
      },
    },
  });
  const renderTask = taskWithArtifact('m5-render-task', {
    artifactId:'render:m5',
    type:'render_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      relativePath:'campaigns/campaign/day/douyin.mp4',
      checksum:`sha256:${'a'.repeat(64)}`,
      audioHash:`sha256:${'b'.repeat(64)}`,
      voiceProviderActionId:'voice-task-01',
      variantKey:'gray_douyin',
      templateBindingHash:grayBinding.bindingHash,
      scriptHash:scriptHash('这是一段只供抖音灰度的独立脚本，不会进入小红书。'),
    },
  });
  const creator = new LocalContentCreator({
    store:{ list:async () => [scriptTask, renderTask] },
    artifactsDir:path.join(root, 'out'),
  });
  const result = await creator.execute({
    taskId:'m5-platform-task',
    taskType:'content.platform-draft',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-platform-adapt',
        pipelineCaseId:'22222222-2222-4222-8222-222222222222',
        sourceTaskIds:[scriptTask.taskId, renderTask.taskId],
        pipelineCase:{
          parentCaseId:'11111111-1111-4111-8111-111111111111',
          fields:{ platform:'douyin', scheduledDate:'2026-08-09' },
        },
      },
    },
  });
  const artifact = result.artifactRefs[0];
  assert.equal(result.status, 'succeeded');
  assert.equal(artifact.type, 'platform_content_draft');
  assert.equal(artifact.data.contentVersion.platform, 'douyin');
  assert.equal(artifact.data.contentVersion.mediaPath, 'campaigns/campaign/day/douyin.mp4');
  assert.equal(artifact.data.contentVersion.checksum, `sha256:${'a'.repeat(64)}`);
  assert.match(artifact.data.contentVersion.contentVersionId, /^m5:douyin:[0-9a-f]{40}$/);
  assert.equal(artifact.data.contentVersion.templateVersionId, 'template-v2');
  assert.equal(artifact.data.contentVersion.dayCaseId, '11111111-1111-4111-8111-111111111111');
  assert.equal(artifact.data.contentVersion.platformCaseId, '22222222-2222-4222-8222-222222222222');
  assert.equal(artifact.data.contentVersion.templateWorkProductId, 'template-product-v2');
  assert.equal(artifact.data.contentVersion.grayRelease, true);
  assert.equal(artifact.data.contentVersion.title, '先看这次失败后有没有恢复。');
  assert.equal(artifact.data.contentVersion.templateApplication.mode, 'verified_full_content_variant');
  assert.equal(artifact.data.publishingStatus, 'draft_only');

  const wrongTarget = await creator.execute({
    taskId:'m5-platform-task-wrong-target',
    taskType:'content.platform-draft',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-platform-adapt',
        pipelineCaseId:'33333333-3333-4333-8333-333333333333',
        sourceTaskIds:[scriptTask.taskId, renderTask.taskId],
        pipelineCase:{
          parentCaseId:'11111111-1111-4111-8111-111111111111',
          fields:{ platform:'douyin', scheduledDate:'2026-08-09' },
        },
      },
    },
  });
  assert.equal(wrongTarget.status, 'needs_input');
  assert.equal(wrongTarget.error.code, 'm5_gray_target_mismatch');
});

test('M5 平台适配从三份 RenderPackage 中选择当前平台成片', async (t) => {
  const root = await sandbox(t);
  const baselineBinding = defaultM5ProductionTemplateBinding();
  const baselineText = '真实工具结果必须进入下一步。';
  const scriptTask = taskWithArtifact('m5-script-three-output', {
    artifactId:'video-script:m5-three-output',
    type:'video_script_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      hook:'看真实产出',
      fullScript:baselineText,
      templateLifecycle:{ templateBinding:baselineBinding },
      variants:{
        baseline:{
          variantKey:'baseline',
          hook:'看真实产出',
          fullScript:baselineText,
          templateBinding:baselineBinding,
          scriptHash:scriptHash(baselineText),
        },
      },
    },
  });
  const renderTask = taskWithArtifact('m5-render-three-output', {
    artifactId:'render:m5-three-output',
    type:'render_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      outputs:{
        master:{
          outputPath:'campaigns/day/master.mp4',
          checksum:`sha256:${'a'.repeat(64)}`,
          audioHash:`sha256:${'b'.repeat(64)}`,
          voiceProviderActionId:'voice-task-01',
        },
        douyin:{
          outputPath:'campaigns/day/douyin.mp4',
          checksum:`sha256:${'b'.repeat(64)}`,
          audioHash:`sha256:${'c'.repeat(64)}`,
          voiceProviderActionId:'voice-task-02',
          templateBindingHash:baselineBinding.bindingHash,
          scriptHash:scriptHash(baselineText),
        },
        xiaohongshu:{
          outputPath:'campaigns/day/xiaohongshu.mp4',
          checksum:`sha256:${'c'.repeat(64)}`,
          audioHash:`sha256:${'d'.repeat(64)}`,
          voiceProviderActionId:'voice-task-03',
          variantKey:'baseline',
          templateBindingHash:baselineBinding.bindingHash,
          scriptHash:scriptHash(baselineText),
        },
      },
    },
  });
  const creator = new LocalContentCreator({
    store:{ list:async () => [scriptTask, renderTask] },
    artifactsDir:path.join(root, 'out'),
  });

  const result = await creator.execute({
    taskId:'m5-platform-three-output',
    taskType:'content.platform-draft',
    input:{
      context:{
        paperclipRoutineKey:'m5-platform-adapt',
        pipelineCaseId:'11111111-1111-4111-8111-111111111111',
        sourceTaskIds:[scriptTask.taskId, renderTask.taskId],
        pipelineCase:{
          parentCaseId:'33333333-3333-4333-8333-333333333333',
          fields:{ platform:'xiaohongshu', scheduledDate:'2026-08-09' },
        },
      },
    },
  });

  assert.equal(result.status, 'succeeded');
  const contentVersion = result.artifactRefs[0].data.contentVersion;
  assert.equal(contentVersion.mediaPath, 'campaigns/day/xiaohongshu.mp4');
  assert.equal(contentVersion.checksum, `sha256:${'c'.repeat(64)}`);
  assert.equal(contentVersion.templateVersionId, 'm5-template-default-v1');
  assert.equal(contentVersion.templateApplication.variantKey, 'baseline');
  assert.equal(contentVersion.grayRelease, false);
});

test('M5 平台适配缺少真实 RenderPackage 时失败闭锁', async (t) => {
  const root = await sandbox(t);
  const scriptTask = taskWithArtifact('m5-script-only', {
    artifactId:'video-script:m5-only',
    type:'video_script_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{ fullScript:'只有脚本，没有真实成片。' },
  });
  const creator = new LocalContentCreator({
    store:{ list:async () => [scriptTask] },
    artifactsDir:path.join(root, 'out'),
  });
  const result = await creator.execute({
    taskId:'m5-platform-no-render',
    taskType:'content.platform-draft',
    input:{
      context:{
        paperclipRoutineKey:'m5-platform-adapt',
        pipelineCaseId:'11111111-1111-4111-8111-111111111111',
        sourceTaskIds:[scriptTask.taskId],
        pipelineCase:{ fields:{ platform:'xiaohongshu' } },
      },
    },
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'm5_render_package_required');
  assert.equal(result.artifactRefs, undefined);
});

test('正式 full 拆解只复用确认稿并生成 13 个带证据模块', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed.md');
  await fs.writeFile(transcriptPath, '# 样片｜人工确认稿\n\n[00:00] 开场直接给出真实结果。\n\n[00:08] 接着解释方法和限制条件。\n');
  const sourceTask = taskWithArtifact('source-task-0001', confirmedArtifact(transcriptPath, 'automatic'));
  const store = { list:async () => [sourceTask] };
  const analyst = new LocalVideoContentAnalyst({ store, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  const result = await analyst.execute({
    taskId:'analysis-task-0001',
    taskType:'content.video-benchmark-analysis',
    assigneeAgentId:'video-content-analyst',
    input:{ title:'样片拆解', analysisIntent:'deep', evidenceMode:'formal', depth:'full', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.type, 'video_content_analysis_report');
  assert.equal(artifact.data.modules.length, 13);
  assert.equal(artifact.data.confirmationMode, 'automatic');
  assert.equal(artifact.data.evidenceLabel, '系统质量确认稿');
  assert.ok(artifact.data.modules.every((item) => item.evidence.fragment));
  assert.deepEqual(artifact.data.modules.map((item) => item.name), [
    '基本信息', '标题诊断', '开头诊断', '爆点拆解', '全文逐句作用拆解', '结构分析',
    '话术技巧与文字洁癖', '表达效率检测', '认知落差检测', '素材盘点',
    'AI辅助创作建议', '可模仿点 Top3', '爆款结构模板'
  ]);
  assert.ok(artifact.data.modules.every((item) => item.originalAnalysis.length && item.diagnosis.length && item.optimization.length));
  assert.ok(artifact.data.modules.every((item) => item.observedFact?.evidence?.fragment));
  assert.ok(artifact.data.modules.every((item) => item.mechanismInference?.certainty === 'inference'));
  assert.ok(artifact.data.modules.every((item) => item.applicableWhen && item.failureConditions && item.validationMethod && item.reuseMethod));
  const sentenceModule = artifact.data.modules.find((item) => item.name === '全文逐句作用拆解');
  assert.equal(sentenceModule.sentenceBreakdown.length, 2);
  assert.ok(sentenceModule.sentenceBreakdown.every((item) => item.original && item.role && item.evidence.fragment));
  assert.equal(artifact.validation.formalSourceConfirmed, true);
  const markdown = await fs.readFile(new URL(artifact.location), 'utf8');
  assert.match(markdown, /## 行动清单/);
  assert.match(markdown, /### 1\. 基本信息/);
  assert.match(markdown, /### 13\. 爆款结构模板/);
  assert.match(markdown, /没有冒充人工听审/);
  assert.match(markdown, /展开全文作用拆解（2 个连续证据段）/);
  assert.doesNotMatch(markdown, /\[object Object\]/);
  assert.doesNotMatch(markdown, /## 结构化结果|```json|\"modules\"\\s*:/);
});

test('精华提炼输出短摘要、原文金句和唯一下一步并保留证据', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-digest.md');
  await fs.writeFile(transcriptPath, '[00:00] 先展示真实结果，再解释适用条件。\n[00:08] 每次只调整一个变量，才能知道变化来自哪里。\n[00:16] 最后记录结果并决定下一轮是否保留。\n');
  const sourceTask = taskWithArtifact('source-task-digest', confirmedArtifact(transcriptPath, 'automatic'));
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root]
  });
  const result = await analyst.execute({
    taskId:'analysis-task-digest',
    taskType:'content.video-benchmark-analysis',
    input:{
      title:'快速看懂样片',
      analysisIntent:'digest',
      evidenceMode:'formal',
      context:{ sourceTaskIds:[sourceTask.taskId] }
    }
  });
  const data = result.artifactRefs[0].data;
  assert.equal(data.analysisIntent, 'digest');
  assert.equal(data.reportVersion, 'video-analysis/v2');
  assert.deepEqual(data.availableAnalysisIntents.map((item) => item.id), ['digest', 'deep', 'template', 'style']);
  assert.ok(data.digest.corePoints.length >= 3 && data.digest.corePoints.length <= 5);
  assert.ok(data.digest.goldenQuotes.length >= 2 && data.digest.goldenQuotes.length <= 3);
  assert.ok(data.digest.goldenQuotes.every((item) => item.quote && item.evidence.fragment === item.quote));
  assert.equal(data.nextAction.action, 'continue_deep_analysis');
  assert.equal(data.creationEligible, true);
  assert.equal(result.artifactRefs[0].validation.digestWithinCharacterLimit, true);
  assert.ok(result.artifactRefs[0].validation.digestCharacterCount <= 800);
});

test('精华提炼按开头、中段和结尾覆盖长确认稿，不只截取前三段', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-digest-coverage.md');
  await fs.writeFile(transcriptPath, Array.from({ length:9 }, (_, index) => (
    `[00:${String(index * 5).padStart(2, '0')}] 第${index + 1}段真实内容，承担独立信息任务。`
  )).join('\n'));
  const sourceTask = taskWithArtifact('source-task-digest-coverage', confirmedArtifact(transcriptPath));
  const analyst = new LocalVideoContentAnalyst({ store:{ list:async () => [sourceTask] }, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  const result = await analyst.execute({
    taskId:'analysis-task-digest-coverage', taskType:'content.video-benchmark-analysis',
    input:{ title:'覆盖式精华提炼', analysisIntent:'digest', evidenceMode:'formal', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  const digest = result.artifactRefs[0].data.digest;
  assert.deepEqual(digest.goldenQuotes.map((item) => item.evidence.timestamp), ['00:00', '00:20', '00:40']);
  assert.match(digest.oneSentenceSummary, /第1段/);
  assert.match(digest.oneSentenceSummary, /第5段/);
  assert.match(digest.oneSentenceSummary, /第9段/);
});

test('模型模块通过但长确认稿 digest 证据被归并后，只做一次无 Provider 的确定性结构修复', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-digest-structure-recovery.md');
  const transcriptLines = Array.from({ length:32 }, (_, index) => (
    `[00:${String(index).padStart(2, '0')}] 第${index + 1}句真实转录内容，承担独立信息任务。`
  ));
  await fs.writeFile(transcriptPath, transcriptLines.join('\n\n'));
  const sourceTask = taskWithArtifact('source-task-digest-structure-recovery', confirmedArtifact(transcriptPath, 'automatic'));
  const evidence = { timestamp:'00:00', fragment:'第1句真实转录内容，承担独立信息任务。' };
  const modules = ['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议']
    .map((name) => ({ name, finding:`模型对${name}的判断`, evidence, confidence:'high' }));
  let advisorCalls = 0;
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() {
      advisorCalls += 1;
      return {
        data:{ summary:'模型模块已通过语义校验，但没有返回合格 digest。', modules },
        usage:{ model:{ provider:'test-provider', model:'test-model', inputTokens:10, outputTokens:5, apiCalls:1 } },
      };
    } },
  });

  const result = await analyst.execute({
    taskId:'analysis-task-digest-structure-recovery',
    taskType:'content.video-benchmark-analysis',
    input:{
      title:'长确认稿精华提炼',
      analysisIntent:'digest',
      evidenceMode:'formal',
      depth:'fast',
      visualMode:'off',
      context:{ sourceTaskIds:[sourceTask.taskId] },
    },
  });

  const artifact = result.artifactRefs[0];
  assert.equal(advisorCalls, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(artifact.validation.modeStructurePassedBeforeRepair, false);
  assert.equal(artifact.validation.modeStructureRepairAttempted, true);
  assert.equal(artifact.validation.modeStructureRepairApplied, true);
  assert.equal(artifact.validation.modeStructurePassed, true);
  assert.equal(artifact.data.generationMode, 'hermes_advisor_with_deterministic_digest_repair');
  assert.equal(artifact.data.advisorFailure, null);
  assert.equal(artifact.data.qualityFailure, 'content_analysis_mode_structure_validation_failed');
  assert.deepEqual(artifact.data.modeStructureRepair, {
    attempted:true,
    applied:true,
    attemptCount:1,
    providerInvoked:false,
    method:'deterministic_plain_text_digest_rebuild',
    sourceGenerationMode:'hermes_advisor',
    reason:'content_analysis_mode_structure_validation_failed',
    validationPassed:true,
  });
  assert.ok(artifact.data.digest.corePoints.every((item) => transcriptLines.some((line) => line.includes(item.evidence.fragment))));
  assert.ok(artifact.data.digest.goldenQuotes.every((item) => item.quote === item.evidence.fragment));
  assert.equal(result.usage.model.apiCalls, 1);
});

test('模型精华输出含伪造金句时保留证据化兜底内容', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-digest-guard.md');
  await fs.writeFile(transcriptPath, '[00:00] 第一句真实内容。\n[00:08] 第二句真实内容。\n[00:16] 第三句真实内容。\n');
  const sourceTask = taskWithArtifact('source-task-digest-guard', confirmedArtifact(transcriptPath));
  const evidence = { timestamp:'00:00', fragment:'第一句真实内容。' };
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] }, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root],
    advisor:{ async analyze() { return { data:{
      summary:'模型摘要',
      modules:['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'].map((name) => ({ name, finding:name, evidence, confidence:'high' })),
      digest:{
        oneSentenceSummary:'模型摘要',
        corePoints:[1, 2, 3].map((index) => ({ point:`重点${index}`, evidence })),
        goldenQuotes:[1, 2].map((index) => ({ quote:`不存在的金句${index}`, evidence:{ timestamp:'00:00', fragment:`不存在的金句${index}` } })),
        actionItems:['行动一']
      }
    } }; } }
  });
  const result = await analyst.execute({
    taskId:'analysis-task-digest-guard', taskType:'content.video-benchmark-analysis',
    input:{ title:'精华提炼', analysisIntent:'digest', evidenceMode:'formal', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  const digest = result.artifactRefs[0].data.digest;
  assert.equal(result.artifactRefs[0].validation.advisorApplied, true);
  assert.ok(digest.goldenQuotes.every((item) => !item.quote.includes('不存在')));
  assert.ok(digest.goldenQuotes.every((item) => item.quote === item.evidence.fragment));
});

test('模板学习只输出结构模板候选、替换指南和异题原创示例', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-template.md');
  await fs.writeFile(transcriptPath, '[00:00] 开场先给出可核验结果。\n[00:08] 中段解释三个步骤和限制。\n[00:16] 结尾只给一个行动。\n');
  const sourceTask = taskWithArtifact('source-task-template', confirmedArtifact(transcriptPath));
  const analyst = new LocalVideoContentAnalyst({ store:{ list:async () => [sourceTask] }, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  const result = await analyst.execute({
    taskId:'analysis-task-template', taskType:'content.video-benchmark-analysis',
    input:{ title:'提取模板', analysisIntent:'template', evidenceMode:'formal', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  const data = result.artifactRefs[0].data;
  assert.equal(data.analysisIntent, 'template');
  assert.equal(data.templateLearning.status, 'candidate');
  assert.equal(data.templateLearning.openingTemplates.length, 3);
  assert.ok(data.templateLearning.structure.every((item) => item.placeholder && item.replacementGuide && item.evidence.fragment));
  assert.match(data.templateLearning.differentTopicExample, /家庭收纳/);
  assert.match(data.templateLearning.originalityReminder, /原创内容/);
  assert.doesNotMatch(data.templateLearning.performanceClaim, /验证有效/);
  assert.equal(data.nextAction.requiresExplicitApproval, true);
});

test('风格探索返回四个事实锁定短样稿且无数据时降级为证据驱动版', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-style.md');
  await fs.writeFile(transcriptPath, '[00:00] 开场先展示流程结果。\n[00:08] 中间解释为什么每次只改一个变量。\n[00:16] 最后记录限制并安排下一轮验证。\n');
  const sourceTask = taskWithArtifact('source-task-style', confirmedArtifact(transcriptPath));
  const analyst = new LocalVideoContentAnalyst({ store:{ list:async () => [sourceTask] }, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  const result = await analyst.execute({
    taskId:'analysis-task-style', taskType:'content.video-benchmark-analysis',
    input:{ title:'探索表达风格', analysisIntent:'style', evidenceMode:'formal', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  const data = result.artifactRefs[0].data;
  assert.equal(data.analysisIntent, 'style');
  assert.equal(data.styleExploration.factsLocked, true);
  assert.equal(data.styleExploration.variants.length, 4);
  assert.ok(data.styleExploration.variants.every((item) => item.sample.length >= 150 && item.sample.length <= 250));
  assert.equal(data.styleExploration.variants[3].name, '证据驱动版');
  assert.match(data.styleExploration.variants[3].sample, /不能证明播放或转化提升/);
  assert.equal(data.nextAction.requiresExplicitApproval, true);
});

test('正式分析缺少确认稿时拒绝，初步分析可读机器稿但明确降级', async (t) => {
  const root = await sandbox(t);
  const rawPath = path.join(root, 'raw.txt');
  await fs.writeFile(rawPath, '这是机器转录内容，只有初步证据，不能进入正式创作。');
  const sourceTask = taskWithArtifact('source-task-0002', {
    artifactId:'raw-1', taskId:'source-task-0002', type:'raw_asr_transcript', location:`file://${rawPath}`,
    validation:{ exists:true, readable:true, nonEmpty:true }
  });
  const store = { list:async () => [sourceTask] };
  const analyst = new LocalVideoContentAnalyst({ store, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  const formal = await analyst.execute({
    taskId:'analysis-task-0002', taskType:'content.video-benchmark-analysis',
    input:{ title:'正式分析', evidenceMode:'formal', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  assert.equal(formal.error.code, 'confirmed_transcript_required');
  const preliminary = await analyst.execute({
    taskId:'analysis-task-0003', taskType:'content.video-benchmark-analysis',
    input:{ title:'初步分析', evidenceMode:'preliminary', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  assert.equal(preliminary.status, 'succeeded');
  assert.equal(preliminary.artifactRefs[0].data.evidenceMode, 'preliminary');
  assert.equal(preliminary.artifactRefs[0].data.creationEligible, false);
});

test('Hermes 完整拆解只有在 13 模块及逐项证据通过校验后才替换本机兜底', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-hermes.md');
  await fs.writeFile(transcriptPath, '[00:00] 开场直接给出真实结果。\n[00:08] 接着解释方法和限制条件。\n');
  const sourceTask = taskWithArtifact('source-task-hermes', confirmedArtifact(transcriptPath));
  const evidence = { timestamp:'00:00', fragment:'开场直接给出真实结果！' };
  const names = [
    '基本信息', '标题诊断', '开头诊断', '爆点拆解', '全文逐句作用拆解', '结构分析',
    '话术技巧与文字洁癖', '表达效率检测', '认知落差检测', '素材盘点',
    'AI辅助创作建议', '可模仿点 Top3', '爆款结构模板'
  ];
  const modules = names.map((name) => ({
    name,
    finding:`${name}判断`,
    evidence,
    originalAnalysis:[{ claim:'原文判断', evidence }],
    diagnosis:[{ issue:'待优化项', severity:'low', evidence }],
    optimization:[{ action:'具体建议', evidence }],
    ...(name === '全文逐句作用拆解' ? {
      sentenceBreakdown:[
        { original:'开场直接给出真实结果！', role:'开场', evidence:{ timestamp:'00:00', fragment:'开场直接给出真实结果！' } },
        { original:'接着解释方法和限制条件。', role:'展开', evidence:{ timestamp:'00:08', fragment:'接着解释方法和限制条件。' } }
      ]
    } : {})
  }));
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() {
      return {
        data:{ summary:'Hermes 证据化结果', modules, reusablePatterns:[], actionItems:[] },
        usage:{ model:{ provider:'openai-codex', model:'gpt-5.6-terra', inputTokens:100, outputTokens:50, apiCalls:1 } }
      };
    } }
  });
  const result = await analyst.execute({
    taskId:'analysis-task-hermes',
    taskType:'content.video-benchmark-analysis',
    assigneeAgentId:'video-content-analyst',
    input:{ title:'Hermes 拆解', evidenceMode:'formal', depth:'full', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  assert.equal(result.artifactRefs[0].validation.advisorApplied, true);
  assert.equal(result.artifactRefs[0].data.generationMode, 'hermes_advisor');
  assert.equal(result.usage.model.apiCalls, 1);
});

test('Hermes 深度内容充足但逐句覆盖不完整时只修复证据结构，不丢弃模型模块', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-repair.md');
  await fs.writeFile(transcriptPath, '[00:00] 开场直接给出真实结果。\n[00:08] 接着解释方法和限制条件。\n');
  const sourceTask = taskWithArtifact('source-task-repair', confirmedArtifact(transcriptPath));
  const names = [
    '基本信息', '标题诊断', '开头诊断', '爆点拆解', '全文逐句作用拆解', '结构分析',
    '话术技巧与文字洁癖', '表达效率检测', '认知落差检测', '素材盘点',
    'AI辅助创作建议', '可模仿点 Top3', '爆款结构模板'
  ];
  const evidence = { timestamp:'00:00', fragment:'开场直接给出真实结果。' };
  const modules = names.map((name) => ({
    name,
    finding:`Hermes 对${name}的深度判断`,
    evidence,
    originalAnalysis:[{ claim:`Hermes ${name}原文分析`, evidence }],
    diagnosis:[{ issue:`Hermes ${name}问题诊断`, severity:'medium', evidence }],
    optimization:[{ action:`Hermes ${name}具体改法`, evidence }],
    ...(name === '全文逐句作用拆解' ? {
      sentenceBreakdown:[
        { original:'开场直接给出真实结果。', role:'开场', explanation:'直接交付结果。', evidence }
      ]
    } : {})
  }));
  const semanticError = new Error('结构不完整');
  semanticError.code = 'content_analysis_semantic_validation_failed';
  semanticError.data = { summary:'Hermes 深度分析，证据覆盖待修复。', modules, reusablePatterns:['模型模式'], actionItems:['模型行动'] };
  semanticError.usage = { model:{ provider:'openai-codex', model:'gpt-5.6-terra', inputTokens:200, outputTokens:100, apiCalls:2 } };
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() { throw semanticError; } }
  });

  const result = await analyst.execute({
    taskId:'analysis-task-repair',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'证据修复拆解', evidenceMode:'formal', depth:'full', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.data.generationMode, 'hermes_advisor_evidence_repaired');
  assert.equal(artifact.validation.advisorApplied, true);
  assert.equal(artifact.validation.semanticValidationPassed, true);
  assert.equal(artifact.validation.semanticRepairApplied, true);
  assert.match(artifact.data.modules[0].finding, /Hermes 对基本信息/);
  assert.equal(artifact.data.modules.find((item) => item.name === '全文逐句作用拆解').sentenceBreakdown.length, 2);
  assert.equal(result.usage.model.apiCalls, 2);
});

test('确认稿的时间点缺失系统标记不会让逐字原文引用被误判为无来源', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-untimed.md');
  await fs.writeFile(transcriptPath, '[时间点缺失] 开场直接给出真实结果。\n[时间点缺失] 接着解释方法和限制条件。\n');
  const sourceTask = taskWithArtifact('source-task-untimed', confirmedArtifact(transcriptPath));
  const names = [
    '基本信息', '标题诊断', '开头诊断', '爆点拆解', '全文逐句作用拆解', '结构分析',
    '话术技巧与文字洁癖', '表达效率检测', '认知落差检测', '素材盘点',
    'AI辅助创作建议', '可模仿点 Top3', '爆款结构模板'
  ];
  const evidence = { timestamp:null, fragment:'开场直接给出真实结果。' };
  const modules = names.map((name) => ({
    name,
    finding:`${name}判断`,
    evidence,
    originalAnalysis:[{ claim:'原文判断', evidence }],
    diagnosis:[{ issue:'待优化项', severity:'low', evidence }],
    optimization:[{ action:'具体建议', evidence }],
    ...(name === '全文逐句作用拆解' ? {
      sentenceBreakdown:[
        { original:'开场直接给出真实结果。', role:'开场', evidence:{ timestamp:null, fragment:'开场直接给出真实结果。' } },
        { original:'接着解释方法和限制条件。', role:'展开', evidence:{ timestamp:null, fragment:'接着解释方法和限制条件。' } }
      ]
    } : {})
  }));
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() {
      return { data:{ summary:'无时间点深度结果', modules, reusablePatterns:[], actionItems:[] } };
    } }
  });

  const result = await analyst.execute({
    taskId:'analysis-task-untimed',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'无时间点拆解', evidenceMode:'formal', depth:'full', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });

  assert.equal(result.artifactRefs[0].validation.advisorApplied, true);
  assert.equal(result.artifactRefs[0].data.generationMode, 'hermes_advisor');
});

test('跨多句的原文引用忽略中间时间戳，但引用时间点仍必须来自确认稿', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-timed-dialogue.md');
  await fs.writeFile(transcriptPath, '[00:29] 但是你们藏私房钱\n\n[00:31] 这事可就违反家法了\n\n[00:33] 你们会吗\n');
  const sourceTask = taskWithArtifact('source-task-timed-dialogue', confirmedArtifact(transcriptPath));
  const names = [
    '基本信息', '标题诊断', '开头诊断', '爆点拆解', '全文逐句作用拆解', '结构分析',
    '话术技巧与文字洁癖', '表达效率检测', '认知落差检测', '素材盘点',
    'AI辅助创作建议', '可模仿点 Top3', '爆款结构模板'
  ];
  const evidence = { timestamp:'00:29', fragment:'但是你们藏私房钱，这事可就违反家法了，你们会吗？' };
  const modules = names.map((name) => ({
    name,
    finding:`${name}判断`,
    evidence,
    originalAnalysis:[{ claim:'原文判断', evidence }],
    diagnosis:[{ issue:'待优化项', severity:'low', evidence }],
    optimization:[{ action:'具体建议', evidence }],
    ...(name === '全文逐句作用拆解' ? {
      sentenceBreakdown:[
        { original:'但是你们藏私房钱', role:'设问', evidence:{ timestamp:'00:29', fragment:'但是你们藏私房钱' } },
        { original:'这事可就违反家法了', role:'冲突', evidence:{ timestamp:'00:31', fragment:'这事可就违反家法了' } },
        { original:'你们会吗', role:'反问', evidence:{ timestamp:'00:33', fragment:'你们会吗' } }
      ]
    } : {})
  }));
  let invalidTimestamp = false;
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() {
      const advisedModules = structuredClone(modules);
      if (invalidTimestamp) advisedModules[0].evidence.timestamp = '09:59';
      return { data:{ summary:'连续台词分析', modules:advisedModules, visualFindings:[], reusablePatterns:[], actionItems:[] } };
    } }
  });

  const accepted = await analyst.execute({
    taskId:'analysis-task-timed-dialogue',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'时间轴拆解', evidenceMode:'formal', depth:'full', visualMode:'off', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  assert.equal(accepted.artifactRefs[0].validation.advisorApplied, true);

  invalidTimestamp = true;
  const rejected = await analyst.execute({
    taskId:'analysis-task-invalid-timestamp',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'错误时间轴拆解', evidenceMode:'formal', depth:'full', visualMode:'off', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  assert.equal(rejected.artifactRefs[0].validation.advisorApplied, false);
});

test('长确认稿会覆盖式归并为最多 30 个证据块而不是只截取开头', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-long.md');
  const lines = Array.from({ length:61 }, (_, index) => `[时间点缺失] 这是第${index + 1}句可核验的长视频转录内容。`);
  await fs.writeFile(transcriptPath, lines.join('\n\n'));
  const sourceTask = taskWithArtifact('source-task-long', confirmedArtifact(transcriptPath));
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root]
  });

  const result = await analyst.execute({
    taskId:'analysis-task-long',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'长视频拆解', evidenceMode:'formal', depth:'full', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });

  const sentenceModule = result.artifactRefs[0].data.modules.find((item) => item.name === '全文逐句作用拆解');
  assert.ok(sentenceModule.sentenceBreakdown.length <= 30);
  assert.match(sentenceModule.sentenceBreakdown[0].original, /第1句/);
  assert.match(sentenceModule.sentenceBreakdown.at(-1).original, /第61句/);
});

test('Hermes 预算失败时仍交付本机证据化兜底并保留已消耗用量', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-budget.md');
  await fs.writeFile(transcriptPath, '[00:00] 开场给结论。\n[00:05] 接着给依据。\n');
  const sourceTask = taskWithArtifact('source-task-budget', confirmedArtifact(transcriptPath));
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() {
      const error = new Error('budget exhausted');
      error.usage = { model:{ provider:'openai-codex', model:'gpt-5.6-terra', inputTokens:20, outputTokens:2, apiCalls:2 } };
      throw error;
    } }
  });
  const result = await analyst.execute({
    taskId:'analysis-task-budget',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'预算兜底', evidenceMode:'formal', depth:'fast', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].data.generationMode, 'deterministic_fallback');
  assert.equal(result.artifactRefs[0].data.advisorFailure, 'content_analysis_advisor_failed');
  assert.equal(result.artifactRefs[0].data.qualityFailure, 'content_analysis_mode_structure_validation_failed');
  assert.equal(result.artifactRefs[0].validation.modeStructurePassedBeforeRepair, false);
  assert.equal(result.artifactRefs[0].validation.modeStructureRepairAttempted, true);
  assert.equal(result.artifactRefs[0].validation.modeStructureRepairApplied, false);
  assert.equal(result.artifactRefs[0].validation.modeStructurePassed, false);
  assert.equal(result.artifactRefs[0].data.modeStructureRepair.attemptCount, 1);
  assert.equal(result.artifactRefs[0].data.modeStructureRepair.providerInvoked, false);
  assert.equal(result.artifactRefs[0].data.modeStructureRepair.validationPassed, false);
  assert.equal(result.artifactRefs[0].validation.advisorApplied, false);
  assert.equal(result.artifactRefs[0].validation.semanticValidationPassed, false);
  assert.equal(result.usage.model.apiCalls, 2);
});

test('普通故事板没有受控 Provider 时自动模式降级为部分文字报告', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-visual.md');
  const sourceEvidencePath = path.join(root, 'source-evidence.json');
  const visualDir = path.join(root, 'visual');
  const storyboardDir = path.join(visualDir, 'storyboards');
  await fs.mkdir(storyboardDir, { recursive:true });
  await fs.writeFile(transcriptPath, '[00:00] 开场直接给出结果。\n[00:05] 接着说明方法和边界。\n');
  await fs.writeFile(sourceEvidencePath, JSON.stringify({
    sourceMetadata:{
      title:'平台真实原标题',
      author:'平台作者',
      platform:'bili',
      durationSeconds:20,
      canonicalUrl:'https://www.bilibili.com/video/BVTEST'
    }
  }));
  await fs.writeFile(path.join(storyboardDir, 'storyboard-01.jpg'), 'storyboard');
  const frames = [
    { frameId:'frame-001', timestamp:'00:00', reason:'opening_anchor' },
    { frameId:'frame-002', timestamp:'00:05', reason:'transcript_cue' },
    { frameId:'frame-003', timestamp:'00:12', reason:'scene_change' }
  ];
  await fs.writeFile(path.join(visualDir, 'visual-evidence.json'), JSON.stringify({
    schemaVersion:'agent.army/visual-evidence/v1',
    frames,
    storyboards:[{ storyboardId:'storyboard-01', localRef:'storyboards/storyboard-01.jpg', frameRefs:frames.map((frame) => frame.frameId) }],
    coverage:{ firstFrameAt:'00:00', lastFrameAt:'00:12' }
  }));
  const artifacts = [
    confirmedArtifact(transcriptPath, 'automatic'),
    {
      artifactId:'source-evidence-visual',
      type:'source_evidence_record',
      location:`file://${sourceEvidencePath}`,
      validation:{ exists:true, readable:true, nonEmpty:true }
    },
    {
      artifactId:'visual-evidence-visual',
      type:'visual_evidence_package',
      location:`file://${path.join(visualDir, 'visual-evidence.json')}`,
      validation:{ exists:true, readable:true, nonEmpty:true }
    }
  ];
  const sourceTask = { taskId:'source-task-visual', status:'succeeded', artifactRefs:artifacts };
  let advisorCalls = 0;
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() {
      advisorCalls += 1;
      throw new Error('视觉不可用时模型分析失败也必须保留证据化文字报告');
    } }
  });
  const result = await analyst.execute({
    taskId:'analysis-task-visual',
    taskType:'content.video-benchmark-analysis',
    input:{
      title:'用户任务标题',
      evidenceMode:'formal',
      depth:'fast',
      visualMode:'auto',
      context:{ sourceTaskIds:[sourceTask.taskId] }
    }
  });
  assert.equal(result.status, 'succeeded');
  const report = result.artifactRefs.find((item) => item.type === 'video_content_analysis_report')?.data;
  assert.equal(report.completeness, 'partial');
  assert.equal(report.visualCoverage.status, 'unavailable');
  const markdown = await fs.readFile(new URL(result.artifactRefs[0].location), 'utf8');
  assert.match(markdown, /没有通过证据门禁的画面结论/);
  assert.equal(advisorCalls, 1);

  const required = await analyst.execute({
    taskId:'analysis-task-visual-required',
    taskType:'content.video-benchmark-analysis',
    input:{
      title:'用户明确要求画面分析',
      evidenceMode:'formal',
      depth:'fast',
      visualMode:'required',
      context:{ sourceTaskIds:[sourceTask.taskId] }
    }
  });
  assert.equal(required.status, 'needs_input');
  assert.equal(required.error.code, 'controlled_vision_capability_unavailable');
  assert.match(required.error.userMessage, /自动启动和安全恢复后仍不可用/);
  assert.equal(advisorCalls, 1);
});

test('普通故事板通过本机受控视觉能力形成完整画面拆解并保存执行凭证', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-controlled-visual.md');
  const visualDir = path.join(root, 'controlled-visual');
  const storyboardDir = path.join(visualDir, 'storyboards');
  await fs.mkdir(storyboardDir, { recursive:true });
  await fs.writeFile(transcriptPath, '[00:00] 开场直接给出结果。\n[00:05] 接着说明方法和边界。\n');
  await fs.writeFile(path.join(storyboardDir, 'storyboard-01.jpg'), 'storyboard');
  const frames = [
    { frameId:'frame-001', timestamp:'00:00', reason:'opening_anchor' },
    { frameId:'frame-002', timestamp:'00:05', reason:'transcript_cue' },
    { frameId:'frame-003', timestamp:'00:12', reason:'scene_change' },
  ];
  await fs.writeFile(path.join(visualDir, 'visual-evidence.json'), JSON.stringify({
    schemaVersion:'agent.army/visual-evidence/v1',
    frames,
    storyboards:[{ storyboardId:'storyboard-01', localRef:'storyboards/storyboard-01.jpg', frameRefs:frames.map((frame) => frame.frameId) }],
    coverage:{ firstFrameAt:'00:00', lastFrameAt:'00:12' },
  }));
  const sourceTask = {
    taskId:'source-controlled-visual',
    status:'succeeded',
    artifactRefs:[
      confirmedArtifact(transcriptPath, 'automatic'),
      {
        artifactId:'visual-controlled',
        type:'visual_evidence_package',
        location:`file://${path.join(visualDir, 'visual-evidence.json')}`,
        validation:{ exists:true, readable:true, nonEmpty:true },
      },
    ],
  };
  const evidence = { timestamp:'00:00', fragment:'开场直接给出结果。' };
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    visionExecution:async ({ visualEvidence }) => {
      assert.match(visualEvidence.storyboards[0].filePath, /storyboard-01\.jpg$/);
      return {
        observation:'开场画面直接展示核心结果，并使用字幕强化结论。',
        receipt:{ receiptId:'receipt:local-vision', attempts:1, recovered:false, costUsd:0 },
        usage:null,
      };
    },
    advisor:{ async analyze(input) {
      assert.match(input.providerVisionObservation, /展示核心结果/);
      const data = {
        summary:'文字和画面共同强化开场结论。',
        modules:['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'].map((name) => ({
          name, finding:name, evidence, confidence:'high',
        })),
        visualFindings:[
          { category:'opening_visual_hook', finding:'开场直接展示核心结果。', evidence:{ frameRef:'frame-001', timestamp:'00:00' }, confidence:'high' },
          { category:'captions_and_graphics', finding:'字幕强化开场结论。', evidence:{ frameRef:'frame-002', timestamp:'00:05' }, confidence:'medium' },
          { category:'reusable_visual_pattern', finding:'结论与画面同步出现。', evidence:{ frameRef:'frame-003', timestamp:'00:12' }, confidence:'medium' },
        ],
      };
      assert.equal(input.validate(data), true);
      return { data };
    } },
  });
  const result = await analyst.execute({
    taskId:'analysis-controlled-visual',
    taskType:'content.video-benchmark-analysis',
    assigneeAgentId:'video-content-analyst',
    idempotencyKey:'controlled-visual',
    input:{
      title:'受控视觉分析', evidenceMode:'formal', depth:'fast', visualMode:'required',
      context:{ sourceTaskIds:[sourceTask.taskId] },
    },
  });
  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.data.completeness, 'complete');
  assert.equal(artifact.data.visualExecutionReceipt.receiptId, 'receipt:local-vision');
  assert.equal(artifact.validation.controlledVisionInvoked, true);
  assert.equal(artifact.validation.visualExecutionReceiptValid, true);
});

test('visualMode off 明确忽略故事板，只执行无视觉工具的文本拆解', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed-invalid-visual.md');
  const visualDir = path.join(root, 'visual-invalid');
  await fs.mkdir(path.join(visualDir, 'storyboards'), { recursive:true });
  await fs.writeFile(transcriptPath, '[00:00] 这是用于验证视觉证据门禁的确认稿正文。\n');
  await fs.writeFile(path.join(visualDir, 'storyboards', 'board.jpg'), 'board');
  await fs.writeFile(path.join(visualDir, 'visual-evidence.json'), JSON.stringify({
    schemaVersion:'agent.army/visual-evidence/v1',
    frames:[{ frameId:'frame-001', timestamp:'00:00', reason:'opening_anchor' }],
    storyboards:[{ localRef:'storyboards/board.jpg', frameRefs:['frame-001'] }]
  }));
  const sourceTask = {
    taskId:'source-task-invalid-visual',
    status:'succeeded',
    artifactRefs:[
      confirmedArtifact(transcriptPath),
      {
        artifactId:'visual-invalid',
        type:'visual_evidence_package',
        location:`file://${path.join(visualDir, 'visual-evidence.json')}`,
        validation:{ exists:true, readable:true, nonEmpty:true }
      }
    ]
  };
  const evidence = { timestamp:'00:00', fragment:'这是用于验证视觉证据门禁的确认稿正文。' };
  let advisorInput;
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze(input) {
      advisorInput = input;
      return {
        data:{
          summary:'纯文本拆解',
          modules:['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'].map((name) => ({ name, finding:name, evidence, confidence:'high' })),
          visualFindings:[]
        }
      };
    } }
  });
  const result = await analyst.execute({
    taskId:'analysis-task-invalid-visual',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'关闭视觉', evidenceMode:'formal', depth:'fast', visualMode:'off', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  const artifact = result.artifactRefs[0];
  assert.equal(result.status, 'succeeded');
  assert.equal(advisorInput.visualEvidence, null);
  assert.equal(artifact.validation.advisorApplied, true);
  assert.equal(artifact.data.visualFindings.length, 0);
  assert.equal(artifact.data.completeness, 'complete');
  assert.equal(artifact.validation.visualAnalysisApplied, true);
});

test('小创要求确认稿和正式分析，且一次最多三个平台', async (t) => {
  const root = await sandbox(t);
  const transcriptPath = path.join(root, 'confirmed.md');
  await fs.writeFile(transcriptPath, '[00:00] 先给结论。\n[00:05] 再解释依据。');
  const confirmed = confirmedArtifact(transcriptPath);
  const preliminary = analysisArtifact('preliminary');
  const formal = analysisArtifact('formal');
  const store = { list:async () => [
    taskWithArtifact('source-task-0003', confirmed),
    taskWithArtifact('analysis-task-0004', preliminary)
  ] };
  const creator = new LocalContentCreator({ store, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  const rejected = await creator.execute({
    taskId:'draft-task-0001', taskType:'content.platform-draft',
    input:{ title:'草稿', platforms:['douyin'], context:{ sourceTaskIds:['source-task-0003', 'analysis-task-0004'] } }
  });
  assert.equal(rejected.error.code, 'formal_analysis_required');
  store.list = async () => [taskWithArtifact('source-task-0003', confirmed), taskWithArtifact('analysis-task-0005', formal)];
  const tooMany = await creator.execute({
    taskId:'draft-task-0002', taskType:'content.platform-draft',
    input:{ title:'草稿', platforms:['douyin', 'xiaohongshu', 'shipinhao', 'bilibili'], context:{ sourceTaskIds:['source-task-0003', 'analysis-task-0005'] } }
  });
  assert.equal(tooMany.error.code, 'platform_limit_exceeded');
  const result = await creator.execute({
    taskId:'draft-task-0003', taskType:'content.platform-draft',
    input:{
      title:'草稿',
      platforms:['douyin', 'xiaohongshu', 'wechat_mp'],
      audience:'正在搭建内容流程的经营者',
      contentGoal:'解释一个方法',
      experiment:{
        variable:'开场结构',
        hypothesis:'先给证据更容易产生深度互动',
        successCriterion:'深度互动率高于同类中位数',
        observationWindow:'发布后72小时',
      },
      context:{ sourceTaskIds:['source-task-0003', 'analysis-task-0005'] }
    }
  });
  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.data.drafts.length, 3);
  assert.deepEqual(artifact.data.platforms, ['douyin', 'xiaohongshu', 'wechat_official_account']);
  assert.equal(artifact.data.contentBrief.audience, '正在搭建内容流程的经营者');
  assert.equal(artifact.data.contentStrategy.singleExperiment.variable, '开场结构');
  assert.equal(artifact.data.drafts.every((draft) => draft.qualityChecklist.length === 6), true);
  assert.equal(artifact.data.drafts.every((draft) => Boolean(draft.visualAnchor)), true);
  assert.match(artifact.data.drafts[1].platformPlaybook.structure, /每页只承担一个信息任务/);
  assert.equal(artifact.validation.semanticQualityGateCount, 6);
  assert.equal(artifact.validation.externalSideEffects, 0);
});

test('表现复盘派生标准化指标并明确同类范围、决策和唯一实验', async (t) => {
  const root = await sandbox(t);
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
  });
  const result = await analyst.execute({
    taskId:'performance-standardized',
    taskType:'content.performance-review',
    input:{
      platform:'xiaohongshu',
      contentType:'教程图文',
      observationWindow:'72h',
      comparableSampleCount:5,
      metrics:{
        platformContentId:'note-100',
        publishedAt:'2026-08-01T00:00:00Z',
        contentVersionId:'content-v1',
        impressions:200,
        views:100,
        comments:2,
        saves:3,
        shares:5,
        newFollowers:4,
      },
      experiment:{ variable:'封面标题', successCriterion:'点击率高于同类中位数' },
    },
  }, { sourceArtifacts:[{
    artifactId:'video_script_package:standardized',
    type:'video_script_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{ templateLifecycle:{ state:'trial', approvedForUse:true } },
  }] });

  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.data.derivedMetrics.followersPerThousandViews, 40);
  assert.equal(artifact.data.derivedMetrics.deepEngagementRate, 0.1);
  assert.equal(artifact.data.comparableBaseline.views.median, 100);
  assert.deepEqual(artifact.data.comparisonScope, {
    platform:'xiaohongshu',
    contentType:'教程图文',
    observationWindow:'72h',
    comparableSampleCount:0,
    declaredComparableSampleCount:5,
  });
  assert.equal(artifact.data.decision, 'collect_more_samples');
  assert.equal(artifact.data.learning.status, 'insufficient_sample');
  assert.equal(artifact.data.learning.proposal, null);
  assert.equal(artifact.data.learning.governedLearningRoute, 'paperclip-retrospective');
  assert.match(artifact.data.learning.reason, /不能替代五条.*MetricSnapshot/);
  assert.equal(artifact.data.learning.requiresHumanReview, true);
  assert.equal(artifact.data.learning.productionMutationAllowed, false);
  assert.equal(artifact.validation.singleExperimentEnforced, true);
});

test('同类真实指标少于五条时只记录样本不足且不生成学习提案', async (t) => {
  const root = await sandbox(t);
  const analyst = new LocalVideoContentAnalyst({ store:{ list:async () => [] }, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  const result = await analyst.execute({
    taskId:'performance-insufficient', taskType:'content.performance-review',
    input:{
      platform:'douyin', contentType:'口播', observationWindow:'72h', comparableSampleCount:4,
      metrics:{ platformContentId:'video-1', publishedAt:'2026-08-01T00:00:00Z', views:100 }
    }
  }, { sourceArtifacts:[{
    artifactId:'video_script_package:insufficient', type:'video_script_package',
    validation:{ exists:true, readable:true, nonEmpty:true }, data:{ templateLifecycle:{ state:'trial', approvedForUse:true } }
  }] });
  const learning = result.artifactRefs[0].data.learning;
  assert.equal(learning.status, 'insufficient_sample');
  assert.equal(learning.proposal, null);
  assert.equal(learning.productionMutationAllowed, false);
});

test('已采用脚本只有达到真实使用与账号基准门槛后才升级模板状态', async (t) => {
  const root = await sandbox(t);
  const script = {
    artifactId:'video_script_package:approved-1',
    taskId:'approved-1',
    type:'video_script_package',
    location:'runtime://approved-script',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{ templateLifecycle:{ state:'trial', approvedForUse:true } }
  };
  const priorTasks = [];
  const store = { async list() { return priorTasks; } };
  const analyst = new LocalVideoContentAnalyst({ store, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  for (const [index, metBaseline] of [true, false, true].entries()) {
    const result = await analyst.execute({
      taskId:`performance-${index + 1}`,
      taskType:'content.performance-review',
      input:{ metrics:{ metBaseline, baselineSampleSize:10 } }
    }, { sourceArtifacts:[script] });
    const artifact = result.artifactRefs[0];
    priorTasks.push({ taskId:`performance-${index + 1}`, artifactRefs:[artifact], status:'succeeded' });
    assert.equal(artifact.data.templateLifecycle.state, index === 2 ? 'validated' : 'trial');
  }
  const final = priorTasks.at(-1).artifactRefs[0].data.templateLifecycle;
  assert.equal(final.comparableUseCount, 3);
  assert.equal(final.metBaselineCount, 2);
  assert.equal(final.baselineSampleSize, 10);
});

test('已采用脚本连续三次低于账号基准后建议 retired', async (t) => {
  const root = await sandbox(t);
  const script = {
    artifactId:'video_script_package:approved-low',
    taskId:'approved-low',
    type:'video_script_package',
    location:'runtime://approved-low',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{ templateLifecycle:{ state:'trial', approvedForUse:true } }
  };
  const priorTasks = [];
  const store = { async list() { return priorTasks; } };
  const analyst = new LocalVideoContentAnalyst({ store, artifactsDir:path.join(root, 'out'), allowedArtifactRoots:[root] });
  let lifecycle;
  for (let index = 0; index < 3; index += 1) {
    const result = await analyst.execute({
      taskId:`performance-low-${index + 1}`,
      taskType:'content.performance-review',
      input:{ metrics:{ metBaseline:false, baselineSampleSize:8 } }
    }, { sourceArtifacts:[script] });
    const artifact = result.artifactRefs[0];
    priorTasks.push({ taskId:`performance-low-${index + 1}`, artifactRefs:[artifact], status:'succeeded' });
    lifecycle = artifact.data.templateLifecycle;
  }
  assert.equal(lifecycle.state, 'retired');
  assert.match(lifecycle.reason, /连续三次/);
});

async function m5VisualFixture(t, { advisor }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-visual-contract-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const relativePath = 'campaigns/case-1/assets/frame-001.png';
  const framePath = path.join(root, relativePath);
  const frameBytes = Buffer.from('controlled-frame');
  await fs.mkdir(path.dirname(framePath), { recursive:true });
  await fs.writeFile(framePath, frameBytes);
  const assetPackage = {
    artifactId:'asset-package:contract-test',
    type:'asset_package',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      assets:[{
        frameId:'frame-001',
        timestamp:'00:00:03',
        relativePath,
        checksum:`sha256:${crypto.createHash('sha256').update(frameBytes).digest('hex')}`,
      }],
    },
  };
  return {
    framePath,
    assetPackage,
    providerVision:providerVisionFixture({
      relativePath,
      checksum:assetPackage.data.assets[0].checksum,
    }),
    analyst:new LocalVideoContentAnalyst({
      store:{ list:async () => [] },
      artifactsDir:path.join(root, 'out'),
      allowedArtifactRoots:[root],
      advisor,
    }),
  };
}

function providerVisionFixture({
  relativePath,
  checksum,
  projectId = M5_PROJECT_ID,
  heartbeatRunId = 'run-m5-vision-source',
  sourceChecksum = checksum,
  state = 'confirmed',
  onExecute = () => {},
}) {
  return async (parameters) => {
    onExecute(parameters);
    const costEventId = '33333333-3333-4333-8333-333333333333';
    const costEvent = {
      provider:'stepfun',
      projectId,
      heartbeatRunId,
      costCents:1,
    };
    return {
      projectId,
      receipt:{
        actionId:parameters.actionId,
        operation:'vision',
        model:'step-1o-turbo-vision',
        sourcePath:relativePath,
        sourceChecksum,
        observation:'{"visible":"task status"}',
        callRecord:{
          actionId:parameters.actionId,
          operation:'vision',
          model:'step-1o-turbo-vision',
          promptChecksum:`sha256:${'a'.repeat(64)}`,
          costEvent,
        },
        costCommit:{
          status:state,
          costEventId,
          costEvent,
        },
      },
    };
  };
}

function confirmedArtifact(filePath, confirmationMode = 'human') {
  return {
    artifactId:'confirmed-1', taskId:'source-task', type:'confirmed_transcript', location:`file://${filePath}`, checksum:'abc',
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      confirmationMode,
      humanConfirmed:confirmationMode === 'human',
      automaticConfirmed:confirmationMode === 'automatic'
    }
  };
}

function analysisArtifact(evidenceMode) {
  return {
    artifactId:`analysis-${evidenceMode}`, taskId:'analysis-task', type:'video_content_analysis_report', location:'runtime://analysis',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{ evidenceMode, summary:'证据化拆解', modules:[] }
  };
}

function taskWithArtifact(taskId, artifact) {
  return { taskId, artifactRefs:[artifact], status:'succeeded' };
}

function binding(value) {
  return {
    ...value,
    bindingHash:m5ProductionTemplateBindingHash(value),
  };
}

function scriptHash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-growth-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  return root;
}
