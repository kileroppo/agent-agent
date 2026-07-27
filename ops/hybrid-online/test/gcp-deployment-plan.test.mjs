import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  APPLY_CONFIRMATION,
  assertApplyAuthorized,
  buildDeploymentPlan,
  DeploymentPlanError
} from '../gcp/deployment-plan.mjs';
import { applyDeployment, ensureBudget } from '../gcp/deploy.mjs';

function plan() {
  return buildDeploymentPlan({
    project:'agent-army-test-123',
    startupScript:path.resolve('ops/hybrid-online/gcp/bootstrap-host.sh')
  });
}

test('GCP 计划使用独立网络、IAP SSH、Shielded VM 和最小实例身份', () => {
  const deployment = plan();
  const firewall = deployment.resources.find((item) => item.id === 'firewall').create;
  const instance = deployment.resources.find((item) => item.id === 'instance').create;
  assert.ok(firewall.includes('--source-ranges=35.235.240.0/20'));
  assert.ok(firewall.includes('--rules=tcp:22'));
  assert.equal(firewall.some((item) => /4321|0\.0\.0\.0\/0/.test(item)), false);
  assert.ok(instance.includes('--machine-type=e2-medium'));
  assert.ok(instance.includes('--boot-disk-size=40GB'));
  assert.ok(instance.includes('--shielded-secure-boot'));
  assert.ok(instance.includes('--shielded-vtpm'));
  assert.ok(instance.includes('--shielded-integrity-monitoring'));
  assert.ok(instance.includes('--deletion-protection'));
  assert.ok(instance.includes('--no-service-account'));
  assert.ok(instance.includes('--no-scopes'));
  assert.ok(instance.some((item) => item.startsWith('--metadata-from-file=startup-script=')));
});

test('主机引导固定 Hermes 版本并校验官方安装脚本', () => {
  const script = fs.readFileSync(path.resolve('ops/hybrid-online/gcp/bootstrap-host.sh'), 'utf8');
  assert.match(script, /HERMES_RELEASE=.*v2026\.7\.7\.2/);
  assert.match(script, /HERMES_INSTALL_COMMIT=.*[a-f0-9]{40}/);
  assert.match(script, /HERMES_INSTALL_SHA256=.*[a-f0-9]{64}/);
  assert.match(script, /--retry 8/);
  assert.match(script, /sha256sum/);
  assert.match(script, /raw\.githubusercontent\.com\/NousResearch\/hermes-agent/);
  assert.match(script, /postgresql-client/);
});

test('云端服务准备不会提前启动飞书入口', () => {
  const script = fs.readFileSync(path.resolve('ops/hybrid-online/cloud/prepare-services.sh'), 'utf8');
  assert.match(script, /--system/);
  assert.match(script, /--run-as-user/);
  assert.match(script, /--no-start-now/);
  assert.match(script, /--no-start-on-login/);
  assert.doesNotMatch(script, /systemctl\s+(?:enable|start|restart)/);
  assert.match(script, /hermes-gateway-intel-researcher\.service/);
  assert.match(script, /hermes-gateway-office-assistant\.service/);
});

test('Paperclip 跨系统迁移使用官方 SQL 备份且受双门禁保护', () => {
  const script = fs.readFileSync(path.resolve('ops/hybrid-online/cloud/restore-paperclip.sh'), 'utf8');
  assert.match(script, /RESTORE_PAPERCLIP_CUTOVER_BACKUP/);
  assert.match(script, /AGENT_ARMY_PAPERCLIP_RESTORE/);
  assert.match(script, /\/var\/lib\/agent-army\/private\/cutover/);
  assert.match(script, /gzip -dc/);
  assert.match(script, /psql/);
  assert.match(script, /ON_ERROR_STOP=1/);
  assert.match(script, /is-active --quiet agent-army-ajun-cloud\.service/);
  assert.match(script, /systemctl stop agent-army-paperclip\.service/);
});

test('付费执行同时要求显式参数和独立环境门禁', () => {
  assert.doesNotThrow(() => assertApplyAuthorized({ apply:false }));
  assert.throws(
    () => assertApplyAuthorized({ apply:true, confirmation:APPLY_CONFIRMATION, environment:{} }),
    DeploymentPlanError
  );
  assert.throws(
    () => assertApplyAuthorized({ apply:true, confirmation:'wrong', environment:{ AGENT_ARMY_GCP_APPLY:APPLY_CONFIRMATION } }),
    DeploymentPlanError
  );
  assert.doesNotThrow(() => assertApplyAuthorized({
    apply:true,
    confirmation:APPLY_CONFIRMATION,
    environment:{ AGENT_ARMY_GCP_APPLY:APPLY_CONFIRMATION }
  }));
});

