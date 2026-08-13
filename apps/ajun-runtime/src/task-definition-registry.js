import { DEFAULT_TASK_TYPE, TASK_DEFINITIONS } from './task-definitions.js';

export class TaskDefinitionRegistry {
  constructor({ definitions = TASK_DEFINITIONS, defaultTaskType = DEFAULT_TASK_TYPE } = {}) {
    this.definitions = new Map(definitions.map((item) => {
      const normalized = normalizeDefinition(item);
      return [normalized.taskType, normalized];
    }));
    if (this.definitions.size !== definitions.length) throw new TypeError('taskType definitions must be unique');
    this.defaultTaskType = normalizeText(defaultTaskType) || DEFAULT_TASK_TYPE;
    this.intentTaskTypes = new Map();
    this.categoryTaskTypes = new Map();
    for (const definition of this.definitions.values()) {
      for (const intent of definition.intents) {
        if (this.intentTaskTypes.has(intent)) throw new TypeError(`intent definitions must be unique: ${intent}`);
        this.intentTaskTypes.set(intent, definition.taskType);
      }
      for (const category of definition.entryCategories) {
        const taskTypes = this.categoryTaskTypes.get(category) || [];
        taskTypes.push(definition.taskType);
        this.categoryTaskTypes.set(category, taskTypes);
      }
    }
    if (!this.definitions.has(this.defaultTaskType)) throw new TypeError('defaultTaskType must reference a registered taskType');
    for (const definition of this.definitions.values()) {
      if (definition.openDelegate && !this.definitions.has(definition.openDelegate)) {
        throw new TypeError(`openDelegate must reference a registered taskType: ${definition.openDelegate}`);
      }
      if (definition.prerequisiteTaskType && !this.definitions.has(definition.prerequisiteTaskType)) {
        throw new TypeError(`prerequisiteTaskType must reference a registered taskType: ${definition.prerequisiteTaskType}`);
      }
    }
  }

  definition(taskType) {
    return this.definitions.get(normalizeText(taskType)) || null;
  }

  defaultAgentId(taskType) {
    return this.definition(taskType)?.defaultAgentId || null;
  }

  entryDefaultAgentId(taskType) {
    const definition = this.definition(taskType);
    return definition?.entryDefault === true ? definition.defaultAgentId : null;
  }

  fixedAgentId(taskType) {
    return this.definition(taskType)?.fixedAgentId || null;
  }

  openDelegate(taskType) {
    return this.definition(taskType)?.openDelegate || null;
  }

  prerequisiteTaskType(taskType) {
    return this.definition(taskType)?.prerequisiteTaskType || null;
  }

  taskTypeForIntent(intent) {
    return this.intentTaskTypes.get(normalizeText(intent)) || this.defaultTaskType;
  }

  directTaskType(agentId) {
    const normalizedAgentId = normalizeText(agentId);
    return [...this.definitions.values()].find((item) =>
      item.directDefault === true && item.defaultAgentId === normalizedAgentId)?.taskType || null;
  }

  workerName(taskOrType) {
    const task = typeof taskOrType === 'object' && taskOrType !== null ? taskOrType : null;
    const taskType = task ? task.taskType : taskOrType;
    if (this.definition(taskType)?.workerName) return this.definition(taskType).workerName;
    if (task?.assigneeAgentId === 'technical-expert') return '技术专家';
    return null;
  }

  taskLabel(taskType) {
    return this.definition(taskType)?.taskLabel || null;
  }

  belongsToCategory(taskType, category) {
    return this.definition(taskType)?.entryCategories.includes(normalizeText(category)) === true;
  }

  taskTypesForCategory(category) {
    return Object.freeze([...(this.categoryTaskTypes.get(normalizeText(category)) || [])]);
  }

  openTaskDelegates() {
    return Object.freeze(Object.fromEntries(
      [...this.definitions.values()]
        .filter((item) => item.openDelegate)
        .map((item) => [item.taskType, item.openDelegate]),
    ));
  }

  allowsApprovalInheritance(taskType) {
    return this.definition(taskType)?.approvalInheritance === 'safe-parent-scope';
  }
}

export const DEFAULT_TASK_DEFINITION_REGISTRY = new TaskDefinitionRegistry();


function normalizeDefinition(input = {}) {
  const taskType = normalizeText(input.taskType);
  if (!taskType) throw new TypeError('taskType is required');
  return Object.freeze({
    ...input,
    taskType,
    defaultAgentId:normalizeText(input.defaultAgentId) || null,
    fixedAgentId:normalizeText(input.fixedAgentId) || null,
    openDelegate:normalizeText(input.openDelegate) || null,
    prerequisiteTaskType:normalizeText(input.prerequisiteTaskType) || null,
    workerName:normalizeText(input.workerName) || null,
    taskLabel:normalizeText(input.taskLabel) || null,
    contentArtifactType:normalizeText(input.contentArtifactType) || null,
    directDefault:input.directDefault === true,
    entryDefault:input.entryDefault === true,
    approvalInheritance:normalizeText(input.approvalInheritance) || 'deny',
    intents:Object.freeze(uniqueStrings(input.intents)),
    entryCategories:Object.freeze(uniqueStrings(input.entryCategories)),
  });
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || '').trim();
}
