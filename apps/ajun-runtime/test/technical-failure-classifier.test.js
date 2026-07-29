import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTechnicalFailure } from '../src/technical-failure-classifier.js';

test('技术故障先区分代码缺陷、输入问题、授权问题和临时外部故障', () => {
  assert.equal(classifyTechnicalFailure({
    error:{ code:'xiaod_job_failed', category:'manual', message:'转录完整性检查未通过：audio_coverage_below_99_9_percent' }
  }).failureClass, 'code_defect_candidate');
  assert.equal(classifyTechnicalFailure({
    error:{ code:'xiaod_job_failed', category:'needs_input', userMessage:'素材无法识别，请重新上传' }
  }).failureClass, 'input_or_source');
  assert.equal(classifyTechnicalFailure({
    error:{ code:'permission_denied', category:'manual', message:'Cookie expired' }
  }).failureClass, 'authorization_or_permission');
  assert.equal(classifyTechnicalFailure({
    error:{ code:'service_unavailable', category:'retryable', retryable:true, message:'network timeout' }
  }).failureClass, 'transient_external_dependency');
});

test('故障分类只保留脱敏摘要和来源平台，不把 URL 或 token 交给技术专家', () => {
  const result = classifyTechnicalFailure({
    taskType:'media.transcribe-and-refine',
    sourceUrl:'https://www.bilibili.com/video/BV1TEST?token=secret',
    error:{ code:'download_failed', message:'请求 https://example.com/a?token=secret token=raw-secret 失败' }
  });
  assert.equal(result.evidence.sourcePlatform, 'bilibili');
  assert.equal(JSON.stringify(result).includes('raw-secret'), false);
  assert.equal(JSON.stringify(result).includes('BV1TEST'), false);
});

test('模型提供方余额或额度不足属于需要负责人处理的授权边界，不进入代码修复', () => {
  const result = classifyTechnicalFailure({
    error:{
      code:'adapter_failed',
      category:'manual',
      stage:'paperclip_hermes',
      message:'Billing or credits exhausted: HTTP 402: Insufficient Balance'
    },
    taskType:'governance.architecture-review'
  });
  assert.equal(result.failureClass, 'authorization_or_permission');
  assert.equal(result.route, 'needs_authorized_input');
});
