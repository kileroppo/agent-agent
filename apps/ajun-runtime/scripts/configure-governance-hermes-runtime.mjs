#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_ARMY_REPOSITORY_ROOT,
  GOVERNANCE_HERMES_AGENT_IDS,
  hermesRuntimePolicyForManifest,
  hermesProfileHome,
  taskCardPolicyForManifest,
  usesPaperclipHermesExecution
} from '../src/governance-hermes-runtime.ts';

const scriptPath = fileURLToPath(import.meta.url);
export function resolveGovernanceMcpServerPath({
  override = process.env.AGENT_ARMY_MCP_SERVER_PATH,
  currentScriptPath = scriptPath,
  repositoryRoot = AGENT_ARMY_REPOSITORY_ROOT,
} = {}) {
  const candidate = path.resolve(
    String(override || '').trim()
      || path.resolve(path.dirname(currentScriptPath), '../src/agent-army-mcp-server.ts'),
  );
  const approvedRoot = path.resolve(repositoryRoot);
  if (
    path.basename(candidate) !== 'agent-army-mcp-server.ts'
    || !candidate.startsWith(`${approvedRoot}${path.sep}`)
  ) {
    throw new Error('AGENT_ARMY_MCP_SERVER_PATH 必须指向仓库内的 agent-army-mcp-server.ts。');
  }
  return candidate;
}

const mcpServerPath = resolveGovernanceMcpServerPath();
const hermesCommand = process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local/bin/hermes');
const hermesPythonCommand = process.env.AJUN_HERMES_PYTHON
  || path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/python');
