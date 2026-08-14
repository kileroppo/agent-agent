export function employeeRole(agent: any): any {
    const roles: Record<string, any> = {
        xiaod: '负责整理公开视频和音频',
        'public-reporter': '负责读取公开网页并写中文报告',
        'intel-researcher': '负责围绕主题综合公开资料并给行动建议',
        'office-assistant': '负责把材料和员工结果整理成办公汇报包',
        'video-content-analyst': '负责基于确认稿拆解视频内容和复盘表现',
        'content-creator': '负责根据正式分析生成可审核平台草稿',
        operator: '负责检查运行情况和恢复异常',
        reviewer: '负责把关需要你确认的事项',
        architect: '负责评估能力缺口和下一步',
        'technical-expert': '负责排查和修复技术问题',
        creator: '负责准备新员工草案',
    };
    return (roles as any)[agent.agentId] || agent.role || '负责已分配的工作';
}
export function employeeCapabilityTruth(agent: any): any {
    return (({
        human_accepted: '能力已人工验收',
        verified: '能力已有真实任务证据',
        live: '运行可达，业务能力待验证',
        configured: '已配置，运行与业务能力待验证',
        declared: '岗位已登记，能力尚未验证',
        not_declared: '能力尚未接入',
    }) as any)[agent?.capabilityTruth?.overall] || '能力状态待核对';
}
