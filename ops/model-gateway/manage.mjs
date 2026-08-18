#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(HERE, 'docker-compose.yml');
const POLICY_FILE = path.join(HERE, 'policy.json');
const RUNTIME_ROOT = path.join(os.homedir(), '.config', 'agent-army', 'model-gateway');
const RUNTIME_ENV = path.join(RUNTIME_ROOT, 'gateway.env');
const VIRTUAL_KEYS_FILE = path.join(RUNTIME_ROOT, 'virtual-keys.json');
const CUTOVERS_FILE = path.join(RUNTIME_ROOT, 'cutovers.json');
const DIRECT_CUTOVERS_FILE = path.join(RUNTIME_ROOT, 'direct-cutovers.json');
const BACKUP_ROOT = path.join(RUNTIME_ROOT, 'backups');
const HERMES_ROOT = path.join(os.homedir(), '.hermes');
const FLEET_PROFILES = Object.freeze([
  'default',
  'ajun',
  'architect',
  'content-creator',
  'creator',
  'intel-researcher',
  'office-assistant',
  'operator',
  'reviewer',
  'technical-expert',
  'video-content-analyst',
  'xiaod',
]);
const OFFICIAL_STEPFUN_BASE = 'https://api.stepfun.com/step_plan/v1';
const OFFICIAL_STEPFUN_ROUTER_BASE = 'https://api.stepfun.com/step_plan';
const OFFICIAL_STEPFUN_BASES = new Set([
  'https://api.stepfun.com/step_plan/v1',
  'https://api.stepfun.ai/step_plan/v1',
]);
const OFFICIAL_STEPFUN_ROUTER_BASES = new Set([
  'https://api.stepfun.com/step_plan',
  'https://api.stepfun.ai/step_plan',
]);
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command = 'status', ...args] = process.argv.slice(2);
  try {
    if (command === 'prepare') await prepare(resolvePrepareProfile(args));
    else if (command === 'start') await start();
    else if (command === 'provision') await provision();
    else if (command === 'cutover') await cutover(requireProfile(args));
    else if (command === 'rollback') await rollback(requireProfile(args));
    else if (command === 'direct') await direct(requireAll(args));
    else if (command === 'restore-gateway') await restoreGateway(requireNoArgs(command, args));
    else if (command === 'retire') await retire(requireNoArgs(command, args));
    else if (command === 'probe') await probe(requireProfile(args));
    else if (command === 'status') await status();
    else if (command === 'usage') await usage(requireDate(args));
    else throw safeError(`未知命令：${command}`);
  } catch (error) {
    process.stderr.write(`${safeMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function prepare(profile = 'default') {
  const sourceEnv = path.join(hermesProfileHome(profile), '.env');
  const upstreamKey = parseEnvValue(await readPrivateFile(sourceEnv), 'STEPFUN_API_KEY');
  if (!upstreamKey) throw safeError('Hermes 默认 Profile 缺少 STEPFUN_API_KEY。');
  await ensurePrivateDirectory(RUNTIME_ROOT);
  await ensurePrivateDirectory(BACKUP_ROOT);

  const existing = await readOptionalPrivateFile(RUNTIME_ENV);
  const values = existing ? parseEnv(existing) : {};
  const next = {
    POSTGRES_PASSWORD: values.POSTGRES_PASSWORD || randomSecret('pg'),
    LITELLM_MASTER_KEY: values.LITELLM_MASTER_KEY || randomSecret('sk'),
    LITELLM_SALT_KEY: values.LITELLM_SALT_KEY || randomSecret('sk'),
    STEPFUN_UPSTREAM_API_KEY: upstreamKey,
  };
  await writePrivateAtomic(RUNTIME_ENV, serializeEnv(next));
  process.stdout.write(`运行目录已准备：${RUNTIME_ROOT}；上游凭据来源：${profile}（未输出任何钥匙）\n`);
}

async function start() {
  await readPrivateFile(RUNTIME_ENV);
  runDocker(['compose', '--env-file', RUNTIME_ENV, '-f', COMPOSE_FILE, 'up', '-d']);
  await waitForGateway();
  process.stdout.write('模型入口已启动：http://127.0.0.1:4000\n');
}

async function provision() {
  const policy = await readPolicy();
  const runtime = parseEnv(await readPrivateFile(RUNTIME_ENV));
  const saved = await readPrivateJson(VIRTUAL_KEYS_FILE, {
    schemaVersion:'agent.army/model-gateway-virtual-keys/v1',
    profiles:{},
  });
  let created = 0;
  let updated = 0;
  for (const [profile, limits] of Object.entries(policy.profiles)) {
    const body = {
      key_alias:`agent-army:${profile}`,
      models:policy.models,
      max_budget:limits.maxBudgetUsd,
      budget_duration:'1d',
      rpm_limit:limits.rpm,
      tpm_limit:limits.tpm,
      max_parallel_requests:limits.maxParallel,
      metadata:{
        source:'agent-army-model-gateway',
        agent_id:profile,
        budget_basis:'estimated_step_3_5_flash_public_price',
      },
    };
    const existingKey = String(saved.profiles?.[profile]?.key || '');
    if (validVirtualKey(existingKey)) {
      await gatewayJson('/key/update', {
        method:'POST',
        masterKey:runtime.LITELLM_MASTER_KEY,
        body:{ key:existingKey, ...body },
      });
      saved.profiles[profile].policy = limits;
      saved.profiles[profile].updatedAt = new Date().toISOString();
      await writePrivateJson(VIRTUAL_KEYS_FILE, saved);
      updated += 1;
      continue;
    }
    const response = await gatewayJson('/key/generate', {
      method:'POST',
      masterKey:runtime.LITELLM_MASTER_KEY,
      body,
    });
    const key = String(response?.key || response?.token || '');
    if (!validVirtualKey(key)) throw safeError(`${profile} 的虚拟钥匙响应无效。`);
    saved.profiles[profile] = {
      key,
      alias:body.key_alias,
      createdAt:new Date().toISOString(),
      policy:limits,
    };
    await writePrivateJson(VIRTUAL_KEYS_FILE, saved);
    created += 1;
  }
  process.stdout.write(`虚拟钥匙就绪：${Object.keys(saved.profiles).length} 个岗位，本次新建 ${created} 个、同步 ${updated} 个。\n`);
}

async function cutover(profile) {
  const policy = await readPolicy();
  if (!policy.profiles[profile]) throw safeError(`策略中没有岗位：${profile}`);
  const keys = await readPrivateJson(VIRTUAL_KEYS_FILE);
  const virtualKey = String(keys?.profiles?.[profile]?.key || '');
  if (!validVirtualKey(virtualKey)) throw safeError(`岗位 ${profile} 尚未生成虚拟钥匙。`);

  const profileHome = hermesProfileHome(profile);
  const envFile = path.join(profileHome, '.env');
  const configFile = path.join(profileHome, 'config.yaml');
  const envContent = await readPrivateFile(envFile);
  const configContent = await readOwnedRegularFile(configFile);
  const nextEnv = replaceEnvValues(envContent, {
    STEPFUN_API_KEY:virtualKey,
    STEPFUN_BASE_URL:policy.gatewayBaseUrl,
  });
  const nextConfig = rewriteStepfunProviders(configContent, policy.gatewayBaseUrl);
  const backup = await createBackup(profile, { envFile, configFile, envContent, configContent });
  try {
    await writePrivateAtomic(envFile, nextEnv);
    await writePrivateAtomic(configFile, nextConfig);
  } catch (error) {
    await writePrivateAtomic(envFile, envContent);
    await writePrivateAtomic(configFile, configContent);
    throw error;
  }
  const cutovers = await readPrivateJson(CUTOVERS_FILE, {
    schemaVersion:'agent.army/model-gateway-cutovers/v1',
    profiles:{},
  });
  cutovers.profiles[profile] = {
    backupDirectory:backup,
    cutoverAt:new Date().toISOString(),
    gatewayBaseUrl:policy.gatewayBaseUrl,
  };
  await writePrivateJson(CUTOVERS_FILE, cutovers);
  process.stdout.write(`${profile} 已切到统一入口；备份位于私密运行目录。需要重启该 Hermes 进程后生效。\n`);
}

async function rollback(profile) {
  const cutovers = await readPrivateJson(CUTOVERS_FILE);
  const active = cutovers?.profiles?.[profile];
  if (!active?.backupDirectory) throw safeError(`${profile} 没有可恢复的切换记录。`);
  const backupDirectory = path.resolve(active.backupDirectory);
  if (!backupDirectory.startsWith(`${path.resolve(BACKUP_ROOT)}${path.sep}`)) {
    throw safeError('备份目录不在受控范围内。');
  }
  const envBackup = await readPrivateFile(path.join(backupDirectory, '.env'));
  const configBackup = await readPrivateFile(path.join(backupDirectory, 'config.yaml'));
  const profileHome = hermesProfileHome(profile);
  await writePrivateAtomic(path.join(profileHome, '.env'), envBackup);
  await writePrivateAtomic(path.join(profileHome, 'config.yaml'), configBackup);
  delete cutovers.profiles[profile];
  await writePrivateJson(CUTOVERS_FILE, cutovers);
  process.stdout.write(`${profile} 已恢复到切换前配置；重启该 Hermes 进程后生效。\n`);
}

async function direct() {
  const policy = await readPolicy();
  const profiles = requireFleetProfiles(policy);
  const runtime = parseEnv(await readPrivateFile(RUNTIME_ENV));
  const upstreamKey = String(runtime.STEPFUN_UPSTREAM_API_KEY || '');
  if (!upstreamKey) throw safeError('模型入口运行文件缺少上游 StepFun 凭据。');
  const keys = await readPrivateJson(VIRTUAL_KEYS_FILE, { profiles:{} });
  const snapshots = await readProfileSnapshots(profiles);
  assertAllProfilesOnRoute(snapshots, keys, runtime, 'gateway', '全军直连迁移');
  const plans = snapshots.map((snapshot) => ({
    ...snapshot,
    nextEnv:replaceEnvValues(snapshot.envContent, {
      STEPFUN_API_KEY:upstreamKey,
      STEPFUN_BASE_URL:OFFICIAL_STEPFUN_BASE,
    }),
    nextConfig:setModelMaxTokens(rewriteStepfunProvidersForDirect(snapshot.configContent), 8192),
  }));
  const backupDirectory = await createDirectMigrationBackup(plans);
  try {
    await applyProfileContents(plans, 'next');
    await recordDirectCutover(backupDirectory, plans.map(({ profile }) => profile));
  } catch (error) {
    const restoreError = await restoreProfileContents(plans, 'original');
    if (restoreError) throw safeError(`全军直连迁移未完成，且自动恢复失败：${restoreError}`);
    throw safeError('全军直连迁移未完成；已恢复全部岗位原配置。');
  }
  process.stdout.write(`全军 ${plans.length} 个 Hermes Profile 已改为 StepFun 直连；已创建私密网关恢复备份。重启对应 Hermes 进程后生效。\n`);
}

async function restoreGateway() {
  const record = await readPrivateJson(DIRECT_CUTOVERS_FILE);
  const migration = record?.latest;
  if (!migration?.backupDirectory || !Array.isArray(migration?.profiles) || !migration.profiles.length) {
    throw safeError('没有可恢复的全军网关迁移备份。');
  }
  assertFleetProfileList(migration.profiles, '全军网关迁移备份');
  const backupDirectory = controlledBackupDirectory(migration.backupDirectory);
  const backups = await readVerifiedDirectMigrationBackup(backupDirectory, migration.profiles);
  const current = await readProfileSnapshots(migration.profiles);
  const plans = [];
  for (const profile of migration.profiles) {
    const backup = backups.get(profile);
    plans.push({
      profile,
      envFile:path.join(hermesProfileHome(profile), '.env'),
      configFile:path.join(hermesProfileHome(profile), 'config.yaml'),
      envContent:backup.envContent,
      configContent:backup.configContent,
      currentEnv:current.find((item) => item.profile === profile)?.envContent,
      currentConfig:current.find((item) => item.profile === profile)?.configContent,
    });
  }
  try {
    await applyProfileContents(plans, 'backup');
  } catch (error) {
    const restoreError = await restoreProfileContents(plans, 'current');
    if (restoreError) throw safeError(`恢复统一入口未完成，且自动恢复失败：${restoreError}`);
    throw safeError('恢复统一入口未完成；已恢复全军直连前的当前配置。');
  }
  record.latest.restoredAt = new Date().toISOString();
  await writePrivateJson(DIRECT_CUTOVERS_FILE, record);
  process.stdout.write(`全军 ${plans.length} 个 Hermes Profile 已恢复到本次迁移前的统一入口配置。重启对应 Hermes 进程后生效。\n`);
}

async function retire() {
  const policy = await readPolicy();
  const profiles = requireFleetProfiles(policy);
  const runtime = parseEnv(await readPrivateFile(RUNTIME_ENV));
  const keys = await readPrivateJson(VIRTUAL_KEYS_FILE, { profiles:{} });
  const snapshots = await readProfileSnapshots(profiles);
  assertAllProfilesOnRoute(snapshots, keys, runtime, 'direct', '退役模型网关');
  runDocker(['compose', '--env-file', RUNTIME_ENV, '-f', COMPOSE_FILE, 'down']);
  process.stdout.write('模型网关 Compose 已停止；未删除 PostgreSQL 数据卷。\n');
}

async function probe(profile) {
  const policy = await readPolicy();
  if (!policy.profiles[profile]) throw safeError(`策略中没有岗位：${profile}`);
  const keys = await readPrivateJson(VIRTUAL_KEYS_FILE);
  const virtualKey = String(keys?.profiles?.[profile]?.key || '');
  if (!validVirtualKey(virtualKey)) throw safeError(`岗位 ${profile} 尚未生成虚拟钥匙。`);
  const startedAt = Date.now();
  const response = await gatewayJson('/v1/chat/completions', {
    method:'POST',
    masterKey:virtualKey,
    body:{
      model:policy.model,
      messages:[{ role:'user', content:'统一入口验收：只回复 OK' }],
      max_tokens:8,
      temperature:0,
    },
  });
  const usage = response?.usage || {};
  process.stdout.write(`${JSON.stringify({
    ok:Boolean(response?.id) && Array.isArray(response?.choices) && number(usage.total_tokens) > 0,
    profile,
    model:String(response?.model || policy.model),
    requestId:String(response?.id || ''),
    latencyMs:Date.now() - startedAt,
    inputTokens:number(usage.prompt_tokens),
    outputTokens:number(usage.completion_tokens),
    totalTokens:number(usage.total_tokens),
  }, null, 2)}\n`);
}

async function status() {
  const policy = await readPolicy();
  const keys = await readPrivateJson(VIRTUAL_KEYS_FILE, { profiles:{} });
  const runtime = parseEnv(await readPrivateFile(RUNTIME_ENV));
  let gateway = 'down';
  try {
    const response = await fetch(`${policy.gatewayBaseUrl}/health/liveliness`, { signal:AbortSignal.timeout(1500) });
    if (response.ok) gateway = 'up';
  } catch {}
  const rows = [];
  const observedKeys = new Set();
  let sharedUpstreamCredentials = 0;
  for (const profile of Object.keys(policy.profiles)) {
    const profileHome = hermesProfileHome(profile);
    const env = parseEnv(await readPrivateFile(path.join(profileHome, '.env')));
    const config = await readOwnedRegularFile(path.join(profileHome, 'config.yaml'));
    const observedKey = String(env.STEPFUN_API_KEY || '');
    if (observedKey) observedKeys.add(observedKey);
    if (observedKey === runtime.STEPFUN_UPSTREAM_API_KEY) sharedUpstreamCredentials += 1;
    const sstefunBaseUrl = providerBaseUrl(config, 'sstefun');
    const stepfunBaseUrl = providerBaseUrl(config, 'stepfun');
    const route = classifyProfileRoute({
      envBaseUrl:String(env.STEPFUN_BASE_URL || ''),
      sstefunBaseUrl,
      stepfunBaseUrl,
      observedKey,
      expectedVirtualKey:String(keys?.profiles?.[profile]?.key || ''),
      upstreamKey:String(runtime.STEPFUN_UPSTREAM_API_KEY || ''),
    });
    rows.push({
      profile,
      credential:route === 'gateway' ? 'active_unique' : route === 'direct' ? 'shared_upstream' : 'mixed_or_drifted',
      route,
      envBaseUrl:routeForEnvBaseUrl(String(env.STEPFUN_BASE_URL || '')),
      configBaseUrl:routeForConfigBases(sstefunBaseUrl, stepfunBaseUrl),
    });
  }
  process.stdout.write(`${JSON.stringify({
    gateway,
    baseUrl:policy.gatewayBaseUrl,
    uniqueProfileCredentials:observedKeys.size,
    sharedUpstreamCredentials,
    profiles:rows,
  }, null, 2)}\n`);
}

async function usage(date) {
  const policy = await readPolicy();
  const runtime = parseEnv(await readPrivateFile(RUNTIME_ENV));
  const end = new Date(`${date}T00:00:00+08:00`);
  end.setDate(end.getDate() + 1);
  const endDate = formatShanghaiDate(end);
  const result = await gatewayJson(
    `/spend/logs?start_date=${encodeURIComponent(date)}&end_date=${encodeURIComponent(endDate)}&summarize=false`,
    { masterKey:runtime.LITELLM_MASTER_KEY },
  );
  const rows = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
  const totals = new Map();
  for (const row of rows) {
    const alias = String(row?.metadata?.user_api_key_alias || row?.api_key_alias || 'unknown');
    const item = totals.get(alias) || { calls:0, inputTokens:0, outputTokens:0, totalTokens:0, estimatedUsd:0 };
    item.calls += 1;
    item.inputTokens += number(row?.prompt_tokens ?? row?.input_tokens);
    item.outputTokens += number(row?.completion_tokens ?? row?.output_tokens);
    item.totalTokens += number(row?.total_tokens);
    item.estimatedUsd += number(row?.spend);
    totals.set(alias, item);
  }
  process.stdout.write(`${JSON.stringify({
    date,
    timezone:'Asia/Shanghai',
    provider:'stepfun',
    model:policy.model,
    calls:rows.length,
    byKey:Object.fromEntries([...totals.entries()].sort()),
    costNote:'估算值；Provider 后台为最终账单',
  }, null, 2)}\n`);
}

export function replaceEnvValues(content, replacements) {
  const lines = String(content).split(/\r?\n/);
  for (const [key, value] of Object.entries(replacements)) {
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=`).test(lines[index])) matches.push(index);
    }
    if (matches.length > 1) throw safeError(`${key} 在 .env 中重复，拒绝覆盖。`);
    const rendered = `${key}=${dotenvQuote(value)}`;
    if (matches.length === 1) lines[matches[0]] = rendered;
    else lines.push(rendered);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function rewriteSstefunProvider(content, gatewayBaseUrl) {
  const lines = String(content).split(/\r?\n/);
  const start = lines.findIndex((line) => /^  - name:\s*sstefun\s*$/.test(line));
  if (start < 0) throw safeError('config.yaml 缺少 custom provider sstefun。');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  - name:\s*/.test(lines[index]) || /^[A-Za-z_][A-Za-z0-9_-]*:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  let baseCount = 0;
  let keyCount = 0;
  for (let index = start + 1; index < end; index += 1) {
    const base = /^    base_url:\s*(.+)\s*$/.exec(lines[index]);
    if (base) {
      const current = base[1].trim().replace(/^['"]|['"]$/g, '');
      if (!OFFICIAL_STEPFUN_BASES.has(current) && current !== gatewayBaseUrl && current !== 'http://127.0.0.1:4000') {
        throw safeError(`sstefun base_url 不是已知官方地址或目标网关：${current}`);
      }
      lines[index] = `    base_url: ${gatewayBaseUrl}`;
      baseCount += 1;
    }
    if (/^    api_key:\s*/.test(lines[index])) {
      lines[index] = '    api_key: ${STEPFUN_API_KEY}';
      keyCount += 1;
    }
  }
  if (baseCount !== 1 || keyCount !== 1) throw safeError('sstefun provider 的 base_url/api_key 结构异常。');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function rewriteStepfunProviders(content, gatewayBaseUrl) {
  return rewriteStepfunProviderTargets(content, {
    sstefunBaseUrl:gatewayBaseUrl,
    stepfunBaseUrl:gatewayBaseUrl,
  });
}

export function rewriteStepfunProvidersForDirect(content) {
  return rewriteStepfunProviderTargets(content, {
    sstefunBaseUrl:OFFICIAL_STEPFUN_BASE,
    stepfunBaseUrl:OFFICIAL_STEPFUN_ROUTER_BASE,
  });
}

function rewriteStepfunProviderTargets(content, { sstefunBaseUrl, stepfunBaseUrl }) {
  const primary = rewriteSstefunProvider(content, sstefunBaseUrl);
  const lines = primary.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^  - name:\s*stepfun\s*$/.test(lines[start])) continue;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^  - name:\s*/.test(lines[index]) || /^[A-Za-z_][A-Za-z0-9_-]*:\s*$/.test(lines[index])) {
        end = index;
        break;
      }
    }
    const baseIndex = lines.findIndex((line, index) =>
      index > start && index < end && /^    base_url:\s*/.test(line));
    if (baseIndex < 0) continue;
    const current = lines[baseIndex].replace(/^    base_url:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!OFFICIAL_STEPFUN_ROUTER_BASES.has(current) && current !== 'http://127.0.0.1:4000') continue;
    lines[baseIndex] = `    base_url: ${stepfunBaseUrl}`;
    const keyIndex = lines.findIndex((line, index) => index > start && index < end && /^    api_key:\s*/.test(line));
    if (keyIndex >= 0) lines[keyIndex] = '    api_key: ${STEPFUN_API_KEY}';
    else lines.splice(baseIndex + 1, 0, '    api_key: ${STEPFUN_API_KEY}');
    break;
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function setModelMaxTokens(content, maxTokens) {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw safeError('model.max_tokens 必须是正整数。');
  const lines = String(content).split(/\r?\n/);
  const start = lines.findIndex((line) => /^model:\s*$/.test(line));
  if (start < 0) throw safeError('config.yaml 缺少顶层 model 配置。');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const matches = [];
  for (let index = start + 1; index < end; index += 1) {
    if (/^  max_tokens:\s*/.test(lines[index])) matches.push(index);
  }
  if (matches.length > 1) throw safeError('model.max_tokens 重复，拒绝覆盖。');
  if (matches.length === 1) lines[matches[0]] = `  max_tokens: ${maxTokens}`;
  else lines.splice(start + 1, 0, `  max_tokens: ${maxTokens}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function classifyProfileRoute({
  envBaseUrl,
  sstefunBaseUrl,
  stepfunBaseUrl,
  observedKey,
  expectedVirtualKey,
  upstreamKey,
}) {
  const envRoute = routeForEnvBaseUrl(envBaseUrl);
  const configRoute = routeForConfigBases(sstefunBaseUrl, stepfunBaseUrl);
  const credentialRoute = validVirtualKey(expectedVirtualKey) && observedKey === expectedVirtualKey
    ? 'gateway'
    : upstreamKey && observedKey === upstreamKey
      ? 'direct'
      : 'mixed';
  if (envRoute === 'gateway' && configRoute === 'gateway' && credentialRoute === 'gateway') return 'gateway';
  if (envRoute === 'direct' && configRoute === 'direct' && credentialRoute === 'direct') return 'direct';
  return 'mixed';
}

function routeForEnvBaseUrl(baseUrl) {
  if (baseUrl === 'http://127.0.0.1:4000') return 'gateway';
  if (OFFICIAL_STEPFUN_BASES.has(baseUrl)) return 'direct';
  return 'mixed';
}

function routeForConfigBases(sstefunBaseUrl, stepfunBaseUrl) {
  const chatRoute = sstefunBaseUrl === 'http://127.0.0.1:4000'
    ? 'gateway'
    : OFFICIAL_STEPFUN_BASES.has(sstefunBaseUrl)
      ? 'direct'
      : 'mixed';
  const anthropicRoute = stepfunBaseUrl === null
    ? chatRoute
    : stepfunBaseUrl === 'http://127.0.0.1:4000'
      ? 'gateway'
      : OFFICIAL_STEPFUN_ROUTER_BASES.has(stepfunBaseUrl)
        ? 'direct'
        : 'mixed';
  return chatRoute === anthropicRoute ? chatRoute : 'mixed';
}

function providerBaseUrl(content, providerName) {
  const lines = String(content).split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^  - name:\\s*${escapeRegExp(providerName)}\\s*$`).test(line));
  if (start < 0) return null;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  - name:\s*/.test(lines[index]) || /^[A-Za-z_][A-Za-z0-9_-]*:\s*$/.test(lines[index])) break;
    const match = /^    base_url:\s*(.+)\s*$/.exec(lines[index]);
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

