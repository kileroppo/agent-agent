#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APPLY_CONFIRMATION,
  assertApplyAuthorized,
  buildDeploymentPlan,
  DeploymentPlanError,
  MONTHLY_BUDGET
} from './deployment-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function inspectDeployment({ plan, run = runGcloud } = {}) {
  const billing = run(['billing', 'projects', 'describe', plan.options.project, '--format=value(billingEnabled)'], { allowFailure:true });
  const resources = Object.fromEntries(plan.resources.map((resource) => [
    resource.id,
    run(withProject(resource.describe, plan.options.project), { allowFailure:true }).status === 0 ? 'exists' : 'missing'
  ]));
  return {
    billingEnabled:billing.status === 0 && String(billing.stdout || '').trim() === 'True',
    resources
  };
}

export function applyDeployment({ plan, run = runGcloud, waitForBootstrap = waitForBootstrapMarker } = {}) {
  const readiness = inspectDeployment({ plan, run });
  if (!readiness.billingEnabled) throw new DeploymentPlanError('当前项目未启用结算，未创建任何付费资源。');

  run(withProject(['services', 'enable', ...plan.services], plan.options.project));
  ensureBudget({ plan, run });
  for (const resource of plan.resources) {
    const exists = run(withProject(resource.describe, plan.options.project), { allowFailure:true }).status === 0;
    if (!exists) run(withProject(resource.create, plan.options.project));
  }

  try {
    waitForBootstrap({ plan, run });
  } catch (error) {
    run(withProject([
      'compute', 'instances', 'stop', plan.options.instance,
      `--zone=${plan.options.zone}`,
      '--quiet'
    ], plan.options.project), { allowFailure:true });
    throw new DeploymentPlanError('主机引导未通过，实例已停止以避免继续产生计算费用；磁盘和诊断现场保留。', { cause:error });
  }
  return inspectDeployment({ plan, run });
}

export function ensureBudget({ plan, run = runGcloud } = {}) {
  const billing = run([
    'billing', 'projects', 'describe', plan.options.project, '--format=json'
  ]);
  let billingAccountName = '';
  try {
    billingAccountName = String(JSON.parse(billing.stdout || '{}').billingAccountName || '');
  } catch {
    throw new DeploymentPlanError('无法确认项目结算账号，未创建付费资源。');
  }
  const billingAccount = billingAccountName.replace(/^billingAccounts\//, '');
  if (!billingAccount) throw new DeploymentPlanError('项目没有可用于预算门禁的结算账号，未创建付费资源。');

  const projectResult = run([
    'projects', 'describe', plan.options.project, '--format=value(projectNumber)'
  ]);
  const projectNumber = String(projectResult.stdout || '').trim();
  if (!/^\d+$/.test(projectNumber)) throw new DeploymentPlanError('无法确认项目编号，未创建付费资源。');

  const displayName = 'Agent Army private office monthly guard';
  const existing = run([
    'billing', 'budgets', 'list',
    `--billing-account=${billingAccount}`,
    `--filter=displayName="${displayName}"`,
    '--format=value(name)'
  ], { allowFailure:true });
  if (existing.status === 0 && String(existing.stdout || '').trim()) return;

  const created = run([
    'billing', 'budgets', 'create',
    `--billing-account=${billingAccount}`,
    `--display-name=${displayName}`,
    `--budget-amount=${MONTHLY_BUDGET}`,
    `--filter-projects=projects/${projectNumber}`,
    '--calendar-period=month',
    '--threshold-rule=percent=0.50',
    '--threshold-rule=percent=0.90',
    '--threshold-rule=percent=1.00',
    '--ownership-scope=all-users'
  ], { allowFailure:true });
  if (created.status !== 0) {
    throw new DeploymentPlanError('35 美元月度预算提醒未能创建，未创建付费资源。');
  }
}

export function waitForBootstrapMarker({ plan, run = runGcloud, attempts = 30 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run(withProject([
      'compute', 'ssh', plan.options.instance,
      `--zone=${plan.options.zone}`,
      '--tunnel-through-iap',
      '--quiet',
      '--command=sudo test -f /var/lib/agent-army/bootstrap-complete'
    ], plan.options.project), { allowFailure:true });
    if (result.status === 0) return true;
    if (attempt < attempts) sleep(10_000);
  }
  throw new DeploymentPlanError('主机引导在限定时间内没有完成。');
}

function withProject(args, project) {
  return [...args, `--project=${project}`];
}

function runGcloud(args, { allowFailure = false } = {}) {
  const result = spawnSync('gcloud', args, { encoding:'utf8', timeout:20 * 60 * 1000 });
  if (!allowFailure && result.status !== 0) {
    throw new DeploymentPlanError(`Google Cloud 步骤失败：${safeStep(args)}`);
  }
  return result;
}

function safeStep(args) {
  return args.filter((item) => !String(item).startsWith('--metadata=')).slice(0, 5).join(' ');
}

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (arg === '--apply') values.apply = true;
    else if (arg.startsWith('--confirm=')) values.confirmation = arg.slice('--confirm='.length);
    else if (arg.startsWith('--project=')) values.project = arg.slice('--project='.length);
    else if (arg.startsWith('--zone=')) values.zone = arg.slice('--zone='.length);
    else if (arg.startsWith('--instance=')) values.instance = arg.slice('--instance='.length);
    else throw new DeploymentPlanError(`无法识别参数：${arg}`);
  }
  return values;
}

function currentProject() {
  const result = runGcloud(['config', 'get-value', 'project'], { allowFailure:true });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const plan = buildDeploymentPlan({
      project:args.project || currentProject(),
      zone:args.zone,
      region:args.zone ? args.zone.replace(/-[a-z]$/, '') : undefined,
      instance:args.instance,
      startupScript:path.join(here, 'bootstrap-host.sh')
    });
    assertApplyAuthorized({ apply:args.apply, confirmation:args.confirmation });
    if (!args.apply) {
      const state = inspectDeployment({ plan });
      console.log('Google Cloud 部署预览');
      console.log(`- 结算：${state.billingEnabled ? '已启用' : '未启用'}`);
      console.log(`- 实例：${plan.options.machineType} / ${plan.options.bootDiskSize} / ${plan.options.zone}`);
      console.log('- 网络：独立 VPC；仅允许 IAP 来源访问 SSH；A君端口不对公网开放');
      console.log(`- 费用门禁：创建实例前必须先建立 ${MONTHLY_BUDGET} 月度预算提醒（提醒不是自动硬停机）`);
      console.log(`- 现有资源：${Object.entries(state.resources).map(([key, value]) => `${key}=${value}`).join('，')}`);
      console.log(`- 真正执行需要环境门禁和 --confirm=${APPLY_CONFIRMATION}`);
      return;
    }
    const result = applyDeployment({ plan });
    console.log(`部署完成：billing=${result.billingEnabled ? 'enabled' : 'disabled'}，instance=${result.resources.instance}`);
  } catch (error) {
    console.error(`未执行：${error instanceof DeploymentPlanError ? error.message : '部署准备发生未知错误。'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
