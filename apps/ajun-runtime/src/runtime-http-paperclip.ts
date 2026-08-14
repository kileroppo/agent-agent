import { M5LearningLifecycleError, PaperclipLearningLifecycleError } from './paperclip-learning-lifecycle.ts';
import { PaperclipHeartbeatError } from './paperclip-heartbeat.ts';
import { PaperclipMetricMonitorError } from './paperclip-metric-monitor.ts';
import { PaperclipPublisherControllerError } from './paperclip-publisher-controller.ts';
import { PaperclipPublisherRunContextError } from './paperclip-publisher-run-context.ts';
import { PaperclipRetrospectiveError } from './paperclip-retrospective.ts';
import type { HttpRouteResult, JsonRecord, PaperclipHttpInput } from './runtime-http-paperclip-contracts.ts';
export type { HttpRouteResult } from './runtime-http-paperclip-contracts.ts';

const PAPERCLIP_HTTP_ERRORS = [
  PaperclipHeartbeatError,
  PaperclipMetricMonitorError,
  PaperclipPublisherControllerError,
  PaperclipPublisherRunContextError,
  PaperclipRetrospectiveError,
  PaperclipLearningLifecycleError,
  M5LearningLifecycleError,
];

export async function routePaperclipHttp({ request, paperclip, local, readBody }: PaperclipHttpInput): Promise<HttpRouteResult> {
  if (request.method !== 'POST') return null;

  const localOnlyError = localOnlyErrorFor(request.url);
  if (!localOnlyError) return null;
  if (!local) return { status:403, payload:{ error:localOnlyError } };

  const {
    paperclipHeartbeat,
    paperclipCampaignDaily,
    paperclipParallelWork,
    paperclipMetricRunContext,
    paperclipMetricMonitor,
    paperclipCurrentRunScope,
    paperclipPublisherRunContext,
    paperclipPublisherController,
    paperclipRetrospective,
    paperclipLearningLifecycle,
    canonicalPaperclipHeartbeat,
  } = paperclip;

  if (request.url === '/api/paperclip/heartbeat') {
    return accepted(await paperclipHeartbeat.handle(await readBody()));
  }
  if (request.url === '/api/paperclip/m5-daily-heartbeat') {
    return accepted(await paperclipCampaignDaily.handle(await readBody()));
  }
  if (request.url === '/api/paperclip/m5-parallel-heartbeat') {
    return accepted(await paperclipParallelWork.handle(await readBody()));
  }
  if (request.url === '/api/paperclip/m5-metrics-heartbeat') {
    const heartbeat = await readBody();
    const runJwt = bearerToken(request.headers.authorization);
    const canonical = await paperclipMetricRunContext.resolve({ heartbeat, bearerToken:runJwt });
    const context = isJsonRecord(heartbeat.context) ? heartbeat.context : {};
    const approvalId = String(context.approvalId || '').trim();
    return accepted(await paperclipCurrentRunScope.run({
      apiKey:runJwt,
      runId:canonical.runId,
      issueId:canonical.issueId,
      agentId:canonical.agentId,
      companyId:canonical.companyId,
      ...(approvalId ? { approvalId } : {}),
    }, () => paperclipMetricMonitor.handle(canonicalPaperclipHeartbeat(heartbeat, canonical))));
  }
  if (request.url === '/api/paperclip/m5-publisher-heartbeat') {
    const heartbeat = await readBody();
    const runJwt = bearerToken(request.headers.authorization);
    const canonical = await paperclipPublisherRunContext.resolve({ heartbeat, bearerToken:runJwt });
    return accepted(await paperclipCurrentRunScope.run({
      apiKey:runJwt,
      runId:canonical.runId,
      issueId:canonical.issueId,
      agentId:canonical.agentId,
      companyId:canonical.companyId,
    }, () => paperclipPublisherController.handle(canonicalPaperclipHeartbeat(heartbeat, canonical))));
  }
  if (request.url === '/api/paperclip/m5-retrospective-heartbeat') {
    return accepted(await paperclipRetrospective.handle(await readBody()));
  }
  return accepted(await paperclipLearningLifecycle.handle(await readBody()));
}

export function isPaperclipHttpError(error: unknown): boolean {
  return PAPERCLIP_HTTP_ERRORS.some((ErrorType) => error instanceof ErrorType);
}

function accepted(payload: unknown): Exclude<HttpRouteResult, null> {
  return { status:202, payload };
}

function localOnlyErrorFor(url: string | undefined): string | null {
  const messages: Readonly<Record<string, string>> = {
    '/api/paperclip/heartbeat':'Paperclip heartbeat 只能由本机服务调用。',
    '/api/paperclip/m5-daily-heartbeat':'M5 每日 heartbeat 只能由本机 Paperclip 调用。',
    '/api/paperclip/m5-parallel-heartbeat':'M5 并行 heartbeat 只能由本机 Paperclip 调用。',
    '/api/paperclip/m5-metrics-heartbeat':'M5 指标 heartbeat 只能由本机 Paperclip 调用。',
    '/api/paperclip/m5-publisher-heartbeat':'M5 发布 heartbeat 只能由本机 Paperclip 调用。',
    '/api/paperclip/m5-retrospective-heartbeat':'M5 复盘 heartbeat 只能由本机 Paperclip 调用。',
    '/api/paperclip/m5-learning-heartbeat':'M5 学习 heartbeat 只能由本机 Paperclip 调用。',
  };
  return messages[String(url || '')] || null;
}

function bearerToken(value: string | undefined): string {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
