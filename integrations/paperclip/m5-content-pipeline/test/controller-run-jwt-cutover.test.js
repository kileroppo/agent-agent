import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyControllerRunJwtCutover,
  CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
  CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION,
  M5_RUN_JWT_CONTROLLERS,
  PaperclipControllerClient,
  rollbackControllerRunJwtCutover,
  snapshotControllerRunJwtCutover,
} from '../src/controller-run-jwt-cutover.ts';
import {
  parseArgs,
} from '../scripts/manage-controller-run-jwt-cutover.mjs';

test('snapshot 只保存两个固定 HTTP 控制器的脱敏完整 adapterConfig 和可信 SHA', async (t) => {
  const fixture = await cutoverFixture(t);
  const result = await snapshotControllerRunJwtCutover({
    client:fixture.client,
    snapshotPath:fixture.snapshotPath,
    now:() => new Date('2026-07-31T10:00:00.000Z'),
  });

  assert.equal(result.controllerCount, 2);
  assert.equal(result.writesToPaperclip, 0);
  assert.equal(fixture.updates.length, 0);
  const state = await fs.stat(fixture.snapshotPath);
  assert.equal(state.mode & 0o777, 0o600);
  const snapshot = JSON.parse(await fs.readFile(fixture.snapshotPath, 'utf8'));
  assert.deepEqual(
    snapshot.controllers.map(({ id }) => id),
    M5_RUN_JWT_CONTROLLERS.map(({ id }) => id),
  );
  assert.deepEqual(snapshot.controllers[0].adapterConfig, {
    url:M5_RUN_JWT_CONTROLLERS[0].url,
  });
  assert.deepEqual(snapshot.controllers[1].adapterConfig, {
    url:M5_RUN_JWT_CONTROLLERS[1].url,
    forwardRunJwt:false,
  });
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.match(snapshot.snapshotSha256, /^[a-f0-9]{64}$/);
});

test('snapshot 在固定 ID、HTTP 类型、loopback URL 或 adapterConfig 白名单漂移时零写入失败', async (t) => {
  const fixture = await cutoverFixture(t);
  fixture.records.get(M5_RUN_JWT_CONTROLLERS[0].id).adapterConfig.extra = true;
  await assert.rejects(
    snapshotControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
    }),
    /包含未知字段/,
  );
  assert.equal(await exists(fixture.snapshotPath), false);
  assert.equal(fixture.updates.length, 0);

  delete fixture.records.get(M5_RUN_JWT_CONTROLLERS[0].id).adapterConfig.extra;
  fixture.records.get(M5_RUN_JWT_CONTROLLERS[0].id).adapterConfig.url =
    'http://127.0.0.1:4321/api/paperclip/other';
  await assert.rejects(
    snapshotControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
    }),
    /URL 不匹配/,
  );
  assert.equal(await exists(fixture.snapshotPath), false);
});

test('apply 强确认后只把缺失或 false 的 forwardRunJwt 改为 true 并逐项回读', async (t) => {
  const fixture = await cutoverFixture(t);
  await createSnapshot(fixture);
  await assert.rejects(
    applyControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
    }),
    /必须显式确认/,
  );
  assert.equal(fixture.updates.length, 0);

  const result = await applyControllerRunJwtCutover({
    client:fixture.client,
    snapshotPath:fixture.snapshotPath,
    confirmation:CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(
    fixture.updates.map(({ id, adapterConfig }) => [
      id,
      adapterConfig.forwardRunJwt,
      Object.keys(adapterConfig).sort(),
    ]),
    M5_RUN_JWT_CONTROLLERS.map(({ id }) => [
      id,
      true,
      ['forwardRunJwt', 'url'],
    ]),
  );
});

