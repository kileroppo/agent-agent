import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLocalExecutionComposition } from '../src/runtime/local-execution-composition.ts';
import { createContentCampaignComposition, M5RuntimeDisabledError } from '../src/runtime/content-campaign-composition.ts';
import { createPaperclipSystemControlComposition } from '../src/runtime/paperclip-system-control-composition.ts';
import { createRuntimeConfiguration } from '../src/runtime/runtime-configuration.ts';
import { createRuntimeStateComposition } from '../src/runtime/runtime-state-composition.ts';

test('运行配置集中解析 createRuntime 的端口、数据目录和部署开关', () => {
  const configuration = createRuntimeConfiguration({
    compositionRootUrl:'file:///workspace/apps/ajun-runtime/src/runtime-composition-root.ts',
    homeDirectory:'/private/test-home',
    bootedAt:'2026-08-13T00:00:00.000Z',
    environment:{
      PORT:'0',
      AJUN_HOST:'127.0.0.1',
      AGENT_ARMY_DATA_DIR:'/private/runtime-data',
      AGENT_ARMY_TASK_STORE:'sqlite',
      AGENT_ARMY_EVENT_RETENTION_MODE:'apply',
      AGENT_ARMY_DEPLOYMENT_MODE:'CLOUD',
      AGENT_ARMY_EMPLOYEE_FEISHU_OWNER:'HERMES',
      AJUN_HERMES_NATIVE_EMPLOYEE_IDS:'xiaod, invalid id,Reviewer-1',
      AJUN_M5_RUNTIME_ENABLED:'true',
      AJUN_BOOM_MONITOR_ENABLED:'false',
      AJUN_BOOM_MONITOR_AUTO_SCHEDULE_ENABLED:'true',
      BOOM_ANALYSIS_DAILY_LIMIT:'8',
      AJUN_DEV_HOT_RELOAD:'true',
    },
  });

  assert.equal(configuration.bootedAt, '2026-08-13T00:00:00.000Z');
  assert.equal(configuration.paths.root, '/workspace');
  assert.equal(configuration.paths.dataDir, '/private/runtime-data');
  assert.equal(configuration.paths.lanShareKeyPath, '/private/runtime-data/lan-share-key');
  assert.deepEqual(configuration.network, { port:0, host:'127.0.0.1', lanEnabled:false });
  assert.deepEqual(configuration.deployment, {
    mode:'cloud',
    employeeFeishuOwner:'hermes',
    hermesNativeEmployeeIds:['xiaod'],
  });
  assert.deepEqual(configuration.persistence, {
    taskStoreMode:'sqlite',
    eventRetentionMode:'apply',
  });
  assert.deepEqual(configuration.features, {
    m5RuntimeEnabled:true,
    boomMonitorEnabled:false,
    boomMonitorAutoScheduleEnabled:true,
    boomAnalysisDailyLimit:8,
    developmentHotReload:true,
  });
  assert.ok(Object.isFrozen(configuration));
});

test('M5 和 Boom 自动调度默认关闭，但 Boom 历史只读能力保持可接入', () => {
  const configuration = createRuntimeConfiguration({
    compositionRootUrl:'file:///workspace/apps/ajun-runtime/src/runtime-composition-root.ts',
    homeDirectory:'/private/test-home',
    environment:{},
  });

  assert.equal(configuration.features.m5RuntimeEnabled, false);
  assert.equal(configuration.features.boomMonitorEnabled, true);
  assert.equal(configuration.features.boomMonitorAutoScheduleEnabled, false);
});

