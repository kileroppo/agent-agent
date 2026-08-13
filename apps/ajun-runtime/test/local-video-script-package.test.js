import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { LocalVideoScriptPackage } from '../src/local-video-script-package.js';
import { m5ProductionTemplateBindingHash } from '../src/m5-production-template-resolver.js';
import { confirmedTranscriptDocument } from '../../xiaod-media-transcriber/src/transcript-evidence.js';

test('缺少脚本主题时在模板解析和生产写入前停止', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-topic-required-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  let resolverCalls = 0;
  const artifactsDir = path.join(root, 'artifacts');
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [] },
    artifactsDir,
    templateResolver:{ async resolve() { resolverCalls += 1; } },
  });
  const result = await executor.execute({
    taskId:'m5-script-without-topic',
    input:{ context:{ paperclipRoutineKey:'m5-script' } },
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'script_topic_required');
  assert.equal(resolverCalls, 0);
  await assert.rejects(fs.access(artifactsDir), (error) => error?.code === 'ENOENT');
});

test('执行时读取最新 Adapter，并在研究和脚本校验完成后才写生产包', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-adapter-order-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const artifactsDir = path.join(root, 'artifacts');
  const events = [];
  const candidate = {
    headline:'动态 Adapter 脚本',
    platform:'douyin',
    durationSeconds:99,
    aspectRatio:'9:16',
    audience:'维护者',
    hook:'先检查执行时的真实 Adapter。',
    fullScript:'先检查执行时的真实 Adapter，再确认研究来源已经完成有界收集。脚本内容和质量审查全部通过以后，系统才允许创建生产目录并写入五件受控文件，任何前置失败都不能留下半成品。',
    shootingNotes:['按顺序展示研究、脚本和产物。'],
    shots:[{ startSeconds:0, endSeconds:99, narration:'完整口播', visual:'执行顺序' }],
    qualityReview:{ factuality:'来源有界', imitation:'不复制', shootability:'可拍', unresolved:[] },
  };
  const executor = new LocalVideoScriptPackage({
    store:{ async list() { events.push('list'); return []; } },
    artifactsDir,
    advisor:{ async scriptPackage() { throw new Error('旧 advisor 不应再调用'); } },
    researcher:{ async execute() { throw new Error('旧 researcher 不应再调用'); } },
    now:() => new Date('2000-01-01T00:00:00.000Z'),
  });
  executor.now = () => new Date('2026-08-13T09:08:07.000Z');
  executor.researcher = {
    async execute({ input }) {
      events.push('research');
      assert.equal(await pathExists(artifactsDir), false);
      assert.deepEqual(input.sourceUrls, [
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
      ]);
      return {
        artifactRefs:[{
          type:'intel_research_report',
          data:{
            sources:Array.from({ length:5 }, (_, index) => ({
              title:`来源 ${index + 1}`,
              source:`https://example.com/report-${index + 1}`,
              summary:`研究摘要 ${index + 1}`,
            })),
          },
        }],
      };
    },
  };
  executor.advisor = {
    async scriptPackage({ durationSeconds, validate }) {
      events.push('advisor');
      assert.equal(await pathExists(artifactsDir), false);
      assert.equal(durationSeconds, 600);
      assert.equal(validate(candidate), true);
      return { data:candidate, usage:{ model:'advisor-test' } };
    },
  };

  const result = await executor.execute({
    taskId:'dynamic-adapter-script',
    assigneeAgentId:'content-creator',
    input:{
      title:'最新研究会不会影响视频脚本',
      durationSeconds:999,
      sourceUrls:[
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
        'https://example.com/d',
      ],
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(events, ['list', 'research', 'advisor']);
  const data = result.artifactRefs[0].data;
  assert.equal(data.generatedAt, '2026-08-13T09:08:07.000Z');
  assert.equal(data.generationMode, 'hermes_advisor');
  assert.equal(data.sources.length, 3);
  assert.equal(result.usage.model, 'advisor-test');
  assert.notEqual(data, candidate);
  assert.notEqual(data.shots, candidate.shots);
  assert.equal(candidate.topic, undefined);
});

test('研究或 Advisor 失败时保持旧的有界兜底语义', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-fallback-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const events = [];
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [] },
    artifactsDir:path.join(root, 'artifacts'),
    researcher:{ async execute() { events.push('research'); throw new Error('offline'); } },
    advisor:{ async scriptPackage() { events.push('advisor'); throw new Error('offline'); } },
  });
  const result = await executor.execute({
    taskId:'fallback-script',
    input:{ title:'最新研究会不会改变工作方式' },
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(events, ['research', 'advisor']);
  assert.equal(result.artifactRefs[0].data.researchStatus, 'unavailable');
  assert.equal(result.artifactRefs[0].data.generationMode, 'deterministic_fallback');
  assert.match(result.artifactRefs[0].data.fullScript, /不编造没有来源的数字和事实/);
});

