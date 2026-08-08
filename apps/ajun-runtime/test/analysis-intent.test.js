import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analysisDepth,
  analysisIntentLabel,
  resolveAnalysisIntent,
} from '../src/analysis-intent.ts';

test('分析意图 Module 保持单一模式真相、兼容旧 depth 并拒绝语义冲突', () => {
  assert.deepEqual(resolveAnalysisIntent({ analysisIntent:'template' }), {
    error:null,
    matched:[],
    analysisIntent:'template',
    depth:'full',
  });
  assert.equal(resolveAnalysisIntent({ depth:'full' }).analysisIntent, 'deep');
  assert.equal(resolveAnalysisIntent({ analysisIntent:'STYLE' }).error, 'invalid_analysis_intent');
  assert.equal(resolveAnalysisIntent({ title:'提炼重点' }).analysisIntent, 'digest');
  assert.deepEqual(resolveAnalysisIntent({ title:'完整分析并提取模板' }), {
    error:'analysis_intent_conflict',
    matched:['deep', 'template'],
    analysisIntent:null,
    depth:null,
  });
  assert.equal(analysisDepth('style'), 'full');
  assert.equal(analysisDepth('unknown'), 'full');
  assert.equal(analysisIntentLabel('style'), '风格探索');
});
