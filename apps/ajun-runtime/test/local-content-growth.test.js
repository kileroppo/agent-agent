import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalContentCreator, LocalVideoContentAnalyst } from '../src/local-content-growth.js';

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
    input:{ title:'样片拆解', evidenceMode:'formal', depth:'full', context:{ sourceTaskIds:[sourceTask.taskId] } }
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
  assert.equal(result.artifactRefs[0].validation.advisorApplied, false);
  assert.equal(result.artifactRefs[0].validation.semanticValidationPassed, false);
  assert.equal(result.usage.model.apiCalls, 2);
});

test('小拆优先使用真实来源标题，并只接受带关键帧引用的视觉结论', async (t) => {
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
  const evidence = { timestamp:'00:00', fragment:'开场直接给出结果。' };
  const moduleNames = ['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'];
  let advisorInput;
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze(input) {
      advisorInput = input;
      return {
        data:{
          summary:'图文联合分析',
          modules:moduleNames.map((name) => ({ name, finding:`${name}判断`, evidence, confidence:'high' })),
          visualFindings:[
            { category:'opening_visual_hook', finding:'开头使用人物近景。', evidence:{ timestamp:'00:00', frameRef:'frame-001' }, confidence:'high' },
            { category:'captions_and_graphics', finding:'画面存在醒目字幕。', evidence:{ timestamp:'00:05', frameRef:'frame-002' }, confidence:'medium' },
            { category:'captions_and_graphics', finding:'中段画面继续使用字幕。', evidence:{ timestamp:'00:11', frameRef:'frame-003' }, confidence:'medium' }
          ],
          reusablePatterns:[],
          actionItems:[]
        }
      };
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
  const artifact = result.artifactRefs[0];
  assert.equal(advisorInput.title, '平台真实原标题');
  assert.equal(advisorInput.visualEvidence.storyboards[0].filePath, path.join(storyboardDir, 'storyboard-01.jpg'));
  assert.equal(artifact.data.title, '平台真实原标题');
  assert.equal(artifact.data.sourceMetadata.author, '平台作者');
  assert.equal(artifact.data.visualFindings.length, 3);
  assert.equal(artifact.data.visualFindings[2].evidence.timestamp, '00:12');
  assert.equal(artifact.data.completeness, 'complete');
  assert.equal(artifact.validation.visualClaimsEvidenceLinked, true);
  assert.equal(artifact.validation.visualAnalysisApplied, true);
  assert.deepEqual(artifact.sourceRefs, ['confirmed-1', 'source-evidence-visual', 'visual-evidence-visual']);
});

test('视觉结论引用不存在的关键帧时降级为部分完成，不冒充图文分析成功', async (t) => {
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
  const analyst = new LocalVideoContentAnalyst({
    store:{ list:async () => [sourceTask] },
    artifactsDir:path.join(root, 'out'),
    allowedArtifactRoots:[root],
    advisor:{ async analyze() {
      return {
        data:{
          summary:'错误视觉引用',
          modules:['定位与受众', '开场钩子', '内容结构', '核心价值点', '可执行优化建议'].map((name) => ({ name, finding:name, evidence, confidence:'high' })),
          visualFindings:[
            { category:'opening_visual_hook', finding:'无法核验的画面结论', evidence:{ timestamp:'00:09', frameRef:'frame-999' }, confidence:'high' }
          ]
        }
      };
    } }
  });
  const result = await analyst.execute({
    taskId:'analysis-task-invalid-visual',
    taskType:'content.video-benchmark-analysis',
    input:{ title:'错误视觉引用', evidenceMode:'formal', depth:'fast', visualMode:'auto', context:{ sourceTaskIds:[sourceTask.taskId] } }
  });
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.validation.advisorApplied, false);
  assert.equal(artifact.data.visualFindings.length, 0);
  assert.equal(artifact.data.completeness, 'partial');
  assert.equal(artifact.validation.visualAnalysisApplied, false);
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
    input:{ title:'草稿', platforms:['douyin', 'xiaohongshu'], contentGoal:'解释一个方法', context:{ sourceTaskIds:['source-task-0003', 'analysis-task-0005'] } }
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].data.drafts.length, 2);
  assert.equal(result.artifactRefs[0].validation.externalSideEffects, 0);
});

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

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-growth-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  return root;
}
