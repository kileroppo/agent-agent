type ResearchAcceptance = Readonly<{
  enabled: boolean;
  requiredEvidenceTerms: string[];
  minimumRecommendations: number;
  error: string | null;
}>;

export function resolveResearchAcceptance(task: any): ResearchAcceptance {
  const context = task?.input?.context || {};
  const requiredForFreshness = context.validationPurpose === 'product_maturity_role_freshness';
  const contract = context.researchAcceptance;
  if (!requiredForFreshness && contract === undefined) {
    return { enabled:false, requiredEvidenceTerms:[], minimumRecommendations:0, error:null };
  }
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return {
      enabled:true,
      requiredEvidenceTerms:[],
      minimumRecommendations:0,
      error:'产品成熟度小R复验必须先声明 researchAcceptance，不允许仅凭一般“有结论、有来源”门禁记为成功。',
    };
  }
  const rawTerms = Array.isArray(contract.requiredEvidenceTerms) ? contract.requiredEvidenceTerms : [];
  const requiredEvidenceTerms = [...new Set<string>(rawTerms
    .map((term: unknown) => String(term || '').replace(/\s+/g, ' ').trim())
    .filter((term: string) => Boolean(term)))];
  const minimumRecommendations = Number(contract.minimumRecommendations || 0);
  if (
    requiredEvidenceTerms.length === 0
    || requiredEvidenceTerms.length > 8
    || requiredEvidenceTerms.some((term) => term.length > 80)
    || !Number.isInteger(minimumRecommendations)
    || minimumRecommendations < 0
    || minimumRecommendations > 8
  ) {
    return {
      enabled:true,
      requiredEvidenceTerms:[],
      minimumRecommendations:0,
      error:'researchAcceptance 必须声明 1-8 个必需证据词，每项最多 80 字，建议数上限为 8。',
    };
  }
  return { enabled:true, requiredEvidenceTerms, minimumRecommendations, error:null };
}

export function buildResearchDeliveryGate(acceptance: ResearchAcceptance, sources: any[], report: any) {
  const coveredEvidenceTerms = acceptance.requiredEvidenceTerms.filter((term) =>
    sources.some((source) => source.coveredEvidenceTerms?.some((covered: string) => covered.toLowerCase() === term.toLowerCase())),
  );
  const missingEvidenceTerms = acceptance.requiredEvidenceTerms.filter((term) => !coveredEvidenceTerms.includes(term));
  const recommendationCount = Array.isArray(report?.recommendations)
    ? report.recommendations.filter((item: unknown) => String(item || '').trim()).length
    : 0;
  const evidenceCoverageSatisfied = missingEvidenceTerms.length === 0;
  const recommendationCountMet = recommendationCount >= acceptance.minimumRecommendations;
  return Object.freeze({
    schemaVersion:'agent.army/research-delivery-gate/v1',
    requiredEvidenceTerms:acceptance.requiredEvidenceTerms,
    coveredEvidenceTerms,
    missingEvidenceTerms,
    evidenceCoverageSatisfied,
    minimumRecommendations:acceptance.minimumRecommendations,
    recommendationCount,
    recommendationCountMet,
    accepted:evidenceCoverageSatisfied && recommendationCountMet,
  });
}

export function researchEvidenceFragments(text: unknown, requiredTerms: string[]) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact || !requiredTerms.length) return [];
  const lower = compact.toLowerCase();
  return requiredTerms.flatMap((term) => {
    const index = lower.indexOf(term.toLowerCase());
    if (index < 0) return [];
    const start = Math.max(0, index - 120);
    const end = Math.min(compact.length, index + term.length + 220);
    return [compact.slice(start, end).trim()];
  }).filter((fragment, index, all) => all.indexOf(fragment) === index);
}

export function containsResearchTerm(text: unknown, term: unknown) {
  return String(text || '').toLowerCase().includes(String(term || '').toLowerCase());
}