test('apply 任一失败后按 publisher 到 metrics 逆序恢复两个控制器', async (t) => {
  const fixture = await cutoverFixture(t);
  await createSnapshot(fixture);
  fixture.failUpdateAfterMutation = {
    id:M5_RUN_JWT_CONTROLLERS[1].id,
    value:true,
    remaining:1,
  };

  await assert.rejects(
    applyControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      confirmation:CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
    }),
    /两个控制器已按逆序恢复/,
  );
  assert.deepEqual(
    fixture.updates.map(({ id, adapterConfig }) => [
      id,
      adapterConfig.forwardRunJwt ?? 'missing',
    ]),
    [
      [M5_RUN_JWT_CONTROLLERS[0].id, true],
      [M5_RUN_JWT_CONTROLLERS[1].id, true],
      [M5_RUN_JWT_CONTROLLERS[1].id, false],
      [M5_RUN_JWT_CONTROLLERS[0].id, 'missing'],
    ],
  );
  assert.equal(
    fixture.records.get(M5_RUN_JWT_CONTROLLERS[0].id)
      .adapterConfig.forwardRunJwt,
    undefined,
  );
  assert.equal(
    fixture.records.get(M5_RUN_JWT_CONTROLLERS[1].id)
      .adapterConfig.forwardRunJwt,
    false,
  );
});

test('rollback 只接受可信快照并按 publisher 到 metrics 逆序恢复', async (t) => {
  const fixture = await cutoverFixture(t);
  await createSnapshot(fixture);
  await applyControllerRunJwtCutover({
    client:fixture.client,
    snapshotPath:fixture.snapshotPath,
    confirmation:CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
  });
  fixture.updates.length = 0;

  const result = await rollbackControllerRunJwtCutover({
    client:fixture.client,
    snapshotPath:fixture.snapshotPath,
    confirmation:CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION,
  });
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(
    fixture.updates.map(({ id }) => id),
    [
      M5_RUN_JWT_CONTROLLERS[1].id,
      M5_RUN_JWT_CONTROLLERS[0].id,
    ],
  );
});

test('rollback 在 secret、未知字段或当前配置漂移时于任何 PATCH 前失败关闭', async (t) => {
  const fixture = await cutoverFixture(t);
  await createSnapshot(fixture);
  const snapshot = JSON.parse(await fs.readFile(fixture.snapshotPath, 'utf8'));
  snapshot.apiKey = 'fixture-do-not-persist';
  await fs.writeFile(
    fixture.snapshotPath,
    `${JSON.stringify(snapshot)}\n`,
    { mode:0o600 },
  );
  await assert.rejects(
    rollbackControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      confirmation:CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION,
    }),
    /禁止的敏感字段/,
  );
  assert.equal(fixture.updates.length, 0);

  await fs.rm(fixture.snapshotPath);
  await createSnapshot(fixture);
  fixture.records.get(M5_RUN_JWT_CONTROLLERS[1].id).adapterConfig.unknown = true;
  await assert.rejects(
    rollbackControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      confirmation:CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION,
    }),
    /包含未知字段/,
  );
  assert.equal(fixture.updates.length, 0);
});

test('apply 在核验快照后遇到 A→B symlink 竞态时零 PATCH 失败关闭', async (t) => {
  const fixture = await cutoverFixture(t);
  await createSnapshot(fixture);
  const alternateSnapshotPath = path.join(fixture.root, 'alternate.json');
  fixture.records.get(M5_RUN_JWT_CONTROLLERS[0].id)
    .adapterConfig.forwardRunJwt = false;
  delete fixture.records.get(M5_RUN_JWT_CONTROLLERS[1].id)
    .adapterConfig.forwardRunJwt;
  await snapshotControllerRunJwtCutover({
    client:fixture.client,
    snapshotPath:alternateSnapshotPath,
    now:() => new Date('2026-07-31T10:01:00.000Z'),
  });
  delete fixture.records.get(M5_RUN_JWT_CONTROLLERS[0].id)
    .adapterConfig.forwardRunJwt;
  fixture.records.get(M5_RUN_JWT_CONTROLLERS[1].id)
    .adapterConfig.forwardRunJwt = false;

  const originalSnapshotPath = path.join(fixture.root, 'snapshot.original.json');
  let swapped = false;
  const racingFileSystem = {
    ...fs,
    async open(value, flags, mode) {
      if (value === fixture.snapshotPath && !swapped) {
        swapped = true;
        await fs.rename(fixture.snapshotPath, originalSnapshotPath);
        await fs.symlink(alternateSnapshotPath, fixture.snapshotPath);
      }
      return fs.open(value, flags, mode);
    },
  };
  await assert.rejects(
    applyControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      confirmation:CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
      fileSystem:racingFileSystem,
    }),
    /no-follow|安全打开/,
  );
  assert.equal(swapped, true);
  assert.equal(fixture.updates.length, 0);
});

