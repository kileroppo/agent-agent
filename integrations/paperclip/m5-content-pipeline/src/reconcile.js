export function containsDeclared(actual, declared) {
  if (Array.isArray(declared)) {
    return Array.isArray(actual)
      && actual.length === declared.length
      && declared.every((item, index) => containsDeclared(actual[index], item));
  }
  if (declared && typeof declared === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(declared).every(([key, value]) =>
      value === undefined || containsDeclared(actual[key], value),
    );
  }
  return Object.is(actual, declared);
}

export function routineMatchesDeclaration(routine, payload) {
  return containsDeclared(routine, payload);
}

export function pipelineHeaderMatchesDeclaration(pipeline, payload) {
  return containsDeclared(pipeline, {
    key:payload.key,
    name:payload.name,
    description:payload.description,
    projectId:payload.projectId,
    enforceTransitions:payload.enforceTransitions,
  });
}

export function stageMatchesDeclaration(stage, declared) {
  return containsDeclared(stage, {
    key:declared.key,
    name:declared.name,
    kind:declared.kind,
    position:declared.position,
    config:declared.config,
  });
}
