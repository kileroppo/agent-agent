import { ConnectionStore } from '../../../integrations/access/connection-store.js';
import { ConnectionBroker } from '../../../integrations/access/connection-broker.js';
import { ContentAcquisitionCenter } from '../../../integrations/access/content-acquisition-center.js';
import { OperationsEventStore } from '../../../integrations/access/operations-event-store.js';
import { YtDlpGeneralMediaAdapter } from '../../../integrations/access/yt-dlp-general-media-adapter.js';
import { MediaCrawlerProAdapter } from '../../../integrations/access/mediacrawler-pro-adapter.js';
import { BilibiliNativeSubtitleAdapter } from '../../../integrations/access/bilibili-native-subtitle-adapter.js';
import { config } from './config.js';

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
    async resolveConnectionForSource(source) {
      const provider = contentCenter.adapters.find((adapter) => adapter.priorityClass === 'specialized' && adapter.matches(source))?.providerFor(source);
      if (!provider) return null;
      const existing = connectionStore.list().filter((connection) => connection.provider === provider && connection.status === 'active' && connection.allowedAgentIds.includes('xiaod'));
      if (existing.length === 1) return existing[0].connectionId;
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
      return connection.connectionId;
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
