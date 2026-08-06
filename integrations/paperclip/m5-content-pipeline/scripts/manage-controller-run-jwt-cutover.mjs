#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyControllerRunJwtCutover,
  CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
  CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION,
  PaperclipControllerClient,
  rollbackControllerRunJwtCutover,
  snapshotControllerRunJwtCutover,
} from '../src/controller-run-jwt-cutover.js';

export async function main(argv = process.argv.slice(2), {
  clientFactory = (apiBase) => new PaperclipControllerClient({ apiBase }),
} = {}) {
  const options = parseArgs(argv);
  const client = clientFactory(options['api-base']);
  if (options.mode === 'snapshot') {
    return snapshotControllerRunJwtCutover({
      client,
      snapshotPath:options.snapshot,
    });
  }
  if (options.mode === 'apply') {
    return applyControllerRunJwtCutover({
      client,
      snapshotPath:options.snapshot,
      confirmation:options.confirm,
    });
  }
  return rollbackControllerRunJwtCutover({
    client,
    snapshotPath:options.snapshot,
    confirmation:options.confirm,
  });
}

export function parseArgs(args) {
  const allowed = new Set(['mode', 'api-base', 'snapshot', 'confirm']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const item = args[index];
    const key = item?.startsWith('--') ? item.slice(2) : '';
    const value = args[index + 1];
    if (
      !allowed.has(key)
      || !value
      || value.startsWith('--')
      || key in values
    ) {
      throw new Error(`参数无效：${item || '(empty)'}。`);
    }
    values[key] = value;
  }
  if (!['snapshot', 'apply', 'rollback'].includes(values.mode)) {
    throw new Error('--mode 必须是 snapshot、apply 或 rollback。');
  }
  if (!values['api-base']) throw new Error('--api-base 必填。');
  if (!path.isAbsolute(String(values.snapshot || ''))) {
    throw new Error('--snapshot 必须是绝对路径。');
  }
  if (values.mode === 'snapshot' && values.confirm) {
    throw new Error('snapshot 模式不接受写入确认串。');
  }
  if (
    values.mode === 'apply'
    && values.confirm !== CONTROLLER_RUN_JWT_APPLY_CONFIRMATION
  ) {
    throw new Error(
      `apply 必须显式确认 ${CONTROLLER_RUN_JWT_APPLY_CONFIRMATION}。`,
    );
  }
  if (
    values.mode === 'rollback'
    && values.confirm !== CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION
  ) {
    throw new Error(
      `rollback 必须显式确认 ${CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION}。`,
    );
  }
  return values;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  try {
    process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${String(error?.message || 'M5 controller forwardRunJwt 工具失败。')}\n`,
    );
    process.exitCode = error?.recoveryRequired ? 4 : 1;
  }
}
