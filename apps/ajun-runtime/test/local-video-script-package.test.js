import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalVideoScriptPackage } from '../src/local-video-script-package.js';
import { m5ProductionTemplateBindingHash } from '../src/m5-production-template-resolver.js';

test('M5 脚本把同一 Case 的证据结论逐字绑定到至少两个来源', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-script-evidence-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const evidenceTask = {
    taskId:'m5-evidence-task',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'evidence:m5',
      type:'evidence_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        schemaVersion:'agent.army/evidence-package/v2',
        sources:[
          {
            sourceId:'source-1',
            url:'https://example.com/a',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'a'.repeat(64),
            kind:'public_web',
            evidenceFragments:[{ fragmentId:'source-1-fragment-1', text:'来源 A 原文。' }],
          },
          {
            sourceId:'source-2',
            url:'https://example.com/b',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'b'.repeat(64),
            kind:'public_pdf',
            evidenceFragments:[{ fragmentId:'source-2-fragment-1', text:'来源 B 原文。' }],
          },
        ],
        claims:[{
          claimId:'claim-1',
          text:'Paperclip 管流程，Hermes 执行岗位任务。',
          sourceIds:['source-1', 'source-2'],
          evidenceFragments:[
            { sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'来源 A 原文。' },
            { sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'来源 B 原文。' },
          ],
        }],
        prohibitedStatements:['无来源效果承诺'],
      },
    }],
  };
  const visualTask = {
    taskId:'m5-visual-task',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'visual:m5',
      type:'visual_analysis_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        insights:[{
          insightId:'visual-1',
          finding:'使用产品流程画面承接该结论。',
          frameRef:'frame-1',
          timestamp:'00:03',
          evidenceKind:'keyframe',
        }],
      },
    }],
  };
  const templateBinding = approvedBinding();
  const grayTemplateBinding = approvedGrayBinding();
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(root, 'out'),
    advisor:{
      async scriptPackage({ templateBinding:received }) {
        assert.ok([
          templateBinding.bindingHash,
          grayTemplateBinding.bindingHash,
        ].includes(received.bindingHash));
        return {
          data:{
            headline:'AI Agent 实战',
            platform:'douyin',
            durationSeconds:45,
            aspectRatio:'9:16',
            audience:'希望验证 Agent 真实能力的人',
            hook:'先看真实产出。',
            fullScript:received.source === 'approved_single_gray'
              ? '这是只供抖音灰度的独立口播：前三秒直接展示失败恢复和最终交付，再解释任务、执行回执与审核结果。它不会进入小红书母版，也不会共享配音和视频，所有判断继续绑定公开证据。最后给出一个能立即核对的动作，让观众自己判断这次交付是否真实。'
              : '不要只看 Agent 会不会回答，要看它能否读取真实结果、纠错并完成可核验交付。这条内容只调整前三秒开场，其余结论继续绑定公开证据。接下来展示任务、执行回执和审核结果，让每个判断都能回到真实产物，而不是停留在漂亮文案。',
            shootingNotes:['开场展示真实产物。'],
            shots:[{ startSeconds:0, endSeconds:45, narration:'展示真实产物。', visual:'流程画面' }],
            qualityReview:{ factuality:'绑定来源', imitation:'不复制', shootability:'可执行', unresolved:[] },
            structure:['开场', '证据', '结论'],
            templateBindingHash:received.bindingHash,
            templateApplicationEvidence:[{
              guidance:received.contentGuidance[0],
              scriptFragment:received.source === 'approved_single_gray'
                ? '前三秒直接展示失败恢复和最终交付'
                : '这条内容只调整前三秒开场',
            }],
          },
        };
      },
    },
    templateResolver:{
      async resolve(caseId) {
        assert.equal(caseId, 'm5-case-1');
        return templateBinding;
      },
      async resolveGrayForDay(caseId) {
        assert.equal(caseId, 'm5-case-1');
        return grayTemplateBinding;
      },
    },
  });
  const result = await executor.execute({
    taskId:'m5-script-task',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        pipelineCaseId:'m5-case-1',
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const script = result.artifactRefs[0].data;
  assert.match(script.fullScript, /Paperclip 管流程，Hermes 执行岗位任务/);
  assert.deepEqual(script.factBindings[0].sourceIds, ['source-1', 'source-2']);
  assert.equal(script.factBindings[0].evidenceFragments.length, 2);
  assert.equal(script.visualAnalysisBindings[0].frameRef, 'frame-1');
  assert.equal(script.visualAnalysisBindings[0].timestamp, '00:03');
  assert.equal(script.shots[0].evidenceKind, 'keyframe');
  assert.equal(script.sources.length, 2);
  assert.equal(
    script.templateLifecycle.templateBinding.templateVersionId,
    'template-v2',
  );
  assert.equal(script.templateGuidanceHash, templateBinding.bindingHash);
  assert.equal(script.variants.baseline.templateBinding.bindingHash, templateBinding.bindingHash);
  assert.equal(script.variants.gray_douyin.templateBinding.bindingHash, grayTemplateBinding.bindingHash);
  assert.deepEqual(script.variants.baseline.templateApplicationEvidence, [{
    guidance:'只调整前三秒开场。',
    scriptFragment:'这条内容只调整前三秒开场',
  }]);
  assert.deepEqual(script.variants.gray_douyin.templateApplicationEvidence, [{
    guidance:'只调整抖音前三秒开场。',
    scriptFragment:'前三秒直接展示失败恢复和最终交付',
  }]);
  assert.notEqual(script.variants.baseline.scriptHash, script.variants.gray_douyin.scriptHash);
  assert.match(script.variants.gray_douyin.fullScript, /只供抖音灰度/);
  const sourcesFile = script.productionFiles.find((file) => file.fileName === 'sources.md');
  const sourcesText = await fs.readFile(new URL(sourcesFile.location), 'utf8');
  assert.match(sourcesText, /https:\/\/example\.com\/a/);
  assert.match(sourcesText, /a{64}/);

  const failed = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(root, 'failed-out'),
    advisor:{ async scriptPackage() { throw new Error('advisor unavailable'); } },
    templateResolver:{ async resolve() { return templateBinding; } },
  });
  const failedResult = await failed.execute({
    taskId:'m5-script-failed-advisor',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        pipelineCaseId:'m5-case-1',
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  });
  assert.equal(failedResult.status, 'needs_input');
  assert.equal(failedResult.error.code, 'm5_template_guidance_not_applied');
  assert.equal(failedResult.artifactRefs, undefined);

  const unlocatableEvidence = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(root, 'unlocatable-evidence-out'),
    advisor:{
      async scriptPackage({ templateBinding:received }) {
        const data = unchangedScript(received);
        data.templateApplicationEvidence[0].scriptFragment = '这段声称已应用指导的文字根本不在完整脚本中';
        return { data };
      },
    },
    templateResolver:{ async resolve() { return templateBinding; } },
  });
  const unlocatableResult = await unlocatableEvidence.execute({
    taskId:'m5-script-unlocatable-guidance-evidence',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        pipelineCaseId:'m5-case-1',
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  });
  assert.equal(unlocatableResult.status, 'needs_input');
  assert.equal(unlocatableResult.error.code, 'm5_template_guidance_not_applied');
  assert.equal(unlocatableResult.artifactRefs, undefined);

  const { bindingHash:ignoredBindingHash, ...multiGuidanceValue } = approvedBinding();
  void ignoredBindingHash;
  multiGuidanceValue.contentGuidance = ['只调整前三秒开场。', '结尾增加一个核验动作。'];
  const multiGuidanceBinding = {
    ...multiGuidanceValue,
    bindingHash:m5ProductionTemplateBindingHash(multiGuidanceValue),
  };
  const duplicateEvidence = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(root, 'duplicate-evidence-out'),
    advisor:{
      async scriptPackage({ templateBinding:received }) {
        return { data:unchangedScript(received) };
      },
    },
    templateResolver:{ async resolve() { return multiGuidanceBinding; } },
  });
  const duplicateEvidenceResult = await duplicateEvidence.execute({
    taskId:'m5-script-duplicate-guidance-evidence',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        pipelineCaseId:'m5-case-1',
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  });
  assert.equal(duplicateEvidenceResult.status, 'needs_input');
  assert.equal(duplicateEvidenceResult.error.code, 'm5_template_guidance_not_applied');

  const { bindingHash:ignoredPlaceholderHash, ...placeholderValue } = approvedBinding();
  void ignoredPlaceholderHash;
  placeholderValue.contentGuidance = [
    '待补充第一段示例开场。',
    'TODO：待补充第二段示例结尾。',
  ];
  const placeholderBinding = {
    ...placeholderValue,
    bindingHash:m5ProductionTemplateBindingHash(placeholderValue),
  };
  let placeholderAdvisorCalls = 0;
  const placeholderGuidance = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(root, 'placeholder-guidance-out'),
    advisor:{
      async scriptPackage() {
        placeholderAdvisorCalls += 1;
        throw new Error('占位 guidance 应在调用模型前被拒绝');
      },
    },
    templateResolver:{ async resolve() { return placeholderBinding; } },
  });
  const placeholderResult = await placeholderGuidance.execute({
    taskId:'m5-script-placeholder-guidance',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        pipelineCaseId:'m5-case-1',
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  });
  assert.equal(placeholderResult.status, 'needs_input');
  assert.equal(placeholderResult.error.code, 'm5_template_binding_invalid');
  assert.equal(placeholderAdvisorCalls, 0);

  const unchanged = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(root, 'unchanged-out'),
    advisor:{
      async scriptPackage({ templateBinding:received }) {
        return { data:unchangedScript(received) };
      },
    },
    templateResolver:{
      async resolve() { return defaultBindingForTest(); },
      async resolveGrayForDay() { return grayTemplateBinding; },
    },
  });
  const unchangedResult = await unchanged.execute({
    taskId:'m5-script-unchanged-gray',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        pipelineCaseId:'m5-case-1',
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  });
  assert.equal(unchangedResult.status, 'needs_input');
  assert.equal(unchangedResult.error.code, 'm5_gray_variant_unchanged');
});

