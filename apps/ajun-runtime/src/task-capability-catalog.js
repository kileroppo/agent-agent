import {
  DEFAULT_TASK_DEFINITION_REGISTRY,
  TaskDefinitionRegistry,
} from './task-definition-registry.js';

export class TaskCapabilityCatalog {
  constructor({ definitions, registry, executors = {} } = {}) {
    this.registry = registry || (definitions ? new TaskDefinitionRegistry({ definitions }) : DEFAULT_TASK_DEFINITION_REGISTRY);
    this.executors = executors;
  }

  definition(taskType) {
    return this.registry.definition(taskType);
  }

  fixedAgentId(taskType) {
    return this.registry.fixedAgentId(taskType);
  }

  openDelegate(taskType) {
    return this.registry.openDelegate(taskType);
  }

  executor(agentId, executors = this.executors) {
    return executors[String(agentId || '').trim()] || null;
  }

  contentGrowthContract(taskType, agentId) {
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