async function createBackup(profile, files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(BACKUP_ROOT, `${stamp}-${profile}`);
  await ensurePrivateDirectory(directory);
  await writePrivateAtomic(path.join(directory, '.env'), files.envContent);
  await writePrivateAtomic(path.join(directory, 'config.yaml'), files.configContent);
  await writePrivateJson(path.join(directory, 'manifest.json'), {
    schemaVersion:'agent.army/model-gateway-backup/v1',
    profile,
    createdAt:new Date().toISOString(),
    files:{
      '.env':sha256(files.envContent),
      'config.yaml':sha256(files.configContent),
    },
  });
  return directory;
}

async function readProfileSnapshots(profiles) {
  const uniqueProfiles = [...new Set(profiles)];
  if (uniqueProfiles.length !== profiles.length || !uniqueProfiles.length) throw safeError('全军迁移岗位清单无效。');
  const snapshots = [];
  for (const profile of uniqueProfiles) {
    const profileHome = hermesProfileHome(profile);
    const envFile = path.join(profileHome, '.env');
    const configFile = path.join(profileHome, 'config.yaml');
    snapshots.push({
      profile,
      envFile,
      configFile,
      envContent:await readPrivateFile(envFile),
      configContent:await readOwnedRegularFile(configFile),
    });
  }
  return snapshots;
}

