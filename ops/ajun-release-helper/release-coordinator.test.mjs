import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReleaseCoordinator, ReleaseRequestError } from './release-coordinator.mjs';

test('检查新版只记录真实候选，不触发发布', async (context) => {
  const fixture = await createFixture(context, {
    inspect:async () => inspection({ canPublish:true, updateAvailable:true, message:'发现新版 abcdef1。' }),
  });
  const accepted = await fixture.coordinator.start('check');
  assert.equal(accepted.accepted, true);
  const status = await fixture.coordinator.wait();
  assert.equal(status.state, 'ready');
  assert.equal(status.candidate.gitHead, 'abcdef1234567890');
  assert.equal(status.candidate.validation.status, 'not_checked');
  assert.equal(status.candidate.committed, true);
  assert.equal(fixture.calls.publish, 0);
  assert.equal((await fs.stat(path.join(fixture.root, 'status.json'))).mode & 0o777, 0o600);
});

test('脏工作区失败关闭并说明未提交内容不会发布', async (context) => {
  const fixture = await createFixture(context, {
    inspect:async () => inspection({ canPublish:false, updateAvailable:true, message:'正式仓库有未提交改动；这些内容不会发布。' }),
  });
  await fixture.coordinator.start('check');
  const status = await fixture.coordinator.wait();
  assert.equal(status.state, 'blocked');
  assert.match(status.message, /未提交改动/);
});

test('相同版本明确显示无需发布', async (context) => {
  const fixture = await createFixture(context, {
    inspect:async () => inspection({ canPublish:false, updateAvailable:false, message:'当前已经是最新版。' }),
  });
  await fixture.coordinator.start('check');
  assert.equal((await fixture.coordinator.wait()).state, 'up_to_date');
});

test('发布和回滚都要求精确确认文本', async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(() => fixture.coordinator.start('publish', {}), (error) => error instanceof ReleaseRequestError && error.httpStatus === 400);
  await assert.rejects(() => fixture.coordinator.start('rollback', { confirm:'yes' }), /请确认退回上一版/);
});

test('运行中的重复请求不会启动第二次发布', async (context) => {
  let releaseInspect;
  const blocked = new Promise((resolve) => { releaseInspect = resolve; });
  const fixture = await createFixture(context, { inspect:async () => blocked });
  const first = await fixture.coordinator.start('check');
  const second = await fixture.coordinator.start('check');
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.duplicate, true);
  releaseInspect(inspection({ canPublish:true, updateAvailable:true, message:'发现新版。' }));
  await fixture.coordinator.wait();
});

test('发布按适配器真实阶段推进并保存结果', async (context) => {
  const fixture = await createFixture(context, {
    publish:async ({ onStage }) => {
      await onStage('verifying', '正在运行完整验证。');
      await onStage('activating', '正在切换。');
      return {
        current:{
          releaseHash:'new-release', gitHead:'abcdef1234567890',
          verification:{ pid:123, verifiedAt:'2026-08-17T00:00:00.000Z', checks:{ pid:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true, rollbackAvailable:true } },
        },
      };
    },
  });
  await fixture.coordinator.start('publish', { confirm:'publish_current_commit' });
  const status = await fixture.coordinator.wait();
  assert.equal(status.state, 'succeeded');
  assert.equal(status.current.releaseHash, 'new-release');
  assert.equal(status.candidate.validation.status, 'passed');
  assert.equal(status.candidate.committed, true);
  assert.equal(status.candidate.publishable, false);
  assert.equal(status.candidate.undeployed, false);
  assert.equal(status.current.verification.checks.rollbackAvailable, true);
  assert.equal(fixture.calls.publish, 1);
});

test('手动回滚后候选仍以源码 main 对比恢复后的线上版本', async (context) => {
  const fixture = await createFixture(context, {
    rollback:async () => ({ current:{ releaseHash:'old-release', gitHead:'0'.repeat(40) }, rollback:null }),
  });
  await fixture.coordinator.start('rollback', { confirm:'rollback_previous_release' });
  const status = await fixture.coordinator.wait();
  assert.equal(status.state, 'succeeded');
  assert.equal(status.current.gitHead, '0'.repeat(40));
  assert.equal(status.candidate.gitHead, 'abcdef1234567890');
  assert.equal(status.candidate.publishable, true);
  assert.equal(status.candidate.undeployed, true);
  assert.equal(status.candidate.validation.status, 'not_checked');
});

