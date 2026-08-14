import { DEFAULT_TASK_TYPE, TASK_DEFINITIONS } from './task-definitions.ts';
export class TaskDefinitionRegistry {
    categoryTaskTypes: any;
    defaultTaskType: any;
    definitions: any;
    directTaskTypesByAgentId: Map<string, string>;
    intentTaskTypes: any;
    constructor({ definitions = TASK_DEFINITIONS, defaultTaskType = DEFAULT_TASK_TYPE }: any = {}) {
        this.definitions = new Map(definitions.map((item: any): any => {
            const normalized: any = normalizeDefinition(item);
            return [normalized.taskType, normalized];
        }));
        if (this.definitions.size !== definitions.length)
            throw new TypeError('taskType definitions must be unique');
        this.defaultTaskType = normalizeText(defaultTaskType) || DEFAULT_TASK_TYPE;
        this.intentTaskTypes = new Map();
        this.categoryTaskTypes = new Map();
        this.directTaskTypesByAgentId = new Map();
        for (const definition of this.definitions.values()) {
            for (const intent of definition.intents) {
                if (this.intentTaskTypes.has(intent))
                    throw new TypeError(`intent definitions must be unique: ${intent}`);
                this.intentTaskTypes.set(intent, definition.taskType);
            }
            for (const category of definition.entryCategories) {
                const taskTypes: any = this.categoryTaskTypes.get(category) || [];
                taskTypes.push(definition.taskType);
                this.categoryTaskTypes.set(category, taskTypes);
            }
            if (definition.directDefault && definition.defaultAgentId) {
                if (this.directTaskTypesByAgentId.has(definition.defaultAgentId))
                    throw new TypeError(`directDefault definitions must be unique per agent: ${definition.defaultAgentId}`);
                this.directTaskTypesByAgentId.set(definition.defaultAgentId, definition.taskType);
            }
        }
        if (!this.definitions.has(this.defaultTaskType))
            throw new TypeError('defaultTaskType must reference a registered taskType');
        for (const definition of this.definitions.values()) {
            if (definition.openDelegate && !this.definitions.has(definition.openDelegate)) {
                throw new TypeError(`openDelegate must reference a registered taskType: ${definition.openDelegate}`);
            }
            if (definition.prerequisiteTaskType && !this.definitions.has(definition.prerequisiteTaskType)) {
                throw new TypeError(`prerequisiteTaskType must reference a registered taskType: ${definition.prerequisiteTaskType}`);
            }
        }
    }
    definition(taskType: any): any {
        return this.definitions.get(normalizeText(taskType)) || null;
    }
    defaultAgentId(taskType: any): any {
        return this.definition(taskType)?.defaultAgentId || null;
    }
    entryDefaultAgentId(taskType: any): any {
        const definition: any = this.definition(taskType);
        return definition?.entryDefault === true ? definition.defaultAgentId : null;
    }
    fixedAgentId(taskType: any): any {
        return this.definition(taskType)?.fixedAgentId || null;
    }
    openDelegate(taskType: any): any {
        return this.definition(taskType)?.openDelegate || null;
    }
    prerequisiteTaskType(taskType: any): any {
        return this.definition(taskType)?.prerequisiteTaskType || null;
    }
    taskTypeForIntent(intent: any): any {
        return this.intentTaskTypes.get(normalizeText(intent)) || this.defaultTaskType;
    }
    directTaskType(agentId: any): any {
        const normalizedAgentId: any = normalizeText(agentId);
        return this.directTaskTypesByAgentId.get(normalizedAgentId) || null;
    }
    workerName(taskOrType: any): any {
        const task: any = typeof taskOrType === 'object' && taskOrType !== null ? taskOrType : null;
        const taskType: any = task ? task.taskType : taskOrType;
        if (this.definition(taskType)?.workerName)
            return this.definition(taskType).workerName;
        if (task?.assigneeAgentId === 'technical-expert')
            return '技术专家';
        return null;
    }
    taskLabel(taskType: any): any {
        return this.definition(taskType)?.taskLabel || null;
    }
    belongsToCategory(taskType: any, category: any): any {
        return this.definition(taskType)?.entryCategories.includes(normalizeText(category)) === true;
    }
    taskTypesForCategory(category: any): any {
        return Object.freeze([...(this.categoryTaskTypes.get(normalizeText(category)) || [])]);
    }
    openTaskDelegates(): any {
        return Object.freeze(Object.fromEntries([...this.definitions.values()]
            .filter((item: any): any => item.openDelegate)
            .map((item: any): any => [item.taskType, item.openDelegate])));
    }
    allowsApprovalInheritance(taskType: any): any {
        return this.definition(taskType)?.approvalInheritance === 'safe-parent-scope';
    }
}
export const DEFAULT_TASK_DEFINITION_REGISTRY: any = new TaskDefinitionRegistry();
function normalizeDefinition(input: any = {}): any {
    const taskType: any = normalizeText(input.taskType);
    if (!taskType)
        throw new TypeError('taskType is required');
    return Object.freeze({
        ...input,
        taskType,
        defaultAgentId: normalizeText(input.defaultAgentId) || null,
        fixedAgentId: normalizeText(input.fixedAgentId) || null,
        openDelegate: normalizeText(input.openDelegate) || null,
        prerequisiteTaskType: normalizeText(input.prerequisiteTaskType) || null,
        workerName: normalizeText(input.workerName) || null,
        taskLabel: normalizeText(input.taskLabel) || null,
        contentArtifactType: normalizeText(input.contentArtifactType) || null,
        directDefault: input.directDefault === true,
        entryDefault: input.entryDefault === true,
        approvalInheritance: normalizeText(input.approvalInheritance) || 'deny',
        intents: Object.freeze(uniqueStrings(input.intents)),
        entryCategories: Object.freeze(uniqueStrings(input.entryCategories)),
    });
}
function uniqueStrings(values: any): any {
    return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))];
}
function normalizeText(value: any): any {
    return String(value || '').trim();
}
