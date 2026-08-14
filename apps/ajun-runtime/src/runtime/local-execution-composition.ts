import path from 'node:path';
// @ts-expect-error -- transitional JS Module; removed with the access-connection batch.
import { AccessConnectionService } from '../access-connection-service.js';
// @ts-expect-error -- transitional JS Module; removed with the registry batch.
import { AgentRegistry } from '../agent-registry.js';
// @ts-expect-error -- transitional JS Adapter; removed with the Xiaod execution batch.
import { CloudXiaodExecutor } from '../cloud-xiaod-executor.js';
// @ts-expect-error -- transitional JS Adapter; removed with the local-AI client batch.
import { LocalAiCapabilityClient } from '../local-ai-capability-client.js';
import { ProposalAgentRegistry } from '../proposal-agent-registry.ts';
// @ts-expect-error -- transitional JS Adapter; removed with the Xiaod execution batch.
import { XiaodDelegate } from '../xiaod-delegate.js';
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
