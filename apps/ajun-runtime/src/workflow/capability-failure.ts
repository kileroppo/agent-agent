export type CapabilityFailureKind =
  | 'startup_failure'
  | 'timeout'
  | 'rate_limited'
  | 'authentication_failed'
  | 'permission_denied'
  | 'provider_unavailable'
  | 'invalid_output'
  | 'quality_failed'
  | 'budget_exceeded'
  | 'ambiguous_result'
  | 'policy_denied';

export type CapabilityFailure = Readonly<{
  code: string;
  kind: CapabilityFailureKind;
  outcome: 'confirmed_failure' | 'ambiguous';
  recoverCurrentRoute: boolean;
  allowFallback: boolean;
}>;

/** Normalize provider-specific errors without leaking their raw messages. */
export function classifyCapabilityFailure(error: unknown): CapabilityFailure {
  const code = clean((error as { code?: unknown })?.code) || 'capability_execution_failed';
  const declaredKind = clean((error as { failureKind?: unknown })?.failureKind) as CapabilityFailureKind;
  const kind = FAILURE_KINDS.has(declaredKind) ? declaredKind : inferKind(code, error);
  const ambiguous = kind === 'ambiguous_result' || (error as { ambiguous?: unknown })?.ambiguous === true;
  const retryable = (error as { retryable?: unknown })?.retryable === true;
  const recoverCurrentRoute = !ambiguous && (
    retryable
    || ['startup_failure', 'timeout', 'provider_unavailable'].includes(kind)
    || LEGACY_RECOVERABLE_CODES.has(code)
  );
  return Object.freeze({
    code,
    kind,
    outcome:ambiguous ? 'ambiguous' : 'confirmed_failure',
    recoverCurrentRoute,
    allowFallback:!ambiguous && ![
      'authentication_failed',
      'permission_denied',
      'budget_exceeded',
      'policy_denied',
    ].includes(kind),
  });
}

const FAILURE_KINDS = new Set<CapabilityFailureKind>([
  'startup_failure', 'timeout', 'rate_limited', 'authentication_failed',
  'permission_denied', 'provider_unavailable', 'invalid_output', 'quality_failed',
  'budget_exceeded', 'ambiguous_result', 'policy_denied',
]);

const LEGACY_RECOVERABLE_CODES = new Set([
  'local_ai_control_unavailable', 'local_ai_gateway_unavailable', 'local_ai_failed',
  'local_model_failed', 'local_model_timeout', 'service_disabled',
  'service_start_timeout', 'qwen_server_unavailable',
]);

function inferKind(code: string, error: unknown): CapabilityFailureKind {
  if ((error as { ambiguous?: unknown })?.ambiguous === true || /ambiguous|unknown_result|status_unknown/.test(code)) return 'ambiguous_result';
  if (/auth|credential|token/.test(code)) return 'authentication_failed';
  if (/permission|forbidden/.test(code)) return 'permission_denied';
  if (/budget|cost_limit/.test(code)) return 'budget_exceeded';
  if (/policy|denied/.test(code)) return 'policy_denied';
  if (/invalid_source|source_not_public|scope_denied/.test(code)) return 'policy_denied';
  if (/rate|quota|throttl/.test(code)) return 'rate_limited';
  if (/timeout|timed_out/.test(code)) return 'timeout';
  if (/start|disabled/.test(code)) return 'startup_failure';
  if (/invalid|schema|format/.test(code)) return 'invalid_output';
  if (/quality/.test(code)) return 'quality_failed';
  return 'provider_unavailable';
}

function clean(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
