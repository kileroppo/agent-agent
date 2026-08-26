import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDownstreamMissionPayload,
  verifyAndCreateAssetPackage,
} from '../src/content-pipeline-handoff.ts';

test('verifyAndCreateAssetPackage 验证完整性并生成带 SHA256 的不可变素材包描述符', () => {
  const pkg = verifyAndCreateAssetPackage({
    taskId: 'task-abc-12345',
    sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    title: 'AI行业洞察视频',
    transcriptMarkdown: '# 行业分析\n\n这是包含足够字符长度的详尽行业纪要全文，分析了多模态大模型的最新落地进展。',
    audioDurationMs: 120000,
    storyboardFrames: [
      { frameIndex: 1, timestampMs: 1000, sha256: 'f1_sha256' },
      { frameIndex: 2, timestampMs: 60000, sha256: 'f2_sha256' },
    ],
  });

  assert.equal(pkg.schemaVersion, 'agent.army/asset-package/v1');
  assert.equal(pkg.taskId, 'task-abc-12345');
  assert.equal(pkg.frameCount, 2);
  assert.ok(pkg.packageId.startsWith('pkg_task-abc_'));
  assert.ok(pkg.packageDigest);
  assert.ok(pkg.transcriptSha256);
});

test('verifyAndCreateAssetPackage 拦截内容过短或异常时长的脏数据', () => {
  assert.throws(
    () =>
      verifyAndCreateAssetPackage({
        taskId: 'task-short',
        sourceUrl: '',
        title: '短标题',
        transcriptMarkdown: '太短了',
        audioDurationMs: 1000,
      }),
    /未达到交付完整性门禁要求/
  );

  assert.throws(
    () =>
      verifyAndCreateAssetPackage({
        taskId: 'task-invalid-time',
        sourceUrl: '',
        title: '有效标题',
        transcriptMarkdown: '有效文本足够长 '.repeat(10),
        audioDurationMs: 0,
      }),
    /素材时长异常/
  );
});

test('createDownstreamMissionPayload 准确构建下游任务载荷', () => {
  const descriptor = {
    schemaVersion: 'agent.army/asset-package/v1',
    packageId: 'pkg_test_123',
    taskId: 't-123',
    sourceUrl: 'https://test.com',
    title: '行业深度分享',
    summary: '行业总结',
    audioDurationMs: 60000,
    transcriptSha256: 'sha_text',
    frameCount: 5,
    packageDigest: 'digest_123',
    createdAt: new Date().toISOString(),
  };

  const briefing = createDownstreamMissionPayload(descriptor, 'office_briefing');
  assert.equal(briefing.taskType, 'office.briefing-generate');
  assert.ok(briefing.title.includes('行业深度分享'));
  assert.equal(briefing.input.assetPackageId, 'pkg_test_123');

  const social = createDownstreamMissionPayload(descriptor, 'social_publish');
  assert.equal(social.taskType, 'publisher.social-draft');
});
