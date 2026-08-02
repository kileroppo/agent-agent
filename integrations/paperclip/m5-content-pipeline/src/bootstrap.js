import { buildBootstrapPlan } from './plan.js';
import { FakePaperclipAdapter } from './adapters/fake.js';

const APPLY_CONFIRMATION = 'APPLY_M5_TO_PAPERCLIP';

async function ensure(adapter, type, key, marker, payload) {
  const existing = await adapter.findByMarker(type, marker);
  if (existing) return { resource: existing, created: false };
  return { resource: await adapter.create(type, payload), created: true };
}

export async function dryRunBootstrap({
  definition,
  bindings = {},
  adapter = new FakePaperclipAdapter(),
  budgetCents = 625,
} = {}) {
  const result = await executeBootstrap({
    definition,
    bindings,
    adapter,
    budgetCents,
    mode: 'dry-run',
  });
  return { ...result, adapter };
}

export async function applyBootstrap({
  definition,
  bindings = {},
  adapter,
  budgetCents,
  confirmLiveWrite,
} = {}) {
  if (confirmLiveWrite !== APPLY_CONFIRMATION) {
    throw new Error(`live apply 被拒绝：必须显式传入 ${APPLY_CONFIRMATION}`);
  }
  if (!adapter || adapter instanceof FakePaperclipAdapter) {
    throw new Error('live apply 必须传入非 Fake 的 Paperclip adapter');
  }
  if (!Number.isInteger(budgetCents) || budgetCents <= 0) {
    throw new Error('live apply 必须显式提供正整数 budgetCents');
  }
  const unresolvedAgents = buildBootstrapPlan(definition, bindings).unresolved.agentKeys;
  if (unresolvedAgents.length > 0) {
    throw new Error(`live apply 缺少岗位 Agent UUID: ${unresolvedAgents.join(', ')}`);
  }
  const preflight = buildBootstrapPlan(definition, bindings);
  const unsafeScheduledVariables = preflight.resources.scheduleRoutine.payload.variables
    .filter((variable) => variable.required && variable.defaultValue == null);
  if (unsafeScheduledVariables.length > 0) {
    throw new Error(`live apply 拒绝创建无法调度的Routine变量: ${unsafeScheduledVariables.map((item) => item.name).join(', ')}`);
  }
  return executeBootstrap({ definition, bindings, adapter, budgetCents, mode: 'apply' });
}