test('M5 脚本缺少 VisualAnalysisPackage 时拒绝继续', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-script-visual-required-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const evidenceTask = {
    taskId:'m5-evidence-only',
    artifactRefs:[{
      artifactId:'evidence:m5-only',
      type:'evidence_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        schemaVersion:'agent.army/evidence-package/v2',
        sources:[
          {
            sourceId:'source-1',
            url:'https://example.com/a',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'a'.repeat(64),
            kind:'public_web',
            evidenceFragments:[{ fragmentId:'source-1-f1', text:'来源 A。' }],
          },
          {
            sourceId:'source-2',
            url:'https://example.com/b',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'b'.repeat(64),
            kind:'public_pdf',
            evidenceFragments:[{ fragmentId:'source-2-f1', text:'来源 B。' }],
          },
        ],
        claims:[{
          claimId:'claim-1',
          text:'有来源结论。',
          sourceIds:['source-1', 'source-2'],
          evidenceFragments:[
            { sourceId:'source-1', fragmentId:'source-1-f1', text:'来源 A。' },
            { sourceId:'source-2', fragmentId:'source-2-f1', text:'来源 B。' },
          ],
        }],
      },
    }],
  };
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask] },
    artifactsDir:path.join(root, 'out'),
  });
  const result = await executor.execute({
    taskId:'m5-script-without-visual',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{ paperclipRoutineKey:'m5-script', sourceTaskIds:[evidenceTask.taskId] },
    },
  }, { allowAdvisor:false });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'm5_visual_analysis_package_required');
});