test('GCP 计划拒绝扩大首版规格、磁盘或网络范围', () => {
  const base = { project:'agent-army-test-123', startupScript:path.resolve('ops/hybrid-online/gcp/bootstrap-host.sh') };
  assert.throws(() => buildDeploymentPlan({ ...base, machineType:'e2-standard-4' }), DeploymentPlanError);
  assert.throws(() => buildDeploymentPlan({ ...base, bootDiskSize:'200GB' }), DeploymentPlanError);
  assert.throws(() => buildDeploymentPlan({ ...base, subnetRange:'10.0.0.0/8' }), DeploymentPlanError);
});

test('项目未启用结算时 apply 在任何资源创建前失败关闭', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'billing') return { status:0, stdout:'False\n' };
    return { status:1, stdout:'' };
  };
  assert.throws(() => applyDeployment({ plan:plan(), run }), /未启用结算/);
  assert.equal(calls.some((args) => args[0] === 'services' && args[1] === 'enable'), false);
  assert.equal(calls.some((args) => args.includes('create')), false);
});

test('主机引导失败时保留诊断现场但停止实例计费', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'billing' && args.includes('--format=value(billingEnabled)')) return { status:0, stdout:'True\n' };
    if (args[0] === 'billing' && args.includes('--format=json')) {
      return { status:0, stdout:'{"billingAccountName":"billingAccounts/000000-000000-000000"}' };
    }
    if (args[0] === 'billing' && args[1] === 'budgets' && args[2] === 'list') return { status:0, stdout:'' };
    if (args[0] === 'projects') return { status:0, stdout:'123456789\n' };
    if (args.includes('describe')) return { status:1, stdout:'' };
    return { status:0, stdout:'' };
  };
  assert.throws(
    () => applyDeployment({
      plan:plan(),
      run,
      waitForBootstrap:() => { throw new Error('controlled bootstrap failure'); }
    }),
    /实例已停止/
  );
  assert.ok(calls.some((args) => args[0] === 'compute' && args[1] === 'instances' && args[2] === 'stop'));
  assert.equal(calls.some((args) => args[0] === 'compute' && args[1] === 'instances' && args[2] === 'delete'), false);
});

test('35 美元预算提醒创建失败时不会创建任何 GCP 资源', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'billing' && args[1] === 'projects') {
      return args.includes('--format=json')
        ? { status:0, stdout:'{"billingAccountName":"billingAccounts/000000-000000-000000"}' }
        : { status:0, stdout:'True\n' };
    }
    if (args[0] === 'projects') return { status:0, stdout:'123456789\n' };
    if (args[0] === 'billing' && args[1] === 'budgets' && args[2] === 'list') return { status:0, stdout:'' };
    if (args[0] === 'billing' && args[1] === 'budgets' && args[2] === 'create') return { status:1, stdout:'' };
    return { status:0, stdout:'' };
  };
  assert.throws(() => applyDeployment({ plan:plan(), run }), /预算提醒未能创建/);
  assert.equal(calls.some((args) => args[0] === 'compute' && args.includes('create')), false);
});

test('预算门禁只覆盖当前项目并设置 50、90、100 百分比提醒', () => {
  const calls = [];
  ensureBudget({
    plan:plan(),
    run:(args) => {
      calls.push(args);
      if (args.includes('--format=json')) {
        return { status:0, stdout:'{"billingAccountName":"billingAccounts/000000-000000-000000"}' };
      }
      if (args[0] === 'projects') return { status:0, stdout:'123456789\n' };
      return { status:0, stdout:'' };
    }
  });
  const create = calls.find((args) => args[0] === 'billing' && args[1] === 'budgets' && args[2] === 'create');
  assert.ok(create.includes('--budget-amount=35USD'));
  assert.ok(create.includes('--filter-projects=projects/123456789'));
  assert.ok(create.includes('--threshold-rule=percent=0.50'));
  assert.ok(create.includes('--threshold-rule=percent=0.90'));
  assert.ok(create.includes('--threshold-rule=percent=1.00'));
});