test('M5 关闭时只创建 Paperclip 核心治理桥，不创建预算密钥或 Campaign', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-m5-disabled-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const dataDir = path.join(root, 'data');
  const composition = await createContentCampaignComposition({
    enabled:false,
    environment:{},
    dataDir,
    hermesProfileRoot:path.join(root, 'hermes'),
    contentWorkspaceDir:path.join(root, 'content'),
  });

  assert.equal(composition.enabled, false);
  assert.equal(typeof composition.governance.health, 'function');
  assert.equal(composition.publisherBindings, null);
  assert.equal(composition.paperclipCurrentRunScope, null);
  await assert.rejects(composition.campaigns(), M5RuntimeDisabledError);
  await assert.rejects(fs.access(path.join(dataDir, 'm5-budget-ticket-ed25519.pem')), { code:'ENOENT' });
});

test('M5 关闭时 Paperclip 核心 heartbeat 保留，M5 heartbeat 给出明确关闭状态', async () => {
  const control = await createPaperclipSystemControlComposition({
    m5RuntimeEnabled:false,
    governance:{ baseUrl:'http://127.0.0.1:3100', companyForRuntime:async () => ({ id:'company-1' }) },
    tasks:{ create:async () => ({ taskId:'incident-1' }) },
    operator:{},
    campaigns:async () => { throw new Error('不应构造 Campaign'); },
    publisherBindings:null,
    paperclipCurrentRunScope:null,
  });

  assert.equal(typeof control.paperclipHeartbeat.handle, 'function');
  await assert.rejects(control.paperclipCampaignDaily.handle({}), (error) => {
    assert.equal(error.code, 'm5_runtime_disabled');
    assert.equal(error.httpStatus, 503);
    return true;
  });
});

test('M5 显式启用时仍构造原有预算与发布装配', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-m5-enabled-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const dataDir = path.join(root, 'data');
  const composition = await createContentCampaignComposition({
    enabled:true,
    environment:{},
    dataDir,
    hermesProfileRoot:path.join(root, 'hermes'),
    contentWorkspaceDir:path.join(root, 'content'),
  });

  assert.equal(composition.enabled, true);
  assert.ok(composition.publisherBindings.publisher);
  assert.ok(composition.paperclipCurrentRunScope);
  assert.ok(composition.templateResolver);
  await fs.access(path.join(dataDir, 'm5-budget-ticket-ed25519.pem'));
});

test('运行状态 Module 负责事件保留定时器和关闭生命周期', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-runtime-state-'));
  context.after(() => fs.rm(temporaryRoot, { recursive:true, force:true }));
  let scheduled = null;
  let cleared = null;
  let unrefCount = 0;
  const timer = { unref:() => { unrefCount += 1; } };
  const runtimeState = createRuntimeStateComposition({
    configuration:{
      paths:{ dataDir:temporaryRoot },
      persistence:{ taskStoreMode:'json', eventRetentionMode:'dry-run' },
    },
    logger:{ warn:() => undefined },
    timers:{
      setInterval(callback, intervalMs) {
        scheduled = { callback, intervalMs };
        return timer;
      },
      clearInterval(value) {
        cleared = value;
      },
    },
  });

  assert.equal(scheduled.intervalMs, 24 * 60 * 60 * 1000);
  assert.equal(unrefCount, 1);
  assert.equal(runtimeState.taskRunEventRetention.lastResult.mode, 'dry-run');
  scheduled.callback();
  runtimeState.close();
  runtimeState.close();
  assert.equal(cleared, timer);
});

test('本机执行装配隐藏部署模式选择并连接小D恢复器', () => {
  const baseConfiguration = {
    paths:{ root:'/workspace' },
    deployment:{ mode:'local' },
  };
  const store = { list:async () => [] };
  const local = createLocalExecutionComposition({ configuration:baseConfiguration, store });
  let reconciled = 0;
  local.bindXiaodReconciler({ reconcile:() => { reconciled += 1; } });
  local.localXiaod.observe({ execution:{ xiaodJobId:'job-1' } });
  assert.equal(reconciled, 1);
  assert.equal(local.xiaod, local.localXiaod);

  const cloud = createLocalExecutionComposition({
    configuration:{ ...baseConfiguration, deployment:{ mode:'cloud' } },
    store,
  });
  assert.notEqual(cloud.xiaod, cloud.localXiaod);
});
