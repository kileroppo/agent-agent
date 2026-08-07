import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const NO_SIDE_EFFECT_HERMES_ARGS = Object.freeze([
  '--toolsets',
  'clarify',
]);

export function defaultHermesCommand() {
  return process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local', 'bin', 'hermes');
}

export function runHermesCommand(command, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => execFile(
    command,
    args,
    { timeout:timeoutMs, maxBuffer:16 * 1024, env },
    (error, stdout) => error ? reject(error) : resolve(stdout),
  ));
}

export function parseHermesJson(raw) {
  return JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

export function cleanHermesText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
