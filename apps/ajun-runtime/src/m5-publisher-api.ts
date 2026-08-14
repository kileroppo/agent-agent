export async function routeM5PublisherApi({ method, url, local, getService, readBody = async (): Promise<any> => ({}), paperclipApiKey = '', }: any = {}): Promise<any> {
    if (method === 'POST' && url === '/api/tool-executions') {
        if (!local)
            return { status: 403, payload: { error: '岗位工具调用只能由本机受控执行面发起。' } };
        if (!String(paperclipApiKey || '').trim()) {
            return { status: 401, payload: { error: '岗位工具调用需要当前 Paperclip Run 的短期身份凭证。' } };
        }
        const service: any = await getService();
        return {
            status: 200,
            payload: {
                execution: await service.executeTool(await readBody(), {
                    requireRunAuthentication: true,
                    paperclipApiKey: String(paperclipApiKey).trim(),
                }),
            },
        };
    }
    const receiptMatch: any = String(url || '').match(/^\/api\/publish-receipts\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
    if (method === 'GET' && receiptMatch) {
        if (!local)
            return { status: 403, payload: { error: '发布凭证只允许本机负责人读取。' } };
        const service: any = await getService();
        return {
            status: 200,
            payload: { receipt: await service.getPublishReceipt(receiptMatch[1]) },
        };
    }
    return null;
}
