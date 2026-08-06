const GOAL_SCHEMA_VERSION = 'agent.army/goal-spec/v1';
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const SENSITIVE_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|authorization|credentials?)$/i;
const SENSITIVE_TEXT = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|[?&](?:token|api[_-]?key|secret|password)=)/i;

export class GoalSpecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoalSpecError';
    this.code = code;
  }
}

export function normalizeGoalSpec(input, { allowedPermissions = [], now = new Date() } = {}) {
  assertNoSensitiveData(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoalSpecError('invalid_goal_spec', '目标规范必须是对象。');
  }
  const goalId = identifier(input.goalId, 'goalId');
  const objective = requiredText(input.objective, 'objective', 2_000);
  const deliverables = requiredTextList(input.deliverables, 'deliverables', 30, 500);
  const acceptanceCriteria = requiredTextList(input.acceptanceCriteria, 'acceptanceCriteria', 30, 1_000);
  const constraints = textList(input.constraints, 'constraints', 50, 1_000);
  const priority = String(input.priority || 'normal').trim().toLowerCase();
  if (!PRIORITIES.has(priority)) {
    throw new GoalSpecError('invalid_priority', `不支持的目标优先级：${priority || 'empty'}。`);
  }
  const permissionCeiling = new Set(textList(allowedPermissions, 'allowedPermissions', 200, 160));
  const requestedPermissions = textList(input.requestedPermissions, 'requestedPermissions', 100, 160);
  const expanded = requestedPermissions.filter((permission) => !permissionCeiling.has(permission));
  if (expanded.length) {
    throw new GoalSpecError('permission_expansion', `目标请求了未授予的权限：${expanded.join(', ')}。`);
  }

  return {
    schemaVersion:GOAL_SCHEMA_VERSION,
    goalId,
    objective,
    deliverables,
    constraints,
    acceptanceCriteria,
    priority,
    requestedPermissions,
    createdAt:asIso(now, 'now')
  };
}

export function assertNoSensitiveData(value, path = 'input') {
  if (typeof value === 'string') {
    if (SENSITIVE_TEXT.test(value)) {
      throw new GoalSpecError('sensitive_data_rejected', `${path} 包含敏感凭据，已拒绝。`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveData(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new GoalSpecError('sensitive_data_rejected', `${path}.${key} 是敏感字段，已拒绝。`);
    }
    assertNoSensitiveData(child, `${path}.${key}`);
  }
}

function requiredText(value, field, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new GoalSpecError('invalid_goal_spec', `${field} 不能为空。`);
  if (text.length > maxLength) throw new GoalSpecError('invalid_goal_spec', `${field} 超过长度限制。`);
  return text;
}

function requiredTextList(value, field, maxItems, maxLength) {
  const values = textList(value, field, maxItems, maxLength);
  if (!values.length) throw new GoalSpecError('invalid_goal_spec', `${field} 至少需要一项。`);
  return values;
}

function textList(value, field, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new GoalSpecError('invalid_goal_spec', `${field} 必须是数组。`);
  if (value.length > maxItems) throw new GoalSpecError('invalid_goal_spec', `${field} 超过数量限制。`);
  const result = value.map((item) => requiredText(item, field, maxLength));
  return [...new Set(result)];
}

function identifier(value, field) {
  const text = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(text)) {
    throw new GoalSpecError('invalid_goal_spec', `${field} 格式无效。`);
  }
  return text;
}

function asIso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new GoalSpecError('invalid_goal_spec', `${field} 不是有效时间。`);
  return date.toISOString();
}
