export const M5_ROLE_TOOL_BUNDLES = Object.freeze({
  ajun:Object.freeze(['campaign-preflight']),
  'intel-researcher':Object.freeze([]),
  xiaod:Object.freeze(['stepfun-vision', 'media-probe', 'media-validate']),
  'video-content-analyst':Object.freeze(['stepfun-vision', 'media-probe', 'media-validate']),
  'content-creator':Object.freeze([
    'stepfun-image-generate',
    'stepfun-image-edit',
    'stepfun-tts',
    'media-probe',
    'media-validate',
    'media-finalize',
    'remotion-props-write',
    'remotion-render',
    'social-card-render',
    'subtitle-layout-validate',
    'artifact-lineage-validate',
  ]),
  reviewer:Object.freeze([
    'campaign-preflight',
    'media-probe',
    'media-validate',
    'subtitle-layout-validate',
    'artifact-package-write',
    'artifact-lineage-validate',
    'publish-preflight',
  ]),
  operator:Object.freeze([]),
  'office-assistant':Object.freeze([]),
});

export const M5_CONTENT_ROLES = Object.freeze(Object.keys(M5_ROLE_TOOL_BUNDLES));

export function validateExactAgentToolPolicy(config) {
  const bindings = plainObject(config?.agentRoleBindings);
  const grants = plainObject(config?.agentToolGrants);
  const errors = [];
  if (!bindings) errors.push('缺少 agentRoleBindings 岗位 UUID 绑定。');
  if (!grants) errors.push('缺少 agentToolGrants 岗位工具授权。');
  if (!bindings || !grants) return { ok:false, errors };

  const roleKeys = Object.keys(bindings);
  if (!sameSet(roleKeys, M5_CONTENT_ROLES)) {
    errors.push('agentRoleBindings 必须精确覆盖 M5 内容岗位，不能增加或遗漏岗位。');
  }
  const boundAgentIds = roleKeys.map((role) => String(bindings[role] || '').trim());
  if (
    boundAgentIds.some((agentId) => !agentId)
    || new Set(boundAgentIds).size !== boundAgentIds.length
  ) {
    errors.push('每个 M5 内容岗位必须绑定唯一且非空的 Paperclip Agent UUID。');
  }
  if (!sameSet(Object.keys(grants), boundAgentIds)) {
    errors.push('agentToolGrants 必须精确覆盖已绑定的 M5 内容岗位 UUID，不能包含其他 Agent。');
  }

  for (const role of M5_CONTENT_ROLES) {
    const agentId = String(bindings[role] || '').trim();
    const actual = grants[agentId];
    const expected = M5_ROLE_TOOL_BUNDLES[role];
    if (
      !Array.isArray(actual)
      || actual.some((tool) => typeof tool !== 'string')
      || new Set(actual).size !== actual.length
      || !sameSet(actual, expected)
    ) {
      errors.push(`岗位 ${role} 的 agentToolGrants 必须与 M5 最小岗位bundle精确一致。`);
    }
  }
  return { ok:errors.length === 0, errors };
}

function sameSet(left, right) {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
