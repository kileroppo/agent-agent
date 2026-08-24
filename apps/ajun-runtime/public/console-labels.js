const TASK_LABELS = {
    'army.intake': '先让 A君判断下一步',
    'army.route-task': '任务路由',
    'army.cross-agent-mission': 'A君：多人任务统筹',
    'media.transcribe-and-refine': '小D：转录并整理素材',
    'media.audio-separation': '小D：音频人声分离',
    'media.subtitle-generation': '小D：字幕生成',
    'media.video-render': '小D：视频渲染',
    'report.public-material': '小R：公开网页摘要',
    'research.github-search': '小R：公开 GitHub 检索',
    'research.intel-report': '小R：公开资料研究',
    'office.briefing-package': '小办：汇报包',
    'office.presentation-package': '小办：演示文稿',
    'office.knowledge-summary': '小办：知识归档',
    'content.video-benchmark-analysis': '小拆：视频内容拆解',
    'content.performance-review': '小拆：内容表现复盘',
    'content.audience-resonance': '小拆：受众共鸣分析',
    'content.hook-analysis': '小拆：前三秒爆点拆解',
    'content.platform-draft': '小创：平台内容草稿',
    'content.video-script-package': '小创：可拍视频脚本',
    'content.article-adaptation': '小创：多平台图文改写',
    'content.topic-expansion': '小创：选题发散',
    'content.visual-asset-generation': '小创：视觉素材生成',
    'operations.health-review': '运维官：本机健康检查',
    'operations.failure-recovery': '运维官：故障恢复',
    'operations.incident-response': '运维官：应急响应',
    'operations.technical-repair': '技术专家：技术排障',
    'operations.engineering-resolution': '技术专家：工程修复',
    'governance.approval-review': '审核官：范围与风险审查',
    'governance.architecture-review': '架构师：能力评估',
    'governance.architecture-experiment': '架构师：架构实验',
    'governance.agent-proposal': '创角官：员工提案',
    'governance.capability-design': '创角官：能力设计',
    'governance.change-impact': '审核官：影响分析',
    'governance.rollback-plan': '审核官：回滚方案',
    'wechat.chat.retrieval': '微信助理：聊天记录检索',
};
const STATUS_LABELS = {
    active: '可用', ready: '可用', local: '本机可用', waiting: '等待连接',
    blocked: '尚未配置', not_configured: '未接线', not_ready: '未就绪',
    pending_authorization: '待授权', verified: '已验证', connected: '已连接',
    external: 'Hermes 已接管', connecting: '连接中', disabled: '未启用',
    expiring: '即将到期', expired: '已到期', revoked: '已撤销', error: '需检查',
    unavailable: '暂不可用', partial: '部分完成', planned: '待准备', draft: '草案中',
    pending_approval: '等待审核', waiting_approval: '等待确认', waiting_worker: '等待 Mac',
    waiting_test: '待验证', queued: '等待开始', running: '处理中', pausing: '正在暂停',
    paused: '已暂停', succeeded: '已完成', failed: '未完成', needs_input: '等待补充',
    cancelled: '已关闭', rejected: '已拒绝', stopped: '已停止'
};
export function taskTypeLabel(type, agents = []) {
    const typeStr = String(type || '').trim();
    if (!typeStr)
        return '待分配工作';
    const mapped = TASK_LABELS[typeStr];
    const agent = Array.isArray(agents) ? agents.find((item) => item?.acceptedTaskTypes?.includes(typeStr)) : null;
    const suffix = agent?.status === 'draft' ? '（准备中）' : '';
    if (mapped)
        return `${mapped}${suffix}`;
    const fallback = agent?.name ? `${agent.name}：${typeStr}` : typeStr;
    return `${fallback}${suffix}`;
}
export function statusLabel(status) {
    return STATUS_LABELS[String(status || '')] || '状态待确认';
}
