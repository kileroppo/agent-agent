import type { ServerResponse } from 'node:http';

export interface SseClient {
  id: string;
  response: ServerResponse;
  taskId?: string;
  heartbeatTimer: NodeJS.Timeout;
}

export class RuntimeSseHub {
  private clients = new Map<string, SseClient>();
  private nextClientId = 1;

  addClient(
    response: ServerResponse,
    { taskId, heartbeatIntervalMs = 15000 }: { taskId?: string; heartbeatIntervalMs?: number } = {},
  ): SseClient {
    const id = `sse-client-${this.nextClientId++}`;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(`: connected client=${id}\n\n`);

    const heartbeatTimer = setInterval(() => {
      try {
        response.write(`: heartbeat ts=${Date.now()}\n\n`);
      } catch {
        this.removeClient(id);
      }
    }, heartbeatIntervalMs);

    const client: SseClient = { id, response, taskId, heartbeatTimer };
    this.clients.set(id, client);

    response.on('close', () => {
      this.removeClient(id);
    });
    response.on('error', () => {
      this.removeClient(id);
    });

    return client;
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    clearInterval(client.heartbeatTimer);
    this.clients.delete(id);
    try {
      client.response.end();
    } catch {
      // ignore
    }
  }

  broadcast(event: string, data: unknown, targetTaskId?: string): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, client] of this.clients.entries()) {
      if (targetTaskId && client.taskId && client.taskId !== targetTaskId) {
        continue;
      }
      try {
        client.response.write(payload);
      } catch {
        this.removeClient(id);
      }
    }
  }

  broadcastTaskUpdate(taskId: string, patch: Record<string, unknown>): void {
    this.broadcast('task_update', { taskId, patch, timestamp: Date.now() }, taskId);
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const id of this.clients.keys()) {
      this.removeClient(id);
    }
  }
}

export const defaultRuntimeSseHub = new RuntimeSseHub();
