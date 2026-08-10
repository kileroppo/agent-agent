type DigestEvidence = Readonly<{
  timestamp: string | null;
  fragment: string;
}>;

type DigestCandidate = Readonly<{
  timestamp: string | null;
  fragment: string;
}>;

type DigestRecoveryAudit = Readonly<{
  attempted: true;
  applied: boolean;
  attemptCount: 1;
  providerInvoked: false;
  method: 'deterministic_plain_text_digest_rebuild';
  sourceGenerationMode: string;
  reason: 'content_analysis_mode_structure_validation_failed';
  validationPassed: boolean;
}>;

export type DigestStructureRecovery = Readonly<{
  report: Record<string, unknown>;
  generationMode: string;
  audit: DigestRecoveryAudit;
}>;

export type ModeStructureOutcome = Readonly<{
  report: Record<string, unknown>;
  dataFields: Readonly<Record<string, unknown>>;
  validationFields: Readonly<Record<string, unknown>>;
}>;

export function evaluateModeStructureWithDigestRecovery({
  report,
  transcript,
  analysisIntent,
  advisorApplied,
  semanticRepairApplied,
  validate,
  measureDigest,
}: {
  report: Record<string, unknown>;
  transcript: string;
  analysisIntent: string;
  advisorApplied: boolean;
  semanticRepairApplied: boolean;
  validate: (candidate: Record<string, unknown>) => boolean;
  measureDigest: (digest: unknown) => number;
}): ModeStructureOutcome {
  const sourceGenerationMode = advisorApplied
    ? semanticRepairApplied ? 'hermes_advisor_evidence_repaired' : 'hermes_advisor'
    : 'deterministic_fallback';
  const modeStructurePassedBeforeRepair = validate(report);
  const recovery = analysisIntent === 'digest' && !modeStructurePassedBeforeRepair
    ? attemptDeterministicDigestStructureRecovery({ report, transcript, sourceGenerationMode, validate })
    : null;
  const recoveredReport = recovery?.audit.applied ? recovery.report : report;
  const modeStructurePassed = validate(recoveredReport);
  const generationMode = recovery?.generationMode || sourceGenerationMode;
  const qualityFailure = modeStructurePassedBeforeRepair
    ? null
    : 'content_analysis_mode_structure_validation_failed';
  const digestCharacterCount = analysisIntent === 'digest'
    ? measureDigest(recoveredReport.digest)
    : null;
  return Object.freeze({
    report:recoveredReport,
    dataFields:Object.freeze({
      generationMode,
      ...(generationMode !== sourceGenerationMode ? { sourceGenerationMode } : {}),
      qualityFailure,
      ...(recovery ? { modeStructureRepair:recovery.audit } : {}),
    }),
    validationFields:Object.freeze({
      modeStructurePassedBeforeRepair,
      modeStructureRepairAttempted:Boolean(recovery?.audit.attempted),
      modeStructureRepairApplied:Boolean(recovery?.audit.applied),
      modeStructurePassed,
      ...(digestCharacterCount == null ? {} : {
        digestCharacterCount,
        digestWithinCharacterLimit:digestCharacterCount <= 800,
      }),
    }),
  });
}

export function attemptDeterministicDigestStructureRecovery({
  report,
  transcript,
  sourceGenerationMode,
  validate,
}: {
  report: Record<string, unknown>;
  transcript: string;
  sourceGenerationMode: string;
  validate: (candidate: Record<string, unknown>) => boolean;
}): DigestStructureRecovery {
  const reason = 'content_analysis_mode_structure_validation_failed' as const;
  const candidates = extractLiteralEvidence(transcript);
  const selected = coverageCandidates(candidates, 3);
  const candidateReport = selected.length === 3
    ? buildCandidateReport(report, selected)
    : report;
  const validationPassed = candidateReport !== report && validate(candidateReport);
  const applied = validationPassed;
  return Object.freeze({
    report:applied ? candidateReport : report,
    generationMode:applied
      ? repairedGenerationMode(sourceGenerationMode)
      : sourceGenerationMode,
    audit:Object.freeze({
      attempted:true,
      applied,
      attemptCount:1,
      providerInvoked:false,
      method:'deterministic_plain_text_digest_rebuild',
      sourceGenerationMode:safeText(sourceGenerationMode, 120) || 'unknown',
      reason,
      validationPassed,
    }),
  });
}