const feishuToolsetHelperPath = path.join(
  AGENT_ARMY_REPOSITORY_ROOT,
  'integrations/hermes/scripts/set-feishu-toolsets.py',
);
const paperclipUrl = process.env.PAPERCLIP_URL || 'http://127.0.0.1:3100';
const HERMES_BUILTIN_SKILL_SOURCES = Object.freeze({
  docx:path.join(os.homedir(), '.hermes/hermes-agent/skills/productivity/docx'),
  xlsx:path.join(os.homedir(), '.hermes/hermes-agent/skills/productivity/xlsx'),
  pdf:path.join(os.homedir(), '.hermes/hermes-agent/skills/productivity/pdf'),
});
const SHARED_SKILL_LIBRARY_ROOT = path.resolve(
  process.env.AGENT_ARMY_SHARED_SKILLS_ROOT || path.join(os.homedir(), 'Documents/work/AIcode/skills-lib'),
);
const AUDITED_SKILL_INVENTORIES = Object.freeze({
  paperclip:{
    trustLevel:'scripts_executables',
    sourceKind:'paperclip-package',
    sha256:'329f29ef13e96224323d1e1675ce3929baccf3fab4ac6115cc28360054c24c6c',
  },
  'paperclip-board':{
    trustLevel:'markdown_only',
    sourceKind:'paperclip-package',
    sha256:'c5d8557c4565a1c54aaedc568102869ecbf106bd007dbab8531bf835d0f52fdf',
  },
  'paperclip-converting-plans-to-tasks':{
    trustLevel:'markdown_only',
    sourceKind:'paperclip-package',
    sha256:'e04b6d72b89a7c295ed8084e5d738762bd24859c2fec3c648c117ce6990f320d',
  },
  'paperclip-create-agent':{
    trustLevel:'markdown_only',
    sourceKind:'paperclip-package',
    sha256:'c79f5fde9ff8c0f40cc8b28f6d2817f7d93431d8114b9f21bb14f2b4ccdfad86',
  },
  'agent-army-video-content':{
    trustLevel:'markdown_only',
    sourceKind:'repository',
    sha256:'453bd9781d7d445858fe5fd2aa7aa1f1e2e1c8a60242eb004da3458d4ad7502f',
  },
  'yichen-web-research':{
    trustLevel:'scripts_executables', sourceKind:'shared-library',
    sha256:'8fb3e2e364afda7374dce5e17bf8b7760dfb506d46bf8b97caf50e476a623e18',
  },
  'yichen-unified-search':{
    trustLevel:'scripts_executables', sourceKind:'shared-library',
    sha256:'b66056febf314d48355389c7e1c9d1c47c120bda4a78274a495941b96a7b7db3',
  },
  'yichen-content-archive':{
    trustLevel:'scripts_executables', sourceKind:'shared-library',
    sha256:'08018c26c6156938e98d22359a1cf36be359270a4e2c83fd9316508fb812e814',
  },
  'yichen-grok-consult':{
    trustLevel:'assets', sourceKind:'shared-library',
    sha256:'0f3d51284c928440b8c9adb7424c4ce65842af84f4afc31f7199f05ccc04abcc',
  },
  'yichen-asr':{
    trustLevel:'scripts_executables', sourceKind:'shared-library',
    sha256:'c9f240b7ad1981b7d2ee8f8467c1711a0857de1a4323ba467be747a13e71761b',
  },
  'yichen-summary':{
    trustLevel:'markdown_only', sourceKind:'shared-library',
    sha256:'9ba335d807899397117695a3b9d0ed6d7cae1acf3e4c3f1dfa5fb0a7f0c6c83e',
  },
  'yichen-wechat-local-vault':{
    trustLevel:'scripts_executables', sourceKind:'shared-library',
    sha256:'fa164a7ca795f99dbc818c53e0ef621627cf04d86956f5ef59139d51a593c5ff',
  },
  docx:{
    sourceKind:'hermes-builtin',
    sha256:'40980ace424e619c3a5624e93fb36eb0c3b07d4f1469b4a805ebc041a8fa9d85',
  },
  xlsx:{
    sourceKind:'hermes-builtin',
    sha256:'f5022166b63df405dbc08c0d651e00a0ff7959e4d1883579e02b6713a2de6004',
  },
  pdf:{
    sourceKind:'hermes-builtin',
    sha256:'eaa0625a908ae4b50488366f4449ae146d4e4f527c1c2a3caf5064a35e081e78',
  },
});
const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROFILE_SYNC_CONFIRMATION = 'confirm-profile-sync';
const PROFILE_SYNC_TRANSACTION_FILE = '.agent-army-profile-sync-transaction.json';
const PROFILE_SYNC_BACKUP_DIRECTORY = '.agent-army-profile-sync-backups';
const APPROVED_FEISHU_TOOLSETS = new Set([
  'clarify',
  'memory',
  'session_search',
  'skills',
]);
export async function configureGovernanceHermesRuntime({
  agentIds = GOVERNANCE_HERMES_AGENT_IDS,
  allowDraftProfiles = false,
  skillsOnly = false,
  fetchImpl = fetch,
  auditSkillSource = auditApprovedSkillSource,
  installSkillDirectory = installAuditedSkillDirectory,
  stat = fs.stat,
  profileHomeFor = hermesProfileHome,
} = {}) {
  if (!skillsOnly) {
    throw new GovernanceHermesConfigurationError(
      'legacy full-config 写入入口已禁用；请先使用 Profile sync --dry-run，再显式使用 --apply。',
    );
  }
  const ids = normalizeAgentIds(agentIds, { allowDraftProfiles });
  if (!ids.length) throw new GovernanceHermesConfigurationError('至少需要指定一名治理员工。');
  const companySkills = await listPaperclipCompanySkills(fetchImpl);
  const results = [];

  for (const agentId of ids) {
    const manifestPath = path.join(AGENT_ARMY_REPOSITORY_ROOT, 'agents', agentId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const restrictedTestingDraft = allowDraftProfiles
      && manifest.status === 'draft'
      && manifest.interaction?.runtime === 'hermes-profile'
      && manifest.interaction?.directFeishu === 'disabled'
      && manifest.executionOwner === 'paperclip-hermes';
    if (!usesPaperclipHermesExecution(manifest) && !restrictedTestingDraft) {
      throw new GovernanceHermesConfigurationError(`${agentId} 未声明 Paperclip Hermes 执行所有权。`);
    }
    const profileHome = profileHomeFor(agentId);
    const profileStat = await stat(profileHome).catch(() => null);
    if (!profileStat?.isDirectory()) throw new GovernanceHermesConfigurationError(`${agentId} 的 Hermes Profile 不存在。`);

    const installedSkills = [];
    for (const slug of manifest.runtimeCapabilities.skills) {
      if (!SKILL_SLUG_PATTERN.test(String(slug || ''))) {
        throw new GovernanceHermesConfigurationError(`${agentId} 的技能 slug 不合法。`);
      }
      const skill = companySkills.find((item) => item.slug === slug);
      const sourceLocator = AUDITED_SKILL_INVENTORIES[slug]?.sourceKind === 'shared-library'
        ? path.join(SHARED_SKILL_LIBRARY_ROOT, slug)
        : skill?.sourceLocator || HERMES_BUILTIN_SKILL_SOURCES[slug];
      const sourceStat = sourceLocator ? await stat(sourceLocator).catch(() => null) : null;
      if (!sourceStat?.isDirectory()) {
        throw new GovernanceHermesConfigurationError(
          `岗位声明技能 ${slug} 既不在 Paperclip 公司技能库，也不在允许的 Hermes 内置技能源。`,
        );
      }
      const targetRoot = path.resolve(profileHome, 'skills');
      const target = path.resolve(targetRoot, slug);
      if (!target.startsWith(`${targetRoot}${path.sep}`)) {
        throw new GovernanceHermesConfigurationError(`${agentId} 的技能目标路径越界。`);
      }
      const audit = await auditSkillSource({
        slug,
        sourceLocator,
        companySkill:skill || null,
      });
      await installSkillDirectory({
        slug,
        sourceLocator:audit.realPath,
        target,
        expectedHash:audit.sha256,
      });
      installedSkills.push(slug);
    }
    results.push({
      agentId,
      profileHome,
      skills:installedSkills,
      mcpTools:[],
      feishuToolsets:[],
      gatewayInstalled:false,
      executionMode:'skills-only',
    });
  }
  return results;
}

export async function syncGovernanceHermesProfiles({
  agentIds,
  mode = 'dry-run',
  confirmed = false,
  run = runCommand,
  readProfileState,
  profileHomeFor = hermesProfileHome,
  profileRootFor = approvedHermesProfilesRoot,
  now = () => new Date(),
  fileSystem = fs,
} = {}) {
  const inspectProfileState = readProfileState
    || ((profileHome) => readCurrentProfileState(profileHome, { run }));
  const ids = normalizeAgentIds(agentIds);
  if (!ids.length) {
    throw new GovernanceHermesConfigurationError(
      'Profile 最小同步必须通过 --only 显式指定岗位。',
    );
  }
  if (!['dry-run', 'apply'].includes(mode)) {
    throw new GovernanceHermesConfigurationError('Profile 最小同步模式无效。');
  }
  if (mode === 'apply' && confirmed !== true) {
    throw new GovernanceHermesConfigurationError(
      `执行 Profile 同步必须显式传入 --${PROFILE_SYNC_CONFIRMATION}。`,
    );
  }

  const plans = [];
  for (const agentId of ids) {
    const manifest = await readSyncManifest(agentId, fileSystem);
    const profileHome = profileHomeFor(agentId);
    const profileRoot = profileRootFor(agentId);
    await assertSafeProfileHome({
      agentId,
      profileHome,
      profileRoot,
      fileSystem,
    });
    const promptPath = safeRepositoryPromptPath(manifest.promptRef);
    const [targetSoul, currentSoul, currentState] = await Promise.all([
      fileSystem.readFile(promptPath, 'utf8'),
      fileSystem.readFile(path.join(profileHome, 'SOUL.md'), 'utf8'),
      inspectProfileState(profileHome),
    ]);
    plans.push(profileSyncPlan({
      agentId,
      manifest,
      profileHome,
      profileRoot,
      promptPath,
      currentSoul,
      targetSoul,
      currentState,
    }));
  }
  if (mode === 'dry-run') {
    return plans.map((plan) => publicProfileSyncPlan(plan, 'dry-run'));
  }

  for (const plan of plans) {
    await assertNoStaleProfileSyncTransaction(plan, fileSystem);
  }
  for (const plan of plans) {
    await assertProfileSyncPlanStillCurrent({
      plan,
      inspectProfileState,
      fileSystem,
    });
  }

  const applied = [];
  try {
    for (const plan of plans) {
      if (!plan.changed) {
        applied.push({ plan, backup:null });
        continue;
      }
      await assertSafeProfileHome({
        agentId:plan.agentId,
        profileHome:plan.profileHome,
        profileRoot:plan.profileRoot,
        fileSystem,
      });
      await assertProfileSyncPlanStillCurrent({
        plan,
        inspectProfileState,
        fileSystem,
      });
      const backup = await backupProfileSyncFiles({
        plan,
        fileSystem,
        now,
        run,
      });
      applied.push({ plan, backup });
      await writeProfileSyncTransactionMarker(backup, fileSystem);
      await assertSafeProfileHome({
        agentId:plan.agentId,
        profileHome:plan.profileHome,
        profileRoot:plan.profileRoot,
        fileSystem,
      });
      await assertProfileSyncPlanStillCurrent({
        plan,
        inspectProfileState,
        fileSystem,
      });
      await applyProfileSyncPlan({ plan, run, fileSystem });
      const [currentSoul, currentState] = await Promise.all([
        fileSystem.readFile(path.join(plan.profileHome, 'SOUL.md'), 'utf8'),
        inspectProfileState(plan.profileHome),
      ]);
      const verification = profileSyncPlan({
        agentId:plan.agentId,
        manifest:plan.manifest,
        profileHome:plan.profileHome,
        promptPath:plan.promptPath,
        currentSoul,
        targetSoul:plan.targetSoul,
        currentState,
      });
      if (verification.changed) {
        throw new GovernanceHermesConfigurationError(
          `${plan.agentId} 同步后仍存在 ${verification.changedSections.join('、')} 漂移。`,
        );
      }
      await clearProfileSyncTransactionMarker(backup, fileSystem);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...applied].reverse()) {
      if (!item.backup) continue;
      try {
        await restoreProfileSyncBackup(item.backup, fileSystem);
        await clearProfileSyncTransactionMarker(item.backup, fileSystem);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.plan.agentId}: ${rollbackError.message}`);
      }
    }
    const suffix = rollbackErrors.length
      ? `；回滚未完整完成：${rollbackErrors.join('；')}`
      : '；已从逐 Profile 备份恢复非敏感配置。';
    throw new GovernanceHermesConfigurationError(
      `${error?.message || 'Profile 最小同步失败'}${suffix}`,
    );
  }
  return applied.map(({ plan, backup }) => ({
    ...publicProfileSyncPlan(plan, 'apply'),
    backupPath:backup?.root || null,
    rollback:backup
      ? `从 ${backup.root} 恢复 config.yaml 与 SOUL.md；该备份不包含 .env。`
      : null,
  }));
}

export function parseProfileSyncArgs(args = []) {
  const values = [...args];
  const dryRun = values.includes('--dry-run');
  const apply = values.includes('--apply');
  const confirmed = values.includes(`--${PROFILE_SYNC_CONFIRMATION}`);
  const onlyIndex = values.indexOf('--only');
  const hasSyncFlag = dryRun || apply || confirmed || onlyIndex >= 0;
  if (!hasSyncFlag) return null;
  if (dryRun === apply) {
    throw new GovernanceHermesConfigurationError(
      'Profile 最小同步必须且只能选择 --dry-run 或 --apply。',
    );
  }
  if (onlyIndex < 0 || !values[onlyIndex + 1] || values[onlyIndex + 1].startsWith('--')) {
    throw new GovernanceHermesConfigurationError('Profile 最小同步必须提供 --only 岗位列表。');
  }
  const accepted = new Set([
    '--dry-run',
    '--apply',
    `--${PROFILE_SYNC_CONFIRMATION}`,
    '--only',
    values[onlyIndex + 1],
  ]);
  const unknown = values.filter((item) => !accepted.has(item));
  if (unknown.length) {
    throw new GovernanceHermesConfigurationError(
      `Profile 最小同步包含未知参数：${unknown.join(', ')}`,
    );
  }
  if (dryRun && confirmed) {
    throw new GovernanceHermesConfigurationError('dry-run 不接受执行确认参数。');
  }
  if (apply && !confirmed) {
    throw new GovernanceHermesConfigurationError(
      `执行 Profile 同步必须显式传入 --${PROFILE_SYNC_CONFIRMATION}。`,
    );
  }
  const agentIds = values[onlyIndex + 1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const normalized = normalizeAgentIds(agentIds);
  if (normalized.length !== new Set(agentIds).size) {
    throw new GovernanceHermesConfigurationError('--only 包含未知或无效岗位。');
  }
  return {
    mode:dryRun ? 'dry-run' : 'apply',
    confirmed,
    agentIds:normalized,
  };
}

function mcpEnvironmentEntries(manifest) {
  const agentId = String(manifest.agentId || '').trim();
  const mcpTools = Array.isArray(manifest.runtimeCapabilities?.mcpTools)
    ? manifest.runtimeCapabilities.mcpTools
    : [];
  const localAiCapabilities = Array.isArray(manifest.runtimeCapabilities?.localAiCapabilities)
    ? manifest.runtimeCapabilities.localAiCapabilities
    : [];
  const taskCardPolicy = taskCardPolicyForManifest(manifest);
  return [
    `AGENT_ARMY_AGENT_ID=${agentId}`,
    `AGENT_ARMY_PROFILE_ID=${agentId}`,
    `AGENT_ARMY_ALLOWED_AGENT_IDS=${agentId}`,
    `AGENT_ARMY_ALLOWED_TASK_TYPES=${manifest.acceptedTaskTypes.join(',')}`,
    `AGENT_ARMY_ALLOWED_MCP_TOOLS=${mcpTools.join(',')}`,
    `AGENT_ARMY_ALLOWED_LOCAL_AI_CAPABILITIES=${localAiCapabilities.join(',')}`,
    `AGENT_ARMY_ALLOW_MISSIONS=${mcpTools.includes('mission_create') ? 'true' : 'false'}`,
    `AGENT_ARMY_TASK_CARD_POLICY=${taskCardPolicy}`,
    'PAPERCLIP_TASK_ID=${PAPERCLIP_TASK_ID}',
    'PAPERCLIP_RUN_ID=${PAPERCLIP_RUN_ID}',
    'PAPERCLIP_AGENT_ID=${PAPERCLIP_AGENT_ID}',
    'PAPERCLIP_API_KEY=${PAPERCLIP_API_KEY}',
  ];
}

async function readSyncManifest(agentId, fileSystem) {
  const manifestPath = path.join(
    AGENT_ARMY_REPOSITORY_ROOT,
    'agents',
    agentId,
    'manifest.json',
  );
  const manifest = JSON.parse(await fileSystem.readFile(manifestPath, 'utf8'));
  if (!usesPaperclipHermesExecution(manifest)) {
    throw new GovernanceHermesConfigurationError(
      `${agentId} 未声明 Paperclip Hermes 执行所有权。`,
    );
  }
  return manifest;
}

function approvedHermesProfilesRoot() {
  const home = String(process.env.HOME || '').trim();
  if (!home || home === path.parse(home).root) {
    throw new GovernanceHermesConfigurationError('无法确定安全的 Hermes Profile 根目录。');
  }
  return path.resolve(home, '.hermes/profiles');
}

async function assertSafeProfileHome({
  agentId,
  profileHome,
  profileRoot,
  fileSystem,
}) {
  const absoluteRoot = path.resolve(String(profileRoot || ''));
  const absoluteHome = path.resolve(String(profileHome || ''));
  const expectedHome = path.resolve(absoluteRoot, agentId);
  if (
    absoluteHome !== expectedHome
    || !absoluteHome.startsWith(`${absoluteRoot}${path.sep}`)
  ) {
    throw new GovernanceHermesConfigurationError('Hermes Profile 路径超出批准范围。');
  }
  await assertPathChainHasNoSymlink(absoluteRoot, fileSystem);
  await assertPathChainHasNoSymlink(absoluteHome, fileSystem);
  const [realRoot, realHome] = await Promise.all([
    fileSystem.realpath(absoluteRoot).catch(() => null),
    fileSystem.realpath(absoluteHome).catch(() => null),
  ]);
  if (
    !realRoot
    || !realHome
    || realHome !== path.join(realRoot, agentId)
    || !realHome.startsWith(`${realRoot}${path.sep}`)
  ) {
    throw new GovernanceHermesConfigurationError('Hermes Profile 真实路径超出批准范围。');
  }
  for (const name of ['config.yaml', 'SOUL.md']) {
    const item = await fileSystem.lstat(path.join(absoluteHome, name)).catch(() => null);
    if (!item?.isFile() || item.isSymbolicLink()) {
      throw new GovernanceHermesConfigurationError(
        `Hermes Profile 的 ${name} 不存在或不是安全普通文件。`,
      );
    }
  }
}

async function assertPathChainHasNoSymlink(candidate, fileSystem) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const state = await fileSystem.lstat(current).catch(() => null);
    if (!state || state.isSymbolicLink()) {
      throw new GovernanceHermesConfigurationError(
        'Hermes Profile 父链不存在或包含符号链接。',
      );
    }
  }
}

function safeRepositoryPromptPath(promptRef) {
  const promptPath = path.resolve(AGENT_ARMY_REPOSITORY_ROOT, String(promptRef || ''));
  if (!promptPath.startsWith(`${AGENT_ARMY_REPOSITORY_ROOT}${path.sep}`)) {
    throw new GovernanceHermesConfigurationError('员工 Prompt 路径越界。');
  }
  return promptPath;
}

function profileSyncPlan({
  agentId,
  manifest,
  profileHome,
  profileRoot,
  promptPath,
  currentSoul,
  targetSoul,
  currentState,
}) {
  const targetMcp = targetMcpState(manifest);
  const currentMcp = normalizeMcpState(currentState?.mcp);
  const targetToolsets = sortedStrings(manifest.runtimeCapabilities?.feishuToolsets);
  const currentToolsets = sortedStrings(currentState?.feishuToolsets);
  const targetRuntimePolicy = hermesRuntimePolicyForManifest(manifest);
  const currentRuntimePolicy = normalizeRuntimePolicy(currentState?.runtimePolicy);
  const soul = {
    changed:currentSoul !== targetSoul,
    currentSha256:sha256Text(currentSoul),
    targetSha256:sha256Text(targetSoul),
  };
  const mcp = mcpStateDiff(currentMcp, targetMcp);
  const toolsets = listDiff(currentToolsets, targetToolsets);
  const runtimePolicy = runtimePolicyDiff(currentRuntimePolicy, targetRuntimePolicy);
  const currentFingerprint = profileSyncFingerprint({
    currentSoul,
    currentState,
  });
  const changedSections = [
    ...(soul.changed ? ['SOUL'] : []),
    ...(mcp.changed ? ['MCP'] : []),
    ...(toolsets.changed ? ['toolset'] : []),
    ...(runtimePolicy.changed ? ['runtime-policy'] : []),
  ];
  return {
    agentId,
    manifest,
    profileHome,
    profileRoot,
    promptPath,
    currentSoul,
    targetSoul,
    targetMcp,
    currentToolsets,
    targetToolsets,
    targetRuntimePolicy,
    currentFingerprint,
    soul,
    mcp,
    toolsets,
    runtimePolicy,
    changedSections,
    changed:changedSections.length > 0,
  };
}

async function assertNoStaleProfileSyncTransaction(plan, fileSystem) {
  const markerPath = path.join(plan.profileHome, PROFILE_SYNC_TRANSACTION_FILE);
  const markerState = await fileSystem.lstat(markerPath).catch(() => null);
  if (!markerState) return;
  if (!markerState.isFile() || markerState.isSymbolicLink() || markerState.size > 16 * 1024) {
    throw new GovernanceHermesConfigurationError(
      `${plan.agentId} 存在无效的 Profile 同步事务标记；拒绝 apply。`,
    );
  }
  let marker;
  try {
    marker = JSON.parse(await fileSystem.readFile(markerPath, 'utf8'));
  } catch {
    throw new GovernanceHermesConfigurationError(
      `${plan.agentId} 存在无法读取的 Profile 同步事务标记；拒绝 apply。`,
    );
  }
  const backupRoot = path.join(plan.profileHome, PROFILE_SYNC_BACKUP_DIRECTORY);
  const backupPath = path.resolve(String(marker?.backupPath || ''));
  if (
    marker?.schemaVersion !== 'agent.army/hermes-profile-sync-transaction/v1'
    || marker?.agentId !== plan.agentId
    || !backupPath.startsWith(`${backupRoot}${path.sep}`)
  ) {
    throw new GovernanceHermesConfigurationError(
      `${plan.agentId} 存在无效的 Profile 同步事务标记；拒绝 apply。`,
    );
  }
  throw new GovernanceHermesConfigurationError(
    `${plan.agentId} 存在未完成的 Profile 同步事务；请先从备份 ${backupPath} 恢复。`,
  );
}

async function assertProfileSyncPlanStillCurrent({
  plan,
  inspectProfileState,
  fileSystem,
}) {
  await assertSafeProfileHome({
    agentId:plan.agentId,
    profileHome:plan.profileHome,
    profileRoot:plan.profileRoot,
    fileSystem,
  });
  const [currentSoul, currentState] = await Promise.all([
    fileSystem.readFile(path.join(plan.profileHome, 'SOUL.md'), 'utf8'),
    inspectProfileState(plan.profileHome),
  ]);
  if (profileSyncFingerprint({ currentSoul, currentState }) !== plan.currentFingerprint) {
    throw new GovernanceHermesConfigurationError(
      `${plan.agentId} 的 SOUL、MCP 或工具白名单在规划后已变化；拒绝写入。`,
    );
  }
}

function profileSyncFingerprint({ currentSoul, currentState }) {
  return sha256Text(JSON.stringify({
    soulSha256:sha256Text(currentSoul),
    mcp:normalizeMcpState(currentState?.mcp),
    feishuToolsets:sortedStrings(currentState?.feishuToolsets),
    runtimePolicy:normalizeRuntimePolicy(currentState?.runtimePolicy),
  }));
}

function targetMcpState(manifest) {
  const env = Object.fromEntries(
    mcpEnvironmentEntries(manifest)
      .map((item) => item.split(/=(.*)/s).slice(0, 2)),
  );
  return normalizeMcpState({
    enabled:true,
    command:process.execPath,
    args:[mcpServerPath],
    timeout:290,
    env,
  });
}

function normalizeMcpState(value) {
  const rawEnv = value?.env || {};
  const env = Array.isArray(rawEnv)
    ? Object.fromEntries(rawEnv.map((item) => String(item).split(/=(.*)/s).slice(0, 2)))
    : Object.fromEntries(Object.entries(rawEnv).map(([key, child]) => [key, String(child)]));
  const command = String(value?.command || '');
  const args = Array.isArray(value?.args) ? value.args.map(String) : [];
  return {
    enabled:value?.enabled !== false,
    commandSha256:/^[a-f0-9]{64}$/.test(String(value?.commandSha256 || ''))
      ? String(value.commandSha256)
      : sha256Text(command),
    argsSha256:/^[a-f0-9]{64}$/.test(String(value?.argsSha256 || ''))
      ? String(value.argsSha256)
      : sha256Text(JSON.stringify(args)),
    timeout:Number(value?.timeout || 0),
    scope:{
      agentId:String(env.AGENT_ARMY_AGENT_ID || ''),
      profileId:String(env.AGENT_ARMY_PROFILE_ID || ''),
      profileIdPresent:typeof env.AGENT_ARMY_PROFILE_ID === 'string'
        && env.AGENT_ARMY_PROFILE_ID.length > 0,
      allowedAgentIds:splitCsv(env.AGENT_ARMY_ALLOWED_AGENT_IDS),
      taskTypes:splitCsv(env.AGENT_ARMY_ALLOWED_TASK_TYPES),
      mcpTools:splitCsv(env.AGENT_ARMY_ALLOWED_MCP_TOOLS),
      localAiCapabilities:splitCsv(env.AGENT_ARMY_ALLOWED_LOCAL_AI_CAPABILITIES),
      allowMissions:String(env.AGENT_ARMY_ALLOW_MISSIONS || 'false') === 'true',
      taskCardPolicy:String(env.AGENT_ARMY_TASK_CARD_POLICY || 'disabled'),
      taskCardPolicyPresent:typeof env.AGENT_ARMY_TASK_CARD_POLICY === 'string'
        && env.AGENT_ARMY_TASK_CARD_POLICY.length > 0,
    },
    paperclipContextPlaceholdersPresent:[
      'PAPERCLIP_TASK_ID',
      'PAPERCLIP_RUN_ID',
      'PAPERCLIP_AGENT_ID',
      'PAPERCLIP_API_KEY',
    ].every((key) => typeof env[key] === 'string' && env[key].length > 0),
  };
}

function mcpStateDiff(current, target) {
  const scope = {
    agentId:{ current:current.scope.agentId, target:target.scope.agentId },
    profileId:{
      current:current.scope.profileId,
      target:target.scope.profileId,
      present:current.scope.profileIdPresent,
    },
    allowedAgentIds:listDiff(current.scope.allowedAgentIds, target.scope.allowedAgentIds),
    taskTypes:listDiff(current.scope.taskTypes, target.scope.taskTypes),
    mcpTools:listDiff(current.scope.mcpTools, target.scope.mcpTools),
    localAiCapabilities:listDiff(current.scope.localAiCapabilities, target.scope.localAiCapabilities),
    allowMissions:{
      current:current.scope.allowMissions,
      target:target.scope.allowMissions,
    },
    taskCardPolicy:{
      current:current.scope.taskCardPolicy,
      target:target.scope.taskCardPolicy,
      present:current.scope.taskCardPolicyPresent,
    },
  };
  const changed = current.enabled !== target.enabled
    || current.commandSha256 !== target.commandSha256
    || current.argsSha256 !== target.argsSha256
    || current.timeout !== target.timeout
    || current.scope.agentId !== target.scope.agentId
    || current.scope.profileId !== target.scope.profileId
    || !current.scope.profileIdPresent
    || scope.allowedAgentIds.changed
    || scope.taskTypes.changed
    || scope.mcpTools.changed
    || scope.localAiCapabilities.changed
    || current.scope.allowMissions !== target.scope.allowMissions
    || current.scope.taskCardPolicy !== target.scope.taskCardPolicy
    || !current.scope.taskCardPolicyPresent
    || !current.paperclipContextPlaceholdersPresent;
  return {
    changed,
    commandChanged:current.commandSha256 !== target.commandSha256,
    argsChanged:current.argsSha256 !== target.argsSha256,
    timeout:{ current:current.timeout, target:target.timeout },
    scope,
    paperclipContextPlaceholdersPresent:current.paperclipContextPlaceholdersPresent,
  };
}

function listDiff(current, target) {
  const left = sortedStrings(current);
  const right = sortedStrings(target);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const added = right.filter((item) => !leftSet.has(item));
  const removed = left.filter((item) => !rightSet.has(item));
  return {
    changed:added.length > 0 || removed.length > 0,
    current:left,
    target:right,
    added,
    removed,
  };
}

function publicProfileSyncPlan(plan, mode) {
  return {
    agentId:plan.agentId,
    mode,
    changed:plan.changed,
    changedSections:[...plan.changedSections],
    soul:{ ...plan.soul },
    mcp:plan.mcp,
    toolsets:plan.toolsets,
    runtimePolicy:plan.runtimePolicy,
    writesPerformed:mode === 'apply' && plan.changed,
    gatewayActions:0,
  };
}

async function backupProfileSyncFiles({ plan, fileSystem, now, run }) {
  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  const createdAt = now().toISOString();
  const backupRoot = path.join(
    plan.profileHome,
    PROFILE_SYNC_BACKUP_DIRECTORY,
    timestamp,
  );
  if (!backupRoot.startsWith(`${plan.profileHome}${path.sep}`)) {
    throw new GovernanceHermesConfigurationError('Profile 备份路径越界。');
  }
  const configSnapshot = await fileSystem.readFile(
    path.join(plan.profileHome, 'config.yaml'),
    'utf8',
  );
  await assertNoEmbeddedProfileSecret(configSnapshot, {
    profileHome:plan.profileHome,
    run,
  });
  const soulSnapshot = await fileSystem.readFile(
    path.join(plan.profileHome, 'SOUL.md'),
    'utf8',
  );
  const backupParent = path.dirname(backupRoot);
  const backupParentState = await fileSystem.lstat(backupParent).catch(() => null);
  if (backupParentState?.isSymbolicLink() || (backupParentState && !backupParentState.isDirectory())) {
    throw new GovernanceHermesConfigurationError('Profile 备份父目录不是安全目录。');
  }
  await fileSystem.mkdir(backupParent, { recursive:true, mode:0o700 });
  await assertPathChainHasNoSymlink(backupParent, fileSystem);
  await fileSystem.mkdir(backupRoot, { mode:0o700 });
  const files = ['config.yaml', 'SOUL.md'];
  await fileSystem.writeFile(
    path.join(backupRoot, 'config.yaml'),
    configSnapshot,
    { encoding:'utf8', mode:0o600, flag:'wx' },
  );
  await fileSystem.writeFile(
    path.join(backupRoot, 'SOUL.md'),
    soulSnapshot,
    { encoding:'utf8', mode:0o600, flag:'wx' },
  );
  await fileSystem.writeFile(
    path.join(backupRoot, 'manifest.json'),
    JSON.stringify({
      schemaVersion:'agent.army/hermes-profile-sync-backup/v1',
      agentId:plan.agentId,
      createdAt,
      files,
      excludes:['.env', 'auth.json', 'sessions', 'state.db'],
    }, null, 2),
    { encoding:'utf8', mode:0o600, flag:'wx' },
  );
  return {
    agentId:plan.agentId,
    profileHome:plan.profileHome,
    profileRoot:plan.profileRoot,
    root:backupRoot,
    files,
    createdAt,
  };
}

async function writeProfileSyncTransactionMarker(backup, fileSystem) {
  const markerPath = path.join(backup.profileHome, PROFILE_SYNC_TRANSACTION_FILE);
  await fileSystem.writeFile(
    markerPath,
    JSON.stringify({
      schemaVersion:'agent.army/hermes-profile-sync-transaction/v1',
      agentId:backup.agentId,
      backupPath:backup.root,
      createdAt:backup.createdAt,
    }, null, 2),
    { encoding:'utf8', mode:0o600, flag:'wx' },
  );
}

async function clearProfileSyncTransactionMarker(backup, fileSystem) {
  const markerPath = path.join(backup.profileHome, PROFILE_SYNC_TRANSACTION_FILE);
  const markerState = await fileSystem.lstat(markerPath).catch(() => null);
  if (!markerState) return;
  if (!markerState.isFile() || markerState.isSymbolicLink()) {
    throw new GovernanceHermesConfigurationError(
      `${backup.agentId} 的 Profile 同步事务标记不是安全普通文件。`,
    );
  }
  await fileSystem.rm(markerPath);
}

async function assertNoEmbeddedProfileSecret(configText, {
  profileHome,
  run,
}) {
  const result = await run(
    hermesPythonCommand,
    [feishuToolsetHelperPath, 'audit-config-secrets'],
    {
      allowFailure:true,
      env:{ HERMES_HOME:profileHome },
      input:String(configText || ''),
    },
  );
  let response;
  try {
    response = JSON.parse(String(result?.stdout || '').trim());
  } catch {
    throw new GovernanceHermesConfigurationError(
      'Hermes config.yaml 安全解析器返回了无效结构。',
    );
  }
  if (result?.code === 0 && response?.status === 'safe' && response?.code === 'ok') return;
  const safeCodes = new Set([
    'embedded_secret_detected',
    'config_parse_failed',
    'config_structure_unsafe',
    'config_too_large',
    'config_operation_failed',
    'unsupported_action',
  ]);
  const code = safeCodes.has(response?.code) ? response.code : 'invalid_result';
  throw new GovernanceHermesConfigurationError(
    code === 'embedded_secret_detected'
      ? 'Hermes config.yaml 包含疑似明文凭据，拒绝创建配置备份。'
      : `Hermes config.yaml 安全解析失败（${code}）。`,
  );
}

async function applyProfileSyncPlan({ plan, run, fileSystem }) {
  const profileEnvironment = { HERMES_HOME:plan.profileHome };
  if (plan.soul.changed) {
    await fileSystem.copyFile(plan.promptPath, path.join(plan.profileHome, 'SOUL.md'));
  }
  if (plan.mcp.changed) {
    await run(hermesCommand, ['mcp', 'remove', 'agent-army'], {
      allowFailure:true,
      env:profileEnvironment,
      input:'\n',
    });
    await run(hermesCommand, [
      'mcp',
      'add',
      'agent-army',
      '--command',
      process.execPath,
      '--env',
      ...mcpEnvironmentEntries(plan.manifest),
      '--args',
      mcpServerPath,
    ], { env:profileEnvironment, input:'\n' });
    await run(hermesCommand, [
      'config',
      'set',
      '--force',
      'mcp_servers.agent-army.timeout',
      '290',
    ], { env:profileEnvironment, input:'\n' });
    for (const toolName of plan.manifest.runtimeCapabilities.mcpTools) {
      await run(hermesCommand, [
        'tools',
        'enable',
        '--platform',
        'feishu',
        `agent-army:${toolName}`,
      ], { env:profileEnvironment });
    }
  }
  if (plan.toolsets.changed) {
    await setExactFeishuToolsets({
      profileHome:plan.profileHome,
      expectedCurrent:plan.currentToolsets,
      target:plan.targetToolsets,
      run,
    });
  }
  if (plan.runtimePolicy.changed) {
    await applyRuntimePolicy({
      profileHome:plan.profileHome,
      target:plan.targetRuntimePolicy,
      run,
    });
  }
}

async function applyRuntimePolicy({ profileHome, target, run }) {
  const settings = [
    ['agent.max_turns', target.agent.maxTurns],
    ['agent.reasoning_effort', target.agent.reasoningEffort],
    ['agent.api_max_retries', target.agent.apiMaxRetries],
    ['tool_loop_guardrails.hard_stop_enabled', target.toolLoopGuardrails.hardStopEnabled],
    ['tools.tool_search.enabled', target.tools.toolSearch.enabled],
    ['compression.enabled', target.compression.enabled],
    ['compression.threshold', target.compression.threshold],
    ['compression.target_ratio', target.compression.targetRatio],
    ['compression.protect_first_n', target.compression.protectFirstN],
    ['compression.protect_last_n', target.compression.protectLastN],
    ['memory.write_approval', target.memory.writeApproval],
    ['memory.nudge_interval', target.memory.nudgeInterval],
    ['sessions.auto_prune', target.sessions.autoPrune],
    ['sessions.retention_days', target.sessions.retentionDays],
    ['session_reset.mode', target.sessionReset.mode],
    ['session_reset.idle_minutes', target.sessionReset.idleMinutes],
    ['session_reset.notify', target.sessionReset.notify],
  ];
  for (const [key, value] of settings) {
    await run(hermesCommand, ['config', 'set', '--force', key, String(value)], {
      env:{ HERMES_HOME:profileHome },
      input:'\n',
    });
  }
}

export async function setExactFeishuToolsets({
  profileHome,
  expectedCurrent,
  target,
  run = runCommand,
  pythonCommand = hermesPythonCommand,
  helperPath = feishuToolsetHelperPath,
}) {
  const payload = {
    schemaVersion:1,
    expectedCurrent:assertTypedToolsetNames(expectedCurrent, 'expectedCurrent'),
    target:assertTypedToolsetNames(target, 'target', {
      approved:APPROVED_FEISHU_TOOLSETS,
    }),
  };
  const result = await run(pythonCommand, [helperPath, 'apply-toolsets'], {
    allowFailure:true,
    env:{ HERMES_HOME:profileHome },
    input:`${JSON.stringify(payload)}\n`,
  });
  let response;
  try {
    response = JSON.parse(String(result?.stdout || '').trim());
  } catch {
    throw new GovernanceHermesConfigurationError(
      'Hermes 飞书工具白名单写入器返回了无效结构。',
    );
  }
  const safeCodes = new Set([
    'ok',
    'invalid_json',
    'payload_not_object',
    'invalid_payload_contract',
    'expected_current_not_typed_list',
    'expected_current_contains_invalid_name',
    'expected_current_contains_duplicates',
    'target_not_typed_list',
    'target_contains_invalid_name',
    'target_contains_duplicates',
    'target_contains_unapproved_name',
    'config_not_object',
    'platform_toolsets_not_object',
    'current_not_typed_list',
    'current_contains_invalid_name',
    'current_contains_duplicates',
    'expected_current_mismatch',
    'write_verification_failed',
    'config_operation_failed',
    'unsupported_action',
  ]);
  const code = safeCodes.has(response?.code) ? response.code : 'invalid_result';
  const success = result?.code === 0
    && ['updated', 'unchanged'].includes(response?.status)
    && code === 'ok';
  if (!success) {
    throw new GovernanceHermesConfigurationError(
      `Hermes 飞书工具白名单同步失败（${code}）。`,
    );
  }
  return {
    status:response.status,
    changed:response.changed === true,
  };
}

function assertTypedToolsetNames(value, field, { approved } = {}) {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item))
    || new Set(value).size !== value.length
    || (approved && value.some((item) => !approved.has(item)))) {
    throw new GovernanceHermesConfigurationError(
      `Hermes 飞书工具白名单 ${field} 必须是无重复的字符串列表。`,
    );
  }
  return [...value].sort();
}

async function restoreProfileSyncBackup(backup, fileSystem) {
  await assertSafeProfileHome({
    agentId:backup.agentId,
    profileHome:backup.profileHome,
    profileRoot:backup.profileRoot,
    fileSystem,
  });
  for (const name of backup.files) {
    await fileSystem.copyFile(
      path.join(backup.root, name),
      path.join(backup.profileHome, name),
    );
  }
}

export async function readCurrentProfileState(profileHome, {
  run = runCommand,
  pythonCommand = hermesPythonCommand,
  helperPath = feishuToolsetHelperPath,
} = {}) {
  const result = await run(pythonCommand, [helperPath, 'inspect'], {
    allowFailure:true,
    env:{ HERMES_HOME:profileHome },
  });
  let response;
  try {
    response = JSON.parse(String(result?.stdout || '').trim());
  } catch {
    throw new GovernanceHermesConfigurationError(
      'Hermes Profile 检查器返回了无效结构。',
    );
  }
  if (result?.code !== 0 || response?.status !== 'inspected' || response?.code !== 'ok') {
    throw new GovernanceHermesConfigurationError(
      'Hermes Profile 检查失败。',
    );
  }
  const state = response?.state;
  if (!state || !Object.hasOwn(state, 'mcp') || !Object.hasOwn(state, 'feishuToolsets')) {
    throw new GovernanceHermesConfigurationError(
      'Hermes Profile 检查器缺少必要状态。',
    );
  }
  const feishuToolsets = assertTypedToolsetNames(state.feishuToolsets, 'current');
  if (state.mcp !== null && (typeof state.mcp !== 'object' || Array.isArray(state.mcp))) {
    throw new GovernanceHermesConfigurationError(
      'Hermes Profile MCP 状态结构无效。',
    );
  }
  return {
    mcp:state.mcp,
    feishuToolsets,
    runtimePolicy:normalizeRuntimePolicy(state.runtimePolicy),
  };
}

function normalizeRuntimePolicy(value = {}) {
  return {
    agent:{
      maxTurns:Number(value?.agent?.maxTurns || 500),
      reasoningEffort:String(value?.agent?.reasoningEffort || 'medium'),
      apiMaxRetries:Number(value?.agent?.apiMaxRetries ?? 3),
    },
    toolLoopGuardrails:{ hardStopEnabled:value?.toolLoopGuardrails?.hardStopEnabled === true },
    tools:{
      toolSearch:{
        enabled:['auto', 'on', 'off'].includes(value?.tools?.toolSearch?.enabled)
          ? value.tools.toolSearch.enabled
          : 'auto',
      },
    },
    compression:{
      enabled:value?.compression?.enabled !== false,
      threshold:Number(value?.compression?.threshold ?? 0.5),
      targetRatio:Number(value?.compression?.targetRatio ?? 0.2),
      protectFirstN:Number(value?.compression?.protectFirstN ?? 3),
      protectLastN:Number(value?.compression?.protectLastN ?? 20),
    },
    memory:{
      writeApproval:value?.memory?.writeApproval !== false,
      nudgeInterval:Number(value?.memory?.nudgeInterval ?? 0),
    },
    sessions:{
      autoPrune:value?.sessions?.autoPrune === true,
      retentionDays:Number(value?.sessions?.retentionDays ?? 90),
    },
    sessionReset:{
      mode:String(value?.sessionReset?.mode || 'none'),
      idleMinutes:Number(value?.sessionReset?.idleMinutes ?? 1440),
      notify:value?.sessionReset?.notify !== false,
    },
  };
}

function runtimePolicyDiff(current, target) {
  const paths = [
    'agent.maxTurns', 'agent.reasoningEffort', 'agent.apiMaxRetries',
    'toolLoopGuardrails.hardStopEnabled',
    'tools.toolSearch.enabled',
    'compression.enabled', 'compression.threshold', 'compression.targetRatio',
    'compression.protectFirstN', 'compression.protectLastN',
    'memory.writeApproval', 'memory.nudgeInterval',
    'sessions.autoPrune', 'sessions.retentionDays',
    'sessionReset.mode', 'sessionReset.idleMinutes', 'sessionReset.notify',
  ];
  const differences = paths.filter((item) => valueAtPath(current, item) !== valueAtPath(target, item));
  return { changed:differences.length > 0, differences, current, target };
}

function valueAtPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

function splitCsv(value) {
  return sortedStrings(String(value || '').split(','));
}

function sortedStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )].sort();
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export async function auditApprovedSkillSource({
  slug,
  sourceLocator,
  companySkill = null,
} = {}) {
  const policy = AUDITED_SKILL_INVENTORIES[slug];
  if (!policy || !SKILL_SLUG_PATTERN.test(String(slug || ''))) {
    throw new GovernanceHermesConfigurationError(`技能 ${String(slug || '')} 没有已批准的审计清单。`);
  }
  const realPath = await fs.realpath(sourceLocator).catch(() => null);
  if (!realPath) {
    throw new GovernanceHermesConfigurationError(`技能 ${slug} 的来源真实路径不可用。`);
  }
  if (policy.sourceKind === 'paperclip-package') {
    const packageRoot = path.resolve(os.homedir(), '.npm/_npx');
    const expectedSuffix = path.join(
      'node_modules',
      '@paperclipai',
      'server',
      'skills',
      slug,
    );
    if (
      !pathWithin(packageRoot, realPath)
      || !realPath.endsWith(`${path.sep}${expectedSuffix}`)
      || companySkill?.trustLevel !== policy.trustLevel
    ) {
      throw new GovernanceHermesConfigurationError(`技能 ${slug} 的 Paperclip 来源或信任级别未获批准。`);
    }
  } else if (policy.sourceKind === 'repository') {
    const expected = path.resolve(
      AGENT_ARMY_REPOSITORY_ROOT,
      'agents/video-content-analyst/skills/agent-army-video-content',
    );
    if (realPath !== expected || companySkill?.trustLevel !== policy.trustLevel) {
      throw new GovernanceHermesConfigurationError(`技能 ${slug} 的仓库来源或信任级别未获批准。`);
    }
  } else if (policy.sourceKind === 'hermes-builtin') {
    const expected = await fs.realpath(HERMES_BUILTIN_SKILL_SOURCES[slug]).catch(() => null);
    if (!expected || realPath !== expected || companySkill) {
      throw new GovernanceHermesConfigurationError(`技能 ${slug} 不是批准的 Hermes 内置来源。`);
    }
  } else if (policy.sourceKind === 'shared-library') {
    const expected = await fs.realpath(path.join(SHARED_SKILL_LIBRARY_ROOT, slug)).catch(() => null);
    if (!expected || realPath !== expected || companySkill?.trustLevel !== policy.trustLevel) {
      throw new GovernanceHermesConfigurationError(`技能 ${slug} 的共享技能库来源或信任级别未获批准。`);
    }
  }
  const sha256 = await skillInventoryDigest(realPath);
  if (sha256 !== policy.sha256) {
    throw new GovernanceHermesConfigurationError(
      `技能 ${slug} 的文件清单或哈希已漂移，必须重新审计后才能安装。`,
    );
  }
  return { slug, realPath, sha256, sourceKind:policy.sourceKind };
}

export async function installAuditedSkillDirectory({
  slug,
  sourceLocator,
  target,
  expectedHash,
} = {}) {
  if (!SKILL_SLUG_PATTERN.test(String(slug || ''))) {
    throw new GovernanceHermesConfigurationError('技能 slug 不合法。');
  }
  const targetRoot = path.dirname(target);
  if (path.resolve(targetRoot, slug) !== target) {
    throw new GovernanceHermesConfigurationError(`技能 ${slug} 的目标路径不匹配。`);
  }
  const staging = `${target}.agent-army-staging`;
  const backup = `${target}.agent-army-backup`;
  await fs.mkdir(targetRoot, { recursive:true });
  const targetState = await fs.lstat(target).catch(() => null);
  const backupState = await fs.lstat(backup).catch(() => null);
  if (targetState?.isSymbolicLink() || backupState?.isSymbolicLink()) {
    throw new GovernanceHermesConfigurationError(`技能 ${slug} 的目标或恢复目录是符号链接。`);
  }
  if (!targetState && backupState?.isDirectory()) {
    await fs.rename(backup, target);
  } else if (backupState) {
    throw new GovernanceHermesConfigurationError(`技能 ${slug} 存在未确认的旧恢复目录。`);
  }
  await fs.rm(staging, { recursive:true, force:true });
  await fs.cp(sourceLocator, staging, {
    recursive:true,
    force:false,
    errorOnExist:true,
    dereference:false,
  });
  try {
    const copiedHash = await skillInventoryDigest(staging);
    if (copiedHash !== expectedHash) {
      throw new GovernanceHermesConfigurationError(`技能 ${slug} 复制后哈希不一致。`);
    }
    const current = await fs.lstat(target).catch(() => null);
    if (current) await fs.rename(target, backup);
    try {
      await fs.rename(staging, target);
    } catch (error) {
      if (current && !await fs.lstat(target).catch(() => null)) {
        await fs.rename(backup, target);
      }
      throw error;
    }
    await fs.rm(backup, { recursive:true, force:true });
  } finally {
    await fs.rm(staging, { recursive:true, force:true });
  }
}

async function skillInventoryDigest(root) {
  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes:true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const state = await fs.lstat(absolute);
      if (state.isSymbolicLink()) {
        throw new GovernanceHermesConfigurationError(`技能来源包含符号链接：${relative}`);
      }
      if (state.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (state.isFile()) {
        fileCount += 1;
        totalBytes += state.size;
        if (fileCount > 512 || totalBytes > 20 * 1024 * 1024) {
          throw new GovernanceHermesConfigurationError('技能文件清单超过批准上限。');
        }
        hash.update(`f\0${relative}\0${state.mode & 0o777}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update('\0');
      } else {
        throw new GovernanceHermesConfigurationError(`技能来源包含不支持的文件类型：${relative}`);
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function listPaperclipCompanySkills(fetchImpl) {
  const companyResponse = await fetchImpl(`${paperclipUrl}/api/companies`, { signal:AbortSignal.timeout(2500) });
  if (!companyResponse.ok) throw new GovernanceHermesConfigurationError('Paperclip 公司列表不可用。');
  const companies = await companyResponse.json();
  const company = companies.find((item) => item.name === 'Agent军团');
  if (!company) throw new GovernanceHermesConfigurationError('Paperclip 中未找到 Agent军团。');
  const skillsResponse = await fetchImpl(`${paperclipUrl}/api/companies/${company.id}/skills`, { signal:AbortSignal.timeout(2500) });
  if (!skillsResponse.ok) throw new GovernanceHermesConfigurationError('Paperclip 公司技能库不可用。');
  return skillsResponse.json();
}

function normalizeAgentIds(value, { allowDraftProfiles = false } = {}) {
  const allowed = new Set(GOVERNANCE_HERMES_AGENT_IDS);
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values
    .map((item) => String(item || '').trim())
    .filter((item) => allowDraftProfiles ? /^[a-z][a-z0-9-]{0,63}$/.test(item) : allowed.has(item)))];
}

function runCommand(command, args, { allowFailure = false, env = {}, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio:['pipe', 'pipe', 'pipe'],
      env:{ ...process.env, ...env, NO_COLOR:'1' }
    });
    let stdout = '';
    let stderr = '';
    child.stdin.end(input);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout });
      else reject(new GovernanceHermesConfigurationError(
        `Hermes 配置命令失败：${args.slice(0, 4).join(' ')}。${redactHermesCommandError(stderr)}`
      ));
    });
  });
}

