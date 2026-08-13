import { createVisualEvidencePackage } from './visual-evidence.js';

export const VISUAL_EVIDENCE_CAPABILITY_ID = 'vision.extract-evidence';

/** Structural CapabilityAdapter for the shared workflow engine. */
export function createLocalVisualEvidenceAdapter({ createPackage = createVisualEvidencePackage } = {}) {
  return Object.freeze({
    adapterId:'xiaod.local-visual-evidence',
    async invoke({ payload }) {
      const input = payload && typeof payload === 'object' ? payload : {};
      const created = await createPackage({
        videoPath:input.videoPath,
        outputDir:input.outputDir,
        depth:input.depth,
        transcriptSegments:input.transcriptSegments,
        sourceMetadata:input.sourceMetadata
      });
      return Object.freeze({
        output:Object.freeze({
          ...created,
          qualityResult:visualEvidenceQualityResult(created.payload)
        }),
        provider:'local-ffmpeg',
        model:null,
        usage:Object.freeze({
          selectedFrames:created.payload?.frames?.length || 0,
          storyboardCount:created.payload?.storyboards?.length || 0
        }),
        costUsd:0
      });
    }
  });
}

export function visualEvidenceQualityResult(payload = {}) {
  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  const storyboards = Array.isArray(payload.storyboards) ? payload.storyboards : [];
  const reasons = [];
  if (payload.coverage?.status !== 'available') reasons.push('visual_coverage_unavailable');
  if (!frames.length) reasons.push('visual_frames_empty');
  if (frames.some((frame) => !/^sha256:[a-f0-9]{64}$/.test(String(frame?.checksum || '')))) {
    reasons.push('visual_frame_checksum_missing');
  }
  if (!storyboards.length) reasons.push('visual_storyboard_missing');
  return Object.freeze({
    schemaVersion:'agent.army/capability-quality-result/v1',
    capabilityId:VISUAL_EVIDENCE_CAPABILITY_ID,
    gateId:'xiaod.visual-evidence-quality',
    passed:reasons.length === 0,
    status:reasons.length === 0 ? 'passed' : 'failed',
    reasons:Object.freeze([...new Set(reasons)]),
    signals:Object.freeze({
      selectedFrames:frames.length,
      storyboardCount:storyboards.length,
      durationSeconds:Number.isFinite(Number(payload.durationSeconds)) ? Number(payload.durationSeconds) : null
    })
  });
}
