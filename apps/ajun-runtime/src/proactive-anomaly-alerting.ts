export type AnomalySeverity = 'warning' | 'critical';

export type AnomalyIncident = {
  type: string;
  severity: AnomalySeverity;
  title: string;
  summary: string;
  signature: string;
  details?: Record<string, unknown>;
  suggestedAction?: string;
  timestamp: string;
};

export type AlertSender = {
  sendCard: (card: Record<string, unknown>) => Promise<{ success: boolean; messageId?: string }>;
};

export type ProactiveAnomalyAlertingOptions = {
  store?: any;
  alertSender?: AlertSender;
  cooldownMs?: number;
  failureSpikeThreshold?: number;
  failureSpikeWindowMs?: number;
  memoryRssThresholdBytes?: number;
  consoleBaseUrl?: string;
  now?: () => number;
};

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_FAILURE_SPIKE_THRESHOLD = 3;
const DEFAULT_FAILURE_SPIKE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MEMORY_RSS_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_CONSOLE_BASE_URL = 'http://127.0.0.1:4321';

export class ProactiveAnomalyAlerting {
  private store: any;
  private alertSender?: AlertSender;
  private cooldownMs: number;
  private failureSpikeThreshold: number;
  private failureSpikeWindowMs: number;
  private memoryRssThresholdBytes: number;
  private consoleBaseUrl: string;
  private now: () => number;
  private lastAlerts = new Map<string, number>();

  constructor(options: ProactiveAnomalyAlertingOptions = {}) {
    this.store = options.store;
    this.alertSender = options.alertSender;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.failureSpikeThreshold = options.failureSpikeThreshold ?? DEFAULT_FAILURE_SPIKE_THRESHOLD;
    this.failureSpikeWindowMs = options.failureSpikeWindowMs ?? DEFAULT_FAILURE_SPIKE_WINDOW_MS;
    this.memoryRssThresholdBytes = options.memoryRssThresholdBytes ?? DEFAULT_MEMORY_RSS_THRESHOLD_BYTES;
    this.consoleBaseUrl = options.consoleBaseUrl ?? DEFAULT_CONSOLE_BASE_URL;
    this.now = options.now ?? (() => Date.now());
  }

  isCoolingDown(signature: string, now = this.now()): boolean {
    const lastAt = this.lastAlerts.get(signature);
    if (!lastAt) return false;
    return now - lastAt < this.cooldownMs;
  }

  recordAlert(signature: string, now = this.now()) {
    this.lastAlerts.set(signature, now);
  }

  sanitizeText(text: string): string {
    return String(text || '')
      .replace(/(?:Bearer\s+[a-zA-Z0-9._-]+)/gi, 'Bearer ***')
      .replace(/(?:sk-[a-zA-Z0-9_-]{10,})/gi, 'sk-***')
      .replace(/(?:password|passwd|secret)=[^&\s]+/gi, '$1=***')
      .slice(0, 1000);
  }

  formatFeishuAlertCard(incident: AnomalyIncident): Record<string, unknown> {
    const color = incident.severity === 'critical' ? 'red' : 'orange';
    const tag = incident.severity === 'critical' ? '🔴 严重告警' : '🟡 预警通知';

    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: `${tag}：${incident.title}`,
        },
        template: color,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**异常概要**：${this.sanitizeText(incident.summary)}\n**发生时间**：${incident.timestamp}`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**特征标识**：\`${incident.signature}\``,
          },
        },
        ...(incident.suggestedAction ? [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**推荐下一步**：${incident.suggestedAction}`,
            },
          },
        ] : []),
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '🔍 打开运行台诊断',
              },
              type: 'primary',
              url: `${this.consoleBaseUrl}/diagnosis`,
            },
          ],
        },
      ],
    };
  }

  async checkAnomalies({
    now = this.now(),
    rssBytes = process.memoryUsage().rss,
    serviceStates = {},
  }: {
    now?: number;
    rssBytes?: number;
    serviceStates?: Record<string, string>;
  } = {}): Promise<AnomalyIncident[]> {
    const incidents: AnomalyIncident[] = [];

    // 1. 内存过高检查
    if (rssBytes > this.memoryRssThresholdBytes) {
      const mb = Math.round(rssBytes / (1024 * 1024));
      incidents.push({
        type: 'memory_rss_high',
        severity: 'warning',
        title: '进程内存持续偏高',
        summary: `A君运行时 RSS 内存已达 ${mb}MB，超过告警阈值 (${Math.round(this.memoryRssThresholdBytes / (1024 * 1024))}MB)。`,
        signature: 'mem_rss_exceeded',
        suggestedAction: '请检查是否存在未释放的临时文件或大对象泄漏。',
        timestamp: new Date(now).toISOString(),
      });
    }

    // 2. 服务离线检查
    for (const [key, status] of Object.entries(serviceStates)) {
      if (status === 'offline') {
        incidents.push({
          type: 'service_offline',
          severity: 'critical',
          title: `依赖服务 ${key} 处于离线状态`,
          summary: `本地关键依赖服务 [${key}] 多次健康探测失败且自愈未恢复。`,
          signature: `svc_offline_${key}`,
          suggestedAction: `检查 ${key} 进程状态与端口监听。`,
          timestamp: new Date(now).toISOString(),
        });
      }
    }

    // 3. 连续任务失败突刺检查
    if (this.store && typeof this.store.list === 'function') {
      const allTasks = await this.store.list();
      const recentFailures = allTasks.filter((t: any) => {
        if (t.status !== 'failed') return false;
        const failedAt = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
        return failedAt > 0 && now - failedAt <= this.failureSpikeWindowMs;
      });

      if (recentFailures.length >= this.failureSpikeThreshold) {
        incidents.push({
          type: 'task_failure_spike',
          severity: 'critical',
          title: '近期任务连续失败频发',
          summary: `在过去 ${Math.round(this.failureSpikeWindowMs / 60000)} 分钟内发生了 ${recentFailures.length} 起任务失败。`,
          signature: 'task_failure_spike',
          suggestedAction: '请登录运行台查看最新失败任务的错误分类与堆栈。',
          timestamp: new Date(now).toISOString(),
        });
      }
    }

    return incidents;
  }

  async evaluateAndAlert(options?: Parameters<ProactiveAnomalyAlerting['checkAnomalies']>[0]): Promise<{
    status: string;
    incidentsFound: number;
    alertsSent: number;
    alertsSuppressed: number;
  }> {
    const incidents = await this.checkAnomalies(options);
    let alertsSent = 0;
    let alertsSuppressed = 0;

    for (const incident of incidents) {
      if (this.isCoolingDown(incident.signature)) {
        alertsSuppressed += 1;
        continue;
      }

      if (this.alertSender) {
        try {
          const card = this.formatFeishuAlertCard(incident);
          const res = await this.alertSender.sendCard(card);
          if (res?.success) {
            this.recordAlert(incident.signature);
            alertsSent += 1;
          }
        } catch {
          // Failed to send alert card
        }
      } else {
        this.recordAlert(incident.signature);
        alertsSent += 1;
      }
    }

    return {
      status: 'reconciled',
      incidentsFound: incidents.length,
      alertsSent,
      alertsSuppressed,
    };
  }

  async reconcile(): Promise<{ status: string; incidentsFound: number; alertsSent: number }> {
    const res = await this.evaluateAndAlert();
    return {
      status: 'reconciled',
      incidentsFound: res.incidentsFound,
      alertsSent: res.alertsSent,
    };
  }
}
