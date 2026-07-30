import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('生产启动与TaskService不再引用本地DAG、预算或能力授权Store', async () => {
  const [serverSource, taskServiceSource] = await Promise.all([
    fs.readFile(path.join(sourceRoot, 'server.js'), 'utf8'),
    fs.readFile(path.join(sourceRoot, 'task-service.js'), 'utf8')
  ]);
  const productionSource = `${serverSource}\n${taskServiceSource}`;

  for (const forbidden of [
    'FileCapabilityGrantAdapter',
    'CapabilityGrantStore',
    'AutonomousTaskPreparer',
    'autonomous-task-preparer.js',
    'autonomous-work-planner.js',
    'capability-grants.json',
    'autonomous_work_plan'
  ]) {
    assert.equal(productionSource.includes(forbidden), false, `生产路径仍包含 ${forbidden}`);
  }
});

test('M5 每日入口由 loopback HTTP 控制器直连确定性服务，不经过 A君模型执行器', async () => {
  const serverSource = await fs.readFile(path.join(sourceRoot, 'server.js'), 'utf8');
  assert.match(
    serverSource,
    /PaperclipCampaignDailyHandler\(\{\s*governance,\s*campaignActivator:async \(\) => \(await campaigns\(\)\)\.activateScheduledDay\(\),\s*\}\)/,
  );
  assert.match(
    serverSource,
    /req\.url === '\/api\/paperclip\/m5-daily-heartbeat'[\s\S]{0,240}!isLocalAddress\(req\.socket\.remoteAddress\)/,
  );
  assert.equal(
    /new LocalAjunCoordinator\(\{[^}]*campaignDailyExecutor/.test(serverSource),
    false,
  );
});

test('M5 发布入口由 loopback 无模型控制器调用 Publisher，不暴露调用方选择参数', async () => {
  const serverSource = await fs.readFile(path.join(sourceRoot, 'server.js'), 'utf8');
  const controllerSource = await fs.readFile(
    path.join(sourceRoot, 'paperclip-publisher-controller.js'),
    'utf8',
  );
  assert.match(
    serverSource,
    /PaperclipPublisherController\(\{\s*governance,\s*publisher:m5PublisherBindings\.publisher,\s*\}\)/,
  );
  assert.match(
    serverSource,
    /req\.url === '\/api\/paperclip\/m5-publisher-heartbeat'[\s\S]{0,240}!isLocalAddress\(req\.socket\.remoteAddress\)/,
  );
  assert.match(controllerSource, /systemRole:SYSTEM_ROLE/);
  assert.match(controllerSource, /assertCaseIssueLink\(caseId, issueId\)/);
  assert.match(controllerSource, /targetCase\.stageKey !== 'publish'/);
  assert.match(controllerSource, /FORBIDDEN_CALLER_FIELDS/);
});

test('M5 复盘入口由 loopback 无模型控制器读取可信指标，只产出待审核建议', async () => {
  const serverSource = await fs.readFile(path.join(sourceRoot, 'server.js'), 'utf8');
  const controllerSource = await fs.readFile(
    path.join(sourceRoot, 'paperclip-retrospective.js'),
    'utf8',
  );
  assert.match(
    serverSource,
    /PaperclipRetrospectiveHandler\(\{\s*governance\s*\}\)/,
  );
  assert.match(
    serverSource,
    /req\.url === '\/api\/paperclip\/m5-retrospective-heartbeat'[\s\S]{0,240}!isLocalAddress\(req\.socket\.remoteAddress\)/,
  );
  assert.match(controllerSource, /systemRole:SYSTEM_ROLE/);
  assert.match(controllerSource, /assertCaseIssueLink\(caseId, issueId\)/);
  assert.match(controllerSource, /currentCase\.stageKey !== 'retrospective'/);
  assert.match(controllerSource, /item\?\.metadata\?\.checkpoint !== '72h'/);
  assert.match(controllerSource, /automaticProductionMutation:false/);
  assert.match(controllerSource, /FORBIDDEN_FIELDS/);
});