async function createDirectMigrationBackup(plans) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(BACKUP_ROOT, `${stamp}-gateway-before-direct-all`);
  await ensurePrivateDirectory(directory);
  const profiles = {};
  for (const plan of plans) {
    const profileDirectory = path.join(directory, plan.profile);
    await ensurePrivateDirectory(profileDirectory);
    await writePrivateAtomic(path.join(profileDirectory, '.env'), plan.envContent);
    await writePrivateAtomic(path.join(profileDirectory, 'config.yaml'), plan.configContent);
    profiles[plan.profile] = {
      '.env':sha256(plan.envContent),
      'config.yaml':sha256(plan.configContent),
    };
  }
  await writePrivateJson(path.join(directory, 'manifest.json'), {
    schemaVersion:'agent.army/model-gateway-direct-backup/v1',
    createdAt:new Date().toISOString(),
    profiles,
  });
  return directory;
}

async function recordDirectCutover(backupDirectory, profiles) {
  await writePrivateJson(DIRECT_CUTOVERS_FILE, {
    schemaVersion:'agent.army/model-gateway-direct-cutovers/v1',
    latest:{
      backupDirectory,
      profiles,
      directAt:new Date().toISOString(),
      directBaseUrl:OFFICIAL_STEPFUN_BASE,
      directMaxTokens:8192,
    },
  });
}

