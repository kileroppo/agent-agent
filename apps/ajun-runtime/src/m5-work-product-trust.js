const DEFAULT_STATUSES = Object.freeze([
  'active', 'approved', 'ready_for_review', 'changes_requested',
]);

export function trustedM5WorkProducts(outputs, {
  provider,
  schemaVersion,
  kind,
  type = null,
  statuses = DEFAULT_STATUSES,
} = {}) {
  return m5WorkProductItems(outputs).filter((item) => item?.kind === 'work_product'
    && (type == null || item?.type === type)
    && item?.provider === provider
    && item?.sourceTrust == null
    && statuses.includes(item?.status)
    && item?.healthStatus === 'healthy'
    && item?.metadata?.schemaVersion === schemaVersion
    && item?.metadata?.kind === kind);
}

export function uniqueTrustedM5WorkProduct(outputs, contract, {
  matches = () => true,
  duplicateError = () => new Error('存在多个可信 M5 Work Product。'),
} = {}) {
  const candidates = trustedM5WorkProducts(outputs, contract).filter(matches);
  if (candidates.length > 1) {
    throw duplicateError(candidates);
  }
  return candidates[0] || null;
}

export function isValidM5WorkProductDate(value) {
  return Number.isFinite(Date.parse(value));
}

export function m5WorkProductItems(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
