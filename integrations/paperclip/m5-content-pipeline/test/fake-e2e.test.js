import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildCampaignCaseBatch,
  FakePaperclipAdapter,
  ingestCampaignDraftCase,
  ingestCampaignExecutionCases,
} from '../src/index.js';

test('Fake 岗位和 Fake 平台从选题执行到指标回流且覆盖关键恢复门禁', async () => {
  const pipelineId = '10000000-0000-4000-8000-000000000001';
  const adapter = new FakePaperclipAdapter();
  const batch = buildCampaignCaseBatch({
    campaignId:'m5-fake-e2e-hierarchy',
    startDate:'2026-08-08',
    themes:Array.from({ length:7 }, (_, index) => `验收主题${index + 1}`),
  });
  const parent = await ingestCampaignDraftCase(adapter, pipelineId, batch);
  const parentReplay = await ingestCampaignDraftCase(adapter, pipelineId, batch);
  assert.equal(adapter.state.cases.length, 1);
  assert.equal(parent.id, parentReplay.id);

  const first = await ingestCampaignExecutionCases(
    adapter,
    pipelineId,
    batch,
    parent,
  );
  const replay = await ingestCampaignExecutionCases(
    adapter,
    pipelineId,
    batch,
    parent,
  );

  assert.equal(adapter.state.cases.length, 22);
  assert.equal(first.days.length, 7);
  assert.equal(first.platformCases.length, 14);
  assert.deepEqual(
    first.days.map((item) => item.id),
    replay.days.map((item) => item.id),
  );
  assert.deepEqual(
    first.platformCases.map((item) => item.id),
    replay.platformCases.map((item) => item.id),
  );
  assert.ok(first.days.every((item) => item.parentCaseId === parent.id));
  assert.ok(first.platformCases.every((item) =>
    first.days.some((day) => day.id === item.parentCaseId),
  ));

  const runner = new URL('../scripts/run-local-fake-e2e.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [runner.pathname], {
    encoding:'utf8',
    timeout:30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const ledger = JSON.parse(result.stdout);

  assert.equal(ledger.mode, 'local_fake_only');
  assert.equal(ledger.externalEffects, false);
  assert.equal(ledger.paidCalls, 0);
  assert.equal(ledger.passed, true);
  assert.equal(ledger.security.passed, true);

  const journey = ledger.caseJourney.map((item) => item.toStage);
  assert.equal(journey[0], 'draft');
  assert.equal(journey.at(-1), 'done');
  assert.ok([
    'topic',
    'script',
    'render',
    'machine_review',
    'platform_adapt',
    'publish_approval',
    'publish',
    'verify',
    'metrics',
    'retrospective',
  ].every((stage) => journey.includes(stage)));
  assert.equal(ledger.definition.allJourneyEdgesDeclared, true);

  assert.equal(ledger.parallel.branchCount, 5);
  assert.equal(ledger.parallel.declaredMaxConcurrency, 4);
  assert.equal(ledger.parallel.observedMaxConcurrency, 4);
  assert.deepEqual(ledger.parallel.waves, [4, 1]);
  assert.equal(ledger.parallel.allBranchesVerified, true);

  assert.deepEqual(ledger.review.requestChanges, {
    fromStage:'machine_review',
    toStage:'script',
    count:1,
  });
  assert.equal(ledger.recovery.safeRetryCount, 1);
  assert.equal(ledger.recovery.restartCount, 1);
  assert.equal(ledger.recovery.reusedVerifiedWorkProduct, true);
  assert.equal(
    ledger.recovery.workProductCountAfterRestart,
    ledger.recovery.workProductCountBeforeRestart,
  );

  assert.equal(ledger.budget.hardStopCount, 1);
  assert.equal(ledger.budget.connectorCallsBeforeResume, 0);
  assert.equal(ledger.budget.grantStatusAfterStop, 'paused');
  assert.equal(ledger.budget.cronEnabledAfterStop, false);
  assert.equal(ledger.budget.resumeWithoutGrantErrorCode, 'campaign_not_active');
  assert.equal(ledger.budget.connectorCallsBeforeGrantResume, 0);
  assert.equal(ledger.budget.grantStatusAfterResume, 'active');
  assert.equal(ledger.budget.cronEnabledAfterResume, true);

  assert.equal(ledger.publisher.connectorMode, 'fake');
  assert.equal(ledger.publisher.connectorCalls, 1);
  assert.equal(ledger.publisher.controllerReplay, true);
  assert.equal(ledger.publisher.replayed, true);
  assert.equal(ledger.publisher.sameReceipt, true);

  assert.deepEqual(
    ledger.metrics.snapshots.map((item) => item.checkpoint),
    ['2h', '24h', '72h'],
  );
  assert.equal(ledger.metrics.connectorCalls, 3);
  assert.equal(ledger.metrics.restartCount, 1);
  assert.equal(ledger.metrics.duplicateCollections, 0);
});
