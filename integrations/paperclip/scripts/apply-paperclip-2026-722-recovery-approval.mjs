#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyRecoveryApprovalPatch,
  PAPERCLIP_VERSION,
} from '../compat/paperclip-2026-722-recovery-approval.mjs';

const CONFIRMATION = 'I_ACCEPT_PAPERCLIP_2026_722_RECOVERY_APPROVAL_PATCH';

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options['confirm-version'] !== PAPERCLIP_VERSION) {
    throw new Error(`必须显式确认 --confirm-version ${PAPERCLIP_VERSION}。`);
  }
  if (options['confirm-apply'] !== CONFIRMATION) {
    throw new Error(`未应用：必须显式传入 --confirm-apply ${CONFIRMATION}。`);
  }
  const result = await applyRecoveryApprovalPatch({
    paperclipEntry:required(options['paperclip-entry'], '--paperclip-entry 缺失。'),
  });
  return {
    status:result.status,
    changed:result.changed,
    routeFile:result.routeFile,
    backupFile:result.backupFile,
  };
}

function parseArgs(args) {
  const allowed = new Set([
    'paperclip-entry',
    'confirm-version',
    'confirm-apply',
  ]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const item = args[index];
    const key = item?.startsWith('--') ? item.slice(2) : '';
    const value = args[index + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || key in result) {
      throw new Error(`参数无效：${item || '(empty)'}。`);
    }
    result[key] = value;
  }
  return result;
}

function required(value, message) {
  const text = String(value || '').trim();
  if (!text) throw new Error(message);
  return text;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    process.stderr.write(
      `${String(error?.message || 'Recovery approval兼容补丁应用失败。')}\n`,
    );
    process.exitCode = 1;
  }
}
