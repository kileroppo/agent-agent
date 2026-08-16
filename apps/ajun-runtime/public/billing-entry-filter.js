export const BILLING_PAGE_SIZE = 24;
export function filterBillingEntries(entries, { query = '', agentId = '', view = 'all' } = {}) {
    const term = String(query).trim().toLocaleLowerCase('zh-CN');
    return (Array.isArray(entries) ? entries : []).filter((entry) => {
        if (agentId && entry.agentId !== agentId)
            return false;
        if (view === 'unknown_cost' && entry.cost?.status !== 'unknown')
            return false;
        if (!['all', 'unknown_cost'].includes(view) && entry.attribution?.status !== view)
            return false;
        if (!term)
            return true;
        return [
            entry.agentId,
            entry.provider,
            entry.model,
            entry.usageClass,
            entry.attribution?.taskRef,
            entry.attribution?.taskTitle,
        ].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(term));
    });
}