async function applyProfileContents(plans, source) {
  for (const plan of plans) {
    const contents = contentsForPlan(plan, source);
    await writePrivateAtomic(plan.envFile, contents.env);
    await writePrivateAtomic(plan.configFile, contents.config);
  }
}

async function restoreProfileContents(plans, source) {
  try {
    await applyProfileContents(plans, source);
    return null;
  } catch {
    return '无法写回至少一个 Profile 的原配置';
  }
}

function contentsForPlan(plan, source) {
  if (source === 'next') return { env:plan.nextEnv, config:plan.nextConfig };
  if (source === 'original' || source === 'backup') return { env:plan.envContent, config:plan.configContent };
  if (source === 'current') return { env:plan.currentEnv, config:plan.currentConfig };
  throw safeError('迁移内容来源无效。');
}

function controlledBackupDirectory(directory) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${path.resolve(BACKUP_ROOT)}${path.sep}`)) {
    throw safeError('备份目录不在受控范围内。');
  }
  return resolved;
}

async function readVerifiedDirectMigrationBackup(backupDirectory, profiles) {
  const manifest = await readPrivateJson(path.join(backupDirectory, 'manifest.json'));
  validateDirectBackupManifest(manifest, profiles);
  const backups = new Map();
  for (const profile of profiles) {
    const profileDirectory = path.join(backupDirectory, profile);
    backups.set(profile, {
      envContent:await readPrivateFile(path.join(profileDirectory, '.env')),
      configContent:await readPrivateFile(path.join(profileDirectory, 'config.yaml')),
    });
  }
  verifyDirectBackupContents(manifest, backups, profiles);
  return backups;
}

export function validateDirectBackupManifest(manifest, profiles, expectedProfiles = FLEET_PROFILES) {
  if (manifest?.schemaVersion !== 'agent.army/model-gateway-direct-backup/v1') {
    throw safeError('全军网关迁移备份 manifest schema 无效。');
  }
  if (!sameProfileSet(profiles, expectedProfiles) || !sameProfileSet(Object.keys(manifest?.profiles || {}), expectedProfiles)) {
    throw safeError('全军网关迁移备份的 Profile 集合不完整或不匹配。');
  }
  for (const profile of expectedProfiles) {
    const files = manifest.profiles?.[profile];
    if (!validSha256(files?.['.env']) || !validSha256(files?.['config.yaml'])) {
      throw safeError(`全军网关迁移备份缺少 ${profile} 的完整性校验。`);
    }
  }
  return true;
}

export function verifyDirectBackupContents(manifest, backups, profiles) {
  for (const profile of profiles) {
    const backup = backups.get(profile);
    if (!backup || sha256(backup.envContent) !== manifest.profiles[profile]['.env']
      || sha256(backup.configContent) !== manifest.profiles[profile]['config.yaml']) {
      throw safeError(`全军网关迁移备份 ${profile} 的内容校验失败。`);
    }
  }
  return true;
}

function requireFleetProfiles(policy) {
  const profiles = Object.keys(policy?.profiles || {});
  assertFleetProfileList(profiles, '模型入口策略');
  return FLEET_PROFILES;
}

export function assertFleetProfileList(profiles, label) {
  if (!sameProfileSet(profiles, FLEET_PROFILES)) {
    throw safeError(`${label} 必须精确包含 12 个正式 Hermes Profile。`);
  }
}

function sameProfileSet(left, right) {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === left.length
    && normalizedRight.length === right.length
    && normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((profile, index) => profile === normalizedRight[index]);
}

function assertAllProfilesOnRoute(snapshots, keys, runtime, expectedRoute, action) {
  const mismatched = snapshots.filter((snapshot) => profileRouteForSnapshot(snapshot, keys, runtime) !== expectedRoute);
  if (mismatched.length) {
    throw safeError(`${action}要求 12 个 Profile 全部处于 ${expectedRoute} 路由；当前不符合：${mismatched.map(({ profile }) => profile).join(', ')}。`);
  }
}

function profileRouteForSnapshot(snapshot, keys, runtime) {
  const env = parseEnv(snapshot.envContent);
  return classifyProfileRoute({
    envBaseUrl:String(env.STEPFUN_BASE_URL || ''),
    sstefunBaseUrl:providerBaseUrl(snapshot.configContent, 'sstefun'),
    stepfunBaseUrl:providerBaseUrl(snapshot.configContent, 'stepfun'),
    observedKey:String(env.STEPFUN_API_KEY || ''),
    expectedVirtualKey:String(keys?.profiles?.[snapshot.profile]?.key || ''),
    upstreamKey:String(runtime?.STEPFUN_UPSTREAM_API_KEY || ''),
  });
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

async function gatewayJson(route, { method = 'GET', masterKey, body } = {}) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:4000${route}`, {
      method,
      headers:{
        authorization:`Bearer ${masterKey}`,
        accept:'application/json',
        ...(body ? { 'content-type':'application/json' } : {}),
      },
      body:body ? JSON.stringify(body) : undefined,
      signal:AbortSignal.timeout(30000),
    });
  } catch {
    throw safeError('模型入口请求未完成。');
  }
  if (!response.ok) throw safeError(`模型入口返回 HTTP ${response.status}。`);
  try {
    return await response.json();
  } catch {
    throw safeError('模型入口响应不是有效 JSON。');
  }
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:4000/health/liveliness', {
        signal:AbortSignal.timeout(1500),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw safeError('模型入口 90 秒内未通过健康检查。');
}

