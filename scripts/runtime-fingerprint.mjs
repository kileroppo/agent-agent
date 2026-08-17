import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SERVICES = Object.freeze({
  ajun:Object.freeze({ port:4321, endpoint:'/api/health', required:true }),
  xiaod:Object.freeze({ port:4318, endpoint:'/api/health', required:true }),
  paperclip:Object.freeze({ port:3100, endpoint:'/api/health', required:true }),
  publisher:Object.freeze({ port:4390, endpoint:'/health', required:false }),
});

export function parseGitStatusPorcelain(output = '') {
  const lines = String(output).split(/\r?\n/).filter(Boolean);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith('??')) {
      untracked += 1;
      continue;
    }
    if (line[0] && line[0] !== ' ') staged += 1;
    if (line[1] && line[1] !== ' ') unstaged += 1;
  }
  return Object.freeze({
    clean:lines.length === 0,
    changedPathCount:lines.length,
    stagedPathCount:staged,
    unstagedPathCount:unstaged,
    untrackedPathCount:untracked,
  });
}

export function findReleaseIdentity(startDir, { exists = fs.existsSync, read = fs.readFileSync } = {}) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = path.join(current, 'release-manifest.json');
    if (exists(manifestPath)) {
      let manifest;
      try {
        manifest = JSON.parse(read(manifestPath, 'utf8'));
      } catch {
        return Object.freeze({ status:'invalid_manifest' });
      }
      if (manifest?.kind !== 'agent-army/ajun-immutable-runtime-release') {
        return Object.freeze({ status:'unexpected_manifest_kind' });
      }
      const releaseHash = normalizedSha256(manifest.releaseHash)
        || normalizedSha256(path.basename(current).match(/-([0-9a-f]{64})$/i)?.[1]);
      return Object.freeze({
        status:'immutable_release',
        releaseHash,
        payloadHash:normalizedSha256(manifest.payloadHash),
        gitHead:normalizedGitHead(manifest.git?.gitHead),
        worktreeState:String(manifest.git?.worktreeState || '').trim() || null,
        runtimeAbi:manifest.runtimeAbi ? Object.freeze({
          node:String(manifest.runtimeAbi.node || '') || null,
          platform:String(manifest.runtimeAbi.platform || '') || null,
          arch:String(manifest.runtimeAbi.arch || '') || null,
        }) : null,
      });
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return Object.freeze({ status:'mutable_or_unknown_runtime' });
}

export function summarizeServiceHealth(service, response) {
  const body = response?.body && typeof response.body === 'object' ? response.body : {};
  const base = {
    reachable:response?.httpStatus >= 200 && response?.httpStatus < 500,
    httpStatus:Number.isInteger(response?.httpStatus) ? response.httpStatus : null,
  };
  if (service === 'ajun') {
    return Object.freeze({
      ...base,
      status:String(body.status || 'unknown'),
      coreStatus:String(body.core?.status || 'unknown'),
      employeeCount:safeInteger(body.summary?.employeeCount),
      optional:Array.isArray(body.optional?.components)
        ? Object.freeze(body.optional.components.map((item) => Object.freeze({
          id:String(item?.id || ''),
          status:String(item?.status || 'unknown'),
        })).filter((item) => item.id))
        : Object.freeze([]),
    });
  }
  if (service === 'paperclip') {
    return Object.freeze({
      ...base,
      status:String(body.status || 'unknown'),
      version:String(body.version || body.serverVersion || '') || null,
      deploymentMode:String(body.deploymentMode || '') || null,
      authReady:typeof body.authReady === 'boolean' ? body.authReady : null,
      bootstrapStatus:String(body.bootstrapStatus || '') || null,
    });
  }
  if (service === 'publisher') {
    return Object.freeze({
      ...base,
      status:String(body.status || 'unknown'),
      mode:String(body.mode || 'unknown'),
      hardStop:typeof body.hardStop === 'boolean' ? body.hardStop : null,
      realConnectorsConfigured:typeof body.realConnectorsConfigured === 'boolean'
        ? body.realConnectorsConfigured
        : null,
    });
  }
  return Object.freeze({
    ...base,
    ok:body.ok === true,
    capabilities:body.capabilities && typeof body.capabilities === 'object'
      ? Object.freeze(Object.fromEntries(
        Object.entries(body.capabilities)
          .filter(([, value]) => typeof value === 'boolean')
          .map(([key, value]) => [key, value]),
      ))
      : Object.freeze({}),
  });
}

