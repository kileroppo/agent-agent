export type VisualAnalysisEvaluation = Readonly<{
  visualCoverage: Readonly<Record<string, unknown>>;
  visualAnalysisApplied: boolean;
}>;

export function evaluateVisualAnalysis({
  visualMode,
  visualEvidence,
  advisorApplied,
  visualFindings,
  depth,
  validateFindings,
}: {
  visualMode: 'off' | 'auto' | 'required';
  visualEvidence: any;
  advisorApplied: boolean;
  visualFindings: unknown;
  depth: string;
  validateFindings: (findings: unknown, evidence: unknown, thresholds: Readonly<{ minFindings: number; minCategories: number }>) => boolean;
}): VisualAnalysisEvaluation {
  const visualCoverage = visualEvidence
    ? Object.freeze({
        status:'available', mode:visualMode,
        selectedFrames:visualEvidence.frames.length,
        storyboardCount:visualEvidence.storyboards.length,
        firstFrameAt:visualEvidence.coverage?.firstFrameAt || null,
        lastFrameAt:visualEvidence.coverage?.lastFrameAt || null,
      })
    : Object.freeze({
        status:visualMode === 'off' ? 'disabled' : 'unavailable', mode:visualMode,
        selectedFrames:0, storyboardCount:0,
      });
  const visualAnalysisApplied = visualMode === 'off' || (advisorApplied && validateFindings(
    visualFindings,
    visualEvidence,
    { minFindings:depth === 'full' ? 5 : 3, minCategories:depth === 'full' ? 3 : 2 },
  ));
  return Object.freeze({ visualCoverage, visualAnalysisApplied });
}
