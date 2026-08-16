import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    applyVersionLockedFile,
    rollbackVersionLockedFile,
} from './paperclip-2026-722-binary-rpc.ts';

export const PAPERCLIP_VERSION: any = '2026.722.0';
export const HERMES_ADAPTER_VERSION: any = '2026.722.0';
export const EXECUTE_ORIGINAL_SHA256: any = '9c7b06db4cf001e03f2adc514c6c256333a90513a1b42f4144886245057b374a';
export const EXECUTE_PATCHED_SHA256: any = '414517c52cf249d5093e5a4e92559a8597d48fd7de7913a59f0ba0d017698043';
export const BACKUP_SUFFIX: any = '.agent-army-paperclip-2026.722.0-hermes-quiet-transcript.bak';

const EXECUTE_RELATIVE_PATH: any = 'dist/server/execute.js';
const ORIGINAL_LOG_BRIDGE: any = `    // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
    // Paperclip renders all stderr as red/error in the UI.
    // Wrap onLog to reclassify benign stderr lines as stdout.
    const wrappedOnLog = async (stream, chunk) => {
        if (stream === "stderr") {
            const trimmed = chunk.trimEnd();
            // Benign patterns that should NOT appear as errors:
            // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
            // - MCP server registration messages
            // - Python import/site noise
            const isBenign = /^\\[?\\d{4}[-/]\\d{2}[-/]\\d{2}T/.test(trimmed) || // structured timestamps
                /^[A-Z]+:\\s+(INFO|DEBUG|WARN|WARNING)\\b/.test(trimmed) || // log levels
                /Successfully registered all tools/.test(trimmed) ||
                /MCP [Ss]erver/.test(trimmed) ||
                /tool registered successfully/.test(trimmed) ||
                /Application initialized/.test(trimmed);
            if (isBenign) {
                return ctx.onLog("stdout", chunk);
            }
        }
        return ctx.onLog(stream, chunk);
    };`;
const PATCHED_LOG_BRIDGE: any = `    // Quiet mode is the user-facing Paperclip view. Hermes emits private draft
    // reasoning first, a session marker on stderr, then the final response on stdout.
    // Buffer the draft for parsing, hide it from the transcript, and forward only the
    // final response. Real stderr still passes through; benign init noise is hidden.
    let quietResponseReady = false;
    let quietFinalResponse = "";
    const wrappedOnLog = async (stream, chunk) => {
        if (useQuiet && stream === "stderr" && /(?:^|\\n)session_id:\\s*\\S+/.test(chunk)) {
            quietResponseReady = true;
            return;
        }
        if (useQuiet && stream === "stdout") {
            if (!quietResponseReady) {
                return;
            }
            quietFinalResponse += chunk;
        }
        if (stream === "stderr") {
            const trimmed = chunk.trimEnd();
            const isBenign = /^\\[?\\d{4}[-/]\\d{2}[-/]\\d{2}T/.test(trimmed) ||
                /^[A-Z]+:\\s+(INFO|DEBUG|WARN|WARNING)\\b/.test(trimmed) ||
                /Successfully registered all tools/.test(trimmed) ||
                /MCP [Ss]erver/.test(trimmed) ||
                /tool registered successfully/.test(trimmed) ||
                /Application initialized/.test(trimmed) ||
                /Deprecated \.env settings detected/.test(trimmed);
            if (isBenign) {
                return;
            }
        }
        return ctx.onLog(stream, chunk);
    };`;
const PARSE_OUTPUT_ORIGINAL: any = '    const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");';
const PARSE_OUTPUT_PATCHED: any = `    const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");
    if (useQuiet && quietFinalResponse.trim()) {
        parsed.response = cleanResponse(quietFinalResponse);
    }`;

export function shouldForwardHermesChildLog({ useQuiet, stream, chunk, quietResponseReady = false }: any): any {
    if (useQuiet === true && stream === 'stderr' && isQuietSessionMarker(chunk))
        return false;
    if (useQuiet === true && stream === 'stdout')
        return quietResponseReady === true;
    if (stream !== 'stderr')
        return true;
    const trimmed: any = String(chunk || '').trimEnd();
    const isBenign: any = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed)
        || /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed)
        || /Successfully registered all tools/.test(trimmed)
        || /MCP [Ss]erver/.test(trimmed)
        || /tool registered successfully/.test(trimmed)
        || /Application initialized/.test(trimmed)
        || /Deprecated \.env settings detected/.test(trimmed);
    return !isBenign;
}

export function rewriteHermesExecuteSource(source: any): any {
    const text: any = String(source);
    if (occurrences(text, ORIGINAL_LOG_BRIDGE) !== 1 || occurrences(text, PARSE_OUTPUT_ORIGINAL) !== 1) {
        throw compatError('Hermes适配器日志桥接锚点不匹配，拒绝修改。');
    }
    return text
        .replace(ORIGINAL_LOG_BRIDGE, PATCHED_LOG_BRIDGE)
        .replace(PARSE_OUTPUT_ORIGINAL, PARSE_OUTPUT_PATCHED);
}