test('snapshot 在父目录核验后被换成 symlink 时不创建目标或临时文件', async (t) => {
  const fixture = await cutoverFixture(t);
  const trustedParent = path.join(fixture.root, 'trusted-parent');
  const movedParent = path.join(fixture.root, 'trusted-parent.original');
  const alternateParent = path.join(fixture.root, 'alternate-parent');
  await fs.mkdir(trustedParent);
  await fs.mkdir(alternateParent);
  const snapshotPath = path.join(trustedParent, 'snapshot.json');
  let swapped = false;
  const racingFileSystem = {
    ...fs,
    async lstat(value, options) {
      if (value === snapshotPath && !swapped) {
        swapped = true;
        const state = await fs.lstat(value, options).catch(() => null);
        await fs.rename(trustedParent, movedParent);
        await fs.symlink(alternateParent, trustedParent);
        return state;
      }
      return fs.lstat(value, options);
    },
  };
  await assert.rejects(
    snapshotControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath,
      fileSystem:racingFileSystem,
    }),
    /父目录.*漂移/,
  );
  assert.equal(swapped, true);
  assert.equal(await exists(snapshotPath), false);
  assert.deepEqual(await fs.readdir(alternateParent), []);
  assert.deepEqual(await fs.readdir(movedParent), []);
  assert.equal(fixture.updates.length, 0);
});

test('snapshot 在 hard-link 成功后父目录被换成 symlink 时清空原目录且零 PATCH', async (t) => {
  const fixture = await cutoverFixture(t);
  const trustedParent = path.join(fixture.root, 'trusted-parent');
  const movedParent = path.join(fixture.root, 'trusted-parent.original');
  const alternateParent = path.join(fixture.root, 'alternate-parent');
  await fs.mkdir(trustedParent);
  await fs.mkdir(alternateParent);
  const snapshotPath = path.join(trustedParent, 'snapshot.json');
  let swapped = false;
  const racingFileSystem = {
    ...fs,
    async link(existingPath, newPath) {
      await fs.link(existingPath, newPath);
      swapped = true;
      await fs.rename(trustedParent, movedParent);
      await fs.symlink(alternateParent, trustedParent);
    },
  };

  await assert.rejects(
    snapshotControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath,
      fileSystem:racingFileSystem,
    }),
    /父目录.*漂移/,
  );

  assert.equal(swapped, true);
  assert.deepEqual(await fs.readdir(movedParent), []);
  assert.deepEqual(await fs.readdir(alternateParent), []);
  assert.equal(await exists(snapshotPath), false);
  assert.equal(fixture.updates.length, 0);
});

test('snapshot cleaner 不回 ready IPC 时硬超时并确认子进程退出', async (t) => {
  const fixture = await cutoverFixture(t);
  let child = null;
  const startedAt = Date.now();

  await assert.rejects(
    snapshotControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      fileSystem:{
        ...fs,
        __controllerRunJwtCleanerOptions:{
          spawnImpl(_command, _args, options) {
            child = spawn(
              process.execPath,
              ['-e', 'setInterval(() => {}, 1000)'],
              options,
            );
            return child;
          },
          messageTimeoutMs:100,
          closeTimeoutMs:25,
          termTimeoutMs:25,
          killTimeoutMs:500,
        },
      },
    }),
    /无法安全启动/,
  );

  assert.ok(Date.now() - startedAt < 2_000);
  assert.ok(child);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(await exists(fixture.snapshotPath), false);
  assert.equal(fixture.updates.length, 0);
});

