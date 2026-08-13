import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadAjunModulePolicy } from './ajun-module-policy.mjs';

const root = path.resolve(
  process.env.AGENT_ARMY_ARCHITECTURE_ROOT
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
);
const sourceRoots = ['apps', 'integrations', 'packages'];
const ignoredSegments = new Set(['node_modules', 'data', 'dist', 'build', 'work', 'test', 'tests']);
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.mts', '.cts', '.tsx']);
const retiredAjunM5Facades = new Set([
  'm5-campaign-domain',
  'm5-content-version',
  'm5-route-execution',
  'm5-routine-execution-contract',
  'm5-work-product-integrity',
]);
const responsibilityLineLimits = new Map([
  ['integrations/m5-kernel/src/content-campaign-kernel.js', 400],
  ['integrations/m5-kernel/src/campaign-lifecycle.js', 550],
  ['integrations/m5-kernel/src/content-campaign-execution.js', 100],
  ['integrations/m5-kernel/src/campaign-execution-router.js', 400],
  ['integrations/m5-kernel/src/campaign-execution-replay.js', 400],
  ['integrations/m5-kernel/src/campaign-execution-planning.js', 500],
  ['integrations/m5-kernel/src/content-campaign-execution-support.js', 250],
  ['integrations/m5-kernel/src/campaign-work-product-lineage.js', 525],
  ['integrations/m5-kernel/src/campaign-delivery-validation.js', 750],
  ['integrations/m5-kernel/src/stage-recovery-controller.js', 100],
  ['integrations/m5-kernel/src/stage-recovery-state.js', 650],
  ['integrations/m5-kernel/src/stage-recovery-plan-revision.js', 350],
  ['integrations/m5-kernel/src/stage-recovery-execution.js', 400],
  ['integrations/paperclip/m5-content-pipeline/src/reconcile-existing-v2.js', 100],
  ['integrations/paperclip/m5-content-pipeline/src/reconcile-v2-inspection.js', 600],
  ['integrations/paperclip/m5-content-pipeline/src/reconcile-v2-execution.js', 250],
  ['integrations/paperclip/m5-content-pipeline/src/reconcile-v2-recovery.js', 450],
  ['integrations/paperclip/m5-content-pipeline/src/reconcile-v2-journal.js', 350],
  ['integrations/paperclip/m5-content-pipeline/src/controller-run-jwt-cutover.js', 100],
  ['integrations/paperclip/m5-content-pipeline/src/controller-run-jwt-contract.js', 400],
  ['integrations/paperclip/m5-content-pipeline/src/controller-run-jwt-snapshot-store.js', 750],
  ['integrations/paperclip/m5-content-pipeline/src/controller-run-jwt-operations.js', 350],
  ['integrations/paperclip/plugins/content-autonomy/src/media-tools.js', 100],
  ['integrations/paperclip/plugins/content-autonomy/src/media-runtime.js', 350],
  ['integrations/paperclip/plugins/content-autonomy/src/media-provider-lineage.js', 500],
  ['integrations/paperclip/plugins/content-autonomy/src/media-artifact-package.js', 450],
  ['integrations/publishing/m5-publisher-gateway/src/gateway.js', 300],
  ['integrations/publishing/m5-publisher-gateway/src/publish-execution.js', 600],
  ['integrations/publishing/m5-publisher-gateway/src/metric-collection-execution.js', 700],
  ['integrations/publishing/m5-publisher-gateway/src/cua-driver-runner.js', 550],
  ['integrations/publishing/m5-publisher-gateway/src/cua-driver-cli-bridge.js', 500],
  ['integrations/publishing/m5-publisher-gateway/src/cua-semantic-snapshot.js', 450],
]);
const responsibilityImportLimits = new Map([
]);
const repositoryClassifications = new Set([
  'business-agent',
  'compatibility-adapter',
  'delivery-tool',
  'domain-kernel',
  'external-write-gateway',
  'internal-tool',
  'legacy-rollback',
  'platform-adapter',
  'platform-plugin',
  'product-runtime',
  'runtime-worker',
  'shared-client',
  'shared-contract',
  'workflow-adapter',
]);
const repositoryLifecycles = new Set(['active', 'on-demand', 'retained-rollback']);
const delegatedTaskServiceMethods = new Set([
  'approveApproval',
  'completePaperclipAssignment',
  'completePaperclipAssignmentOnce',
  'confirmPaperclipAssignmentCompletion',
  'continueXiaodDelivery',
  'ensurePaperclipAssignmentCompletion',
  'handleM5ReportedFailure',
  'reconcilePendingPaperclipApprovals',
  'recordM5StageExecution',
  'recordM5StageExecutionFailure',
  'rejectApproval',
  'requestTaskControl',
  'resolvePaperclipApproval',
  'runApprovalResolution',
  'syncM5StageWorkProducts',
]);
const semanticShadowRules = new Map([
  ['apps/ajun-runtime/src/feishu-commander-replies.js', [
    [/\b(?:const|let|var)\s+TASK_TYPE_BY_INTENT\b/, '任务意图映射必须从 TaskDefinitionRegistry 读取'],
  ]],
  ['apps/ajun-runtime/src/feishu-commander-routing.js', [
    [/\bdirectTaskTypes\b/, '直达岗位映射必须从 TaskDefinitionRegistry 读取'],
  ]],
  ['apps/ajun-runtime/src/task-card-presentation.js', [
    [/\b(?:const|let|var)\s+TASK_TYPE_LABELS\b/, '任务类型展示名必须从 TaskDefinitionRegistry 读取'],
  ]],
  ['apps/ajun-runtime/src/agent-army-client.js', [
    [/\b(?:const|let|var)\s+TERMINAL_STATUSES\b/, '通知停止状态必须从 TaskStatusPolicy 读取'],
  ]],
  ['apps/ajun-runtime/src/paperclip-assignment-completion.js', [
    [/\bCOMPLETABLE_TASK_STATUSES\b/, 'Paperclip 完成状态必须从 TaskStatusPolicy 读取'],
  ]],
  ['apps/ajun-runtime/src/workflow/delivery-quality-runtime.ts', [
    [/\bcreateLifecycleRecorder\b/, '生命周期事件记录必须复用 TaskLifecycleEventRecorder'],
    [/\bBLOCKED_STATUSES\b/, '阻塞状态必须从 TaskStatusPolicy 读取'],
  ]],
]);
const violations = [];
let ajunModulePolicy;
try {
  ajunModulePolicy = loadAjunModulePolicy(root);
} catch (error) {
  violations.push(error.message);
  ajunModulePolicy = {
    moduleRule:() => null,
    testFileLineLimits:() => new Map(),
    testGroupLineLimits:() => [],
  };
}
const responsibilityTestLineLimits = ajunModulePolicy.testFileLineLimits();
const responsibilityTestGroupLineLimits = ajunModulePolicy.testGroupLineLimits();
const manifestCache = new Map();
const workspaceManifests = await discoverWorkspaceManifests();
await validateRepositoryCatalog();

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
    const workflowModule = portableRelative.startsWith('apps/ajun-runtime/src/workflow/');
    if (workflowModule && path.extname(portableRelative) !== '.ts') {
      violations.push(`${portableRelative}: 新的 Workflow 核心 Module 必须使用 TypeScript`);
    }
    if (workflowModule && /\b(?:fetch|execFile|exec|spawn)\s*\(/.test(source)) {
      violations.push(`${portableRelative}: Workflow Module 不得直接访问网络或启动进程，请通过 CapabilityAdapter Interface`);
    }
    const ajunRelative = portableRelative.startsWith('apps/ajun-runtime/')
      ? portableRelative.slice('apps/ajun-runtime/'.length)
      : null;
    const localPolicy = ajunRelative ? ajunModulePolicy.moduleRule(ajunRelative) : null;
    const lineLimit = localPolicy?.lineLimit || responsibilityLineLimits.get(portableRelative);
    if (lineLimit && source.split(/\r?\n/).length > lineLimit) {
      violations.push(`${portableRelative}: 责任模块超过 ${lineLimit} 行，请先提取有明确边界的协作者再继续扩展`);
    }
    const importLimit = localPolicy?.importLimit || responsibilityImportLimits.get(portableRelative);
    const importCount = [...source.matchAll(/^\s*import\b/gm)].length;
    if (importLimit && importCount > importLimit) {
      violations.push(`${portableRelative}: 产品装配根超过 ${importLimit} 个直接 import，请将领域装配知识下沉到深层 Module`);
    }
    if (portableRelative === 'apps/ajun-runtime/src/task-service.js') {
      for (const methodName of delegatedTaskServiceMethods) {
        if (new RegExp(`^\\s+(?:async\\s+)?${methodName}\\s*\\(`, 'm').test(source)) {
          violations.push(`${portableRelative}: ${methodName} 已委托给深层 Module，不得在 TaskService 保留影子实现`);
        }
      }
    }
    for (const [pattern, message] of semanticShadowRules.get(portableRelative) || []) {
      if (pattern.test(source)) violations.push(`${portableRelative}: ${message}`);
    }
    const ownerManifest = await owningPackageManifest(file);
    const productionSource = !relative.split(path.sep).some((segment) => ['test', 'tests', 'scripts'].includes(segment));
    if (productionSource && source.split(/\r?\n/).length > 1000) {
      violations.push(`${relative}: 生产源码超过 1000 行，请按完整领域行为提取深层 Module`);
    }
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
      && retiredAjunM5Facades.has(path.parse(relative).name)) {
      violations.push(`${relative}: 已退役的 M5 转发门面不得回流，请直接使用 m5-kernel 包 exports`);
    }
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      if (workflowModule && workflowImplementationImport(match[1])) {
        violations.push(`${portableRelative}: Workflow Module 不得直接依赖平台或 Adapter Implementation（${match[1]}）`);
      }
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
for (const [relative, lineLimit] of responsibilityTestLineLimits) {
  const file = path.join(root, relative);
  if (!await pathExists(file)) continue;
  const source = await fs.readFile(file, 'utf8');
  if (source.split(/\r?\n/).length > lineLimit) {
    violations.push(`${relative}: 接缝测试超过 ${lineLimit} 行，请按 Module Interface 拆分并删除重复入口断言`);
  }
}
for (const group of responsibilityTestGroupLineLimits) {
  let totalLines = 0;
  for (const relative of group.paths) {
    const file = path.join(root, relative);
    if (!await pathExists(file)) continue;
    totalLines += (await fs.readFile(file, 'utf8')).split(/\r?\n/).length;
  }
  if (totalLines > group.lineLimit) {
    violations.push(`${group.name}总计 ${totalLines} 行，超过 ${group.lineLimit} 行，请删除重复入口断言`);
  }
}
await validateHermesTaskCardPatch();
await validateTaskDefinitionCoverage();

