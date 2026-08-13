import { createRuntime as defaultCreateRuntime } from './runtime-composition-root.js';

export async function startRuntime({
  createRuntime = defaultCreateRuntime,
  startBackgroundServices = true,
  ...compositionOptions
} = {}) {
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

export function startRuntimeBackgroundServices(runtime) {
  const services = runtime.services || {};
  services.interruptedLocalExecutionReconciler?.start();
  services.deliveryQualityReconciler?.start();
  services.paperclipRosterReconciler?.start();
  services.approvalExpiryReconciler?.start();
  if (runtime.deploymentMode !== 'cloud') services.xiaodReconciler?.start();
  services.paperclipRepairReconciler?.start();
  services.paperclipHermesTaskReconciler?.start();
  services.missionReconciler?.start();
  services.boomMonitor?.start();
  // Keep the shared HTTP/MCP completion watcher alive. Dynamic Commander cards
  // are never registered in this watcher, while callers without a confirmed
  // card anchor still depend on it for the terminal notification fallback.
  startWithoutBlocking(services.hermesNativeCompletionWatcher, null, runtime.logger);
  services.technicalRepairWatchdog?.start();
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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
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

function startWithoutBlocking(service, warning, logger, input = undefined) {
  if (typeof service?.start !== 'function') return;
  void Promise.resolve(service.start(input)).catch((error) => {
    if (warning) logger.warn(`${warning}：${String(error?.message || '未知问题')}`);
  });
}
