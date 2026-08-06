const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPaperclipSecretRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.type !== 'secret_ref' || !UUID.test(String(value.secretId || ''))) return false;
  if (
    value.version !== undefined
    && value.version !== 'latest'
    && (!Number.isInteger(value.version) || value.version < 1)
  ) return false;
  return true;
}

export function requirePaperclipSecretRef(value, errorFactory = (message) => new Error(message)) {
  if (!isPaperclipSecretRef(value)) {
    throw errorFactory('StepFun 只接受 Paperclip secret_ref 对象引用；禁止明文或旧字符串 UUID。');
  }
  return value;
}
