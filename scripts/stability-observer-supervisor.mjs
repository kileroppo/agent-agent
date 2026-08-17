import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const observerScriptPath = path.join(scriptsDirectory, 'stability-observer.mjs');
const TERMINAL_EXIT_CODES = new Set([0, 2]);
const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code, signal) => finish(resolve, { code, signal }));
  });
}

function sanitizedSpawnError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  return new Error(`稳定性观察子进程启动失败（${code}）。`);
}

/**
 * Run the real observer as a child while keeping launchd from restarting a
 * completed run. Exit 0 and identity-gate exit 2 are both terminal outcomes;
 * the supervisor parks until launchd asks it to stop.
 */
export async function superviseObserver(observerArgs, {
  spawnImpl = spawn,
  nodePath = process.execPath,
  observerPath = observerScriptPath,
} = {}) {
  let child = null;
  let requestedSignal = null;
  let wakePark = null;
  let parkTimer = null;

  const requestShutdown = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    wakePark?.();
  };
  const signalHandlers = Object.fromEntries(FORWARDED_SIGNALS.map((signal) => [
    signal,
    () => requestShutdown(signal),
  ]));
  for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler);

  try {
    try {
      child = spawnImpl(nodePath, [observerPath, ...observerArgs], {
        cwd:process.cwd(),
        env:process.env,
        stdio:'inherit',
      });
    } catch (error) {
      throw sanitizedSpawnError(error);
    }

    let outcome;
    try {
      outcome = await waitForChild(child);
    } catch (error) {
      throw sanitizedSpawnError(error);
    }
    child = null;

    // A launchd stop request is successful only after the observer has exited,
    // which guarantees its finally block had a chance to release observe.lock.
    if (requestedSignal) return 0;

    if (!TERMINAL_EXIT_CODES.has(outcome.code)) {
      return Number.isSafeInteger(outcome.code) ? outcome.code : 1;
    }

    await new Promise((resolve) => {
      wakePark = resolve;
      // Keep the event loop alive without polling the observer or its artifacts.
      parkTimer = setInterval(() => {}, 60 * 60 * 1_000);
      if (requestedSignal) resolve();
    });
    return 0;
  } finally {
    if (parkTimer) clearInterval(parkTimer);
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      process.removeListener(signal, handler);
    }
  }
}

async function main() {
  const exitCode = await superviseObserver(process.argv.slice(2));
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}