test('M5 脚本拒绝把 GitHub metadata 或无片段 claim 当证据', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-script-invalid-evidence-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const evidenceTask = {
    taskId:'m5-invalid-evidence-task',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'evidence:invalid',
      type:'evidence_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        schemaVersion:'agent.army/evidence-package/v2',
        sources:[
          {
            sourceId:'source-1',
            url:'https://github.com/example/repo',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'a'.repeat(64),
            kind:'github_metadata',
            evidenceFragments:[{ fragmentId:'source-1-fragment-1', text:'仓库描述。' }],
          },
          {
            sourceId:'source-2',
            url:'https://example.com/b',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'b'.repeat(64),
            kind:'public_web',
            evidenceFragments:[{ fragmentId:'source-2-fragment-1', text:'网页正文。' }],
          },
        ],
        claims:[{
          claimId:'claim-1',
          text:'不能成立的结论。',
          sourceIds:['source-1', 'source-2'],
          evidenceFragments:[],
        }],
      },
    }],
  };
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask] },
    artifactsDir:path.join(root, 'out'),
  });
  const result = await executor.execute({
    taskId:'m5-invalid-script-task',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        sourceTaskIds:[evidenceTask.taskId],
      },
    },
  }, { allowAdvisor:false });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'm5_evidence_package_required');
});