function runDocker(args) {
  const result = spawnSync('/usr/local/bin/docker', args, { cwd:HERE, stdio:'inherit' });
  if (result.status !== 0) throw safeError(`Docker 命令失败（exit ${result.status ?? 'unknown'}）。`);
}

async function readPolicy() {
  const policy = JSON.parse(await fs.readFile(POLICY_FILE, 'utf8'));
  if (
    policy?.schemaVersion !== 'agent.army/model-gateway-policy/v1'
    || policy?.gatewayBaseUrl !== 'http://127.0.0.1:4000'
    || policy?.model !== 'step-3.7-flash'
    || !Array.isArray(policy?.models)
    || !policy.models.includes(policy.model)
    || !policy?.profiles
  ) throw safeError('模型入口策略文件无效。');
  return policy;
}

async function readOwnedRegularFile(file) {
  const state = await fs.lstat(file).catch(() => null);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!state?.isFile() || state.isSymbolicLink() || (uid !== null && state.uid !== uid)) {
    throw safeError(`拒绝读取非本人普通文件：${file}`);
  }
  if (state.size > 2 * 1024 * 1024) throw safeError(`文件过大，拒绝读取：${file}`);
  return fs.readFile(file, 'utf8');
}

async function readPrivateFile(file) {
  const state = await fs.lstat(file).catch(() => null);
  if (!state?.isFile() || state.isSymbolicLink() || state.nlink !== 1 || (state.mode & 0o077) !== 0) {
    throw safeError(`私密文件必须是单硬链接且不能向组/其他用户开放：${file}`);
  }
  return readOwnedRegularFile(file);
}

