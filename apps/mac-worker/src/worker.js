import { loadConfig } from './config.js';
import { AgentArmyCloudClient } from './agent-army-client.js';
import { MacWorker } from './mac-worker.js';
import { WorkerStateStore } from './state-store.js';
import { XiaodLocalClient } from './xiaod-client.js';

const config = loadConfig();
const worker = new MacWorker({
  cloud:new AgentArmyCloudClient({ baseUrl:config.cloudUrl, token:config.workerToken, timeoutMs:config.requestTimeoutMs }),
  xiaod:new XiaodLocalClient({ baseUrl:config.xiaodUrl, timeoutMs:config.requestTimeoutMs }),
  stateStore:new WorkerStateStore(config.stateFile),
  workerId:config.workerId
});

console.log(`Mac工作间已启动：${config.workerId}。仅通过出站加密连接领取受控本机任务。`);
while (true) {
  let delay = config.pollMs;
  try {
    const result = await worker.runOnce();
    delay = Math.max(1_000, Number(result.nextPollAfterMs || config.pollMs));
  } catch (error) {
    console.warn(`Mac工作间暂时无法继续：${safeMessage(error)}；稍后自动重试。`);
  }
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function safeMessage(error) {
  const message = String(error?.message || '未知问题');
  return /token|secret|authorization|cookie/i.test(message) ? '连接或授权校验失败' : message.slice(0, 300);
}