test('snapshot cleaner 在 temp/published 后 SIGSTOP 会超时、强制退出并标记需恢复', async (t) => {
  const fixture = await cutoverFixture(t);
  let child = null;
  let rejection = null;

  try {
    await snapshotControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      fileSystem:{
        ...fs,
        __controllerRunJwtCleanerOptions:{
          async onReady(value) {
            child = value;
            assert.equal(child.kill('SIGSTOP'), true);
          },
          messageTimeoutMs:100,
          closeTimeoutMs:25,
          termTimeoutMs:25,
          killTimeoutMs:500,
        },
      },
    });
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection);
  assert.match(rejection.message, /清理不完整/);
  assert.equal(rejection.recoveryRequired, true);
  assert.ok(child);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(fixture.updates.length, 0);
});

test('snapshot cleaner 不确认正常 close 时不会静默成功且子进程已退出', async (t) => {
  const fixture = await cutoverFixture(t);
  let child = null;
  let rejection = null;
  const ignoreCloseCleaner = `
    const fs = require('node:fs');
    const state = fs.statSync('.');
    process.send({ type:'ready', dev:String(state.dev), ino:String(state.ino) });
    process.on('message', (message) => {
      if (message?.type !== 'cleanup') return;
      const errors = [];
      for (const entry of message.entries) {
        try {
          const current = fs.lstatSync(entry.name);
          if (
            !current.isFile()
            || current.isSymbolicLink()
            || String(current.dev) !== entry.dev
            || String(current.ino) !== entry.ino
          ) throw new Error('identity-mismatch');
          fs.unlinkSync(entry.name);
        } catch (error) {
          errors.push(String(error?.message || error));
        }
      }
      process.send({ type:'result', requestId:message.requestId, errors });
    });
  `;

  try {
    await snapshotControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      fileSystem:{
        ...fs,
        __controllerRunJwtCleanerOptions:{
          spawnImpl(_command, _args, options) {
            child = spawn(process.execPath, ['-e', ignoreCloseCleaner], options);
            return child;
          },
          messageTimeoutMs:100,
          closeTimeoutMs:25,
          termTimeoutMs:500,
          killTimeoutMs:500,
        },
      },
    });
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection);
  assert.match(rejection.message, /清理不完整/);
  assert.equal(rejection.recoveryRequired, true);
  assert.ok(child);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(fixture.updates.length, 0);
});

test('rollback 中途失败会恢复 rollback 前状态并报告失败', async (t) => {
  const fixture = await cutoverFixture(t);
  await createSnapshot(fixture);
  await applyControllerRunJwtCutover({
    client:fixture.client,
    snapshotPath:fixture.snapshotPath,
    confirmation:CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
  });
  fixture.updates.length = 0;
  fixture.failUpdateAfterMutation = {
    id:M5_RUN_JWT_CONTROLLERS[0].id,
    value:false,
    remaining:1,
  };

  await assert.rejects(
    rollbackControllerRunJwtCutover({
      client:fixture.client,
      snapshotPath:fixture.snapshotPath,
      confirmation:CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION,
    }),
    /已恢复 rollback 前状态/,
  );
  assert.equal(
    fixture.records.get(M5_RUN_JWT_CONTROLLERS[0].id)
      .adapterConfig.forwardRunJwt,
    true,
  );
  assert.equal(
    fixture.records.get(M5_RUN_JWT_CONTROLLERS[1].id)
      .adapterConfig.forwardRunJwt,
    true,
  );
});

test('CLI 只接受固定三种模式、绝对快照和各自强确认串', () => {
  assert.deepEqual(
    parseArgs([
      '--mode',
      'apply',
      '--api-base',
      'http://127.0.0.1:3100',
      '--snapshot',
      '/tmp/m5-controller-snapshot.json',
      '--confirm',
      CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
    ]),
    {
      mode:'apply',
      'api-base':'http://127.0.0.1:3100',
      snapshot:'/tmp/m5-controller-snapshot.json',
      confirm:CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
    },
  );
  assert.throws(
    () => parseArgs([
      '--mode',
      'rollback',
      '--api-base',
      'http://127.0.0.1:3100',
      '--snapshot',
      'relative.json',
      '--confirm',
      CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION,
    ]),
    /绝对路径/,
  );
  assert.throws(
    () => parseArgs([
      '--mode',
      'apply',
      '--api-base',
      'http://127.0.0.1:3100',
      '--snapshot',
      '/tmp/m5-controller-snapshot.json',
    ]),
    /必须显式确认/,
  );
});

