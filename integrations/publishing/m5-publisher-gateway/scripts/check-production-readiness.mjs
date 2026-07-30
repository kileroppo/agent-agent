#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProductionReadinessReport } from '../src/production-readiness.js';

const HEALTH_URL = 'http://127.0.0.1:4390/health';
const MAX_SNAPSHOT_BYTES = 64 * 1024;

export function parseArguments(argv) {
  const output = { snapshot:'' };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--snapshot') {
      throw coded('production_readiness_argument_unknown', `未知参数：${option}`);
    }
    const value = argv[++index];
    if (
      typeof value !== 'string'
      || !value
      || path.extname(value).toLowerCase() !== '.json'
      || path.basename(value).startsWith('.')
    ) {
      throw coded(
        'production_readiness_snapshot_path_invalid',
        '预检输入快照必须是明确的非隐藏 JSON 文件。',
      );
    }
    output.snapshot = value;
  }
  return output;
}

export async function main(argv = process.argv.slice(2), {
  probeHealth = probePublisherHealth,
  loadSnapshot = loadReadinessInputSnapshot,
  stdout = process.stdout,
} = {}) {
  const args = parseArguments(argv);
  const [healthSnapshot, inputSnapshot] = await Promise.all([
    probeHealth(),
    args.snapshot ? loadSnapshot(args.snapshot) : null,
  ]);
  const report = await createProductionReadinessReport({
    healthSnapshot,
    inputSnapshot,
  });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function probePublisherHealth({ fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(HEALTH_URL, {
      method:'GET',
      signal:controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      reachable:true,
      port:4390,
      httpStatus:response.status,
      body,
    };
  } catch (error) {
    return {
      reachable:false,
      port:4390,
      httpStatus:null,
      errorCode:String(error?.name || error?.code || 'health_unavailable'),
      body:null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadReadinessInputSnapshot(file, fileSystem = fs) {
  const target = path.resolve(file);
  let stat;
  try {
    stat = await fileSystem.lstat(target);
  } catch {
    throw coded(
      'production_readiness_snapshot_unavailable',
      '生产预检输入快照不存在或不可读。',
    );
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > MAX_SNAPSHOT_BYTES
    || (stat.mode & 0o022) !== 0
    || await fileSystem.realpath(target) !== target
  ) {
    throw coded(
      'production_readiness_snapshot_unsafe',
      '生产预检输入快照必须是不可由组或其他用户写入的普通非链接文件。',
    );
  }
  let handle;
  try {
    handle = await fileSystem.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || opened.size !== stat.size
      || (opened.mode & 0o022) !== 0
    ) {
      throw coded(
        'production_readiness_snapshot_changed',
        '生产预检输入快照在安全核验期间发生变化。',
      );
    }
    const bytes = await handle.readFile();
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw coded(
        'production_readiness_snapshot_json_invalid',
        '生产预检输入快照不是有效 JSON。',
      );
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (invokedPath === import.meta.url) {
  main().then((report) => {
    if (report.status !== 'ready') process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(
      `${String(error?.code || 'production_readiness_failed')}: ${String(error?.message || error)}\n`,
    );
    process.exitCode = 1;
  });
}