async function executeBootstrap({ definition, bindings, adapter, budgetCents, mode }) {
  let plan = buildBootstrapPlan(definition, bindings);
  const operations = [];

  const dailyController = await adapter.ensureSystemAgent(plan.resources.dailyController.payload);
  operations.push({
    type:'agent',
    key:plan.resources.dailyController.key,
    created:dailyController.created,
    updated:dailyController.updated,
    id:dailyController.resource.id,
  });
  const controllerBindings = {
    ...bindings,
    dailyControllerAgentId:dailyController.resource.id,
  };
  const metricsController = await adapter.ensureSystemAgent(plan.resources.metricsController.payload);
  operations.push({
    type:'agent',
    key:plan.resources.metricsController.key,
    created:metricsController.created,
    updated:metricsController.updated,
    id:metricsController.resource.id,
  });
  controllerBindings.metricsControllerAgentId = metricsController.resource.id;
  const publisherController = await adapter.ensureSystemAgent(plan.resources.publisherController.payload);
  operations.push({
    type:'agent',
    key:plan.resources.publisherController.key,
    created:publisherController.created,
    updated:publisherController.updated,
    id:publisherController.resource.id,
  });
  controllerBindings.publisherControllerAgentId = publisherController.resource.id;
  const retrospectiveController = await adapter.ensureSystemAgent(
    plan.resources.retrospectiveController.payload,
  );
  operations.push({
    type:'agent',
    key:plan.resources.retrospectiveController.key,
    created:retrospectiveController.created,
    updated:retrospectiveController.updated,
    id:retrospectiveController.resource.id,
  });
  controllerBindings.retrospectiveControllerAgentId = retrospectiveController.resource.id;
  const learningController = await adapter.ensureSystemAgent(
    plan.resources.learningController.payload,
  );
  operations.push({
    type:'agent',
    key:plan.resources.learningController.key,
    created:learningController.created,
    updated:learningController.updated,
    id:learningController.resource.id,
  });
  controllerBindings.learningControllerAgentId = learningController.resource.id;
  const parallelController = await adapter.ensureSystemAgent(
    plan.resources.parallelController.payload,
  );
  operations.push({
    type:'agent',
    key:plan.resources.parallelController.key,
    created:parallelController.created,
    updated:parallelController.updated,
    id:parallelController.resource.id,
  });
  controllerBindings.parallelControllerAgentId = parallelController.resource.id;
  plan = buildBootstrapPlan(definition, controllerBindings);

  const goalResult = await ensure(
    adapter,
    'goal',
    plan.resources.goal.key,
    plan.resources.goal.marker,
    plan.resources.goal.payload,
  );
  operations.push({ type: 'goal', created: goalResult.created, id: goalResult.resource.id });

  plan = buildBootstrapPlan(definition, { ...controllerBindings, goalId: goalResult.resource.id });
  const projectResult = await ensure(
    adapter,
    'project',
    plan.resources.project.key,
    plan.resources.project.marker,
    plan.resources.project.payload,
  );
  operations.push({ type: 'project', created: projectResult.created, id: projectResult.resource.id });

  const resolved = {
    ...controllerBindings,
    goalId: goalResult.resource.id,
    projectId: projectResult.resource.id,
    routineIds: { ...(bindings.routineIds ?? {}) },
  };
  plan = buildBootstrapPlan(definition, resolved);

  for (const routine of [...plan.resources.routines, plan.resources.scheduleRoutine]) {
    const marker = routine.marker || `[agent-army:m5:routine:${routine.key}]`;
    const ensured = await ensure(adapter, 'routine', routine.key, marker, routine.payload);
    const reconciled = ensured.created
      ? { resource:ensured.resource, updated:false }
      : await adapter.reconcileRoutine(ensured.resource, routine.payload);
    resolved.routineIds[routine.key] = reconciled.resource.id;
    operations.push({
      type:'routine',
      key:routine.key,
      created:ensured.created,
      updated:reconciled.updated,
      id:reconciled.resource.id,
    });
    if (routine.key === 'm5-daily-campaign') {
      const trigger = await adapter.ensureRoutineTrigger(reconciled.resource, plan.resources.scheduleTrigger);
      operations.push({
        type: 'routine-trigger',
        created: trigger.created,
        id: trigger.resource.id,
        enabled: trigger.resource.enabled,
      });
    }
  }

  plan = buildBootstrapPlan(definition, resolved);
  const pipelineMarker = plan.resources.pipeline.payload.key;
  const pipelineResult = await ensure(
    adapter,
    'pipeline',
    plan.resources.pipeline.payload.key,
    pipelineMarker,
    plan.resources.pipeline.payload,
  );
  const reconciledPipeline = pipelineResult.created
    ? { resource:pipelineResult.resource, updated:false }
    : await adapter.reconcilePipeline(pipelineResult.resource, plan.resources.pipeline.payload);
  operations.push({
    type:'pipeline',
    created:pipelineResult.created,
    updated:reconciledPipeline.updated,
    id:reconciledPipeline.resource.id,
  });

  const transitions = plan.resources.pipeline.transitions;
  await adapter.setPipelineTransitions(reconciledPipeline.resource.id, transitions);
  operations.push({
    type:'pipeline-transitions',
    created:pipelineResult.created,
    reconciled:!pipelineResult.created,
    count:transitions.length,
  });

  const budgetPayload = {
    ...plan.resources.budget.payload,
    scopeId: projectResult.resource.id,
    amount: budgetCents,
  };
  const budget = await adapter.upsertBudget(budgetPayload);
  operations.push({ type: 'budget', created: true, id: budget.id, amount: budgetCents });

  return {
    mode,
    paperclipVersion: plan.sourcePaperclipVersion,
    operations,
    bindings: resolved,
    plan,
  };
}

export { APPLY_CONFIRMATION };
