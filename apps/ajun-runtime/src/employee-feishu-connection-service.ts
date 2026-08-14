const LEGACY_DEDICATED_FEISHU_AGENT_IDS: any = new Set(['intel-researcher', 'office-assistant']);
function supportsDedicatedFeishu(agent: any): any {
    return agent?.status === 'active' && (LEGACY_DEDICATED_FEISHU_AGENT_IDS.has(agent?.agentId)
        || (agent?.interaction?.runtime === 'hermes-profile'
            && agent?.interaction?.directFeishu === 'required'));
}
export class EmployeeFeishuConnectionService {
    fleet: any;
    registry: any;
    store: any;
    constructor({ registry, store, fleet }: any = {}) {
        this.registry = registry;
        this.store = store;
        this.fleet = fleet;
    }
    async list(): Promise<any> {
        const [agents, apps] = await Promise.all([this.registry.list(), this.store.listApps()]);
        const states: any = this.fleet.snapshot();
        const results: any[] = [];
        for (const agent of agents.filter(supportsDedicatedFeishu)) {
            const app: any = apps.find((item: any): any => item.agentId === agent.agentId);
            const credentialed: any = app ? Boolean(await this.store.getSecret(agent.agentId)) : false;
            results.push({
                agentId: agent.agentId,
                name: agent.name,
                role: agent.role,
                model: modelReadiness(agent.independentRuntime),
                configured: Boolean(app && credentialed),
                channel: states[agent.agentId] || { status: 'not_configured', message: '尚未填写这名员工的飞书应用资料。' },
                requiredScopes: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'],
                requiredEvents: ['im.message.receive_v1']
            });
        }
        return results;
    }
    async connect(agentId: any, input: any): Promise<any> {
        const id: any = String(agentId || '').trim();
        const agent: any = (await this.registry.list()).find((item: any): any => item.agentId === id && supportsDedicatedFeishu(item));
        if (!agent)
            throw new EmployeeFeishuConnectionError('这名员工未声明独立飞书入口，不能从这里接线。');
        const appId: any = String(input?.appId || '').trim();
        const appSecret: any = String(input?.appSecret || '').trim();
        const allowedUserId: any = String(input?.allowedUserId || '').trim();
        if (!/^cli_[a-zA-Z0-9]{8,}$/.test(appId))
            throw new EmployeeFeishuConnectionError('飞书 App ID 格式不正确。');
        if (appSecret.length < 16 || appSecret.length > 512)
            throw new EmployeeFeishuConnectionError('飞书 App Secret 格式不正确。');
        if (!/^ou_[a-zA-Z0-9_-]{8,}$/.test(allowedUserId))
            throw new EmployeeFeishuConnectionError('允许人员必须填写自己的飞书 open_id。');
        const app: any = await this.store.upsertApp({
            agentId: id,
            appId,
            allowedUserIds: [allowedUserId],
            allowedGroupIds: []
        });
        await this.store.saveSecret(id, appSecret);
        const channel: any = await this.fleet.startApp(app);
        return {
            agentId: id,
            name: agent.name,
            configured: true,
            channel,
            secretStoredLocally: true,
            externalAppCreated: false
        };
    }
}
export class EmployeeFeishuConnectionError extends Error {
}
function modelReadiness(independentRuntime: any): any {
    const state: any = independentRuntime?.state;
    if (['ready', 'channel_pending', 'waiting_verification'].includes(state)) {
        return { status: 'verified', message: '模型调用已验证。' };
    }
    if (state === 'model_pending') {
        return { status: 'not_configured', message: '尚未选择这名员工使用的模型。' };
    }
    if (state === 'model_transport_pending') {
        return { status: 'pending_authorization', message: '独立身份已建立，模型授权和真实调用仍待完成。' };
    }
    return { status: 'not_ready', message: '独立身份尚未完成，暂不能验证模型调用。' };
}
