type RecoveryRequest = Readonly<{
  missionTaskId: string;
  taskId: string;
  idempotencyKey: string;
}>;

export const maturityQueuedChildRecoveryMethods = {
  async resumeVerifiedQueuedMissionChild(this: any, request: RecoveryRequest) {
    const missionTaskId = requiredIdentity(request?.missionTaskId, '总任务 ID');
    const taskId = requiredIdentity(request?.taskId, '子任务 ID');
    const idempotencyKey = requiredIdentity(request?.idempotencyKey, '子任务幂等键');
    if (!this.missionChildPolicy?.verifyMissionAuthorization
      || !this.missionChildPolicy?.verifyTaskAuthorization
      || !this.maturityExecutionGuard?.verifyOrBlock
      || !this.maturityExecutionGuard?.block) {
      throw new Error('产品成熟度排队任务恢复策略不可用，已停止执行。');
    }

    const records = await this.store.list();
    const mission = records.find((item: any) => item.taskId === missionTaskId);
    let task = records.find((item: any) => item.taskId === taskId);
    if (!mission || !task) throw new Error('产品成熟度排队任务或其总任务不存在，已停止恢复。');
    if (task.parentTaskId !== missionTaskId || task.idempotencyKey !== idempotencyKey) {
      throw new Error('产品成熟度排队任务身份或幂等键不一致，已停止恢复。');
    }

    let authorization: any;
    try {
      this.missionChildPolicy.verifyMissionAuthorization(mission);
      task = await migrateLegacyTechnicalSourcePollution.call(this, { mission, task, records });
      authorization = this.missionChildPolicy.verifyTaskAuthorization({ mission, task });
      if (idempotencyKey !== `${mission.idempotencyKey}:${authorization.stepKey}`) {
        throw new Error('产品成熟度排队任务签名步骤与幂等键不一致。');
      }
    } catch (error: any) {
      return blockInvalidQueuedMaturityChild.call(this, taskId, error);
    }

    // 并发 reconcile 中另一个调用可能已经领取或完成；只返回最新状态，不重复执行。
    if (task.status !== 'queued') return task;
    if (task.execution?.owner || task.execution?.executor || task.governance != null) {
      throw new Error('产品成熟度排队任务已绑定其他执行所有者或治理投影，已停止本地恢复。');
    }
    const guardAuthorization = await this.maturityExecutionGuard.verifyOrBlock(task);
    if (!guardAuthorization
      || guardAuthorization.batchId !== authorization.batchId
      || guardAuthorization.stepKey !== authorization.stepKey) {
      throw new Error('产品成熟度排队任务没有通过统一执行门禁，已停止恢复。');
    }

    const agent = typeof this.registry.get === 'function'
      ? await this.registry.get(authorization.agentId)
      : (await this.registry.list()).find((item: any) => item.agentId === authorization.agentId);
    if (!agent || agent.status !== 'active'
      || !agent.acceptedTaskTypes?.includes(authorization.taskType)) {
      throw new Error('产品成熟度排队任务的固定岗位不可用，已停止恢复。');
    }
    return this.executeTask(task, agent);
  },
};

