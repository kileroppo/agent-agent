import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTaskCompletion } from '../src/task-completion-contract.ts';

const readable = (type, data = {}, extra = {}) => {
  const { validation = {}, ...rest } = extra;
  return {
    type,
    validation:{ exists:true, readable:true, nonEmpty:true, ...validation },
    data,
    ...rest,
  };
};

test('专用任务只接受对应类型且通过语义门禁的完成产物', () => {
  const task = { taskType:'research.intel-report' };
  assert.equal(validateTaskCompletion(task, [readable('employee_role_report', { summary:'完成了' })]).valid, false);
  assert.equal(validateTaskCompletion(task, [readable('intel_research_report', { conclusion:'结论', sources:[] })]).valid, false);
  assert.equal(validateTaskCompletion(task, [readable('intel_research_report', { conclusion:'结论', sources:[{ source:'https://example.com' }] })]).valid, true);
});

test('小R 产品成熟度新鲜度任务必须通过显式交付覆盖门禁', () => {
  const task = {
    taskType:'research.intel-report',
    input:{ context:{ validationPurpose:'product_maturity_role_freshness' } },
  };
  const data = {
    conclusion:'结论',
    sources:[{ source:'https://example.com' }],
    deliveryGate:{ accepted:true, evidenceCoverageSatisfied:true },
  };
  assert.equal(validateTaskCompletion(task, [readable('intel_research_report', data)]).valid, false);
  assert.equal(validateTaskCompletion(task, [readable('intel_research_report', data, {
    validation:{ deliverableAccepted:true, deliverableCoverageSatisfied:true },
  })]).valid, true);
  assert.equal(validateTaskCompletion(task, [readable('intel_research_report', {
    ...data,
    deliveryGate:{ ...data.deliveryGate, accepted:false },
  }, { validation:{ deliverableAccepted:true, deliverableCoverageSatisfied:true } })]).valid, false);
});

test('视频分析 v2 必须与请求模式一致并绑定证据', () => {
  const task = { taskType:'content.video-benchmark-analysis', input:{ analysisIntent:'deep', depth:'full', evidenceMode:'formal' } };
  const artifact = readable('video_content_analysis_report', {
    reportVersion:'video-analysis/v2',
    analysisIntent:'deep',
    modules:[{ name:'定位' }],
  }, { validation:{
    reportVersion:'video-analysis/v2',
    analysisIntent:'deep',
    modeStructurePassed:true,
    claimsEvidenceLinked:true,
    formalSourceConfirmed:true,
    semanticValidationPassed:true,
  } });
  assert.equal(validateTaskCompletion(task, [artifact]).valid, true);
  assert.equal(validateTaskCompletion(task, [{ ...artifact, validation:{ ...artifact.validation, claimsEvidenceLinked:false } }]).valid, false);
  assert.equal(validateTaskCompletion(task, [{ ...artifact, data:{ ...artifact.data, analysisIntent:'digest' } }]).valid, false);
});

test('视频脚本包必须是五文件本地待审单稿并覆盖声明的来源任务', () => {
  const task = {
    taskType:'content.video-script-package',
    input:{ context:{ requiredSourceTaskIds:['transcript-task', 'analysis-task'] } },
  };
  const artifact = readable('video_script_package', {
    fullScript:'这是完整口播稿。',
    publishingStatus:'draft_only',
    sourceTaskIds:['transcript-task', 'analysis-task'],
    sourceTaskBindings:[
      { taskId:'transcript-task', artifactIds:['confirmed_transcript:transcript-task'] },
      { taskId:'analysis-task', artifactIds:['video_content_analysis_report:analysis-task'] },
    ],
    productionFiles:['script', 'shots', 'subtitles', 'sources', 'manifest'].map((id) => ({ id })),
  }, {
    sourceRefs:['confirmed_transcript:transcript-task', 'video_content_analysis_report:analysis-task'],
    validation:{ fileCount:5, onePrimaryDraft:true, externalSideEffects:0 },
  });

  assert.equal(validateTaskCompletion(task, [artifact]).valid, true);
});

test('视频脚本包任一关键门禁不满足都不能完成', () => {
  const task = {
    taskType:'content.video-script-package',
    input:{ context:{ requiredSourceTaskIds:['transcript-task', 'analysis-task'] } },
  };
  const artifact = readable('video_script_package', {
    fullScript:'这是完整口播稿。',
    publishingStatus:'draft_only',
    sourceTaskIds:['transcript-task', 'analysis-task'],
    sourceTaskBindings:[
      { taskId:'transcript-task', artifactIds:['confirmed_transcript:transcript-task'] },
      { taskId:'analysis-task', artifactIds:['video_content_analysis_report:analysis-task'] },
    ],
    productionFiles:['script', 'shots', 'subtitles', 'sources', 'manifest'].map((id) => ({ id })),
  }, {
    sourceRefs:['confirmed_transcript:transcript-task', 'video_content_analysis_report:analysis-task'],
    validation:{ fileCount:5, onePrimaryDraft:true, externalSideEffects:0 },
  });
  const invalidArtifacts = [
    { ...artifact, data:{ ...artifact.data, fullScript:'   ' } },
    { ...artifact, validation:{ ...artifact.validation, fileCount:4 } },
    { ...artifact, validation:{ ...artifact.validation, onePrimaryDraft:false } },
    { ...artifact, validation:{ ...artifact.validation, externalSideEffects:1 } },
    { ...artifact, data:{ ...artifact.data, publishingStatus:'published' } },
    { ...artifact, data:{ ...artifact.data, productionFiles:artifact.data.productionFiles.slice(0, 4) } },
    { ...artifact, data:{ ...artifact.data, productionFiles:[...artifact.data.productionFiles.slice(0, 4), { id:'script' }] } },
    { ...artifact, data:{ ...artifact.data, sourceTaskIds:['analysis-task'] } },
    { ...artifact, data:{ ...artifact.data, sourceTaskBindings:[] } },
    { ...artifact, data:{ ...artifact.data, sourceTaskBindings:[
      { taskId:'transcript-task', artifactIds:['confirmed_transcript:transcript-task'] },
      { taskId:'analysis-task', artifactIds:[] },
    ] } },
    { ...artifact, sourceRefs:['video_content_analysis_report:analysis-task'] },
  ];

  for (const invalid of invalidArtifacts) {
    assert.equal(validateTaskCompletion(task, [invalid]).valid, false);
  }
});

test('未声明强制来源的脚本包不要求来源任务列表', () => {
  const artifact = readable('video_script_package', {
    fullScript:'这是完整口播稿。',
    publishingStatus:'draft_only',
    productionFiles:['script', 'shots', 'subtitles', 'sources', 'manifest'].map((id) => ({ id })),
  }, { validation:{ fileCount:5, onePrimaryDraft:true, externalSideEffects:0 } });
  assert.equal(validateTaskCompletion({ taskType:'content.video-script-package' }, [artifact]).valid, true);
});

test('没有任何可读产物的普通任务也不能被视为完成', () => {
  assert.equal(validateTaskCompletion({ taskType:'governance.approval-review' }, []).valid, false);
  assert.equal(validateTaskCompletion({ taskType:'governance.approval-review' }, [readable('employee_role_report', { summary:'已核对' })]).valid, true);
});
