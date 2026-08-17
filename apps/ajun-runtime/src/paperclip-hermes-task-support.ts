export function validDate(value: any): any {
  const text = String(value || '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

export function mergeArtifactRefs(existing: any[] = [], added: any[] = []): any[] {
  const merged = new Map();
  for (const artifact of [...existing, ...added]) {
    const key = artifact?.artifactId
      || `${artifact?.type || 'unknown'}:${artifact?.checksum || artifact?.location || merged.size}`;
    merged.set(key, artifact);
  }
  return [...merged.values()];
}

export function hasReadableArtifact(task: any): boolean {
  return (task.artifactRefs || []).some((artifact: any) => artifact?.validation?.exists === true
    && artifact.validation.readable === true
    && artifact.validation.nonEmpty === true);
}

export function expectedAnalysisIntent(input: any = {}): any {
  const structured = String(input?.analysisIntent || '').trim().toLowerCase();
  if (['digest', 'deep', 'template', 'style'].includes(structured)) return structured;
  return input?.depth === 'full' ? 'deep' : 'digest';
}

export function validLocalEvidenceReport(artifact: any, expectedIntent: any, evidenceMode: any): boolean {
  const validation = artifact?.validation || {};
  const data = artifact?.data || {};
  return artifact?.type === 'video_content_analysis_report'
    && validation.exists === true
    && validation.readable === true
    && validation.nonEmpty === true
    && validation.modeStructurePassed === true
    && validation.claimsEvidenceLinked === true
    && (evidenceMode !== 'formal' || validation.formalSourceConfirmed === true)
    && validation.analysisIntent === expectedIntent
    && validation.reportVersion === 'video-analysis/v2'
    && data.analysisIntent === expectedIntent
    && data.reportVersion === 'video-analysis/v2'
    && data.generationMode === 'deterministic_fallback'
    && Boolean(data.sourceTranscriptArtifactId)
    && Array.isArray(artifact.sourceRefs)
    && artifact.sourceRefs.includes(data.sourceTranscriptArtifactId);
}

export function taskFailure(code: any, userMessage: any, now: any, { category = 'manual', retryable = false }: any = {}): any {
  return {
    code,
    message:userMessage,
    userMessage,
    category,
    stage:'paperclip_hermes',
    retryable,
    occurredAt:new Date(now).toISOString(),
  };
}
