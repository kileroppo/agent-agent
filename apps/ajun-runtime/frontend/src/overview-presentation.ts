export function reliabilityPresentation(health: any, hrefFor: (category: string) => string): any {
  const status: any = healthStatus(health?.reliability, 'unknown');
  const core: any = healthStatus(health?.coreOnline, 'unknown');
  const coreNote: any = ({ online: '核心服务在线', degraded: '核心服务降级', offline: '核心服务离线', unknown: '核心服务待核对' } as Record<string, string>)[core] || '核心服务待核对';
  const presentation: any = ({
    healthy: { value: '观测通过', note: '近期稳定性观测正常；不代表业务交付已验收', icon: 'check', attention: false, href: '' },
    degraded: { value: '需要留意', note: '稳定性观测发现性能或可用性风险，查看运行记录', icon: 'alert', attention: true, href: hrefFor('unresolved_failures') },
    unavailable: { value: '暂不可读', note: '稳定性观测当前不可读取，不能据此判断系统正常', icon: 'alert', attention: true, href: '' },
    unknown: { value: '待核对', note: '尚无有效稳定性观测，不能把核心在线当作一切正常', icon: 'alert', attention: true, href: '' },
  } as Record<string, any>)[status] || { value: '待核对', note: '稳定性状态未知，不能据此判断系统正常', icon: 'alert', attention: true, href: '' };
  return { ...presentation, note: `${coreNote}；${presentation.note}` };
}

export function businessDebtPresentation(value: any, focus: any, hrefFor: (category: string) => string): any {
  const status: any = healthStatus(value, 'unknown');
  const reviewBacklog: any = safeCount(value?.reviewBacklog, focus.verificationBacklog);
  const verificationBacklog: any = safeCount(value?.verificationBacklog, focus.verificationBacklog);
  const unresolvedFailures: any = safeCount(value?.unresolvedFailures, focus.unresolvedFailures);
  const ownerActionable: any = safeCount(value?.ownerActionable, focus.ownerActionable);
  const outstanding: any = reviewBacklog + verificationBacklog + unresolvedFailures + ownerActionable;
  if (status === 'clear') return { value: '暂未发现', note: '当前读模型没有业务质量债；这不替代新的人工验收', icon: 'check', attention: false, href: hrefFor('needs_reverification') };
  if (status === 'needs_attention' || outstanding > 0) {
    const parts: any = [verificationBacklog ? `${verificationBacklog} 待复验` : '', unresolvedFailures ? `${unresolvedFailures} 仍失败` : '', reviewBacklog && reviewBacklog !== verificationBacklog ? `${reviewBacklog} 待审核` : ''].filter(Boolean);
    return { value: parts.join(' · ') || '需要处理', note: ownerActionable ? `${ownerActionable} 项还需要负责人决定` : '保留证据，不会静默重试或当作已交付', icon: 'alert', attention: true, href: unresolvedFailures ? hrefFor('unresolved_failures') : hrefFor('needs_reverification') };
  }
  return { value: '待核对', note: '质量债汇总暂缺，不能据此判断所有业务都已交付', icon: 'alert', attention: true, href: '' };
}

export function capabilityPresentation(item: any): any {
  const overall: any = String(item?.truth?.overall || '');
  if (overall === 'human_accepted') return { level: 'human_accepted', label: '已人工验收', note: '负责人已确认业务结果可用' };
  if (overall === 'verified') return { level: 'verified', label: '真实任务已验证', note: '已有真实任务证据，仍待人工验收' };
  if (['partial', 'live', 'configured', 'declared'].includes(overall) || item?.status === 'partial') return { level: 'partial', label: '部分完成', note: '当前有边界或缺口，不能当作已验收能力' };
  if (['planned', 'draft'].includes(overall) || ['planned', 'draft'].includes(item?.status)) return { level: 'planned', label: '待准备', note: '尚未进入可交付验证，暂不可用' };
  return { level: 'partial', label: '待核对', note: '能力证据尚不完整，不能当作可用承诺' };
}

export function countCapabilityTiers(items: any[]): any {
  return items.reduce((result: any, item: any): any => {
    const level: any = capabilityPresentation(item).level;
    result[level] = (result[level] || 0) + 1;
    return result;
  }, {});
}

export function capabilitySummaryText(tiers: any): string {
  return [tiers.human_accepted ? `${tiers.human_accepted} 项人工验收` : '', tiers.verified ? `${tiers.verified} 项真实验证待人工验收` : '', tiers.partial ? `${tiers.partial} 项受限` : '', tiers.planned ? `${tiers.planned} 项待准备` : ''].filter(Boolean).join(' · ') || '能力状态待核对';
}

export function managerFirstEmployees(manager: any, agents: any[]): any[] {
  const seen = new Set<string>();
  return [manager, ...(Array.isArray(agents) ? agents : [])].filter((employee: any): boolean => {
    const agentId = String(employee?.agentId || '').trim();
    if (!agentId || seen.has(agentId)) return false;
    seen.add(agentId);
    return true;
  });
}

export function isOwnerActionFocus(focus: any, current: any): boolean {
  const taskId = String(current?.taskId || '').trim();
  if (!taskId || !Array.isArray(focus?.actions)) return false;
  const workflowId = String(current?.workflowId || '').trim();
  return focus.actions.some((action: any): boolean => {
    if (String(action?.taskId || '').trim() !== taskId) return false;
    return !workflowId || String(action?.workflowId || '').trim() === workflowId;
  });
}

function safeCount(value: any, fallback: any = 0): any {
  return Number.isFinite(value) ? Math.max(0, value) : Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
}

function healthStatus(value: any, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value && typeof value.status === 'string') return value.status;
  return fallback;
}
