export const CAPABILITY_OPERATIONS: Readonly<Record<string, string>> = {
  basic_content: 'read_media_metadata',
  images: 'read_content_images',
  media: 'download_authorized_media',
  subtitles: 'read_media_subtitles',
  comments: 'read_content_comments'
};

export type ConnectionUse = Readonly<Record<string, unknown> & {
  connectionId: string;
  provider: string;
  credentialKind: string;
  operations: readonly string[];
}>;
type AuthorizedConnection = Readonly<Record<string, unknown> & {
  connectionId: string;
  provider: string;
  credentialKind: string;
  status: string;
  allowedAgentIds: readonly string[];
  grantedOperations: readonly string[];
  dataScope: readonly string[];
}>;
type ConnectionStoreInterface = Readonly<{
  get(id: string): AuthorizedConnection | null;
  getSafe(id: string): Readonly<{ accountAlias?: string | null }> | null;
  markHealth(id: string): Promise<unknown>;
  recordVerification(id: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}> & Record<string, any>;

export class ConnectionBroker {
  readonly connectionStore: ConnectionStoreInterface;

  constructor({ connectionStore }: Readonly<{ connectionStore: ConnectionStoreInterface }>) {
    this.connectionStore = connectionStore;
  }

  async authorize({
    connectionId, provider, operations, requestingAgentId, dataScope = ['content:read'],
  }: Readonly<{
    connectionId?: string | null;
    provider: string;
    operations: readonly string[];
    requestingAgentId: string;
    dataScope?: readonly string[];
  }>) {
    if (!connectionId) return denial('connection_required', '该来源需要先在 A君中连接账号。', 'reauthorize');
    const connection = this.connectionStore.get(connectionId);
    if (!connection) return denial('connection_not_found', '找不到指定的账号连接，请重新授权。', 'reauthorize');
    if (connection.provider !== provider) return denial('connection_provider_mismatch', '该账号连接不适用于此平台。', 'manual_review');
    if (connection.status === 'expired' || connection.status === 'expiring') return denial('connection_expired', '账号连接已过期，请在 A君中重新授权。', 'reauthorize');
    if (connection.status === 'revoked' || connection.status === 'disabled') return denial('connection_unavailable', '账号连接已撤销或停用，请重新授权。', 'reauthorize');
    if (connection.status !== 'active') return denial('connection_unavailable', '账号连接当前不可用，请稍后重试或重新授权。', 'manual_review');
    if (connection.credentialKind === 'browser_session') return denial('browser_session_forbidden', '旧浏览器连接不能读取浏览器 Cookie；请改用公开视频读取或已批准的受控连接器。', 'reauthorize');
    if (!connection.allowedAgentIds.includes(requestingAgentId)) return denial('agent_not_allowed', '该任务没有使用此账号连接的权限。', 'manual_review');
    if (operations.some((operation) => !connection.grantedOperations.includes(operation))) return denial('operation_not_granted', '此账号连接未授予所需的只读范围。', 'reauthorize');
    if (dataScope.some((scope) => !connection.dataScope.includes(scope))) return denial('scope_not_granted', '此账号连接的数据范围不足。', 'reauthorize');
    await this.connectionStore.markHealth(connectionId);
    return {
      ok: true as const,
      connectionUse: {
        connectionId: connection.connectionId,
        provider: connection.provider,
        credentialKind: connection.credentialKind,
        browser: connection.browser,
        companionProfile: connection.companionProfile,
        cookieBridgeClientId: connection.cookieBridgeClientId,
        operations: [...operations]
      }
    };
  }
}

function denial(code: string, safeMessage: string, recommendedAction: string) {
  return { ok: false as const, code, safeMessage, recommendedAction, category: 'needs_input' };
}