function workflowImplementationImport(specifier) {
  const normalized = String(specifier || '').toLowerCase();
  return [
    '/adapters/',
    'local-ai-capability',
    'paperclip',
    'hermes',
    'feishu',
    'public-web',
    'browser-automation',
  ].some((fragment) => normalized.includes(fragment));
}

async function validateHermesTaskCardPatch() {
  const relative = 'integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs';
  const file = path.join(root, relative);
  if (!await pathExists(file)) return;
  const source = await fs.readFile(file, 'utf8');
  if (/\bdynamicTaskCard(?:Methods|Callback)\b/.test(source)) {
    violations.push(`${relative}: 不得把任务卡业务逻辑重新内嵌为字符串补丁`);
  }
  const runtimeRelative = 'integrations/hermes/runtime/agent_army_feishu_task_card.py';
  if (!source.includes('taskCardRuntimeSource') || !await pathExists(path.join(root, runtimeRelative))) {
    violations.push(`${relative}: 任务卡安装必须引用受版本约束的独立 Runtime Module`);
  }
}

async function validateTaskDefinitionCoverage() {
  const definitionsPath = path.join(root, 'apps/ajun-runtime/src/task-definitions.js');
  const agentsPath = path.join(root, 'agents');
  if (!await pathExists(definitionsPath) || !await pathExists(agentsPath)) return;
  const definitionsSource = await fs.readFile(definitionsPath, 'utf8');
  const definedTaskTypes = new Set(
    [...definitionsSource.matchAll(/taskDefinition\(['"]([^'"]+)['"]/g)].map((match) => match[1]),
  );
  const defaultTaskType = definitionsSource.match(/DEFAULT_TASK_TYPE\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (defaultTaskType) definedTaskTypes.add(defaultTaskType);
  for (const entry of await fs.readdir(agentsPath, { withFileTypes:true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(agentsPath, entry.name, 'manifest.json');
    const manifest = await readJsonFile(manifestPath);
    for (const taskType of manifest?.acceptedTaskTypes || []) {
      if (!definedTaskTypes.has(taskType)) {
        violations.push(`agents/${entry.name}/manifest.json: acceptedTaskType ${taskType} 未登记到 TaskDefinitionRegistry`);
      }
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

async function validateRepositoryCatalog() {
  const catalogPath = path.join(root, 'repository-catalog.json');
  if (!await pathExists(catalogPath)) return;
  const catalog = await readJsonFile(catalogPath);
  if (!catalog) {
    violations.push('repository-catalog.json: 不是有效 JSON');
    return;
  }
  if (catalog.schemaVersion !== 'agent.army/repository-catalog/v1') {
    violations.push('repository-catalog.json: schemaVersion 必须是 agent.army/repository-catalog/v1');
  }
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  const paths = entries.map((entry) => entry?.path).filter(Boolean);
  if (new Set(paths).size !== paths.length) {
    violations.push('repository-catalog.json: entry path 不得重复');
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    violations.push('repository-catalog.json: entries 必须按 path 排序');
  }

  const entryByPath = new Map(entries.map((entry) => [entry?.path, entry]));
  for (const entry of entries) {
    if (!safeRepositoryPath(entry?.path)) {
      violations.push(`repository-catalog.json: 非法 entry path（${String(entry?.path || '')}）`);
      continue;
    }
    if (!repositoryClassifications.has(entry.classification)) {
      violations.push(`${entry.path}: 未知 repository classification（${String(entry.classification || '')}）`);
    }
    if (!repositoryLifecycles.has(entry.lifecycle)) {
      violations.push(`${entry.path}: 未知 repository lifecycle（${String(entry.lifecycle || '')}）`);
    }
    if (!await pathExists(path.join(root, entry.path))) {
      violations.push(`${entry.path}: repository catalog 指向的目录不存在`);
    }
    if (!safeRepositoryPath(entry.entrypoint) || !await pathExists(path.join(root, entry.entrypoint))) {
      violations.push(`${entry.path}: repository catalog entrypoint 不存在或越界`);
    }
    if (entry.workspace === true) {
      const manifest = await readManifest(path.join(root, entry.path, 'package.json'));
      if (!manifest || manifest.name !== entry.name) {
        violations.push(`${entry.path}: Workspace package name 与 repository catalog 不一致`);
      }
      if (!String(manifest?.description || '').trim()) {
        violations.push(`${entry.path}: Workspace package.json 必须说明产品或 Module 用途`);
      }
      if (!await pathExists(path.join(root, entry.path, 'README.md'))) {
        violations.push(`${entry.path}: Workspace 必须提供 README 说明入口、验证和非目标`);
      }
    }
    if (entry.classification === 'legacy-rollback') {
      if (entry.lifecycle !== 'retained-rollback' || entry.workspace !== false) {
        violations.push(`${entry.path}: legacy-rollback 必须是 retained-rollback 且不得进入 Workspace`);
      }
      if (!safeRepositoryPath(entry.replacement)
        || !await pathExists(path.join(root, entry.replacement))) {
        violations.push(`${entry.path}: legacy-rollback 必须指向存在的正式 replacement`);
      }
    }
  }

  const declaredWorkspaces = await declaredWorkspaceDirectories();
  const catalogWorkspaces = new Set(
    entries.filter((entry) => entry.workspace === true).map((entry) => entry.path),
  );
  for (const workspace of declaredWorkspaces) {
    if (!catalogWorkspaces.has(workspace)) {
      violations.push(`${workspace}: 根 Workspace 未登记到 repository-catalog.json`);
    }
  }
  for (const workspace of catalogWorkspaces) {
    if (!declaredWorkspaces.has(workspace)) {
      violations.push(`${workspace}: repository catalog 标记为 Workspace，但根 package.json 未声明`);
    }
  }

  const appsRoot = path.join(root, 'apps');
  for (const app of await fs.readdir(appsRoot, { withFileTypes:true }).catch(() => [])) {
    if (!app.isDirectory() || ignoredSegments.has(app.name)) continue;
    const appPath = `apps/${app.name}`;
    if (!entryByPath.has(appPath)) {
      violations.push(`${appPath}: 应用目录未登记到 repository-catalog.json`);
    }
  }
  for (const area of Array.isArray(catalog.areas) ? catalog.areas : []) {
    if (!safeRepositoryPath(area?.path) || !await pathExists(path.join(root, area.path))) {
      violations.push(`repository-catalog.json: area 不存在或越界（${String(area?.path || '')}）`);
    }
  }
}

async function declaredWorkspaceDirectories() {
  const manifest = await readJsonFile(path.join(root, 'package.json'));
  const directories = new Set();
  for (const rawPattern of manifest?.workspaces || []) {
    const pattern = String(rawPattern || '').replace(/\/$/, '');
    if (!pattern.endsWith('/*')) {
      if (safeRepositoryPath(pattern)) directories.add(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    if (!safeRepositoryPath(parent)) continue;
    for (const entry of await fs.readdir(path.join(root, parent), { withFileTypes:true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const directory = `${parent}/${entry.name}`;
      if (await pathExists(path.join(root, directory, 'package.json'))) directories.add(directory);
    }
  }
  return directories;
}

function safeRepositoryPath(value) {
  const candidate = String(value || '');
  return Boolean(candidate)
    && !path.isAbsolute(candidate)
    && !candidate.includes('\\')
    && candidate.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

async function readJsonFile(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
}

async function pathExists(target) {
  return fs.access(target).then(() => true).catch(() => false);
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
