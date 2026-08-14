import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
export const NO_SIDE_EFFECT_HERMES_ARGS: any = Object.freeze([
    '--toolsets',
    'clarify',
]);
export function defaultHermesCommand(): any {
    return process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local', 'bin', 'hermes');
}
export function runHermesCommand(command: any, args: any, { timeoutMs, env }: any): any {
    return new Promise((resolve: any, reject: any): any => execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024, env }, (error: any, stdout: any): any => error ? reject(error) : resolve(stdout)));
}
export function parseHermesJson(raw: any): any {
    return JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
export function cleanHermesText(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
