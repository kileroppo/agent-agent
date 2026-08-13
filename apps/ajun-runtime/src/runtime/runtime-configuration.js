import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackHost } from '../lan-access.js';

export function createRuntimeConfiguration({
  environment = process.env,
  compositionRootUrl = new URL('../runtime-composition-root.js', import.meta.url),
  homeDirectory = os.homedir(),
  bootedAt = new Date().toISOString(),
} = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(compositionRootUrl)), '../../..');
  const dataDir = path.resolve(
    environment.AGENT_ARMY_DATA_DIR || path.join(root, 'apps/ajun-runtime/data'),
  );
  const privateDir = path.resolve(
    environment.AGENT_ARMY_PRIVATE_DIR || path.join(homeDirectory, '.agent-army'),
  );
  const repairWorktreeParent = path.resolve(
    environment.PAPERCLIP_REPAIR_WORKTREE_PARENT
      || path.join(homeDirectory, '.paperclip', 'agent-army-worktrees'),
  );
  const contentWorkspaceDir = path.resolve(
    environment.AGENT_ARMY_CONTENT_WORKSPACE_DIR || path.join(root, 'work/m5-content-autonomy'),
  );
  const hermesProfileRoot = path.resolve(
    environment.AGENT_ARMY_HERMES_PROFILE_ROOT
      || path.join(homeDirectory, '.hermes', 'profiles'),
  );
  const autoWorkRoot = path.resolve(environment.AUTO_WORK_ROOT || path.resolve(root, '../auto-work'));
  const xiaodArtifactRoot = path.resolve(
    environment.XIAOD_ARTIFACT_ROOT || path.join(root, 'apps/xiaod-media-transcriber/data'),
  );
  const deploymentMode = normalized(environment.AGENT_ARMY_DEPLOYMENT_MODE, 'local');
  const host = environment.AJUN_HOST || '0.0.0.0';

  const paths = Object.freeze({
    root,
    publicDir:path.join(root, 'apps/ajun-runtime/public'),
    dataDir,
    lanShareKeyPath:path.join(dataDir, 'lan-share-key'),
    privateDir,
    repairWorktreeParent,
    contentWorkspaceDir,
    hermesProfileRoot,
    autoWorkRoot,
    xiaodArtifactRoot,
  });

  return Object.freeze({
    bootedAt,
    paths,
    source:Object.freeze({
      configuredSourceRoot:environment.AGENT_ARMY_SOURCE_PROJECT_ROOT,
      externalStatePaths:Object.freeze({
        AGENT_ARMY_CONTENT_WORKSPACE_DIR:contentWorkspaceDir,
        AGENT_ARMY_HERMES_PROFILE_ROOT:hermesProfileRoot,
        AUTO_WORK_ROOT:autoWorkRoot,
        XIAOD_ARTIFACT_ROOT:xiaodArtifactRoot,
      }),
    }),
    network:Object.freeze({
      port:Number(environment.PORT || 4321),
      host,
      lanEnabled:!isLoopbackHost(host),
    }),
    deployment:Object.freeze({
      mode:deploymentMode,
      employeeFeishuOwner:normalized(environment.AGENT_ARMY_EMPLOYEE_FEISHU_OWNER, 'local'),
      hermesNativeEmployeeIds:Object.freeze(parseEmployeeIds(
        environment.AJUN_HERMES_NATIVE_EMPLOYEE_IDS,
      )),
    }),
    persistence:Object.freeze({
      taskStoreMode:environment.AGENT_ARMY_TASK_STORE || 'json',
      eventRetentionMode:environment.AGENT_ARMY_EVENT_RETENTION_MODE === 'apply'
        ? 'apply'
        : 'dry-run',
    }),
    features:Object.freeze({
      boomMonitorEnabled:normalized(environment.AJUN_BOOM_MONITOR_ENABLED, 'true') !== 'false',
      boomAnalysisDailyLimit:Number(environment.BOOM_ANALYSIS_DAILY_LIMIT || 5),
      developmentHotReload:normalized(environment.AJUN_DEV_HOT_RELOAD) === 'true',
    }),
  });
}

function normalized(value, fallback = '') {
  return String(value || fallback).trim().toLowerCase();
}

function parseEmployeeIds(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^[a-z][a-z0-9-]{0,63}$/.test(item));
}