async function readOptionalPrivateFile(file) {
  try {
    return await readPrivateFile(file);
  } catch (error) {
    if ((await fs.lstat(file).catch(() => null)) === null) return null;
    throw error;
  }
}

async function readPrivateJson(file, fallback) {
  const content = await readOptionalPrivateFile(file);
  if (content === null) {
    if (fallback !== undefined) return structuredClone(fallback);
    throw safeError(`缺少私密运行文件：${file}`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw safeError(`私密运行文件不是有效 JSON：${file}`);
  }
}

async function writePrivateJson(file, value) {
  await writePrivateAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateAtomic(file, content) {
  await ensurePrivateDirectory(path.dirname(file));
  const existing = await fs.lstat(file).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw safeError(`拒绝覆盖非普通文件：${file}`);
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(temporary, content, { flag:'wx', mode:PRIVATE_FILE_MODE });
  await fs.chmod(temporary, PRIVATE_FILE_MODE);
  await fs.rename(temporary, file);
  await fs.chmod(file, PRIVATE_FILE_MODE);
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive:true, mode:PRIVATE_DIRECTORY_MODE });
  const state = await fs.lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw safeError(`私密运行目录不安全：${directory}`);
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

function parseEnv(content) {
  const result = {};
  for (const line of String(content).split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] in result) throw safeError(`环境变量重复：${match[1]}`);
    result[match[1]] = parseDotenvScalar(match[2]);
  }
  return result;
}

