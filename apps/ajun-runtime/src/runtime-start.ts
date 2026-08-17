import type { Server } from 'node:http';
import { createRuntime as defaultCreateRuntime } from './runtime-composition-root.ts';

type Startable = Readonly<{ start(input?: unknown): unknown }>;
type RuntimeLogger = Pick<Console, 'log' | 'warn'>;
type RuntimeServices = Readonly<Record<string, unknown>> & Readonly<{
  interruptedLocalExecutionReconciler?: Startable;
  deliveryQualityReconciler?: Startable;
  reconciliationCoordinator?: Startable;
  boomMonitor?: Startable;
  hermesNativeCompletionWatcher?: Startable;
  officialFeishuChannelRunner?: Startable;
  agentFeishuChannelFleet?: Startable;
}>;

type RuntimeTarget = Readonly<{
  server: Server;
  port: number;
  host: string;
  lanEnabled: boolean;
  deploymentMode: string;
  feishuChannelStartup?: Readonly<{
    startLegacyAJun?: boolean;
    skipAgentIds?: readonly string[];
  }>;
  logger: RuntimeLogger;
  services?: RuntimeServices;
}> & Readonly<Record<string, unknown>>;

export type StartRuntimeInput = Readonly<{
  createRuntime?: (input: Readonly<Record<string, unknown>>) => Promise<RuntimeTarget>;
  startBackgroundServices?: boolean;
}> & Readonly<Record<string, unknown>>;

export async function startRuntime({
  createRuntime = defaultCreateRuntime,
  startBackgroundServices = true,
  ...compositionOptions
}: StartRuntimeInput = {}) {
  const runtime = await createRuntime(compositionOptions);
  await listen(runtime.server, runtime.port, runtime.host);
  const address = runtime.server.address();
  const port = typeof address === 'object' && address ? address.port : runtime.port;
  runtime.logger.log(
    `A君运行台：http://${runtime.host === '0.0.0.0' ? '127.0.0.1' : runtime.host}:${port}`
      + `${runtime.lanEnabled ? '（局域网共享已开启）' : ''}`,
  );
  if (startBackgroundServices) startRuntimeBackgroundServices(runtime);
  return Object.freeze({ ...runtime, port });
}

export function startRuntimeBackgroundServices(runtime: RuntimeTarget) {
  const services = runtime.services || {};
  services.interruptedLocalExecutionReconciler?.start();
  services.deliveryQualityReconciler?.start();
  services.reconciliationCoordinator?.start();
  services.boomMonitor?.start();
  // Keep the shared HTTP/MCP completion watcher alive. Dynamic Commander cards
  // are never registered in this watcher, while callers without a confirmed
  // card anchor still depend on it for the terminal notification fallback.
  startWithoutBlocking(services.hermesNativeCompletionWatcher, null, runtime.logger);
  if (runtime.feishuChannelStartup?.startLegacyAJun) {
    startWithoutBlocking(
      services.officialFeishuChannelRunner,
      '官方飞书入口没有启用',
      runtime.logger,
    );
  }
  startWithoutBlocking(
    services.agentFeishuChannelFleet,
    '员工飞书智能体应用没有启用',
    runtime.logger,
    { skipAgentIds:runtime.feishuChannelStartup?.skipAgentIds || [] },
  );
}

function listen(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function startWithoutBlocking(
  service: Startable | undefined,
  warning: string | null,
  logger: RuntimeLogger,
  input: unknown = undefined,
) {
  if (typeof service?.start !== 'function') return;
  void Promise.resolve(service.start(input)).catch((error: unknown) => {
    if (warning) logger.warn(`${warning}：${error instanceof Error ? error.message : '未知问题'}`);
  });
}
