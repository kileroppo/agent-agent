import {
  m5Sha256,
  M5_PLATFORM_IDS,
  M5_PLATFORMS,
  normalizeM5Sha256,
} from '@agent-army/m5-contracts';

const PLATFORMS = new Set(M5_PLATFORMS);

export function deriveM5ContentVersionId({
  pipelineCaseId,
  platform,
  mediaChecksum,
}: Readonly<{ pipelineCaseId?: unknown; platform?: unknown; mediaChecksum?: unknown }> = {}): string | null {
  const caseId = String(pipelineCaseId || '').trim();
  const targetPlatform = String(platform || '').trim();
  const checksum = normalizeM5Sha256(mediaChecksum);
  if (!caseId || !isM5Platform(targetPlatform) || !checksum) return null;
  const digest = m5Sha256(`${caseId}\n${targetPlatform}\n${checksum}`).slice('sha256:'.length);
  return `m5:${targetPlatform}:${digest.slice(0, 40)}`;
}

export function validM5MediaChecksum(value: unknown): boolean {
  return normalizeM5Sha256(value) !== null;
}

export function buildM5PlatformCopy(script: Record<string, any> | null, platform: unknown) {
  if (typeof platform !== 'string' || !isM5Platform(platform)) return null;
  const titleLimit = platform === M5_PLATFORM_IDS.DOUYIN ? 60 : 80;
  const bodyLimit = platform === M5_PLATFORM_IDS.DOUYIN ? 800 : 1500;
  const title = clean(
    script?.hook || script?.opening || script?.topic,
    titleLimit,
  ) || (
    platform === M5_PLATFORM_IDS.DOUYIN
      ? 'AI Agent 实战：从任务到可核验结果'
      : 'AI Agent 实战：一条可核验的工作流'
  );
  const body = [
    clean(script?.fullScript, bodyLimit),
    clean(script?.coreConclusion || script?.conclusion, 240),
  ].filter(Boolean).join('\n\n')
    || '用真实任务、真实工具结果和恢复动作，验证 AI Agent 是否真正完成工作。';
  return {
    title,
    body,
    tags:platform === M5_PLATFORM_IDS.DOUYIN
      ? ['AI Agent', '智能体实战', '效率工具']
      : ['AI Agent实战', '智能体工作流', '效率提升'],
  };
}

function isM5Platform(value: string): value is (typeof M5_PLATFORMS)[number] {
  return PLATFORMS.has(value as (typeof M5_PLATFORMS)[number]);
}

function clean(value: unknown, maximum: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