test('Fake Paperclip 契约只调用固定 health、GET 与 controller PATCH 路径', async (t) => {
  const fixture = await cutoverFixture(t);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({
      pathname:parsed.pathname,
      method:options.method,
      headers:structuredClone(options.headers),
      body:options.body ? JSON.parse(options.body) : null,
      redirect:options.redirect,
    });
    if (parsed.pathname === '/api/health') {
      return fakeResponse(200, { version:'2026.722.0' });
    }
    const id = parsed.pathname.split('/').at(-1);
    const record = fixture.records.get(id);
    if (!record) return fakeResponse(404, { error:'not found' });
    if (options.method === 'PATCH') {
      record.adapterConfig = JSON.parse(options.body).adapterConfig;
    }
    return fakeResponse(200, record);
  };
  const client = new PaperclipControllerClient({
    apiBase:'http://127.0.0.1:3100',
    fetchImpl,
  });

  await snapshotControllerRunJwtCutover({
    client,
    snapshotPath:fixture.snapshotPath,
  });
  await applyControllerRunJwtCutover({
    client,
    snapshotPath:fixture.snapshotPath,
    confirmation:CONTROLLER_RUN_JWT_APPLY_CONFIRMATION,
  });

  const patches = calls.filter(({ method }) => method === 'PATCH');
  assert.deepEqual(
    patches.map(({ pathname }) => pathname),
    M5_RUN_JWT_CONTROLLERS.map(({ id }) => `/api/agents/${id}`),
  );
  assert.equal(
    patches.every(({ body }) =>
      Object.keys(body).length === 1
      && body.adapterConfig.forwardRunJwt === true),
    true,
  );
  assert.equal(
    calls.every(({ headers, redirect }) =>
      !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
      && redirect === 'manual'),
    true,
  );
});

async function cutoverFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'm5-controller-run-jwt-')),
  );
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const records = new Map(M5_RUN_JWT_CONTROLLERS.map((item, index) => [
    item.id,
    {
      id:item.id,
      adapterType:'http',
      adapterConfig:{
        url:item.url,
        ...(index === 1 ? { forwardRunJwt:false } : {}),
      },
      ignoredOperationalField:'not-persisted',
    },
  ]));
  const updates = [];
  const fixture = {
    root,
    records,
    updates,
    snapshotPath:path.join(root, 'snapshot.json'),
    failUpdateAfterMutation:null,
  };
  fixture.client = {
    async getVersion() {
      return '2026.722.0';
    },
    async getController(id) {
      const record = records.get(id);
      if (!record) throw new Error('fixture missing');
      return structuredClone(record);
    },
    async updateController(id, adapterConfig) {
      updates.push({ id, adapterConfig:structuredClone(adapterConfig) });
      const record = records.get(id);
      record.adapterConfig = structuredClone(adapterConfig);
      const failure = fixture.failUpdateAfterMutation;
      const value = adapterConfig.forwardRunJwt === true;
      if (
        failure
        && failure.id === id
        && failure.value === value
        && failure.remaining > 0
      ) {
        failure.remaining -= 1;
        throw new Error('fixture ambiguous update failure');
      }
      return structuredClone(record);
    },
  };
  return fixture;
}

async function createSnapshot(fixture) {
  return snapshotControllerRunJwtCutover({
    client:fixture.client,
    snapshotPath:fixture.snapshotPath,
    now:() => new Date('2026-07-31T10:00:00.000Z'),
  });
}

async function exists(file) {
  return fs.lstat(file).then(() => true).catch(() => false);
}

function fakeResponse(status, payload) {
  return {
    ok:status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
