import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  patchHermesExecuteSource,
  resolveCompatibilityTargets,
  rewriteHermesExecuteSource,
  shouldForwardHermesChildLog,
} from '../compat/paperclip-2026-722-hermes-quiet-transcript.ts';
import { main as applyMain } from '../scripts/apply-paperclip-2026-722-hermes-quiet-transcript.mjs';
import { main as rollbackMain } from '../scripts/rollback-paperclip-2026-722-hermes-quiet-transcript.mjs';

const ORIGINAL_BRIDGE_FIXTURE = `    // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
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

test('安静模式屏蔽草稿stdout，但保留真实stderr', () => {
  assert.equal(shouldForwardHermesChildLog({ useQuiet:true, stream:'stdout', chunk:'内部推理', quietResponseReady:false }), false);
  assert.equal(shouldForwardHermesChildLog({ useQuiet:true, stream:'stderr', chunk:'\nsession_id: example-session\n' }), false);
  assert.equal(shouldForwardHermesChildLog({ useQuiet:true, stream:'stdout', chunk:'最终结论', quietResponseReady:true }), true);
  assert.equal(shouldForwardHermesChildLog({ useQuiet:false, stream:'stdout', chunk:'可见输出' }), true);
  assert.equal(shouldForwardHermesChildLog({ useQuiet:true, stream:'stderr', chunk:'ERROR: provider failed' }), true);
  assert.equal(shouldForwardHermesChildLog({ useQuiet:true, stream:'stderr', chunk:'[2026-08-16T10:00:00Z] INFO: MCP ready' }), false);
  assert.equal(shouldForwardHermesChildLog({ useQuiet:true, stream:'stderr', chunk:'Successfully registered all tools' }), false);
  assert.equal(shouldForwardHermesChildLog({ useQuiet:true, stream:'stderr', chunk:'⚠ Deprecated .env settings detected:\n  TERMINAL_CWD=example' }), false);
});

test('日志桥接改写只命中一次，并把草稿留在最终结果解析路径', () => {
  const parseLine = '    const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");';
  const rewritten = rewriteHermesExecuteSource(`before\n${ORIGINAL_BRIDGE_FIXTURE}\n${parseLine}\nafter`);
  assert.match(rewritten, /useQuiet && stream === "stdout"/);
  assert.match(rewritten, /quietResponseReady/);
  assert.match(rewritten, /quietFinalResponse \+= chunk/);
  assert.match(rewritten, /parsed\.response = cleanResponse\(quietFinalResponse\)/);
  assert.match(rewritten, /Real stderr still passes through/);
  assert.doesNotMatch(rewritten, /return ctx\.onLog\("stdout", chunk\)/);
  assert.throws(() => rewriteHermesExecuteSource('unknown'), /锚点不匹配/);
  assert.throws(() => rewriteHermesExecuteSource(`${ORIGINAL_BRIDGE_FIXTURE}\n${ORIGINAL_BRIDGE_FIXTURE}\n${parseLine}`), /锚点不匹配/);
});

test('未知源码、未知版本与未确认CLI均失败关闭', async (context) => {
  assert.throws(() => patchHermesExecuteSource('unknown'), /SHA不匹配/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-hermes-quiet-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const paperclipRoot = path.join(root, 'node_modules', 'paperclipai');
  const adapterRoot = path.join(root, 'node_modules', '@paperclipai', 'hermes-paperclip-adapter');
  const paperclipEntry = path.join(paperclipRoot, 'dist', 'index.js');
  const executeFile = path.join(adapterRoot, 'dist', 'server', 'execute.js');
  await fs.mkdir(path.dirname(paperclipEntry), { recursive:true });
  await fs.mkdir(path.dirname(executeFile), { recursive:true });
  await fs.writeFile(path.join(paperclipRoot, 'package.json'), JSON.stringify({ name:'paperclipai', version:'2099.1.0' }));
  await fs.writeFile(path.join(adapterRoot, 'package.json'), JSON.stringify({ name:'@paperclipai/hermes-paperclip-adapter', version:'2026.722.0' }));
  await fs.writeFile(paperclipEntry, '');
  await fs.writeFile(executeFile, '');
  await assert.rejects(resolveCompatibilityTargets({ paperclipEntry }), /只允许 Paperclip 2026\.722\.0/);
  await assert.rejects(applyMain([]), /显式确认/);
  await assert.rejects(rollbackMain([]), /显式确认/);
});