test('执行路径继续经过公开 research 覆写方法', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-research-override-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [] },
    artifactsDir:path.join(root, 'artifacts'),
  });
  let calls = 0;
  executor.research = async () => {
    calls += 1;
    return {
      status:'public_sources_used',
      report:{ sources:[{ summary:'覆写研究结论' }] },
      sources:[{ summary:'覆写研究结论' }],
    };
  };

  const result = await executor.execute({
    taskId:'research-override-script',
    input:{ title:'最新趋势为什么变化' },
  }, { allowAdvisor:false });

  assert.equal(calls, 1);
  assert.equal(result.artifactRefs[0].data.researchStatus, 'public_sources_used');
  assert.match(result.artifactRefs[0].data.fullScript, /覆写研究结论/);
});

test('来源读取和模板解析同时会失败时保留来源错误优先级', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-error-order-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const events = [];
  const sourceError = new Error('来源产物读取失败');
  const templateError = Object.assign(new Error('模板解析失败'), {
    code:'m5_production_template_blocked',
  });
  const executor = new LocalVideoScriptPackage({
    store:{ async list() {
      events.push('list');
      return [{
        taskId:'broken-source',
        get artifactRefs() {
          events.push('source');
          throw sourceError;
        },
      }];
    } },
    artifactsDir:path.join(root, 'artifacts'),
    templateResolver:{ async resolve() {
      events.push('template');
      throw templateError;
    } },
  });

  await assert.rejects(
    executor.execute({
      taskId:'error-order-script',
      input:{
        title:'错误顺序',
        context:{ paperclipRoutineKey:'m5-script' },
      },
    }),
    (error) => error === sourceError,
  );
  assert.deepEqual(events, ['list', 'source']);
  await assert.rejects(fs.access(path.join(root, 'artifacts')), (error) => error?.code === 'ENOENT');
});

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
  assert.deepEqual(script.sourceTaskIds, [evidenceTask.taskId, visualTask.taskId]);
  assert.deepEqual(script.sourceTaskBindings.map((item) => item.taskId), [evidenceTask.taskId, visualTask.taskId]);
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
  await assert.rejects(
    fs.access(path.join(root, 'failed-out')),
    (error) => error?.code === 'ENOENT',
    '模板证据拒绝路径不得创建任何生产目录',
  );

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
  let placeholderResearchCalls = 0;
  const placeholderArtifactsDir = path.join(root, 'placeholder-guidance-out');
  const placeholderGuidance = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:placeholderArtifactsDir,
    researcher:{ async execute() { placeholderResearchCalls += 1; } },
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
  assert.equal(placeholderResearchCalls, 0);
  await assert.rejects(
    fs.access(placeholderArtifactsDir),
    (error) => error?.code === 'ENOENT',
  );

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