test('自动恢复旧版时候选保持未部署且不会伪装验证通过', async (context) => {
  const fixture = await createFixture(context, {
    publish:async () => {
      const error = new Error('新版未通过启动检查。');
      error.rolledBack = true;
      throw error;
    },
  });
  await fixture.coordinator.start('publish', { confirm:'publish_current_commit' });
  const status = await fixture.coordinator.wait();
  assert.equal(status.state, 'rolled_back');
  assert.equal(status.candidate.publishable, true);
  assert.equal(status.candidate.undeployed, true);
  assert.equal(status.candidate.validation.status, 'not_completed');
});

test('历史持久化失败但新版本已通过线上核对时，状态保留新版本与回滚入口而非报失败', async (context) => {
  const fixture = await createFixture(context, {
    publish:async () => {
      const error = new Error('history write failed');
      error.releaseActive = true;
      error.current = {
        releaseHash:'new-release', gitHead:'abcdef1234567890',
        verification:{ pid:123, verifiedAt:'2026-08-17T00:00:00.000Z', checks:{ pid:true, listener:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true, rollbackAvailable:true } },
      };
      error.rollback = { releaseHash:'old-release', gitHead:'0'.repeat(40) };
      throw error;
    },
  });
  await fixture.coordinator.start('publish', { confirm:'publish_current_commit' });
  const status = await fixture.coordinator.wait();
  assert.equal(status.state, 'succeeded');
  assert.equal(status.current.releaseHash, 'new-release');
  assert.equal(status.rollback.releaseHash, 'old-release');
  assert.equal(status.candidate.validation.status, 'passed');
  assert.match(status.message, /历史写入失败/);
});

test('阶段看门狗在挂死时自动熔断并释放运行锁', async (context) => {
  let releaseBlocked;
  const blockedPromise = new Promise((resolve) => { releaseBlocked = resolve; });
  const fixture = await createFixture(context, {
    publish:async ({ onStage }) => {
      await onStage('freezing', '正在生成不可变版本。');
      await blockedPromise;
      return {};
    },
  });
  let watchdogFired;
  const watchdogPromise = new Promise((resolve) => { watchdogFired = resolve; });
  fixture.coordinator.armStageWatchdog = (stage) => {
    if (fixture.coordinator.stageTimer) clearTimeout(fixture.coordinator.stageTimer);
    fixture.coordinator.stageTimer = setTimeout(async () => {
      fixture.coordinator.running = null;
      await fixture.coordinator.update({
        state:'failed',
        message:`阶段【${stage}】执行超时，已自动熔断。`,
        finishedAt:new Date().toISOString(),
      });
      watchdogFired();
    }, 10);
  };
  await fixture.coordinator.start('publish', { confirm:'publish_current_commit' });
  await watchdogPromise;
  const status = fixture.coordinator.status();
  assert.equal(status.state, 'failed');
  assert.match(status.message, /超时，已自动熔断/);
  assert.equal(fixture.coordinator.running, null);
  releaseBlocked();
  fixture.coordinator.clearStageWatchdog();
});

async function createFixture(context, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-release-coordinator-'));
  context.after(async () => {
    await fs.rm(root, { recursive:true, force:true }).catch(() => {});
  });
  const calls = { publish:0, rollback:0 };
  const adapter = {
    inspect:overrides.inspect || (async () => inspection({ canPublish:true, updateAvailable:true, message:'发现新版。' })),
    publish:async (input) => {
      calls.publish += 1;
      return overrides.publish ? overrides.publish(input) : {};
    },
    rollback:async (input) => {
      calls.rollback += 1;
      return overrides.rollback ? overrides.rollback(input) : {};
    },
  };
  const coordinator = new ReleaseCoordinator({ stateDir:root, adapter, randomUUID:() => 'run-1' });
  await coordinator.initialize();
  return { root, calls, coordinator };
}

function inspection({ canPublish, updateAvailable, message }) {
  return {
    canPublish,
    updateAvailable,
    message,
    current:{ releaseHash:'old-release', gitHead:'0000000000000000' },
    candidate:{
      gitHead:'abcdef1234567890', branch:'main', clean:canPublish || !updateAvailable,
      committed:true, publishable:canPublish, undeployed:updateAvailable,
      validation:{ status:'not_checked', verifiedAt:null },
    },
    rollback:null,
  };
}
