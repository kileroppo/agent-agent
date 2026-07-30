import crypto from 'node:crypto';

const PLATFORMS = new Set(['douyin', 'xiaohongshu']);
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function deriveM5ContentVersionId({
  pipelineCaseId,
  platform,
  mediaChecksum,
} = {}) {
  const caseId = String(pipelineCaseId || '').trim();
  const targetPlatform = String(platform || '').trim();
  const checksum = String(mediaChecksum || '').trim().toLowerCase();
  if (!caseId || !PLATFORMS.has(targetPlatform) || !SHA256.test(checksum)) return null;
  const digest = crypto.createHash('sha256')
    .update(`${caseId}\n${targetPlatform}\n${checksum}`)
    .digest('hex');
  return `m5:${targetPlatform}:${digest.slice(0, 40)}`;
}

export function validM5MediaChecksum(value) {
  return SHA256.test(String(value || '').trim());
}

export function buildM5PlatformCopy(script, platform) {
  if (!PLATFORMS.has(platform)) return null;
  const titleLimit = platform === 'douyin' ? 60 : 80;
  const bodyLimit = platform === 'douyin' ? 800 : 1500;
  const title = clean(
    script?.hook || script?.opening || script?.topic,
    titleLimit,
  ) || (
    platform === 'douyin'
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
    tags:platform === 'douyin'
      ? ['AI Agent', '智能体实战', '效率工具']
      : ['AI Agent实战', '智能体工作流', '效率提升'],
  };
}

function clean(value, maximum) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
