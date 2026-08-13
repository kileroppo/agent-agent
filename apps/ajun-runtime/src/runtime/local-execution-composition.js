import path from 'node:path';
import { AccessConnectionService } from '../access-connection-service.js';
import { AgentRegistry } from '../agent-registry.js';
import { CloudXiaodExecutor } from '../cloud-xiaod-executor.js';
import { LocalAiCapabilityClient } from '../local-ai-capability-client.js';
import { ProposalAgentRegistry } from '../proposal-agent-registry.js';
import { XiaodDelegate } from '../xiaod-delegate.js';

export function createLocalExecutionComposition({ configuration, store } = {}) {
  const registry = new ProposalAgentRegistry({
    baseRegistry:new AgentRegistry({ agentsDir:path.join(configuration.paths.root, 'agents') }),
    store,
  });
  let xiaodReconciler = null;
  const localXiaod = new XiaodDelegate({
    onStarted:() => void xiaodReconciler?.reconcile(),
  });
  const xiaod = configuration.deployment.mode === 'cloud'
    ? new CloudXiaodExecutor()
    : localXiaod;

  return Object.freeze({
    registry,
    xiaod,
    localXiaod,
    localAi:new LocalAiCapabilityClient(),
    accessConnections:new AccessConnectionService(),
    bindXiaodReconciler(reconciler) {
      xiaodReconciler = reconciler;
    },
  });
}
