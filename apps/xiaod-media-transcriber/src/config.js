import path from 'node:path';

// Local development is started directly with Node, so load the project's
// untracked .env before deriving the immutable runtime config below.
// Keep an explicitly injected acceptance-test switch before .env loading:
// Node's dotenv loader may replace it with a blank value from the file.
const launchedTestFailOnceAt = process.env.XIAOD_TEST_FAIL_ONCE_AT || '';
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

export const config = {
  port: Number(process.env.PORT || 4318),
  host: process.env.HOST || '127.0.0.1',
  workDir: path.resolve(process.env.WORK_DIR || './data'),
  inboundMedia: {
    maxBytes: Number(process.env.INBOUND_MEDIA_MAX_BYTES || 1024 * 1024 * 1024),
    allowedRoots: (process.env.INBOUND_MEDIA_ALLOWED_ROOTS || (process.env.HERMES_HOME ? path.join(process.env.HERMES_HOME, 'cache') : ''))
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry))
  },
  asrBin: process.env.ASR_BIN || 'mlx_whisper',
  asrModel: process.env.ASR_MODEL || 'mlx-community/whisper-large-v3-turbo',
  // Explicit local acceptance-test hook. Never set this in normal operation.
  testFailOnceAt: launchedTestFailOnceAt || process.env.XIAOD_TEST_FAIL_ONCE_AT || '',
  refiner: {
    url: process.env.TEXT_REFINER_URL || '',
    apiKey: process.env.TEXT_REFINER_API_KEY || '',
    model: process.env.TEXT_REFINER_MODEL || '',
    maxTokens: Number(process.env.TEXT_REFINER_MAX_TOKENS || 8192)
  },
  lark: {
    appId: process.env.LARK_APP_ID || '',
    appSecret: process.env.LARK_APP_SECRET || '',
    userOpenId: process.env.LARK_USER_OPEN_ID || ''
  },
  mediaCrawler: {
    // These two A君-managed services are intentionally loopback-only. They can
    // still be disabled by setting either environment value to an empty string.
    cookieBridgeUrl: process.env.MEDIACRAWLER_COOKIE_BRIDGE_URL ?? 'http://127.0.0.1:8274',
    downloadServerUrl: process.env.MEDIACRAWLER_DOWNLOAD_SERVER_URL ?? 'http://127.0.0.1:8205'
  }
};

export const configuredCapabilities = () => ({
  asr: Boolean(config.asrBin),
  aiRefinement: Boolean(config.refiner.url && config.refiner.model),
  lark: Boolean(config.lark.appId && config.lark.appSecret),
  mediaCrawlerDeep: Boolean(config.mediaCrawler.cookieBridgeUrl && config.mediaCrawler.downloadServerUrl),
  testFailpointArmed: Boolean(config.testFailOnceAt)
});