function parseEnvValue(content, key) {
  return parseEnv(content)[key] || '';
}

function parseDotenvScalar(raw) {
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function serializeEnv(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${dotenvQuote(value)}`).join('\n')}\n`;
}

function dotenvQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function hermesProfileHome(profile) {
  if (profile === 'default') return HERMES_ROOT;
  if (!/^[a-z0-9-]+$/.test(profile)) throw safeError('岗位名格式无效。');
  return path.join(HERMES_ROOT, 'profiles', profile);
}

function requireProfile(args) {
  if (args.length !== 2 || args[0] !== '--profile') throw safeError('必须使用 --profile <岗位>。');
  return args[1];
}

export function resolvePrepareProfile(args) {
  return args.length === 0 ? 'default' : requireProfile(args);
}

export function requireAll(args) {
  if (args.length !== 1 || args[0] !== '--all') throw safeError('全军直连必须使用 direct --all。');
  return true;
}

function requireNoArgs(command, args) {
  if (args.length) throw safeError(`${command} 不接受参数。`);
  return true;
}

function requireDate(args) {
  if (args.length !== 2 || args[0] !== '--date' || !/^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
    throw safeError('必须使用 --date YYYY-MM-DD。');
  }
  return args[1];
}

function formatShanghaiDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
  }).format(date);
}

function randomSecret(prefix) {
  return `${prefix}-${crypto.randomBytes(32).toString('base64url')}`;
}

function validVirtualKey(value) {
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(String(value || ''));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeError(message) {
  const error = new Error(message);
  error.name = 'ModelGatewayError';
  return error;
}

function safeMessage(error) {
  return error?.name === 'ModelGatewayError' ? error.message : '模型入口操作失败；已隐藏可能含敏感信息的底层错误。';
}