export function patchHermesExecuteSource(source: any): any {
    const text: any = String(source);
    if (sha256(text) === EXECUTE_PATCHED_SHA256)
        return text;
    if (sha256(text) !== EXECUTE_ORIGINAL_SHA256) {
        throw compatError('Hermes适配器execute源码SHA不匹配，拒绝修改未知版本。');
    }
    const patched: any = rewriteHermesExecuteSource(text);
    if (sha256(patched) !== EXECUTE_PATCHED_SHA256) {
        throw compatError('Hermes适配器execute目标SHA不匹配，拒绝写入。');
    }
    return patched;
}

export async function resolveCompatibilityTargets({ paperclipEntry }: any = {}): Promise<any> {
    const paperclipRoot: any = await packageRootForEntry(paperclipEntry, 'paperclipai');
    const paperclipPackage: any = await readPackage(path.join(paperclipRoot, 'package.json'));
    if (paperclipPackage.version !== PAPERCLIP_VERSION) {
        throw compatError(`只允许 Paperclip ${PAPERCLIP_VERSION}，当前为 ${paperclipPackage.version || 'unknown'}。`);
    }
    const adapterRoot: any = path.join(path.dirname(paperclipRoot), '@paperclipai', 'hermes-paperclip-adapter');
    const adapterPackage: any = await readPackage(path.join(adapterRoot, 'package.json'));
    if (adapterPackage.name !== '@paperclipai/hermes-paperclip-adapter'
        || adapterPackage.version !== HERMES_ADAPTER_VERSION) {
        throw compatError('Hermes Paperclip适配器包名或版本不匹配。');
    }
    const executeFile: any = path.join(adapterRoot, EXECUTE_RELATIVE_PATH);
    await assertInside(adapterRoot, executeFile);
    return {
        paperclipRoot,
        adapterRoot,
        executeFile,
        backupFile: `${executeFile}${BACKUP_SUFFIX}`,
    };
}

export async function applyCompatibilityPatch(options: any): Promise<any> {
    const targets: any = await resolveCompatibilityTargets(options);
    const result: any = await applyVersionLockedFile({
        file: targets.executeFile,
        backupFile: targets.backupFile,
        originalSha: EXECUTE_ORIGINAL_SHA256,
        patchedSha: EXECUTE_PATCHED_SHA256,
        patch: (current: any): any => Buffer.from(patchHermesExecuteSource(current.toString('utf8'))),
    });
    return { ...result, ...targets };
}

export async function rollbackCompatibilityPatch(options: any): Promise<any> {
    const targets: any = await resolveCompatibilityTargets(options);
    const result: any = await rollbackVersionLockedFile({
        file: targets.executeFile,
        backupFile: targets.backupFile,
        originalSha: EXECUTE_ORIGINAL_SHA256,
        patchedSha: EXECUTE_PATCHED_SHA256,
    });
    return { ...result, ...targets };
}

async function packageRootForEntry(entryValue: any, expectedName: any): Promise<any> {
    const entry: any = await fs.realpath(path.resolve(required(entryValue, `${expectedName}入口缺失。`)));
    let current: any = path.dirname(entry);
    for (;;) {
        const record: any = await readPackage(path.join(current, 'package.json'), { optional: true });
        if (record?.name === expectedName)
            return current;
        const parent: any = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    throw compatError(`入口不属于 ${expectedName} 包。`);
}

async function assertInside(rootValue: any, fileValue: any): Promise<any> {
    const root: any = await fs.realpath(rootValue);
    const file: any = await fs.realpath(fileValue);
    if (!file.startsWith(`${root}${path.sep}`))
        throw compatError('兼容补丁目标路径逃逸Hermes适配器包目录。');
}

async function readPackage(file: any, { optional = false }: any = {}): Promise<any> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    }
    catch (error: any) {
        if (optional && error?.code === 'ENOENT')
            return null;
        throw compatError(`无法读取或解析包元数据：${path.basename(path.dirname(file))}。`);
    }
}

function occurrences(source: any, needle: any): any {
    return source.split(needle).length - 1;
}

function isQuietSessionMarker(value: any): any {
    return /(?:^|\n)session_id:\s*\S+/.test(String(value || ''));
}

function required(value: any, message: any): any {
    const text: any = String(value || '').trim();
    if (!text)
        throw compatError(message);
    return text;
}

function sha256(value: any): any {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function compatError(message: any): any {
    const error: any = new Error(message);
    error.name = 'PaperclipHermesQuietTranscriptCompatError';
    return error;
}
