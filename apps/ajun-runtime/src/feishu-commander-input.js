export function safeRef(value) {
  return String(value || '').trim().slice(0, 240) || null;
}

export function safeAgentId(value) {
  const agentId = String(value || '').trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(agentId) ? agentId : null;
}

export function safeLoopbackBaseUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