test('强制来源在模型调用前校验并把受控确认稿与正式分析传入生成', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-required-sources-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const sourceRoot = path.join(root, 'source-artifacts');
  await fs.mkdir(sourceRoot, { recursive:true });
  const transcriptPath = path.join(sourceRoot, 'confirmed.md');
  const transcriptText = '确认稿原文：很多人把宿命理解成什么都不用做，但访谈强调行动仍然会改变结果。\n';
  const confirmed = confirmedFixture(transcriptText);
  const transcriptChecksum = confirmed.checksum;
  await fs.writeFile(transcriptPath, confirmed.markdown);
  const transcriptTask = {
    taskId:'transcript-task',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'confirmed-transcript:source:v1',
      type:'confirmed_transcript',
      title:'访谈系统确认稿',
      location:pathToFileURL(transcriptPath).href,
      checksum:transcriptChecksum,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        confirmationMode:'automatic',
      },
    }, {
      artifactId:'transcript-quality:source:v1',
      type:'transcript_quality_report',
      validation:{ exists:true, readable:true, nonEmpty:true },
    }],
  };
  const analysisTask = {
    taskId:'analysis-task',
    taskType:'content.video-benchmark-analysis',
    status:'succeeded',
    input:{ analysisIntent:'digest', evidenceMode:'formal' },
    artifactRefs:[{
      artifactId:'video-analysis:source',
      type:'video_content_analysis_report',
      checksum:'b'.repeat(64),
      title:'访谈正式分析',
      sourceRefs:['confirmed-transcript:source:v1'],
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        evidenceMode:'formal',
        formalSourceConfirmed:true,
        reportVersion:'video-analysis/v2',
        analysisIntent:'digest',
        claimsEvidenceLinked:true,
        modeStructurePassed:true,
      },
      data:{
        evidenceMode:'formal',
        analysisIntent:'digest',
        reportVersion:'video-analysis/v2',
        summary:'访谈的核心不是消极等待，而是区分不可控条件和仍可执行的选择。',
        modules:[{ name:'精华摘要' }],
        sourceTranscriptArtifactId:'confirmed-transcript:source:v1',
        sourceTranscriptChecksum:transcriptChecksum,
      },
    }, {
      artifactId:'analysis-support:source',
      type:'source_evidence_record',
      validation:{ exists:true, readable:true, nonEmpty:true },
    }],
  };
  let receivedSourceContext = null;
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return [transcriptTask, analysisTask]; } },
    artifactsDir:path.join(root, 'artifacts'),
    allowedSourceArtifactRoots:[sourceRoot],
    advisor:{
      async scriptPackage({ sourceContext }) {
        receivedSourceContext = sourceContext;
        return { data:null };
      },
    },
  });
  const result = await creator.execute({
    taskId:'grounded-script',
    taskType:'content.video-script-package',
    input:{
      contentGoal:'用 45 秒解释访谈中的宿命观点',
      context:{
        sourceTaskIds:[transcriptTask.taskId, analysisTask.taskId],
        requiredSourceTaskIds:[transcriptTask.taskId, analysisTask.taskId],
      },
    },
  });

  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.match(receivedSourceContext.confirmedTranscript.excerpt, /行动仍然会改变结果/);
  assert.equal(receivedSourceContext.formalAnalysis.summary, analysisTask.artifactRefs[0].data.summary);
  assert.deepEqual(receivedSourceContext.lineage, {
    sourceTranscriptArtifactId:'confirmed-transcript:source:v1',
    sourceTranscriptChecksum:transcriptChecksum,
  });
  const artifact = result.artifactRefs[0];
  assert.match(artifact.data.fullScript, /不可控条件和仍可执行的选择/);
  assert.match(artifact.data.fullScript, /行动仍然会改变结果/);
  assert.equal(artifact.data.sourceContext.confirmedTranscript.artifactId, 'confirmed-transcript:source:v1');
  assert.deepEqual(artifact.data.sourceTaskBindings, [
    { taskId:'transcript-task', artifactIds:['confirmed-transcript:source:v1'] },
    { taskId:'analysis-task', artifactIds:['video-analysis:source'] },
  ]);
});

