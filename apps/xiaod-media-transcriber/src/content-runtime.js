import { ConnectionStore } from '../../../integrations/access/connection-store.js';
import { ConnectionBroker } from '../../../integrations/access/connection-broker.js';
import { ContentAcquisitionCenter } from '../../../integrations/access/content-acquisition-center.js';
import { OperationsEventStore } from '../../../integrations/access/operations-event-store.js';
import { YtDlpGeneralMediaAdapter } from '../../../integrations/access/yt-dlp-general-media-adapter.js';
import { MediaCrawlerProAdapter } from '../../../integrations/access/mediacrawler-pro-adapter.js';
import { BilibiliNativeSubtitleAdapter } from '../../../integrations/access/bilibili-native-subtitle-adapter.js';
import { config } from './config.js';

export class ConnectionSelectionError extends Error {
  constructor(message, { provider, candidates = [] } = {}) {
    super(message);
    this.name = 'ConnectionSelectionError';
    this.provider = provider || null;
    this.candidates = candidates;
  }
}

export async function createContentRuntime(workDir) {
  const connectionStore = new ConnectionStore(workDir);
  const operations = new OperationsEventStore(workDir);
  await Promise.all([connectionStore.init(), operations.init()]);
  const connectionBroker = new ConnectionBroker({ connectionStore });
  const contentCenter = new ContentAcquisitionCenter({
    adapters: [
      new BilibiliNativeSubtitleAdapter({ cookieBridgeUrl: config.mediaCrawler.cookieBridgeUrl }),
      new MediaCrawlerProAdapter(config.mediaCrawler),
      new YtDlpGeneralMediaAdapter()
    ],
    connectionBroker, operations
  });
  return {
    connectionStore,
    operations,
    contentCenter,
    async resolveConnectionBindingForSource(source, requestedConnectionId = null) {
      const provider = contentCenter.adapters.find((adapter) => adapter.priorityClass === 'specialized' && adapter.matches(source))?.providerFor(source);
      if (!provider) return null;
      if (requestedConnectionId) {
        const connection = connectionStore.getSafe(requestedConnectionId);
        return {
          connectionId:requestedConnectionId,
          provider,
          accountAlias:connection?.accountAlias || null,
          selectionSource:'explicit'
        };
      }
      const existing = connectionStore.list().filter((connection) => connection.provider === provider && connection.status === 'active' && connection.allowedAgentIds.includes('xiaod'));
      const selectedDefault = existing.find((connection) => connection.isDefault === true);
      if (selectedDefault) return binding(selectedDefault, 'default');
      if (existing.length === 1) return binding(existing[0], 'unique');
      if (existing.length > 1) {
        throw new ConnectionSelectionError('该平台有多个可用账号，请先在 A君控制台设置默认账号。', {
          provider,
          candidates:existing.map((connection) => ({
            connectionId:connection.connectionId,
            accountAlias:connection.accountAlias
          }))
        });
      }
      const imported = await findSingleCookieBridgeAccount(config.mediaCrawler.cookieBridgeUrl, provider);
      if (!imported) return null;
      const connection = await connectionStore.createCookieBridgeConnection({
        provider,
        accountAlias: imported.accountAlias,
        clientId: imported.clientId,
        grantedOperations: [
          'read_media_metadata',
          'read_content_images',
          'download_authorized_media',
          ...(provider === 'bili' ? ['read_media_subtitles'] : [])
        ],
        dataScope: ['content:read'],
        allowedAgentIds: ['xiaod']
      });
      return binding(connection, 'imported');
    },
    async resolveConnectionForSource(source) {
      const resolved = await this.resolveConnectionBindingForSource(source);
      return resolved?.connectionId || null;
    },
    health() {
      return {
        connectionManager: true,
        contentAcquisitionCenter: true,
        operationsOfficer: true,
        adapters: contentCenter.adapters.map((adapter) => ({ id: adapter.id, priorityClass: adapter.priorityClass, healthStatus: adapter.healthStatus }))
      };
    }
  };
}

function binding(connection, selectionSource) {
  return {
    connectionId:connection.connectionId,
    provider:connection.provider,
    accountAlias:connection.accountAlias,
    selectionSource
  };
}

async function findSingleCookieBridgeAccount(baseUrl, provider) {
  let endpoint;
  try {
    endpoint = new URL('/api/accounts', baseUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) return null;
  } catch { return null; }
  try {
    const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    const accounts = Array.isArray(payload?.data?.accounts) ? payload.data.accounts : [];
    const matching = accounts.filter((account) => account?.connected && Object.hasOwn(account.platforms || {}, provider) && typeof account.client_id === 'string');
    if (matching.length !== 1) return null;
    const account = matching[0];
    return { clientId: account.client_id, accountAlias: String(account.nicknames?.[provider] || `${provider} 已登录账号`).slice(0, 80) };
  } catch { return null; }
}
