// @ts-expect-error legacy task definition registry has no declaration yet
import { DEFAULT_TASK_DEFINITION_REGISTRY, TaskDefinitionRegistry } from './task-definition-registry.js';

export class TaskCapabilityCatalog {
  registry: any;
  executors: Record<string, any>;

  constructor({ definitions, registry, executors = {} }: any = {}) {
    this.registry = registry || (definitions ? new TaskDefinitionRegistry({ definitions }) : DEFAULT_TASK_DEFINITION_REGISTRY);
    this.executors = executors;
  }

  definition(taskType: unknown) {
    return this.registry.definition(taskType);
  }

  fixedAgentId(taskType: unknown) {
    return this.registry.fixedAgentId(taskType);
  }

  openDelegate(taskType: unknown) {
    return this.registry.openDelegate(taskType);
  }

  executor(agentId: unknown, executors: Record<string, any> = this.executors) {
    return executors[String(agentId || '').trim()] || null;
  }

  contentGrowthContract(taskType: unknown, agentId: unknown) {
    const definition = this.definition(taskType);
    if (!definition?.contentArtifactType || definition.fixedAgentId !== agentId) return null;
    return {
      taskType:definition.taskType,
      agentId:definition.fixedAgentId,
      artifactType:definition.contentArtifactType,
    };
  }

  openTaskDelegates() {
    return this.registry.openTaskDelegates();
  }
}

export const DEFAULT_TASK_CAPABILITY_CATALOG = new TaskCapabilityCatalog();