function readCommandOutput(command, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio:['ignore', 'pipe', 'pipe'],
      env:{ ...process.env, ...env, NO_COLOR:'1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new GovernanceHermesConfigurationError(
        `Hermes 只读配置命令失败：${args.slice(0, 4).join(' ')}。${redactHermesCommandError(stderr)}`,
      ));
    });
  });
}

export function redactHermesCommandError(value) {
  return String(value || '')
    .replace(
      /\b(Bearer)\s+[^\s"'`,;]+/gi,
      '$1 [REDACTED]',
    )
    .replace(
      /\b(api[-_]?key|secret|token|cookie|authorization|password|passwd|private[-_]?key)\b(\s*(?:=|:)\s*|\s+)(["']?)[^\s,;]+/gi,
      '$1$2$3[REDACTED]',
    )
    .replace(
      /(?:file:\/\/)?\/(?:Users|home|private\/var|var\/folders)\/[^\s"'`,;]+/g,
      '[LOCAL_PATH]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export class GovernanceHermesConfigurationError extends Error {}

async function main() {
  try {
    const args = process.argv.slice(2);
    const profileSync = parseProfileSyncArgs(args);
    if (profileSync) {
      const results = await syncGovernanceHermesProfiles(profileSync);
      console.log(JSON.stringify({
        mode:profileSync.mode,
        results,
        writesPerformed:profileSync.mode === 'apply'
          && results.some((item) => item.writesPerformed),
        gatewayActions:0,
      }, null, 2));
      return;
    }
    const allowDraftProfiles = args.includes('--allow-draft-testing');
    const skillsOnly = args.includes('--skills-only');
    const requestedAgentIds = args.filter(
      (item) => !['--allow-draft-testing', '--skills-only'].includes(item),
    );
    if (skillsOnly && requestedAgentIds.length === 0) {
      throw new GovernanceHermesConfigurationError(
        '--skills-only 必须显式列出岗位 ID；拒绝默认修改全部 Profile。',
      );
    }
    const results = await configureGovernanceHermesRuntime(requestedAgentIds.length
      ? { agentIds:requestedAgentIds, allowDraftProfiles, skillsOnly }
      : { allowDraftProfiles, skillsOnly });
    for (const result of results) {
      console.log(
        result.executionMode === 'skills-only'
          ? `已为 ${result.agentId} 收敛 ${result.skills.length} 个声明技能；未修改 MCP、Gateway 或外部连接。`
          : `已配置 ${result.agentId}：${result.skills.length} 个复用技能、${result.mcpTools.length} 个 MCP 工具、${result.gatewayInstalled ? 'Gateway 登录自启' : 'Paperclip 按需运行且 Gateway 已停用'}。`,
      );
    }
  } catch (error) {
    console.error(error instanceof GovernanceHermesConfigurationError ? error.message : '治理员工 Hermes 配置失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
