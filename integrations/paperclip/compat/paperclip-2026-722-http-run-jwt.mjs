import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyVersionLockedFile,
  rollbackVersionLockedFile,
} from './paperclip-2026-722-binary-rpc.mjs';

export const PAPERCLIP_VERSION = '2026.722.0';
export const HTTP_INDEX_ORIGINAL_SHA256 = '6e678c3a5d01ada9686a54d858ca3eef921595706feb378984cb20f2cbdd0d63';
export const HTTP_INDEX_PATCHED_SHA256 = '391bd85fb108e00eb55eaeaca49315dd57acb90f0120a7b383fc71e8c7d6135d';
export const BACKUP_SUFFIX = '.agent-army-paperclip-2026.722.0-http-run-jwt.bak';

const INDEX_RELATIVE_PATH = 'dist/adapters/http/index.js';
const INDEX_IMPORT_ORIGINAL = 'import { execute } from "./execute.js";';
const INDEX_IMPORT_PATCHED = 'import { asString, asNumber, parseObject } from "../utils.js";';
const INDEX_TEST_IMPORT = 'import { testEnvironment } from "./test.js";';
const INDEX_MODELS_ORIGINAL = '    models: [],';
const INDEX_MODELS_PATCHED = `    models: [],
    supportsLocalAgentJwt: true,`;
const SECURE_EXECUTE = `async function execute(ctx) {
    const { config, runId, agent, context, authToken } = ctx;
    const url = asString(config.url, "");
    if (!url)
        throw new Error("HTTP adapter missing url");
    const method = asString(config.method, "POST");
    const timeoutMs = asNumber(config.timeoutMs, 0);
    const headers = parseObject(config.headers);
    const forwardRunJwt = config.forwardRunJwt === true;
    if (forwardRunJwt && !isLoopbackHttpUrl(url))
        throw new Error("HTTP adapter forwardRunJwt requires a loopback URL");
    const localAgentJwt = asString(authToken, "").trim();
    if (forwardRunJwt && !localAgentJwt)
        throw new Error("HTTP adapter forwardRunJwt missing run JWT");
    const requestHeaders = forwardRunJwt
        ? Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"))
        : headers;
    const payloadTemplate = parseObject(config.payloadTemplate);
    const body = { ...payloadTemplate, agentId: agent.id, runId, context };
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetch(url, {
            method,
            headers: {
                "content-type": "application/json",
                ...requestHeaders,
                ...(forwardRunJwt ? { authorization: \`Bearer \${localAgentJwt}\` } : {}),
            },
            body: JSON.stringify(body),
            ...(forwardRunJwt ? { redirect: "manual" } : {}),
            ...(timer ? { signal: controller.signal } : {}),
        });
        if (!res.ok) {
            throw new Error(\`HTTP invoke failed with status \${res.status}\`);
        }
        return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            summary: \`HTTP \${method} \${url}\`,
        };
    }
    catch (err) {
        if (timer && err instanceof Error && err.name === "AbortError") {
            return {
                exitCode: null,
                signal: null,
                timedOut: true,
                errorMessage: \`HTTP \${method} \${url} timed out after \${timeoutMs}ms\`,
                errorCode: "timeout",
            };
        }
        throw err;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function isLoopbackHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase());
    }
    catch {
        return false;
    }
}`;

export function patchHttpIndexSource(source) {
  const text = String(source);
  if (sha256(text) === HTTP_INDEX_PATCHED_SHA256) return text;
  if (
    sha256(text) !== HTTP_INDEX_ORIGINAL_SHA256
    || occurrences(text, INDEX_IMPORT_ORIGINAL) !== 1
    || occurrences(text, INDEX_TEST_IMPORT) !== 1
    || occurrences(text, INDEX_MODELS_ORIGINAL) !== 1
  ) {
    throw compatError('Paperclip HTTP index源码SHA或补丁锚点不匹配，拒绝修改未知版本。');
  }
  const patched = text
    .replace(INDEX_IMPORT_ORIGINAL, INDEX_IMPORT_PATCHED)
    .replace(INDEX_TEST_IMPORT, `${INDEX_TEST_IMPORT}\n${SECURE_EXECUTE}`)
    .replace(INDEX_MODELS_ORIGINAL, INDEX_MODELS_PATCHED);
  if (sha256(patched) !== HTTP_INDEX_PATCHED_SHA256) {
    throw compatError('Paperclip HTTP index目标SHA不匹配，拒绝写入。');
  }
  return patched;
}

export async function resolveCompatibilityTargets({ paperclipEntry } = {}) {
  const paperclipRoot = await packageRootForEntry(paperclipEntry, 'paperclipai');
  const paperclipPackage = await readPackage(path.join(paperclipRoot, 'package.json'));
  if (paperclipPackage.version !== PAPERCLIP_VERSION) {
    throw compatError(`只允许 Paperclip ${PAPERCLIP_VERSION}，当前为 ${paperclipPackage.version || 'unknown'}。`);
  }
  const serverRoot = path.join(path.dirname(paperclipRoot), '@paperclipai', 'server');
  const serverPackage = await readPackage(path.join(serverRoot, 'package.json'));
  if (serverPackage.name !== '@paperclipai/server' || serverPackage.version !== PAPERCLIP_VERSION) {
    throw compatError('Paperclip server包名或版本不匹配。');
  }
  const indexFile = path.join(serverRoot, INDEX_RELATIVE_PATH);
  await assertInside(serverRoot, indexFile);
  return {
    paperclipRoot,
    serverRoot,
    indexFile,
    backupFile:`${indexFile}${BACKUP_SUFFIX}`,
  };
}

export async function applyCompatibilityPatch(options) {
  const targets = await resolveCompatibilityTargets(options);
  const result = await applyVersionLockedFile({
    file:targets.indexFile,
    backupFile:targets.backupFile,
    originalSha:HTTP_INDEX_ORIGINAL_SHA256,
    patchedSha:HTTP_INDEX_PATCHED_SHA256,
    patch:(current) => Buffer.from(patchHttpIndexSource(current.toString('utf8'))),
  });
  return { ...result, ...targets };
}

export async function rollbackCompatibilityPatch(options) {
  const targets = await resolveCompatibilityTargets(options);
  const result = await rollbackVersionLockedFile({
    file:targets.indexFile,
    backupFile:targets.backupFile,
    originalSha:HTTP_INDEX_ORIGINAL_SHA256,
    patchedSha:HTTP_INDEX_PATCHED_SHA256,
  });
  return { ...result, ...targets };
}

async function packageRootForEntry(entryValue, expectedName) {
  const entry = await fs.realpath(path.resolve(required(entryValue, `${expectedName}入口缺失。`)));
  let current = path.dirname(entry);
  for (;;) {
    const record = await readPackage(path.join(current, 'package.json'), { optional:true });
    if (record?.name === expectedName) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw compatError(`入口不属于 ${expectedName} 包。`);
}

async function assertInside(rootValue, fileValue) {
  const root = await fs.realpath(rootValue);
  const file = await fs.realpath(fileValue);
  if (!file.startsWith(`${root}${path.sep}`)) {
    throw compatError('兼容补丁目标路径逃逸Paperclip server包目录。');
  }
}

async function readPackage(file, { optional = false } = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw compatError(`无法读取或解析包元数据：${path.basename(path.dirname(file))}。`);
  }
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function required(value, message) {
  const text = String(value || '').trim();
  if (!text) throw compatError(message);
  return text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compatError(message) {
  const error = new Error(message);
  error.name = 'PaperclipHttpRunJwtCompatError';
  return error;
}