test('强制来源血缘不一致时在任何模型或研究调用前停止', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-lineage-mismatch-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const transcriptPath = path.join(root, 'confirmed.md');
  const transcriptText = '这是一份足够长且通过质量门禁的确认稿内容。';
  const confirmed = confirmedFixture(transcriptText);
  await fs.writeFile(transcriptPath, confirmed.markdown);
  const sourceTasks = requiredSourceTasks(transcriptPath, {
    sourceTranscriptChecksum:'b'.repeat(64),
  }, confirmed.checksum);
  let advisorCalls = 0;
  let researcherCalls = 0;
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return sourceTasks; } },
    artifactsDir:path.join(root, 'artifacts'),
    allowedSourceArtifactRoots:[root],
    advisor:{ async scriptPackage() { advisorCalls += 1; return null; } },
    researcher:{ async execute() { researcherCalls += 1; return null; } },
  });
  const result = await creator.execute(requiredSourceScriptTask('为什么宿命观点仍然强调行动'));

  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'script_source_lineage_mismatch');
  assert.equal(advisorCalls, 0);
  assert.equal(researcherCalls, 0);
  assert.equal(result.artifactRefs, undefined);
});

test('确认稿和分析都挂在同一任务时不能用另一来源任务的无关产物凑数', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-source-task-coverage-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const transcriptPath = path.join(root, 'confirmed.md');
  const transcriptText = '这是一份来自受控目录的真实确认稿。';
  const confirmed = confirmedFixture(transcriptText);
  await fs.writeFile(transcriptPath, confirmed.markdown);
  const [transcriptTask, analysisTask] = requiredSourceTasks(transcriptPath, {}, confirmed.checksum);
  transcriptTask.artifactRefs.push(analysisTask.artifactRefs[0]);
  analysisTask.artifactRefs = [{
    artifactId:'unrelated-readable-artifact',
    type:'source_evidence_record',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{ summary:'与脚本来源血缘无关。' },
  }];
  let advisorCalls = 0;
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return [transcriptTask, analysisTask]; } },
    artifactsDir:path.join(root, 'artifacts'),
    allowedSourceArtifactRoots:[root],
    advisor:{ async scriptPackage() { advisorCalls += 1; return null; } },
  });
  const result = await creator.execute(requiredSourceScriptTask('解释宿命观点'));

  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'script_source_lineage_mismatch');
  assert.equal(advisorCalls, 0);
  assert.equal(result.artifactRefs, undefined);
});

test('强制来源确认稿越出允许目录时拒绝读取且不调用模型', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-source-boundary-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const allowedRoot = path.join(root, 'allowed');
  await fs.mkdir(allowedRoot, { recursive:true });
  const outsidePath = path.join(root, 'outside-confirmed.md');
  const transcriptText = '这份确认稿虽然存在，但不在允许读取的目录中。';
  const confirmed = confirmedFixture(transcriptText);
  await fs.writeFile(outsidePath, confirmed.markdown);
  const sourceTasks = requiredSourceTasks(outsidePath, {}, confirmed.checksum);
  let advisorCalls = 0;
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return sourceTasks; } },
    artifactsDir:path.join(root, 'artifacts'),
    allowedSourceArtifactRoots:[allowedRoot],
    advisor:{ async scriptPackage() { advisorCalls += 1; return null; } },
  });
  const result = await creator.execute(requiredSourceScriptTask('解释宿命观点'));

  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'script_source_artifact_path_not_allowed');
  assert.equal(advisorCalls, 0);
  assert.equal(result.artifactRefs, undefined);
});

test('确认稿最终路径是目录内符号链接时也拒绝打开', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-source-symlink-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const sourceRoot = path.join(root, 'allowed');
  await fs.mkdir(sourceRoot, { recursive:true });
  const transcriptText = '符号链接指向的内容即使校验和一致也不能作为确认稿输入。';
  const confirmed = confirmedFixture(transcriptText);
  const targetPath = path.join(sourceRoot, 'target.md');
  const symlinkPath = path.join(sourceRoot, 'confirmed.md');
  await fs.writeFile(targetPath, confirmed.markdown);
  await fs.symlink(targetPath, symlinkPath);
  const sourceTasks = requiredSourceTasks(symlinkPath, {}, confirmed.checksum);
  let advisorCalls = 0;
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return sourceTasks; } },
    artifactsDir:path.join(root, 'artifacts'),
    allowedSourceArtifactRoots:[sourceRoot],
    advisor:{ async scriptPackage() { advisorCalls += 1; return null; } },
  });
  const result = await creator.execute(requiredSourceScriptTask('解释宿命观点'));

  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'script_source_artifact_symlink_not_allowed');
  assert.equal(advisorCalls, 0);
  assert.equal(result.artifactRefs, undefined);
});

