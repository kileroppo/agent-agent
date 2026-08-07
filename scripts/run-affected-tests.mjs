import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_WIDE_PREFIXES = Object.freeze(['scripts/']);
const AJUN_SHARED_PREFIXES = Object.freeze(['agents/', 'docs/contracts/']);
const AJUN_MODULE_TESTS = Object.freeze({
  'src/paperclip-task-projector.js': Object.freeze([
    'test/paperclip-task-projector.test.js',
    'test/paperclip-bridge.test.js',
  ]),
  'src/task-capability-catalog.js': Object.freeze([
    'test/task-capability-catalog.test.js',
    'test/business-task-routing.test.js',
    'test/open-task-routing.test.js',
    'test/task-service.test.js',
  ]),
  'src/task-execution-coordinator.js': Object.freeze([
    'test/task-execution-coordinator.test.js',
    'test/task-service.test.js',
  ]),
  'src/task-intake.js': Object.freeze([
    'test/task-service.test.js',
    'test/open-task-runtime-wiring.test.js',
  ]),
  'src/task-notification.js': Object.freeze([
    'test/task-service.test.js',
    'test/cross-agent-mission-service.test.js',
  ]),
  'src/task-paperclip-assignment.js': Object.freeze([
    'test/task-service.test.js',
    'test/m5-role-tool-execution.test.js',
    'test/paperclip-employee-assignment.test.js',
  ]),
  'src/task-role-execution.js': Object.freeze([
    'test/task-service.test.js',
    'test/m5-role-tool-execution.test.js',
    'test/local-content-growth.test.js',
  ]),
  'src/task-overview-focus.js': Object.freeze([
    'test/task-overview-focus.test.js',
    'test/task-service.test.js',
  ]),
});

export function discoverWorkspaces(root = DEFAULT_ROOT) {
  const rootManifest = readJson(path.join(root, 'package.json'));
  const directories = expandWorkspacePatterns(root, rootManifest.workspaces || []);
  const workspaces = new Map();
  for (const directory of directories) {
    const manifest = readJson(path.join(root, directory, 'package.json'));
    if (!manifest.name) throw new Error(`${directory}/package.json 缺少 name`);
    if (workspaces.has(manifest.name)) throw new Error(`重复 workspace 名称：${manifest.name}`);
    const declaredDependencies = new Set(Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    }));
    workspaces.set(manifest.name, {
      name:manifest.name,
      directory:toPosix(directory),
      manifest,
      declaredDependencies,
    });
  }
  const workspaceNames = new Set(workspaces.keys());
  for (const workspace of workspaces.values()) {
    workspace.dependencies = new Set(
      [...workspace.declaredDependencies].filter((name) => workspaceNames.has(name)),
    );
  }
  return workspaces;
}

export function selectAffectedWorkspaces(changedFiles, workspaces) {
  const changed = [...new Set(changedFiles.map(toPosix).filter(Boolean))];
  const selected = new Set();
  const rootWide = changed.some((file) => file === 'package.json'
    || ROOT_WIDE_PREFIXES.some((prefix) => file.startsWith(prefix)));
  if (rootWide) {
    for (const name of workspaces.keys()) selected.add(name);
  } else {
    for (const file of changed) {
      const owner = [...workspaces.values()]
        .sort((left, right) => right.directory.length - left.directory.length)
        .find((workspace) => file === workspace.directory || file.startsWith(`${workspace.directory}/`));
      if (owner) selected.add(owner.name);
      if (AJUN_SHARED_PREFIXES.some((prefix) => file.startsWith(prefix)) && workspaces.has('ajun-runtime')) {
        selected.add('ajun-runtime');
      }
    }
  }

  const reverse = reverseDependencies(workspaces);
  const queue = [...selected];
  while (queue.length) {
    const dependency = queue.shift();
    for (const consumer of reverse.get(dependency) || []) {
      if (selected.has(consumer)) continue;
      selected.add(consumer);
      queue.push(consumer);
    }
  }
  return topologicalOrder(selected, workspaces);
}