test('只给主题时自动复用同会话参考案例并生成五件受控生产包', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-package-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const analysisTask = {
    taskId:'analysis-1',
    status:'succeeded',
    source:{ channel:'feishu', chatRef:'chat-1' },
    updatedAt:'2026-07-28T01:00:00.000Z',
    artifactRefs:[{
      artifactId:'analysis-artifact-1',
      type:'video_content_analysis_report',
      title:'参考视频拆解',
      data:{
        evidenceMode:'formal',
        title:'AI 会不会让人失业',
        summary:'用冲突问题开场，再解释限制条件。',
        reusablePatterns:['冲突设问', '解释前提', '行动收束'],
        modules:[{ name:'爆款结构模板', structureTemplate:{ opening:'冲突设问', body:'解释前提', ending:'行动收束' } }]
      }
    }]
  };
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return [analysisTask]; } },
    artifactsDir:path.join(root, 'artifacts'),
    researcher:{ async execute() {
      return {
        status:'succeeded',
        artifactRefs:[{
          type:'intel_research_report',
          data:{ sources:[{ title:'公开资料', source:'https://example.com/report', summary:'自动化会改变任务结构。', fetchedAt:'2026-07-28T00:00:00.000Z' }] }
        }]
      };
    } }
  });
  const result = await creator.execute({
    taskId:'script-1',
    taskType:'content.video-script-package',
    assigneeAgentId:'content-creator',
    source:{ channel:'feishu', chatRef:'chat-1' },
    input:{ title:'写一个 AI 会不会让人失业的视频脚本' }
  }, { allowAdvisor:false });

  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.type, 'video_script_package');
  assert.equal(artifact.data.referenceMatch.type, 'reference_case');
  assert.equal(artifact.data.platform, 'douyin');
  assert.equal(artifact.validation.fileCount, 5);
  assert.equal(artifact.validation.externalSideEffects, 0);
  assert.deepEqual(artifact.data.productionFiles.map((item) => item.fileName).sort(), [
    'manifest.json', 'script.md', 'shots.json', 'sources.md', 'subtitles.srt'
  ]);
  for (const file of artifact.data.productionFiles) {
    const stat = await fs.stat(new URL(file.location));
    assert.ok(stat.size > 0);
    assert.equal(file.checksum.length, 64);
  }
  assert.match(await fs.readFile(new URL(artifact.location), 'utf8'), /## 完整口播稿/);
  assert.equal(artifact.data.templateLifecycle.caseOnly, true);
});

