import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { existsSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultFastPython = path.join(os.homedir(), '.local', 'share', 'agent-army', 'xiaod-faster-whisper', 'bin', 'python');
const defaultFastModelRoot = path.join(os.homedir(), '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small', 'snapshots');

// Local development is started directly with Node, so load the project's
// untracked .env before deriving the immutable runtime config below.
// Keep an explicitly injected acceptance-test switch before .env loading:
// Node's dotenv loader may replace it with a blank value from the file.
const launchedTestFailOnceAt = process.env.XIAOD_TEST_FAIL_ONCE_AT || '';
try {
  process.loadEnvFile();
} catch (error: unknown) {
  if (errorCode(error) !== 'ENOENT') throw error;
}

export const config = {
  port: Number(process.env.PORT || 4318),
  host: requireLoopbackHost(process.env.HOST || '127.0.0.1'),
  workDir: path.resolve(process.env.WORK_DIR || './data'),
  taskRunEventDb:resolveTaskRunEventDb(process.env),
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
  adaptiveAsr: {
    enabled: process.env.ADAPTIVE_ASR_ENABLED !== '0',
    fastPython: process.env.FASTER_WHISPER_PYTHON || defaultFastPython,
    fastScript: process.env.FASTER_WHISPER_SCRIPT || path.join(appRoot, 'scripts', 'faster-whisper-transcribe.py'),
    fastModelRoot: process.env.FASTER_WHISPER_MODEL_ROOT || defaultFastModelRoot,
    fastModelId: process.env.FASTER_WHISPER_MODEL_ID || 'Systran/faster-whisper-small',
    fastComputeType: process.env.FASTER_WHISPER_COMPUTE_TYPE || 'int8',
    progressiveFastEnabled: process.env.FASTER_WHISPER_PROGRESSIVE_ENABLED === '1',
    fastMinDurationSeconds: Number(process.env.FASTER_WHISPER_MIN_DURATION_SECONDS || 60),
    fastMaxDurationSeconds: Number(process.env.FASTER_WHISPER_MAX_DURATION_SECONDS || 1800)
  },
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

export function resolveTaskRunEventDb(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(environment.AGENT_ARMY_TASK_RUN_EVENT_DB || '').trim();
  if (explicit) return path.resolve(explicit);
  const sharedDataDir = String(environment.AGENT_ARMY_DATA_DIR || '').trim();
  if (sharedDataDir) return path.resolve(sharedDataDir, 'task-run-events.sqlite');
  return path.join(appRoot, '../ajun-runtime/data/task-run-events.sqlite');
}

type TaskRunEventFileSystem = Pick<
  typeof fs,
  'mkdir' | 'lstat' | 'chmod' | 'stat'
>;

export async function prepareTaskRunEventDatabasePath(
  value: unknown,
  { fileSystem = fs }: Readonly<{ fileSystem?: TaskRunEventFileSystem }> = {},
): Promise<string> {
  const databasePath = path.resolve(String(value || '').trim());
  const parent = path.dirname(databasePath);
  if (!String(value || '').trim() || parent === path.parse(parent).root) {
    throw codedPathError('task_run_event_path_unsafe', '小D运行事件库必须位于独立数据目录。');
  }
  await fileSystem.mkdir(parent, { recursive:true, mode:0o700 });
  const parentStatus = await fileSystem.lstat(parent);
  if (parentStatus.isSymbolicLink() || !parentStatus.isDirectory()) {
    throw codedPathError('task_run_event_parent_unsafe', '小D运行事件库父路径必须是非符号链接目录。');
  }
  await fileSystem.chmod(parent, 0o700);
  const securedParent = await fileSystem.stat(parent);
  if ((securedParent.mode & 0o077) !== 0) {
    throw codedPathError('task_run_event_parent_permissions', '小D运行事件库父目录权限必须为0700。');
  }
  try {
    const databaseStatus = await fileSystem.lstat(databasePath);
    if (databaseStatus.isSymbolicLink() || !databaseStatus.isFile()) {
      throw codedPathError('task_run_event_file_unsafe', '小D运行事件库必须是非符号链接普通文件。');
    }
    await fileSystem.chmod(databasePath, 0o600);
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return databasePath;
}

export function requireLoopbackHost(value: unknown): string {
  const host = String(value || '').trim().toLowerCase();
  if (host === 'localhost' || host === '::1') return host;
  if (net.isIPv4(host) && Number(host.split('.')[0]) === 127) return host;
  throw new Error('小D服务只允许监听本机回环地址。');
}

export const configuredCapabilities = () => ({
  asr: Boolean(config.asrBin),
  adaptiveAsr: config.adaptiveAsr.enabled,
  fastAsrCandidate: config.adaptiveAsr.enabled
    && existsSync(config.adaptiveAsr.fastPython)
    && existsSync(config.adaptiveAsr.fastScript)
    && existsSync(config.adaptiveAsr.fastModelRoot),
  aiRefinement: Boolean(config.refiner.url && config.refiner.model),
  lark: Boolean(config.lark.appId && config.lark.appSecret),
  mediaCrawlerDeep: Boolean(config.mediaCrawler.cookieBridgeUrl && config.mediaCrawler.downloadServerUrl),
  testFailpointArmed: Boolean(config.testFailOnceAt)
});

function codedPathError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : '';
}