export function changedFilesFromGit(root = DEFAULT_ROOT) {
  return [
    capture('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'], root),
    capture('git', ['ls-files', '--others', '--exclude-standard'], root),
  ].join('\n').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function selectAffectedTestFiles(changedFiles, workspace) {
  if (workspace?.name !== 'ajun-runtime') return null;
  const workspacePrefix = `${workspace.directory}/`;
  const owned = [...new Set(changedFiles.map(toPosix))]
    .filter((file) => file.startsWith(workspacePrefix))
    .map((file) => file.slice(workspacePrefix.length));
  if (!owned.length) return null;

  const mappedTests = new Set(Object.values(AJUN_MODULE_TESTS).flat());
  const selected = new Set();
  for (const file of owned) {
    const tests = AJUN_MODULE_TESTS[file];
    if (tests) {
      for (const testFile of tests) selected.add(testFile);
      continue;
    }
    if (mappedTests.has(file)) {
      selected.add(file);
      continue;
    }
    return null;
  }
  return [...selected].sort();
}

function expandWorkspacePatterns(root, patterns) {
  const directories = new Set();
  for (const pattern of patterns) {
    const normalized = toPosix(String(pattern || '').replace(/\/$/, ''));
    if (!normalized.includes('*')) {
      if (fs.existsSync(path.join(root, normalized, 'package.json'))) directories.add(normalized);
      continue;
    }
    if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) {
      throw new Error(`test:affected 暂不支持复杂 workspace pattern：${normalized}`);
    }
    const parent = normalized.slice(0, -2);
    for (const entry of fs.readdirSync(path.join(root, parent), { withFileTypes:true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, parent, entry.name, 'package.json'))) {
        directories.add(`${parent}/${entry.name}`);
      }
    }
  }
  return [...directories].sort();
}

function reverseDependencies(workspaces) {
  const reverse = new Map([...workspaces.keys()].map((name) => [name, new Set()]));
  for (const workspace of workspaces.values()) {
    for (const dependency of workspace.dependencies) reverse.get(dependency)?.add(workspace.name);
  }
  return reverse;
}

function topologicalOrder(selected, workspaces) {
  const result = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (name) => {
    if (!selected.has(name) || visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`workspace 依赖存在循环：${[...visiting, name].join(' -> ')}`);
    visiting.add(name);
    for (const dependency of workspaces.get(name)?.dependencies || []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  };
  for (const name of [...selected].sort()) visit(name);
  return result;
}

function verificationScript(manifest) {
  if (manifest.scripts?.test) return 'test';
  if (manifest.scripts?.check) return 'check';
  if (manifest.scripts?.lint) return 'lint';
  return null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function toPosix(value) {
  return String(value || '').replaceAll(path.sep, '/').replace(/^\.\//, '');
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding:'utf8', stdio:['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout || '';
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio:'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const explicit = args.filter((value) => !value.startsWith('--'));
  const workspaces = discoverWorkspaces(DEFAULT_ROOT);
  const changed = explicit.length ? explicit : changedFilesFromGit(DEFAULT_ROOT);
  const selected = selectAffectedWorkspaces(changed, workspaces);
  if (!selected.length) {
    console.log('affected tests: no workspace affected');
    return;
  }
  console.log(`affected tests: ${selected.join(', ')}`);
  if (listOnly) return;
  for (const name of selected) {
    const workspace = workspaces.get(name);
    const affectedTests = selectAffectedTestFiles(changed, workspace);
    if (affectedTests?.length) {
      console.log(`\n[${name}] node --test ${affectedTests.join(' ')}`);
      run('node', ['--test', ...affectedTests], path.join(DEFAULT_ROOT, workspace.directory));
      continue;
    }
    const script = verificationScript(workspace.manifest);
    if (!script) {
      console.log(`\n[${name}] no test/check/lint script; skipped`);
      continue;
    }
    console.log(`\n[${name}] npm run ${script}`);
    run('npm', ['run', script], path.join(DEFAULT_ROOT, workspace.directory));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