test('回复用这版后只把上一版升级为 trial，不发布也不生成成片', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-approve-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const initialCreator = new LocalVideoScriptPackage({
    store:{ async list() { return []; } },
    artifactsDir:path.join(root, 'artifacts')
  });
  const initial = await initialCreator.execute({
    taskId:'script-draft',
    taskType:'content.video-script-package',
    source:{ channel:'feishu', chatRef:'chat-2' },
    input:{ title:'一个务实的短视频主题', researchMode:'off' }
  }, { allowAdvisor:false });
  const draftTask = {
    taskId:'script-draft',
    status:'succeeded',
    source:{ channel:'feishu', chatRef:'chat-2' },
    artifactRefs:initial.artifactRefs
  };
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return [draftTask]; } },
    artifactsDir:path.join(root, 'artifacts')
  });
  const approved = await creator.execute({
    taskId:'script-approved',
    taskType:'content.video-script-package',
    source:{ channel:'feishu', chatRef:'chat-2' },
    input:{ title:'采用脚本', approvedForUse:true, sourceScriptTaskId:'script-draft', context:{ sourceTaskIds:['script-draft'] } }
  });
  const artifact = approved.artifactRefs[0];
  assert.equal(artifact.data.templateLifecycle.state, 'trial');
  assert.equal(artifact.data.templateLifecycle.approvedForUse, true);
  assert.equal(artifact.data.publishingStatus, 'draft_only');
  assert.equal(artifact.validation.externalSideEffects, 0);
});

function approvedBinding() {
  const value = {
    schemaVersion:'agent.army/production-template-binding/v1',
    templateVersionId:'template-v2',
    source:'approved_learning_decision',
    decisionStatus:'validated',
    decisionWorkProductId:'decision-1',
    templateWorkProductId:'template-product-1',
    productionDefault:true,
    contentGuidance:['只调整前三秒开场。'],
    controls:{
      promptMutation:false,
      permissionExpansion:false,
      frequencyIncrease:false,
      paidPromotion:false,
    },
  };
  return { ...value, bindingHash:m5ProductionTemplateBindingHash(value) };
}

function approvedGrayBinding() {
  const value = {
    schemaVersion:'agent.army/production-template-binding/v1',
    templateVersionId:'template-gray-v2',
    source:'approved_single_gray',
    decisionStatus:'gray_ready',
    decisionWorkProductId:null,
    templateWorkProductId:'template-gray-product-1',
    productionDefault:false,
    grayRelease:true,
    grayTargetCaseId:'22222222-2222-4222-8222-222222222222',
    grayTargetDayCaseId:'m5-case-1',
    grayTargetScheduledDate:'2026-08-09',
    grayTargetPlatform:'douyin',
    applicationScope:'full_content_variant',
    contentGuidance:['只调整抖音前三秒开场。'],
    controls:{
      promptMutation:false,
      permissionExpansion:false,
      frequencyIncrease:false,
      paidPromotion:false,
    },
  };
  return { ...value, bindingHash:m5ProductionTemplateBindingHash(value) };
}

function defaultBindingForTest() {
  const value = {
    schemaVersion:'agent.army/production-template-binding/v1',
    templateVersionId:'m5-template-default-v1',
    source:'built_in_default',
    decisionStatus:'default',
    decisionWorkProductId:null,
    productionDefault:true,
    contentGuidance:[],
    controls:{
      promptMutation:false,
      permissionExpansion:false,
      frequencyIncrease:false,
      paidPromotion:false,
    },
    fallbackReason:'test',
  };
  return { ...value, bindingHash:m5ProductionTemplateBindingHash(value) };
}

function unchangedScript(binding) {
  const fullScript = '这是一段故意保持完全相同的脚本，用于证明只回显模板哈希并不等于实际应用了指导。系统必须在写入灰度产物前比较完整口播并停止假灰度，不能让相同脚本进入双配音和双渲染。';
  return {
    headline:'相同脚本',
    platform:'douyin',
    durationSeconds:45,
    aspectRatio:'9:16',
    audience:'验证 Agent 真实能力的人',
    hook:'先看真实产出。',
    fullScript,
    shootingNotes:['展示真实产物。'],
    shots:[{ startSeconds:0, endSeconds:45, narration:'展示真实产物。', visual:'流程画面' }],
    qualityReview:{ factuality:'绑定来源', imitation:'不复制', shootability:'可执行', unresolved:[] },
    structure:['开场', '证据', '结论'],
    templateBindingHash:binding.bindingHash,
    templateApplicationEvidence:(binding.contentGuidance || []).map((guidance) => ({
      guidance,
      scriptFragment:'系统必须在写入灰度产物前比较完整口播并停止假灰度',
    })),
  };
}
