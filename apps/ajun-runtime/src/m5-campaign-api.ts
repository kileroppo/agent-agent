export async function routeM5CampaignApi({ method, url, local, readBody, getService, tasks, paperclipApiKey = '', }: any = {}): Promise<any> {
    if (method === 'POST' && url === '/api/mcp/m5-stage-execute') {
        if (!local)
            return forbidden('M5 专用阶段执行只能由本机受限 Hermes MCP 调用。');
        const input: Record<string, any> = { ...await readBody(), paperclipApiKey };
        const verified: any = await tasks.getPaperclipAssignment(input);
        let result: any;
        try {
            result = await (await getService()).executeHermesStage(verified);
        }
        catch (error: any) {
            if (error?.m5RouteExecution) {
                await tasks.recordM5StageExecutionFailure(verified.task.taskId, error.m5RouteExecution, error);
            }
            throw error;
        }
        const recorded: any = await tasks.recordM5StageExecution(verified.task.taskId, result);
        return response(200, {
            assignment: verified.assignment,
            result,
            artifact: recorded.artifact,
            duplicate: recorded.duplicate,
        });
    }
    if (url === '/api/content-campaigns' && method === 'GET') {
        if (!local)
            return forbidden('内容活动只允许本机负责人查看。');
        return response(200, { campaigns: await (await getService()).list() });
    }
    if (url === '/api/content-campaigns' && method === 'POST') {
        if (!local)
            return forbidden('内容活动草案只能由本机负责人创建。');
        return response(201, { campaign: await (await getService()).createDraft(await readBody()) });
    }
    const actionMatch: any = url?.match(/^\/api\/content-campaigns\/([0-9a-f-]{8,80})\/(approve|pause|resume|stop)$/i);
    if (method === 'POST' && actionMatch) {
        if (!local)
            return forbidden('内容活动授权和控制只能由本机负责人执行。');
        const [, campaignId, action] = actionMatch;
        const service: any = await getService();
        return response(200, {
            campaign: action === 'approve'
                ? await service.approve(campaignId, await readBody())
                : await service.control(campaignId, action, await readBody()),
        });
    }
    const detailMatch: any = url?.match(/^\/api\/content-campaigns\/([0-9a-f-]{8,80})$/i);
    if (method === 'GET' && detailMatch) {
        if (!local)
            return forbidden('内容活动只允许本机负责人查看。');
        return response(200, { campaign: await (await getService()).get(detailMatch[1]) });
    }
    return null;
}
function forbidden(message: any): any { return response(403, { error: message }); }
function response(status: any, payload: any): any { return { status, payload }; }
