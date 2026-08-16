import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ALLOWED_STATES = new Set([
  'idle', 'checking', 'ready', 'blocked', 'up_to_date', 'preparing_source', 'verifying',
  'freezing', 'activating', 'verifying_live', 'rolling_back', 'rolled_back', 'succeeded', 'failed',
]);

export class RuntimeReleaseClient {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor({
    socketPath = path.join(os.homedir(), '.agent-army', 'state', 'ajun-release-helper', 'release-helper.sock'),
    timeoutMs = 5_000,
  }: { socketPath?: string; timeoutMs?: number } = {}) {
    this.socketPath = path.resolve(socketPath);
    this.timeoutMs = Math.max(500, Number(timeoutMs) || 5_000);
  }

  async status() {
    const payload = await this.request('GET', '/status');
    return projectStatus(payload.status);
  }

  async action(action: 'check' | 'publish' | 'rollback', input: Record<string, unknown> = {}) {
    const payload = await this.request('POST', `/${action}`, input);
    return {
      accepted:payload.accepted === true,
      duplicate:payload.duplicate === true,
      status:projectStatus(payload.status),
    };
  }

  private request(method: string, route: string, body?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? '' : JSON.stringify(body);
      const request = http.request({
        socketPath:this.socketPath,
        method,
        path:route,
        headers:encoded ? { 'content-type':'application/json', 'content-length':Buffer.byteLength(encoded) } : {},
        timeout:this.timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let payload: any;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new RuntimeReleaseClientError(502, '发布助手返回了无效响应。'));
          }
          if (!response.statusCode || response.statusCode >= 400) {
            return reject(new RuntimeReleaseClientError(response.statusCode || 502, String(payload.error || '发布助手请求失败。')));
          }
          resolve(payload);
        });
      });
      request.once('timeout', () => request.destroy(new RuntimeReleaseClientError(504, '发布助手响应超时。')));
      request.once('error', (error: NodeJS.ErrnoException) => {
        reject(error instanceof RuntimeReleaseClientError
          ? error
          : new RuntimeReleaseClientError(503, error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? '发布助手尚未运行。' : '无法连接发布助手。'));
      });
      request.end(encoded);
    });
  }
}

export class RuntimeReleaseClientError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'RuntimeReleaseClientError';
    this.httpStatus = httpStatus;
  }
}

function projectStatus(value: any) {
  if (!value || value.schemaVersion !== 'agent.army/self-service-release-status/v1' || !ALLOWED_STATES.has(value.state)) {
    throw new RuntimeReleaseClientError(502, '发布助手状态不符合契约。');
  }
  return {
    schemaVersion:value.schemaVersion,
    runId:stringOrNull(value.runId),
    action:['check', 'publish', 'rollback'].includes(value.action) ? value.action : null,
    state:value.state,
    message:String(value.message || '').slice(0, 240),
    startedAt:stringOrNull(value.startedAt),
    updatedAt:stringOrNull(value.updatedAt),
    finishedAt:stringOrNull(value.finishedAt),
    current:projectRelease(value.current),
    candidate:value.candidate ? {
      gitHead:String(value.candidate.gitHead || ''),
      branch:String(value.candidate.branch || ''),
      clean:value.candidate.clean === true,
    } : null,
    rollback:projectRelease(value.rollback),
  };
}

function projectRelease(value: any) {
  return value ? {
    releaseHash:String(value.releaseHash || ''),
    payloadHash:value.payloadHash ? String(value.payloadHash) : null,
    gitHead:String(value.gitHead || ''),
  } : null;
}

function stringOrNull(value: unknown) {
  const normalized = String(value || '').trim();
  return normalized || null;
}
