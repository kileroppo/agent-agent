import { ConnectionStore } from 'ajun-common-access/connection-store';
import { ConnectionBroker } from 'ajun-common-access/connection-broker';
import { ContentAcquisitionCenter } from 'ajun-common-access/content-acquisition-center';
import { OperationsEventStore } from 'ajun-common-access/operations-event-store';
import { YtDlpGeneralMediaAdapter } from 'ajun-common-access/yt-dlp-general-media-adapter';
import { MediaCrawlerProAdapter } from 'ajun-common-access/mediacrawler-pro-adapter';
import { BilibiliNativeSubtitleAdapter } from 'ajun-common-access/bilibili-native-subtitle-adapter';
import { config } from './config.ts';

type ConnectionCandidate = Readonly<{ connectionId: string; accountAlias: string | null }>;
type SafeConnection = Readonly<{
  connectionId: string;
  provider: string;
  accountAlias: string | null;
  status: string;
  allowedAgentIds: readonly string[];
  isDefault?: boolean;
}>;
export type ConnectionBinding = Readonly<{
  connectionId: string;
  provider: string;
  accountAlias: string | null;
  selectionSource: string;
}>;

export class ConnectionSelectionError extends Error {
  readonly provider: string | null;
  readonly candidates: readonly ConnectionCandidate[];

  constructor(
    message: string,
    { provider, candidates = [] }: Readonly<{
      provider?: string;
      candidates?: readonly ConnectionCandidate[];
    }> = {},
  ) {
    super(message);
    this.name = 'ConnectionSelectionError';
    this.provider = provider || null;
    this.candidates = candidates;
  }
}

export async function createContentRuntime(workDir: string) {
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
    async resolveConnectionBindingForSource(
      source: string,
      requestedConnectionId: string | null = null,
    ): Promise<ConnectionBinding | null> {
      const provider = contentCenter.adapters
        .find((adapter: any) => adapter.priorityClass === 'specialized' && adapter.matches(source))
        ?.providerFor(source);
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
      const existing: SafeConnection[] = connectionStore.list()
        .filter((connection) => connection.provider === provider && connection.status === 'active' && connection.allowedAgentIds.includes('xiaod'));
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
    async resolveConnectionForSource(source: string): Promise<string | null> {
      const resolved = await this.resolveConnectionBindingForSource(source);
      return resolved?.connectionId || null;
    },
    async health() {
      const acquisition = await contentCenter.health();
      return {
        connectionManager: true,
        contentAcquisitionCenter: acquisition.ready,
        operationsOfficer: true,
        adapters: acquisition.adapters.map((adapter: any) => ({
          id:adapter.id,
          priorityClass:adapter.priorityClass,
          healthStatus:adapter.status,
          configuredStatus:adapter.configuredStatus,
          checkedAt:adapter.checkedAt,
          detail:adapter.detail,
          checks:adapter.checks,
        }))
      };
    }
  };
}

function binding(connection: SafeConnection, selectionSource: string): ConnectionBinding {
  return {
    connectionId:connection.connectionId,
    provider:connection.provider,
    accountAlias:connection.accountAlias,
    selectionSource
  };
}

async function findSingleCookieBridgeAccount(
  baseUrl: string,
  provider: string,
): Promise<Readonly<{ clientId: string; accountAlias: string }> | null> {
  let endpoint: URL;
  try {
    endpoint = new URL('/api/accounts', baseUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) return null;
  } catch { return null; }
  try {
    const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({})) as any;
    const accounts: any[] = Array.isArray(payload?.data?.accounts) ? payload.data.accounts : [];
    const matching = accounts.filter((account: any) => account?.connected && Object.hasOwn(account.platforms || {}, provider) && typeof account.client_id === 'string');
    if (matching.length !== 1) return null;
    const account = matching[0];
    return { clientId: account.client_id, accountAlias: String(account.nicknames?.[provider] || `${provider} 已登录账号`).slice(0, 80) };
  } catch { return null; }
}