async function migrateLegacyTechnicalSourcePollution(this: any, { mission, task, records }: any) {
  const context = task?.input?.context || {};
  const hasSourceTaskIds = Object.hasOwn(context, 'sourceTaskIds');
  if (task?.status !== 'queued'
    || task?.taskType !== 'operations.technical-repair'
    || !hasSourceTaskIds) return task;
  const actualSourceIds = exactStrings(context.sourceTaskIds);

  const plan = mission?.artifactRefs?.find((item: any) => item.type === 'cross_agent_mission_plan')?.data;
  if (!Array.isArray(plan?.subtasks) || plan.subtasks.length !== 3) return task;
  let signedPayload: any = null;
  for (const subtask of plan.subtasks) {
    const payload = this.missionChildPolicy.assertAuthorized({ mission, subtask });
    if (!signedPayload) signedPayload = payload;
    else if (payload?.batchId !== signedPayload?.batchId) return task;
  }
  const stepKey = String(task?.workflow?.step?.key || '');
  const technicalPlanItem = plan.subtasks.find((item: any) => item.key === stepKey);
  const expectedTechnical = signedPayload?.items?.find((item: any) => item.key === stepKey);
  if (!technicalPlanItem
    || expectedTechnical?.taskType !== 'operations.technical-repair'
    || expectedTechnical.agentId !== task.assigneeAgentId
    || exactStrings(expectedTechnical.sourceTaskIds).length !== 0
    || exactStrings(expectedTechnical.requiredSourceTaskIds).length !== 0) return task;

  const dependsOn = exactStrings(technicalPlanItem.dependsOn);
  if (dependsOn.length !== 1
    || !sameStrings(exactStrings(task.input?.context?.dependsOn), dependsOn)) return task;
  const creatorKey = dependsOn[0];
  const expectedCreator = signedPayload.items.find((item: any) => item.key === creatorKey);
  const creatorMatches = records.filter((item: any) => item.parentTaskId === mission.taskId
    && item.idempotencyKey === `${mission.idempotencyKey}:${creatorKey}`);
  if (expectedCreator?.taskType !== 'governance.agent-proposal'
    || creatorMatches.length !== 1) return task;
  const creator = creatorMatches[0];
  const creatorAuthorization = this.missionChildPolicy.verifyTaskAuthorization({ mission, task:creator });
  const dependencyTaskIds = exactStrings(task.input?.context?.dependencyTaskIds);
  if (!Array.isArray(context.sourceTaskIds)
    || context.sourceTaskIds.length !== 1
    || actualSourceIds.length !== 1) {
    throw new Error('产品成熟度技术任务来源污染不符合唯一旧迁移合同，已停止恢复。');
  }
  if (creator.status !== 'succeeded'
    || creatorAuthorization.stepKey !== creatorKey
    || creatorAuthorization.executionMode !== 'draft_only'
    || dependencyTaskIds.length !== 1
    || dependencyTaskIds[0] !== creator.taskId) return task;
  if (actualSourceIds[0] !== creator.taskId) {
    throw new Error('产品成熟度技术任务来源污染没有指向已验签的创建官依赖，已停止恢复。');
  }

  const expectedContext = task.input.context;
  const nextContext = { ...expectedContext };
  delete nextContext.sourceTaskIds;
  const sanitizedTask = { ...task, input:{ ...task.input, context:nextContext } };
  this.missionChildPolicy.verifyTaskAuthorization({ mission, task:sanitizedTask });
  if (typeof this.store.compareAndSwapQueuedTaskContext !== 'function') {
    throw new Error('产品成熟度旧来源污染缺少原子迁移能力，已停止恢复。');
  }
  await this.store.compareAndSwapQueuedTaskContext(task.taskId, {
    expectedContext,
    nextContext,
  });
  const refreshed = (await this.store.list()).find((item: any) => item.taskId === task.taskId);
  if (!refreshed) throw new Error('产品成熟度旧来源污染迁移后无法重读任务，已停止恢复。');
  return refreshed;
}

async function blockInvalidQueuedMaturityChild(this: any, taskId: string, error: any) {
  const latest = (await this.store.list()).find((item: any) => item.taskId === taskId);
  if (!latest) throw error;
  if (latest.status !== 'queued') return latest;
  try {
    await this.maturityExecutionGuard.block(latest, error?.message || '产品成熟度排队任务恢复验签失败。');
  } catch (blocked: any) {
    if (blocked?.blockedTask) return blocked.blockedTask;
    throw blocked;
  }
  throw error;
}

function requiredIdentity(value: unknown, label: string) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`产品成熟度排队任务缺少${label}，已停止恢复。`);
  return normalized;
}

function exactStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
