import { verifiableQualityEvidenceRefs } from './quality-review.ts';

export type DeliveryQualityReviewInput = Readonly<{
  status: 'passed' | 'revise' | 'blocked';
  failedCriteria: readonly string[];
  evidenceRefs: readonly string[];
  safeSummary: string | null;
}>;

type ValidationErrorConstructor = new (message: string) => Error;

export function deliveryQualityReviewInput(
  task: Record<string, any>,
  input: Record<string, any>,
  ValidationError: ValidationErrorConstructor = Error,
): DeliveryQualityReviewInput | null {
  if (task?.taskType !== 'governance.assurance-review') return null;
  const supplied = input?.qualityReview && typeof input.qualityReview === 'object'
    ? input.qualityReview
    : null;
  if (!supplied) throw new ValidationError('独立质量复核必须回报结构化 qualityReview，不能只写结论摘要。');
  const status = String(supplied.status || '').trim();
  if (!['passed', 'revise', 'blocked'].includes(status)) {
    throw new ValidationError('独立质量复核状态必须是 passed、revise 或 blocked。');
  }
  const failedCriteria = safeList(supplied.failedCriteria, 100);
  if (status === 'revise' && !failedCriteria.length) {
    throw new ValidationError('要求返工时必须列出可执行的 failedCriteria。');
  }
  const evidenceRefs = safeList(supplied.evidenceRefs, 240);
  const verifiedEvidenceRefs = verifiableQualityEvidenceRefs(
    evidenceRefs,
    task?.input?.context?.artifactRefs,
  );
  if (status === 'passed' && !verifiedEvidenceRefs.length) {
    throw new ValidationError('独立质量复核通过时必须提供绑定当前产物的 evidenceRefs。');
  }
  return Object.freeze({
    status:status as DeliveryQualityReviewInput['status'],
    failedCriteria:Object.freeze(failedCriteria),
    evidenceRefs:status === 'passed' ? verifiedEvidenceRefs : Object.freeze(evidenceRefs),
    safeSummary:String(supplied.safeSummary || '').replace(/\s+/g, ' ').trim().slice(0, 1000) || null,
  });
}

function safeList(value: unknown, limit: number): string[] {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().slice(0, limit)).filter(Boolean))].slice(0, 100);
}