function buildCandidateReport(
  report: Record<string, unknown>,
  selected: readonly DigestCandidate[],
): Record<string, unknown> {
  const existingDigest = isRecord(report.digest) ? report.digest : {};
  const evidenceStatus = safeText(existingDigest.evidenceStatus, 80) || 'confirmed_transcript';
  const status = safeText(existingDigest.status, 40) || 'formal';
  const actionItems = normalizeActionItems(existingDigest.actionItems);
  const excerpts = selected.map((item) => ({
    timestamp:item.timestamp,
    fragment:safeText(item.fragment, 100),
  })).filter((item) => item.fragment.length >= 4);
  if (excerpts.length !== 3) return report;
  return {
    ...report,
    digest:{
      ...existingDigest,
      status,
      oneSentenceSummary:safeText(excerpts.map((item) => item.fragment).join('；'), 120),
      corePoints:excerpts.map((item) => ({
        point:safeText(item.fragment, 80),
        evidence:evidenceFor(item),
      })),
      goldenQuotes:excerpts.map((item) => ({
        quote:item.fragment,
        evidence:evidenceFor(item),
      })),
      actionItems,
      evidenceStatus,
    },
  };
}

function extractLiteralEvidence(transcript: string): DigestCandidate[] {
  const source = String(transcript || '');
  const timed = [...source.matchAll(/^\[((?:\d{2}:)?\d{2}:\d{2})\][ \t]*(.+)$/gmu)]
    .map((match) => literalCandidate(source, match[1] || null, match[2]));
  const usableTimed = uniqueCandidates(timed.filter(isDigestCandidate));
  if (usableTimed.length >= 3) return usableTimed;
  const untimed = source
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split(/\r?\n/u)
    .filter((line) => !/^\[((?:\d{2}:)?\d{2}:\d{2})\]/u.test(line))
    .map((line) => line.replace(/^\[时间点缺失\][ \t]*/u, ''))
    .filter((line) => line && !/^\s*#/u.test(line))
    .map((line) => literalCandidate(source, null, line));
  return uniqueCandidates([...usableTimed, ...untimed.filter(isDigestCandidate)]);
}

function literalCandidate(source: string, timestamp: string | null, value: unknown): DigestCandidate | null {
  const fragment = safeText(value, 100);
  if (fragment.length < 4 || !source.includes(fragment)) return null;
  return Object.freeze({ timestamp, fragment });
}

function uniqueCandidates(values: readonly DigestCandidate[]): DigestCandidate[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.timestamp || ''}\u0000${item.fragment}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function coverageCandidates(values: readonly DigestCandidate[], maximum: number): DigestCandidate[] {
  if (values.length < maximum) return [];
  if (values.length === maximum) return [...values];
  const indexes = Array.from(
    { length:maximum },
    (_, index) => Math.round(index * (values.length - 1) / (maximum - 1)),
  );
  return [...new Set(indexes)].map((index) => values[index]).filter(isDigestCandidate);
}

function normalizeActionItems(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.map((item) => safeText(item, 60)).filter(Boolean).slice(0, 3)
    : [];
  return items.length ? items : ['继续深度拆解前，先逐条核对以上确认稿证据。'];
}

function evidenceFor(item: DigestCandidate): DigestEvidence {
  return Object.freeze({ timestamp:item.timestamp, fragment:item.fragment });
}

function repairedGenerationMode(sourceGenerationMode: string): string {
  if (sourceGenerationMode === 'hermes_advisor') {
    return 'hermes_advisor_with_deterministic_digest_repair';
  }
  if (sourceGenerationMode === 'hermes_advisor_evidence_repaired') {
    return 'hermes_advisor_evidence_repaired_with_deterministic_digest_repair';
  }
  return 'deterministic_digest_structure_repair';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isDigestCandidate(value: DigestCandidate | null | undefined): value is DigestCandidate {
  return Boolean(value);
}

function safeText(value: unknown, maximum: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}
