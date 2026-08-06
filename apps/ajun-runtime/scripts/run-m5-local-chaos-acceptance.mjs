#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  runM5LocalChaosAcceptance,
} from '../src/m5-local-chaos-acceptance.js';

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    throw new Error('M5 本地 chaos 验收不接收外部目标、凭据或发布参数。');
  }
  return runM5LocalChaosAcceptance();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || 'M5 本地 chaos 验收失败。')}\n`);
    process.exitCode = 1;
  }
}
