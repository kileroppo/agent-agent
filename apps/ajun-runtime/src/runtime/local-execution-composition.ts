import path from 'node:path';
import { AccessConnectionService } from '../access-connection-service.ts';
import { AgentRegistry } from '../agent-registry.ts';
import { CloudXiaodExecutor } from '../cloud-xiaod-executor.ts';
import { LocalAiCapabilityClient } from '../local-ai-capability-client.ts';
import { ProposalAgentRegistry } from '../proposal-agent-registry.ts';
import { XiaodDelegate } from '../xiaod-delegate.ts';
import type { LocalExecutionCompositionInput } from './composition-contracts.ts';

type XiaodReconciler = Readonly<{ reconcile(): unknown }>;

export function createLocalExecutionComposition({ configuration, store }: LocalExecutionCompositionInput) {
  const registry = new ProposalAgentRegistry({
    baseRegistry:new AgentRegistry({ agentsDir:path.join(configuration.paths.root, 'agents') }),
    store,
  });
  let xiaodReconciler: XiaodReconciler | null = null;
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
    bindXiaodReconciler(reconciler: XiaodReconciler) {
      xiaodReconciler = reconciler;
    },
  });
}
