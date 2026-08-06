const DEFAULT_AJUN_URL = 'http://127.0.0.1:4321';
const DEFAULT_XIAOD_URL = 'http://127.0.0.1:4318';

export class LocalRuntimeProbe {
  constructor({ ajunUrl = DEFAULT_AJUN_URL, xiaodUrl = DEFAULT_XIAOD_URL, fetchImpl = fetch, timeoutMs = 2500 } = {}) {
    this.ajunUrl = loopbackBaseUrl(ajunUrl);
    this.xiaodUrl = loopbackBaseUrl(xiaodUrl);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async check() {
    const [ajun, xiaod] = await Promise.all([this.checkAjun(), this.checkXiaod()]);
    return [ajun, xiaod];
  }

  async checkAjun() {
    try {
      const response = await this.fetch(`${this.ajunUrl}/api/overview`, { signal: AbortSignal.timeout(this.timeoutMs) });
      const overview = await response.json().catch(() => null);
      if (!response.ok || !overview || !Array.isArray(overview.tasks)) throw new Error('A君运行台没有返回可用状态。');
      const focus = overview.taskFocus || {};
      const active = Number(focus.inProgress || 0);
      const paused = Number(focus.paused || 0);
      const waiting = Number(focus.waitingApproval || 0) + Number(focus.waitingTest || 0);
      const detail = `运行正常；${Number(overview.agents?.length || 0)} 名员工可用，${active} 项处理中${paused ? `，${paused} 项已暂停` : ''}${waiting ? `，${waiting} 项等待确认或测试` : ''}。`;
      return { id:'ajun-runtime', name:'A君运行台', status:'healthy', detail };
    } catch {
      return { id:'ajun-runtime', name:'A君运行台', status:'degraded', detail:'暂时无法读取运行状态；未尝试重置、登录或修改配置。' };
    }
  }

  async checkXiaod() {
    try {
      const response = await this.fetch(`${this.xiaodUrl}/api/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
      const health = await response.json().catch(() => null);
      if (!response.ok || health?.ok !== true) throw new Error('小D没有返回健康状态。');
      return { id:'xiaod', name:'小D素材处理', status:'healthy', detail:'本机服务正常；可接收公开素材任务。' };
    } catch {
      return { id:'xiaod', name:'小D素材处理', status:'degraded', detail:'暂时无法确认小D服务；已保留任务记录，不会自动发起外部动作。' };
    }
  }
}

function loopbackBaseUrl(value) {
  const parsed = new URL(String(value || ''));
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('本机巡检只允许读取本机服务。');
  return parsed.toString().replace(/\/$/, '');
}
