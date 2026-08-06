import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(
  process.env.AGENT_ARMY_ARCHITECTURE_ROOT
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
);
const sourceRoots = ['apps', 'integrations', 'packages'];
const ignoredSegments = new Set(['node_modules', 'data', 'dist', 'build', 'work', 'test', 'tests']);
const sourceExtensions = new Set(['.js', '.mjs']);
const retiredAjunM5Facades = new Set([
  'm5-campaign-domain.js',
  'm5-content-version.js',
  'm5-route-execution.js',
  'm5-routine-execution-contract.js',
  'm5-work-product-integrity.js',
]);
const responsibilityLineLimits = new Map([
  ['apps/ajun-runtime/src/task-service.js', 1200],
  ['apps/ajun-runtime/src/task-service-execution.js', 1700],
  ['apps/ajun-runtime/src/task-service-execution-support.js', 1100],
  ['integrations/m5-kernel/src/content-campaign-kernel.js', 1000],
  ['integrations/m5-kernel/src/content-campaign-execution.js', 1300],
  ['integrations/m5-kernel/src/content-campaign-execution-support.js', 1300],
  ['integrations/publishing/m5-publisher-gateway/src/gateway.js', 1400],
]);
const violations = [];
const manifestCache = new Map();
const workspaceManifests = await discoverWorkspaceManifests();

async function walk(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes:true })) {
    if (ignoredSegments.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await walk(target));
    else if (sourceExtensions.has(path.extname(entry.name))) rows.push(target);
  }
  return rows;
}

for (const sourceRoot of sourceRoots) {
  const directory = path.join(root, sourceRoot);
  const files = await walk(directory).catch(() => []);
  for (const file of files) {
    const relative = path.relative(root, file);
    const source = await fs.readFile(file, 'utf8');
    const portableRelative = relative.split(path.sep).join('/');
    const lineLimit = responsibilityLineLimits.get(portableRelative);
    if (lineLimit && source.split(/\r?\n/).length > lineLimit) {
      violations.push(`${portableRelative}: 责任模块超过 ${lineLimit} 行，请先提取有明确边界的协作者再继续扩展`);
    }
    const ownerManifest = await owningPackageManifest(file);
    const productionSource = !relative.split(path.sep).some((segment) => ['test', 'tests', 'scripts'].includes(segment));
    if (relative.startsWith('packages/')) {
      for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        if (!match[1].startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), match[1]);
        if (resolved.startsWith(path.join(root, 'apps')) || resolved.startsWith(path.join(root, 'integrations'))) {
          violations.push(`${relative}: packages 不得反向依赖 apps 或 integrations（${match[1]}）`);
        }
      }
    }
    if (/\/data\/runtime\.json(?:["']|$)/.test(source)) {
      violations.push(`${relative}: 生产源码不得静态导入 runtime.json`);
    }
    if (relative.startsWith(`apps${path.sep}ajun-runtime${path.sep}src${path.sep}`)
      && retiredAjunM5Facades.has(path.basename(relative))) {
      violations.push(`${relative}: 已退役的 M5 转发门面不得回流，请直接使用 m5-kernel 包 exports`);
    }
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      if (!match[1].startsWith('.')) {
        const target = workspaceManifests.get(packageNameFromSpecifier(match[1]));
        if (productionSource && target && ownerManifest && ownerManifest.name !== target.name) {
          assertDeclaredDependency({ ownerManifest, targetManifest:target, relative, specifier:match[1] });
        }
        continue;
      }
      const resolved = path.resolve(path.dirname(file), match[1]);
      const targetManifest = await owningPackageManifest(resolved);
      if (!targetManifest || !ownerManifest || ownerManifest.name === targetManifest.name) continue;
      if (!productionSource) continue;
      assertDeclaredDependency({ ownerManifest, targetManifest, relative, specifier:match[1] });
      violations.push(`${relative}: 生产源码不得用深相对路径跨 workspace（${match[1]} -> ${targetManifest.name}），请使用包 exports`);
      const sharedPackage = await sharedPackageFor(resolved);
      if (!sharedPackage) continue;
      const declared = {
        ...ownerManifest.dependencies,
        ...ownerManifest.devDependencies,
        ...ownerManifest.optionalDependencies,
      };
      if (!Object.hasOwn(declared, sharedPackage.name)) {
        violations.push(`${relative}: 使用 ${sharedPackage.name} 前必须在所属 package.json 声明依赖`);
      }
    }
    for (const duplicate of duplicateClassMethods(source)) {
      violations.push(`${relative}: class ${duplicate.className} 重复声明方法 ${duplicate.methodName}`);
    }
  }
}

function assertDeclaredDependency({ ownerManifest, targetManifest, relative, specifier }) {
  const declared = {
    ...ownerManifest.dependencies,
    ...ownerManifest.devDependencies,
    ...ownerManifest.peerDependencies,
    ...ownerManifest.optionalDependencies,
  };
  if (!Object.hasOwn(declared, targetManifest.name)) {
    violations.push(`${relative}: 跨 workspace 使用 ${targetManifest.name} 前必须声明依赖（${specifier}）`);
  }
}

function packageNameFromSpecifier(specifier) {
  const parts = String(specifier || '').split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function discoverWorkspaceManifests() {
  const manifests = new Map();
  for (const sourceRoot of sourceRoots) {
    const directory = path.join(root, sourceRoot);
    for (const file of await walkManifests(directory).catch(() => [])) {
      const manifest = await readManifest(file);
      if (manifest?.name) manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

async function walkManifests(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes:true })) {
    if (ignoredSegments.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await walkManifests(target));
    else if (entry.name === 'package.json') rows.push(target);
  }
  return rows;
}

async function owningPackageManifest(file) {
  let directory = path.dirname(file);
  while (directory.startsWith(root) && directory !== root) {
    const manifestPath = path.join(directory, 'package.json');
    const manifest = await readManifest(manifestPath);
    if (manifest) return manifest;
    directory = path.dirname(directory);
  }
  return null;
}

async function sharedPackageFor(resolved) {
  const packagesRoot = path.join(root, 'packages');
  if (!resolved.startsWith(`${packagesRoot}${path.sep}`)) return null;
  const packageDirectory = path.join(packagesRoot, path.relative(packagesRoot, resolved).split(path.sep)[0]);
  return readManifest(path.join(packageDirectory, 'package.json'));
}

async function readManifest(manifestPath) {
  if (manifestCache.has(manifestPath)) return manifestCache.get(manifestPath);
  const manifest = await fs.readFile(manifestPath, 'utf8')
    .then(JSON.parse)
    .then((value) => ({ ...value, __directory:path.dirname(manifestPath) }))
    .catch(() => null);
  manifestCache.set(manifestPath, manifest);
  return manifest;
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('architecture boundaries: ok');
}

function duplicateClassMethods(source) {
  const duplicates = [];
  const lines = source.split(/\r?\n/);
  let active = null;
  for (const line of lines) {
    const classMatch = line.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      active = /\{\s*\}\s*$/.test(line) ? null : { className:classMatch[1], methods:new Set() };
      continue;
    }
    if (!active) continue;
    if (line === '}') {
      active = null;
      continue;
    }
    const methodMatch = line.match(/^  (?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{$/);
    if (!methodMatch || methodMatch[1] === 'constructor') continue;
    if (active.methods.has(methodMatch[1])) {
      duplicates.push({ className:active.className, methodName:methodMatch[1] });
    }
    active.methods.add(methodMatch[1]);
  }
  return duplicates;
}