test('确认稿在 lstat 后、最终打开前被替换时按 inode 变化拒绝', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-source-replaced-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const transcriptPath = path.join(root, 'confirmed.md');
  const replacementPath = path.join(root, 'replacement.md');
  const transcriptText = '账本确认时的原始确认稿。';
  const confirmed = confirmedFixture(transcriptText);
  await fs.writeFile(transcriptPath, confirmed.markdown);
  await fs.writeFile(replacementPath, confirmed.markdown);
  const sourceTasks = requiredSourceTasks(transcriptPath, {}, confirmed.checksum);
  let advisorCalls = 0;
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return sourceTasks; } },
    artifactsDir:path.join(root, 'artifacts'),
    allowedSourceArtifactRoots:[root],
    advisor:{ async scriptPackage() { advisorCalls += 1; return null; } },
  });
  const originalOpen = fs.open;
  let replaced = false;
  fs.open = async (filePath, ...args) => {
    if (!replaced && path.resolve(String(filePath)) === path.resolve(transcriptPath)) {
      replaced = true;
      await fs.rename(replacementPath, transcriptPath);
    }
    return originalOpen.call(fs, filePath, ...args);
  };
  let result;
  try {
    result = await creator.execute(requiredSourceScriptTask('解释宿命观点'));
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(replaced, true);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'script_source_artifact_replaced');
  assert.equal(advisorCalls, 0);
  assert.equal(result.artifactRefs, undefined);
});

test('确认稿 frontmatter 或正文被篡改后即使账本血缘字段一致也不能进入生成', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-source-checksum-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const original = confirmedFixture('账本最初确认的原始内容。');
  let advisorCalls = 0;
  const cases = [
    {
      name:'frontmatter',
      markdown:original.markdown.replace(
        `checksum: ${original.checksum}`,
        `checksum: ${'b'.repeat(64)}`,
      ),
    },
    {
      name:'body',
      markdown:original.markdown.replace('账本最初确认的原始内容。', '已被替换的确认稿正文。'),
    },
  ];
  for (const item of cases) {
    const transcriptPath = path.join(root, `${item.name}.md`);
    await fs.writeFile(transcriptPath, item.markdown);
    const sourceTasks = requiredSourceTasks(transcriptPath, {}, original.checksum);
    const creator = new LocalVideoScriptPackage({
      store:{ async list() { return sourceTasks; } },
      artifactsDir:path.join(root, `artifacts-${item.name}`),
      allowedSourceArtifactRoots:[root],
      advisor:{ async scriptPackage() { advisorCalls += 1; return null; } },
    });
    const result = await creator.execute(requiredSourceScriptTask('解释宿命观点'));
    assert.equal(result.status, 'needs_input', item.name);
    assert.equal(result.error.code, 'script_source_artifact_checksum_mismatch', item.name);
    assert.equal(result.artifactRefs, undefined, item.name);
  }
  assert.equal(advisorCalls, 0);
});

