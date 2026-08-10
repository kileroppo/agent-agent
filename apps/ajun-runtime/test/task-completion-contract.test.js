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

test('没有任何可读产物的普通任务也不能被视为完成', () => {
  assert.equal(validateTaskCompletion({ taskType:'governance.approval-review' }, []).valid, false);
  assert.equal(validateTaskCompletion({ taskType:'governance.approval-review' }, [readable('employee_role_report', { summary:'已核对' })]).valid, true);
});
