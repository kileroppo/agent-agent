import {
  APPLY_CONFIRMATION,
  M5_EXISTING_V2_RECONCILE_CONFIRMATION,
  M5_EXISTING_V2_RECOVERY_CONFIRMATION,
  M5_V2_CLONE_CUTOVER_CONFIRMATION,
  HttpPaperclipAdapter,
  applyExistingM5V2Reconcile,
  applyM5V2CloneCutover,
  applyBootstrap,
  buildM5V2CloneDefinition,
  createM5V2ProgressJournalAppender,
  defaultDefinition,
  dryRunBootstrap,
  inspectM5V2CloneCutover,
  inspectM5V2Migration,
  inspectExistingM5V2Reconcile,
  recoverExistingM5V2Reconcile,
  validateDefinition,
  verifyGzipBackupReference,
  writeM5V2RollbackSnapshotFile,
} from './index.js';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { resolveLiveAgentBindings } from './live-bindings.js';

const [command, ...args] = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (command === 'validate') {
  const result = validateDefinition(defaultDefinition);
  const controlStageKeys = new Set(['draft', 'campaign_active']);
  console.log(JSON.stringify({
    valid: true,
    controlStages: result.stages.filter((stage) => controlStageKeys.has(stage.key)).length,
    businessStages: result.stages.filter((stage) =>
      !controlStageKeys.has(stage.key) && !['done', 'cancelled'].includes(stage.kind)
    ).length,
    successTerminalStages:result.stages.filter((stage) => stage.kind === 'done').length,
    systemTerminalStages: result.stages.filter((stage) => stage.kind === 'cancelled').length,
    totalStages: result.stages.length,
  }, null, 2));
} else if (command === 'dry-run') {
  const result = await dryRunBootstrap({ definition: defaultDefinition });
  console.log(JSON.stringify({
    mode: result.mode,
    operations: result.operations,
    writesToLivePaperclip: false,
  }, null, 2));
} else if (command === 'migrate-v2-dry-run') {
  const apiBase = option('--api-base');
  const companyId = option('--company-id');
  const legacyPipelineId = option('--legacy-pipeline-id');
  const backupReference = option('--backup');
  if (!apiBase || !companyId || !legacyPipelineId || !backupReference) {
    throw new Error(
      'migrate-v2-dry-run 需要 --api-base、--company-id、--legacy-pipeline-id 和 --backup',
    );
  }
  const adapter = new HttpPaperclipAdapter({ apiBase, companyId });
  const backup = await verifyGzipBackupReference(backupReference);
  const audit = await inspectM5V2Migration({
    adapter,
    legacyPipelineId,
    definition:defaultDefinition,
    backup,
  });
  console.log(JSON.stringify(audit, null, 2));
  if (!audit.preconditionsPassed) process.exitCode = 3;
} else if (command === 'clone-cutover-v2-dry-run') {
  const apiBase = option('--api-base');
  const companyId = option('--company-id');
  const legacyPipelineId = option('--legacy-pipeline-id');
  const backupReference = option('--backup');
  if (!apiBase || !companyId || !legacyPipelineId || !backupReference) {
    throw new Error(
      'clone-cutover-v2-dry-run 需要 --api-base、--company-id、--legacy-pipeline-id 和 --backup',
    );
  }
  const adapter = new HttpPaperclipAdapter({ apiBase, companyId });
  const backup = await verifyGzipBackupReference(backupReference);
  const audit = await inspectM5V2CloneCutover({
    adapter,
    legacyPipelineId,
    definition:defaultDefinition,
    backup,
  });
  console.log(JSON.stringify(audit, null, 2));
  if (!audit.legacyPreconditionsPassed || !audit.applySupported) process.exitCode = 3;
} else if (command === 'clone-cutover-v2-apply') {
  const apiBase = option('--api-base');
  const companyId = option('--company-id');
  const legacyPipelineId = option('--legacy-pipeline-id');
  const legacyCampaignCaseId = option('--legacy-campaign-case-id');
  const backupReference = option('--backup');
  const budgetCents = Number(option('--budget-cents'));
  const confirmation = option('--confirm');
  if (
    !apiBase
    || !companyId
    || !legacyPipelineId
    || !legacyCampaignCaseId
    || !backupReference
  ) {
    throw new Error(
      'clone-cutover-v2-apply 需要 API、公司、v1 Pipeline/草案 Case、备份和预算参数',
    );
  }
  const adapter = new HttpPaperclipAdapter({ apiBase, companyId });
  const backup = await verifyGzipBackupReference(backupReference);
  const targetDefinition = buildM5V2CloneDefinition(defaultDefinition);
  const bindings = await resolveLiveAgentBindings(adapter, targetDefinition);
  const result = await applyM5V2CloneCutover({
    definition:defaultDefinition,
    adapter,
    legacyPipelineId,
    legacyCampaignCaseId,
    backup,
    bindings,
    budgetCents,
    confirmation,
  });
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'reconcile-existing-v2-dry-run') {
  const apiBase = option('--api-base');
  const companyId = option('--company-id');
  const pipelineId = option('--pipeline-id');
  const projectId = option('--project-id');
  if (!apiBase || !companyId || !pipelineId || !projectId) {
    throw new Error(
      'reconcile-existing-v2-dry-run 需要 --api-base、--company-id、--pipeline-id 和 --project-id',
    );
  }
  const adapter = new HttpPaperclipAdapter({ apiBase, companyId });
  const audit = await inspectExistingM5V2Reconcile({
    adapter,
    definition:defaultDefinition,
    pipelineId,
    projectId,
  });
  console.log(JSON.stringify(audit, null, 2));
  if (!audit.preconditionsPassed) process.exitCode = 3;
} else if (command === 'reconcile-existing-v2-apply') {
  const apiBase = option('--api-base');
  const companyId = option('--company-id');
  const pipelineId = option('--pipeline-id');
  const projectId = option('--project-id');
  const rollbackOutput = option('--rollback-output');
  const progressOutput = option('--progress-output')
    || (rollbackOutput ? `${rollbackOutput}.progress.jsonl` : null);
  const confirmation = option('--confirm');
  if (
    !apiBase
    || !companyId
    || !pipelineId
    || !projectId
    || !rollbackOutput
    || !progressOutput
  ) {
    throw new Error(
      'reconcile-existing-v2-apply 需要 API、公司、v2 Pipeline/Project 和绝对回滚快照路径',
    );
  }
  if (!isAbsolute(rollbackOutput) || !isAbsolute(progressOutput)) {
    throw new Error('--rollback-output 和 --progress-output 必须是绝对路径');
  }
  const adapter = new HttpPaperclipAdapter({ apiBase, companyId });
  const progress = createM5V2ProgressJournalAppender(progressOutput);
  try {
    const result = await applyExistingM5V2Reconcile({
      adapter,
      definition:defaultDefinition,
      pipelineId,
      projectId,
      confirmation,
      writeRollbackSnapshot:(snapshot) =>
        writeM5V2RollbackSnapshotFile(rollbackOutput, snapshot),
      appendRecoveryProgress:progress,
    });
    console.log(JSON.stringify({
      mode:result.mode,
      operations:result.operations,
      alreadyReconciled:result.alreadyReconciled,
      rollbackOutput:result.alreadyReconciled ? null : rollbackOutput,
      progressOutput:result.alreadyReconciled ? null : progressOutput,
      rollbackSha256:result.rollbackSnapshot?.sha256 ?? null,
      verification:result.verification ?? null,
    }, null, 2));
  } catch (error) {
    if (error?.recovery_required) {
      console.error(JSON.stringify({
        status:'recovery_required',
        code:error.code,
        message:error.message,
        rollbackOutput,
        progressOutput,
        recovery:error.recovery,
      }, null, 2));
      process.exitCode = 4;
    } else {
      throw error;
    }
  } finally {
    await progress.close();
  }
} else if (command === 'reconcile-existing-v2-recover') {
  const apiBase = option('--api-base');
  const companyId = option('--company-id');
  const snapshotPath = option('--snapshot');
  const progressOutput = option('--progress-output');
  const confirmation = option('--confirm');
  if (!apiBase || !companyId || !snapshotPath || !progressOutput) {
    throw new Error(
      'reconcile-existing-v2-recover 需要 API、公司、回滚快照和进度 journal',
    );
  }
  if (!isAbsolute(snapshotPath) || !isAbsolute(progressOutput)) {
    throw new Error('--snapshot 和 --progress-output 必须是绝对路径');
  }
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  await readFile(progressOutput, 'utf8');
  const adapter = new HttpPaperclipAdapter({ apiBase, companyId });
  const progress = createM5V2ProgressJournalAppender(
    progressOutput,
    { append:true },
  );
  try {
    const result = await recoverExistingM5V2Reconcile({
      adapter,
      snapshot,
      confirmation,
      appendRecoveryProgress:progress,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error?.recovery_required || error?.code === 'M5_V2_RECOVERY_BLOCKED') {
      console.error(JSON.stringify({
        status:error.recovery_required ? 'recovery_required' : 'recovery_blocked',
        code:error.code,
        message:error.message,
        snapshotPath,
        progressOutput,
        recovery:error.recovery,
      }, null, 2));
      process.exitCode = 4;
    } else {
      throw error;
    }
  } finally {
    await progress.close();
  }
} else if (command === 'apply') {
  const apiBase = option('--api-base');
  const companyId = option('--company-id');
  const budgetCents = Number(option('--budget-cents'));
  const dailyControllerUrl = option('--daily-controller-url');
  const confirmation = option('--confirm');
  if (!apiBase || !companyId) {
    throw new Error('apply 需要 --api-base 和 --company-id');
  }
  const adapter = new HttpPaperclipAdapter({ apiBase, companyId });
  const bindings = {
    ...await resolveLiveAgentBindings(adapter, defaultDefinition),
    ...(dailyControllerUrl ? { dailyControllerUrl } : {}),
  };
  const result = await applyBootstrap({
    definition: defaultDefinition,
    adapter,
    bindings,
    budgetCents,
    confirmLiveWrite: confirmation,
  });
  console.log(JSON.stringify({ mode: result.mode, operations: result.operations }, null, 2));
} else {
  console.error(`用法:
  npm run validate
  npm run dry-run
  npm run migration:v2:dry-run -- --api-base http://127.0.0.1:3100 --company-id <uuid> --legacy-pipeline-id <uuid> --backup /absolute/path/paperclip-backup.sql.gz
  npm run clone-cutover:v2:dry-run -- --api-base http://127.0.0.1:3100 --company-id <uuid> --legacy-pipeline-id <uuid> --backup /absolute/path/paperclip-backup.sql.gz
  npm run clone-cutover:v2:apply -- --api-base http://127.0.0.1:3100 --company-id <uuid> --legacy-pipeline-id <uuid> --legacy-campaign-case-id <uuid> --backup /absolute/path/paperclip-backup.sql.gz --budget-cents <n> --confirm ${M5_V2_CLONE_CUTOVER_CONFIRMATION}
  npm run reconcile:v2:dry-run -- --api-base http://127.0.0.1:3100 --company-id <uuid> --pipeline-id <uuid> --project-id <uuid>
  npm run reconcile:v2:apply -- --api-base http://127.0.0.1:3100 --company-id <uuid> --pipeline-id <uuid> --project-id <uuid> --rollback-output /absolute/path/m5-v2-rollback.json --progress-output /absolute/path/m5-v2-progress.jsonl --confirm ${M5_EXISTING_V2_RECONCILE_CONFIRMATION}
  npm run reconcile:v2:recover -- --api-base http://127.0.0.1:3100 --company-id <uuid> --snapshot /absolute/path/m5-v2-rollback.json --progress-output /absolute/path/m5-v2-progress.jsonl --confirm ${M5_EXISTING_V2_RECOVERY_CONFIRMATION}
  npm run apply -- --api-base http://127.0.0.1:3100 --company-id <uuid> --budget-cents <n> --daily-controller-url http://127.0.0.1:4321/api/paperclip/m5-daily-heartbeat --confirm ${APPLY_CONFIRMATION}`);
  process.exitCode = 2;
}
