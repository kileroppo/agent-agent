const TASK_LABELS: Record<string, string> = {
    'army.intake': '先让 A君判断下一步',
    'army.route-task': '任务路由',
    'army.cross-agent-mission': 'A君：多人任务统筹',
    'media.transcribe-and-refine': '小D：转录并整理素材',
    'report.public-material': '小R：公开网页摘要',
    'research.github-search': '小R：公开 GitHub 检索',
    'research.intel-report': '小R：公开资料研究',
    'office.briefing-package': '办公执行助理：汇报包',
    'office.presentation-package': '小办：演示文稿',
    'office.knowledge-summary': '小办：知识归档',
    'content.video-benchmark-analysis': '小拆：视频内容拆解',
    'content.performance-review': '小拆：内容表现复盘',
    'content.platform-draft': '小创：平台内容草稿',
    'content.video-script-package': '小创：可拍视频脚本',
    'operations.health-review': '运维官：本机健康检查',
    'governance.approval-review': '审核官：范围与风险审查',
    'governance.architecture-review': '架构师：能力评估'
};

const STATUS_LABELS: Record<string, string> = {
    active: '可用', ready: '可用', local: '本机可用', waiting: '等待连接',
    blocked: '尚未配置', not_configured: '未接线', not_ready: '未就绪',
    pending_authorization: '待授权', verified: '已验证', connected: '已连接',
    external: 'Hermes 已接管', connecting: '连接中', disabled: '未启用',
    expiring: '即将到期', expired: '已到期', revoked: '已撤销', error: '需检查',
    unavailable: '暂不可用', partial: '部分完成', planned: '待准备', draft: '草案中',
    pending_approval: '等待审核', waiting_approval: '等待确认', waiting_worker: '等待 Mac',
    waiting_test: '待测试', queued: '等待开始', running: '处理中', pausing: '正在暂停',
    paused: '已暂停', succeeded: '已完成', failed: '未完成', needs_input: '等待补充',
    cancelled: '已关闭', rejected: '已拒绝', stopped: '已停止'
};

export function taskTypeLabel(type: unknown, agents: any[] = []): string {
    const agent = agents.find((item: any) => item.acceptedTaskTypes.includes(type));
    const suffix = agent?.status === 'draft' ? '（准备中）' : '';
    return `${TASK_LABELS[String(type || '')] || agent?.name || '待分配工作'}${suffix}`;
}

export function statusLabel(status: unknown): string {
    return STATUS_LABELS[String(status || '')] || '状态待确认';
}