test('缺少 v2 claims 证据门禁的弱分析不能作为强制来源', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-weak-analysis-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const transcriptPath = path.join(root, 'confirmed.md');
  const transcriptText = '这是一份校验和与账本一致的确认稿。';
  const confirmed = confirmedFixture(transcriptText);
  await fs.writeFile(transcriptPath, confirmed.markdown);
  const sourceTasks = requiredSourceTasks(transcriptPath, {}, confirmed.checksum);
  sourceTasks[1].artifactRefs[0].validation.claimsEvidenceLinked = false;
  let advisorCalls = 0;
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return sourceTasks; } },
    artifactsDir:path.join(root, 'artifacts'),
    allowedSourceArtifactRoots:[root],
    advisor:{ async scriptPackage() { advisorCalls += 1; return null; } },
  });
  const result = await creator.execute(requiredSourceScriptTask('解释宿命观点'));

  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'script_formal_analysis_required');
  assert.equal(advisorCalls, 0);
  assert.equal(result.artifactRefs, undefined);
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
    researcher:{ async execute({ input }) {
      assert.deepEqual(input.sourceUrls, [
        'https://example.com/1',
        'https://example.com/2',
        'https://example.com/3',
      ]);
      return {
        status:'succeeded',
        artifactRefs:[{
          type:'intel_research_report',
          data:{ sources:Array.from({ length:6 }, (_, index) => ({
            title:`公开资料 ${index + 1}`,
            source:`https://example.com/report-${index + 1}`,
            summary:index === 0 ? '自动化会改变任务结构。' : `补充资料 ${index + 1}`,
            fetchedAt:'2026-07-28T00:00:00.000Z',
          })) }
        }]
      };
    } }
  });
  const result = await creator.execute({
    taskId:'script-1',
    taskType:'content.video-script-package',
    assigneeAgentId:'content-creator',
    source:{ channel:'feishu', chatRef:'chat-1' },
    input:{
      title:'写一个 AI 会不会让人失业的视频脚本',
      sourceUrls:[
        'https://example.com/1',
        'https://example.com/2',
        'https://example.com/3',
        'https://example.com/4',
      ],
    }
  }, { allowAdvisor:false });

  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.type, 'video_script_package');
  assert.equal(artifact.data.referenceMatch.type, 'reference_case');
  assert.equal(artifact.data.platform, 'douyin');
  assert.equal(artifact.validation.fileCount, 5);
  assert.equal(artifact.validation.externalSideEffects, 0);
  assert.equal(artifact.validation.factualSourcesBounded, true);
  assert.equal(artifact.data.sources.length, 3);
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

function requiredSourceTasks(transcriptPath, analysisOverrides = {}, checksum = 'a'.repeat(64)) {
  const transcriptArtifactId = 'confirmed-transcript:source:v1';
  return [
    {
      taskId:'transcript-task',
      status:'succeeded',
      artifactRefs:[{
        artifactId:transcriptArtifactId,
        type:'confirmed_transcript',
        location:pathToFileURL(transcriptPath).href,
        checksum,
        validation:{ exists:true, readable:true, nonEmpty:true, confirmationMode:'automatic' },
      }],
    },
    {
      taskId:'analysis-task',
      taskType:'content.video-benchmark-analysis',
      status:'succeeded',
      input:{ analysisIntent:'digest', evidenceMode:'formal' },
      artifactRefs:[{
        artifactId:'video-analysis:source',
        type:'video_content_analysis_report',
        sourceRefs:[transcriptArtifactId],
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          evidenceMode:'formal',
          formalSourceConfirmed:true,
          reportVersion:'video-analysis/v2',
          analysisIntent:'digest',
          claimsEvidenceLinked:true,
          modeStructurePassed:true,
        },
        data:{
          evidenceMode:'formal',
          reportVersion:'video-analysis/v2',
          analysisIntent:'digest',
          summary:'正式分析摘要。',
          modules:[{ name:'精华摘要' }],
          sourceTranscriptArtifactId:transcriptArtifactId,
          sourceTranscriptChecksum:checksum,
          ...analysisOverrides,
        },
      }],
    },
  ];
}

function requiredSourceScriptTask(contentGoal) {
  return {
    taskId:'required-source-script',
    taskType:'content.video-script-package',
    input:{
      contentGoal,
      context:{
        sourceTaskIds:['transcript-task', 'analysis-task'],
        requiredSourceTaskIds:['transcript-task', 'analysis-task'],
      },
    },
  };
}

function confirmedFixture(transcript) {
  return confirmedTranscriptDocument({
    title:'测试确认稿',
    transcript,
    machineChecksum:'f'.repeat(64),
    confirmationMode:'automatic',
    confirmerRef:'xiaod-quality-gate',
    confirmedAt:'2026-08-10T00:00:00.000Z',
    version:1,
  });
}

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

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
