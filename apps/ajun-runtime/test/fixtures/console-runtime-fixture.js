import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../../src/runtime-composition-root.js';
import { startRuntime } from '../../src/runtime-start.js';
import { buildConsoleTaskScenarioState } from './console-task-scenarios.js';

export async function startConsoleRuntimeFixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-console-fixture-'));
  const dataDir = path.join(temporaryRoot, 'data');
  const state = buildConsoleTaskScenarioState();
  await fs.mkdir(dataDir, { recursive:true });
  await fs.writeFile(
    path.join(dataDir, 'runtime.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode:0o600 },
  );
  let runtime;
  try {
    runtime = await startRuntime({
      createRuntime,
      startBackgroundServices:false,
      environment:{
        ...process.env,
        PORT:'0',
        AJUN_HOST:'127.0.0.1',
        AGENT_ARMY_SOURCE_PROJECT_ROOT:'',
        AGENT_ARMY_TASK_STORE:'json',
        AGENT_ARMY_DATA_DIR:dataDir,
        AGENT_ARMY_PRIVATE_DIR:path.join(temporaryRoot, 'private'),
        PAPERCLIP_REPAIR_WORKTREE_PARENT:path.join(temporaryRoot, 'worktrees'),
        AGENT_ARMY_CONTENT_WORKSPACE_DIR:path.join(temporaryRoot, 'content'),
        AGENT_ARMY_HERMES_PROFILE_ROOT:path.join(temporaryRoot, 'hermes'),
        AUTO_WORK_ROOT:path.join(temporaryRoot, 'auto-work'),
        XIAOD_ARTIFACT_ROOT:path.join(temporaryRoot, 'xiaod'),
        AJUN_HERMES_NATIVE_FEISHU:'false',
        AJUN_HERMES_NATIVE_EMPLOYEE_IDS:'',
        AJUN_BOOM_MONITOR_ENABLED:'false',
      },
      logger:{ log:() => undefined, warn:() => undefined },
    });
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive:true, force:true });
    throw error;
  }
  let closed = false;
  return Object.freeze({
    runtime,
    state,
    dataDir,
    baseUrl:`http://127.0.0.1:${runtime.port}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => runtime.server.close(resolve));
      await fs.rm(temporaryRoot, { recursive:true, force:true });
    },
  });
}
