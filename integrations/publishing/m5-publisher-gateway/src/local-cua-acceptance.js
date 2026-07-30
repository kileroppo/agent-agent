import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BOUNDED_BROWSER_TOOLS,
  renderBoundedBrowserPolicy
} from './cua-policy.js';

export const MINIMUM_CUA_DRIVER_VERSION = '0.14.1';
export const LOCAL_ACCEPTANCE_HOST = '127.0.0.1';
export const LOCAL_ACCEPTANCE_DEFAULT_PORT = 4387;
export const LOCAL_ACCEPTANCE_CONFIRMATION = 'RUN_LOCAL_FAKE_CUA';
export const LOCAL_ACCEPTANCE_ALLOWED_TOOLS = BOUNDED_BROWSER_TOOLS;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function versionAtLeast(actual, minimum = MINIMUM_CUA_DRIVER_VERSION) {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

export function validateLoopbackOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw coded('invalid_acceptance_origin', 'Computer Use 验收只接受合法的本地 HTTP origin。');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== LOCAL_ACCEPTANCE_HOST ||
    !parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw coded(
      'invalid_acceptance_origin',
      `Computer Use 验收只允许 http://${LOCAL_ACCEPTANCE_HOST}:<port>，禁止路径、查询串和外部域名。`
    );
  }
  return parsed.origin;
}

export async function validateReadableDirectory(directory) {
  if (!path.isAbsolute(directory)) {
    throw coded('invalid_acceptance_directory', 'Computer Use 测试目录必须是绝对路径。');
  }
  const canonical = await fs.realpath(directory);
  const stats = await fs.stat(canonical);
  if (!stats.isDirectory() || canonical === path.parse(canonical).root) {
    throw coded('invalid_acceptance_directory', 'Computer Use 测试目录必须是非根目录的真实目录。');
  }
  return canonical;
}

export async function resolveAcceptanceUploadPath(directory, candidate) {
  const canonicalDirectory = await validateReadableDirectory(directory);
  const requested = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(canonicalDirectory, candidate);
  const canonicalFile = await fs.realpath(requested);
  const relative = path.relative(canonicalDirectory, canonicalFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw coded(
      'acceptance_upload_outside_directory',
      '测试文件必须位于获准的测试目录内，且不能用符号链接越界。'
    );
  }
  const stats = await fs.lstat(requested);
  const canonicalStats = await fs.stat(canonicalFile);
  if (stats.isSymbolicLink() || !canonicalStats.isFile()) {
    throw coded('invalid_acceptance_upload', '测试文件必须是目录内的普通文件，不能是符号链接。');
  }
  if (canonicalStats.size > 2 * 1024 * 1024 * 1024) {
    throw coded('acceptance_upload_too_large', 'Computer Use 验收文件不得超过 2 GiB。');
  }
  return { directory:canonicalDirectory, file:canonicalFile, size:canonicalStats.size };
}

export function buildBoundedSessionPolicy({ origin, readableDirectory, browserExecutable = null }) {
  const safeOrigin = validateLoopbackOrigin(origin);
  return renderBoundedBrowserPolicy({
    origin:safeOrigin,
    readableDirectory,
    browserExecutable
  });
}

export function evaluateCuaPreflight({
  enabled,
  confirmation,
  version,
  permissions
}) {
  if (!enabled || confirmation !== LOCAL_ACCEPTANCE_CONFIRMATION) {
    throw coded(
      'local_cua_acceptance_disabled',
      `本地 Computer Use 验收默认关闭；需同时设置 M5_FAKE_CUA_ACCEPTANCE=1 和 --confirm ${LOCAL_ACCEPTANCE_CONFIRMATION}。`
    );
  }
  if (!versionAtLeast(version)) {
    throw coded(
      'cua_driver_version_unsupported',
      `需要 cua-driver >= ${MINIMUM_CUA_DRIVER_VERSION}，当前为 ${version || 'unknown'}。`
    );
  }
  if (permissions?.source?.bundle_id !== 'com.trycua.driver') {
    throw coded(
      'cua_identity_mismatch',
      '权限状态不是由 com.trycua.driver 的独立 CuaDriver 应用身份返回，拒绝继续。'
    );
  }
  if (permissions?.accessibility !== true) {
    throw coded(
      'accessibility_required',
      'CuaDriver 尚未获得辅助功能权限；请由负责人手工授权后重试。'
    );
  }
  if (
    permissions?.screen_recording !== true ||
    permissions?.screen_recording_capturable === false
  ) {
    throw coded(
      'screen_recording_required',
      'CuaDriver 尚未获得屏幕录制权限；脚本已在启动浏览器和执行任何动作前停止。'
    );
  }
  return {
    passed:true,
    tccIdentity:permissions.source.bundle_id
  };
}

export function createLocalFixtureRequestHandler(html) {
  return (request, response) => {
    const host = String(request.headers.host || '');
    const expectedHost = `${LOCAL_ACCEPTANCE_HOST}:${response.socket.localPort}`;
    if (host !== expectedHost) {
      response.writeHead(421, { 'Content-Type':'text/plain; charset=utf-8' });
      response.end('Misdirected Request');
      return;
    }
    const url = new URL(request.url || '/', `http://${expectedHost}`);
    const headers = {
      'Cache-Control':'no-store',
      'Content-Security-Policy':[
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "connect-src 'none'",
        "img-src 'none'",
        "media-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'"
      ].join('; '),
      'Cross-Origin-Opener-Policy':'same-origin',
      'Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff'
    };
    if (request.method === 'GET' && url.pathname === '/api/health') {
      response.writeHead(200, { ...headers, 'Content-Type':'application/json; charset=utf-8' });
      response.end('{"ok":true,"mode":"local-fake-platform"}');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { ...headers, 'Content-Type':'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    response.writeHead(404, { ...headers, 'Content-Type':'text/plain; charset=utf-8' });
    response.end('Not Found');
  };
}
