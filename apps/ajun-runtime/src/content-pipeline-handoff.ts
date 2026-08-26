import crypto from 'node:crypto';

export type StoryboardFrame = {
  frameIndex: number;
  timestampMs: number;
  sha256: string;
};

export type AssetPackageInput = {
  taskId: string;
  sourceUrl: string;
  title: string;
  transcriptMarkdown: string;
  storyboardFrames?: StoryboardFrame[];
  audioDurationMs: number;
  tags?: string[];
};

export type AssetPackageDescriptor = {
  schemaVersion: 'agent.army/asset-package/v1';
  packageId: string;
  taskId: string;
  sourceUrl: string;
  title: string;
  summary: string;
  audioDurationMs: number;
  transcriptSha256: string;
  frameCount: number;
  packageDigest: string;
  createdAt: string;
};

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

export function verifyAndCreateAssetPackage(input: AssetPackageInput): AssetPackageDescriptor {
  if (!input.taskId || !input.title) {
    throw new Error('素材包缺少必要的任务标识或标题。');
  }

  const transcript = String(input.transcriptMarkdown || '').trim();
  if (transcript.length < 20) {
    throw new Error('字幕或正文内容过短，未达到交付完整性门禁要求。');
  }

  if (input.audioDurationMs <= 0) {
    throw new Error('素材时长异常，无法构造受控素材包。');
  }

  const frames = input.storyboardFrames || [];
  const transcriptSha256 = computeSha256(transcript);

  const digestSource = JSON.stringify({
    taskId: input.taskId,
    sourceUrl: input.sourceUrl,
    transcriptSha256,
    frameCount: frames.length,
    audioDurationMs: input.audioDurationMs,
  });

  const packageDigest = computeSha256(digestSource);
  const summary = transcript.slice(0, 300).replace(/\n+/g, ' ');

  return {
    schemaVersion: 'agent.army/asset-package/v1',
    packageId: `pkg_${input.taskId.slice(0, 8)}_${packageDigest.slice(0, 8)}`,
    taskId: input.taskId,
    sourceUrl: input.sourceUrl || '',
    title: input.title,
    summary,
    audioDurationMs: input.audioDurationMs,
    transcriptSha256,
    frameCount: frames.length,
    packageDigest,
    createdAt: new Date().toISOString(),
  };
}

export function createDownstreamMissionPayload(
  descriptor: AssetPackageDescriptor,
  targetAction: 'office_briefing' | 'social_publish' | 'boom_intel'
): {
  taskType: string;
  title: string;
  input: Record<string, any>;
} {
  switch (targetAction) {
    case 'office_briefing':
      return {
        taskType: 'office.briefing-generate',
        title: `生成【${descriptor.title}】办公汇报材料与演示文稿`,
        input: {
          assetPackageId: descriptor.packageId,
          sourceTaskId: descriptor.taskId,
          title: descriptor.title,
          summary: descriptor.summary,
        },
      };
    case 'social_publish':
      return {
        taskType: 'publisher.social-draft',
        title: `为【${descriptor.title}】拟定多平台发布草稿与宣发文案`,
        input: {
          assetPackageId: descriptor.packageId,
          sourceTaskId: descriptor.taskId,
          sourceUrl: descriptor.sourceUrl,
        },
      };
    case 'boom_intel':
      return {
        taskType: 'research.boom-radar-archive',
        title: `归档【${descriptor.title}】至爆款分析库`,
        input: {
          assetPackageId: descriptor.packageId,
          packageDigest: descriptor.packageDigest,
          audioDurationMs: descriptor.audioDurationMs,
        },
      };
    default:
      throw new Error(`不支持的下游动作类型: ${targetAction}`);
  }
}