export async function collectRuntimeFingerprint({
  root = process.cwd(),
  command = runCommand,
  request = requestJson,
  releaseIdentity = findReleaseIdentity,
  now = () => new Date(),
} = {}) {
  const repositoryRoot = path.resolve(root);
  const source = collectSourceIdentity(repositoryRoot, command);
  const serviceEntries = await Promise.all(Object.entries(SERVICES).map(async ([name, config]) => {
    const processIdentity = inspectListener(config.port, command);
    const response = await request(`http://127.0.0.1:${config.port}${config.endpoint}`);
    const health = summarizeServiceHealth(name, response);
    const runtime = name === 'ajun' && processIdentity.cwd
      ? releaseIdentity(processIdentity.cwd)
      : null;
    return [name, Object.freeze({ ...processIdentity, ...health, ...(runtime ? { runtime } : {}) })];
  }));
  const services = Object.freeze(Object.fromEntries(serviceEntries));
  const liveGitHead = services.ajun.runtime?.gitHead || null;
  const sourceLiveRelationship = source.gitHead && liveGitHead
    ? (liveGitHead === source.gitHead ? 'same_git_head' : 'different_git_head')
    : 'unproven';
  const requiredReachable = Object.entries(SERVICES)
    .filter(([, config]) => config.required)
    .every(([name]) => serviceIsHealthy(name, services[name]));
  return Object.freeze({
    schemaVersion:'agent.army/runtime-fingerprint/v1',
    generatedAt:now().toISOString(),
    safety:Object.freeze({ readOnly:true, secretsRead:false, externalEffects:false }),
    status:requiredReachable ? 'observed' : 'degraded',
    source,
    live:Object.freeze({
      sourceRelationship:sourceLiveRelationship,
      services,
    }),
  });
}

function serviceIsHealthy(name, service) {
  if (!service?.reachable) return false;
  if (name === 'ajun') return service.status === 'healthy' && service.coreStatus === 'healthy';
  if (name === 'xiaod') return service.ok === true;
  if (name === 'paperclip') return ['ok', 'healthy', 'ready'].includes(service.status);
  return true;
}

function collectSourceIdentity(root, command) {
  const gitHead = normalizedGitHead(command('git', ['rev-parse', 'HEAD'], { cwd:root }));
  const branch = command('git', ['branch', '--show-current'], { cwd:root }).trim() || null;
  const status = parseGitStatusPorcelain(command('git', ['status', '--porcelain=v1'], { cwd:root }));
  return Object.freeze({
    repositoryRoot:root,
    branch,
    gitHead,
    ...status,
  });
}

function inspectListener(port, command) {
  const pidText = command('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { optional:true });
  const pid = Number.parseInt(pidText.split(/\r?\n/).find(Boolean) || '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return Object.freeze({ pid:null, cwd:null });
  const cwdOutput = command('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { optional:true });
  const cwd = cwdOutput.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) || null;
  return Object.freeze({ pid, cwd });
}

function runCommand(file, args, { cwd, optional = false } = {}) {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding:'utf8',
      stdio:['ignore', 'pipe', optional ? 'ignore' : 'pipe'],
    });
  } catch (error) {
    if (optional) return '';
    throw error;
  }
}

async function requestJson(url) {
  try {
    const response = await fetch(url, { signal:AbortSignal.timeout(3_000) });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    return { httpStatus:response.status, body };
  } catch {
    return { httpStatus:null, body:{} };
  }
}

function normalizedSha256(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function normalizedGitHead(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function main() {
  const fingerprint = await collectRuntimeFingerprint({ root:path.resolve(process.cwd()) });
  process.stdout.write(`${JSON.stringify(fingerprint, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
