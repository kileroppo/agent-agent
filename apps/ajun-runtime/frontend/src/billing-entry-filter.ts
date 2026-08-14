export const BILLING_PAGE_SIZE: any = 24;
export function filterBillingEntries(entries: any, { query = '', agentId = '', view = 'all' }: any = {}): any {
    const term: any = String(query).trim().toLocaleLowerCase('zh-CN');
    return (Array.isArray(entries) ? entries : []).filter((entry: any): any => {
        if (agentId && entry.agentId !== agentId)
            return false;
        if (view !== 'all' && entry.attribution?.status !== view)
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
        ].some((value: any): any => String(value || '').toLocaleLowerCase('zh-CN').includes(term));
    });
}
