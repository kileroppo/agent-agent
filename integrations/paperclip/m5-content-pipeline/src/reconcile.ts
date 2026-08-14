export function containsDeclared(actual: any, declared: any): boolean {
    if (Array.isArray(declared)) {
        return Array.isArray(actual)
            && actual.length === declared.length
            && declared.every((item: any, index: any) => containsDeclared(actual[index], item));
    }
    if (declared && typeof declared === 'object') {
        if (!actual || typeof actual !== 'object' || Array.isArray(actual))
            return false;
        return Object.entries(declared).every(([key, value]: any) => value === undefined || containsDeclared(actual[key], value));
    }
    return Object.is(actual, declared);
}
export function routineMatchesDeclaration(routine: any, payload: any) {
    return containsDeclared(routine, payload);
}
export function pipelineHeaderMatchesDeclaration(pipeline: any, payload: any) {
    return containsDeclared(pipeline, {
        key: payload.key,
        name: payload.name,
        description: payload.description,
        projectId: payload.projectId,
        enforceTransitions: payload.enforceTransitions,
    });
}
export function stageMatchesDeclaration(stage: any, declared: any) {
    return containsDeclared(stage, {
        key: declared.key,
        name: declared.name,
        kind: declared.kind,
        position: declared.position,
        config: declared.config,
    });
}
