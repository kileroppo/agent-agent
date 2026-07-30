import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertM5DeclaredTransition,
  buildM5LocalChaosRenderWorkProductFixture,
  inspectM5LocalLedgerSafety,
  validateLocalChaosRenderWorkProduct,
} from '../src/m5-local-chaos-acceptance.js';
import {
  getM5RoutineExecutionContract,
} from '../src/m5-routine-execution-contract.js';
import {
  buildBootstrapPlan,
  defaultDefinition,
  validateDefinition,
} from '../../../integrations/paperclip/m5-content-pipeline/src/index.js';

test('M5 本地全链 chaos 纵切输出统一 JSON ledger，覆盖恢复、硬停、幂等和三次指标', async () => {
  const moduleUrl = new URL('../src/m5-local-chaos-acceptance.js', import.meta.url);
  const isolatedRun = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        'globalThis.fetch = async () => {',
        "  throw new Error('本地 chaos 验收禁止网络请求');",
        '};',
        `const { runM5LocalChaosAcceptance } = await import(${JSON.stringify(moduleUrl.href)});`,
        'const ledger = await runM5LocalChaosAcceptance();',
        'process.stdout.write(JSON.stringify(ledger));',
      ].join('\n'),
    ],
    {
      encoding:'utf8',
      timeout:30_000,
    },
  );
  assert.equal(isolatedRun.status, 0, isolatedRun.stderr);
  const ledger = JSON.parse(isolatedRun.stdout);

  assert.equal(ledger.schemaVersion, 'agent.army/m5-local-chaos-acceptance/v1');
  assert.equal(ledger.mode, 'local_fake_only');
  assert.equal(ledger.externalEffects, false);
  assert.equal(ledger.paidCalls, 0);
  assert.equal(ledger.passed, true);

  assert.equal(ledger.definition.declaredStageCount, 15);
  assert.equal(ledger.definition.successTerminal, 'done');
  assert.equal(ledger.definition.alternativeTerminal, 'cancelled');
  assert.equal(ledger.definition.declaredTransitionCount, 16);
  assert.equal(ledger.definition.allJourneyEdgesDeclared, true);
  assert.equal(ledger.caseJourney[0].toStage, 'draft');
  assert.equal(ledger.caseJourney.at(-1).toStage, 'done');
  assert.ok(ledger.caseJourney.every((item) =>
    item.caseId === ledger.scope.platformCaseId,
  ));
  assert.ok(ledger.caseJourney.slice(1).every((item) =>
    item.declaredTransition === true
      && typeof item.declarationLabel === 'string',
  ));

  assert.equal(ledger.parallel.branchCount, 5);
  assert.equal(ledger.parallel.declaredMaxConcurrency, 4);
  assert.equal(ledger.parallel.observedMaxConcurrency, 4);
  assert.deepEqual(ledger.parallel.waves, [4, 1]);
  assert.deepEqual(
    ledger.parallel.barrierEvidence.map((item) => ({
      waveSize:item.waveSize,
      arrived:item.arrived,
      completedBeforeRelease:item.completedBeforeRelease,
    })),
    [
      { waveSize:4, arrived:4, completedBeforeRelease:0 },
      { waveSize:1, arrived:1, completedBeforeRelease:0 },
    ],
  );

  assert.equal(ledger.recovery.safeRetryCount, 1);
  assert.equal(ledger.recovery.restartCount, 1);
  assert.equal(ledger.recovery.reusedVerifiedWorkProduct, true);
  assert.equal(ledger.recovery.workProductCountBeforeRestart, 1);
  assert.equal(ledger.recovery.workProductCountAfterRestart, 1);

  assert.deepEqual(ledger.review.requestChanges, {
    fromStage:'machine_review',
    toStage:'script',
    count:1,
  });
  assert.equal(ledger.review.finalApprovalPassed, true);

  assert.equal(ledger.budget.hardStopCount, 1);
  assert.equal(ledger.budget.connectorCallsBeforeResume, 0);
  assert.equal(ledger.budget.grantStatusAfterStop, 'paused');
  assert.equal(ledger.budget.cronEnabledAfterStop, false);
  assert.equal(ledger.budget.resumeWithoutGrantErrorCode, 'campaign_not_active');
  assert.equal(ledger.budget.connectorCallsBeforeGrantResume, 0);
  assert.equal(ledger.budget.grantStatusAfterResume, 'active');
  assert.equal(ledger.budget.cronEnabledAfterResume, true);
  assert.equal(ledger.budget.resumed, true);

  assert.equal(ledger.publisher.connectorMode, 'fake');
  assert.equal(ledger.publisher.connectorCalls, 1);
  assert.equal(ledger.publisher.replayed, true);
  assert.equal(ledger.publisher.sameReceipt, true);

  assert.deepEqual(
    ledger.metrics.snapshots.map((item) => item.checkpoint),
    ['2h', '24h', '72h'],
  );
  assert.equal(ledger.metrics.connectorCalls, 3);
  assert.equal(ledger.metrics.restartCount, 1);
  assert.equal(ledger.metrics.duplicateCollections, 0);

  assert.deepEqual(
    {
      passed:ledger.security.passed,
      credentialFields:ledger.security.credentialFields,
      credentialValues:ledger.security.credentialValues,
      absolutePaths:ledger.security.absolutePaths,
    },
    {
      passed:true,
      credentialFields:0,
      credentialValues:0,
      absolutePaths:0,
    },
  );
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(ledger)));
  assert.doesNotMatch(
    JSON.stringify(ledger),
    /(?:bearer\s+[a-z0-9._~+/=-]+|(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}|\/Users\/|[a-z]:\\Users\\)/i,
  );
});

test('M5 chaos transition 守卫拒绝正式 Bootstrap plan 未声明的跳跃', () => {
  const transitions = buildBootstrapPlan(
    validateDefinition(defaultDefinition),
  ).resources.pipeline.transitions;
  assert.deepEqual(
    assertM5DeclaredTransition(transitions, 'render', 'machine_review'),
    {
      fromStageKey:'render',
      toStageKey:'machine_review',
      label:'推进',
    },
  );
  assert.throws(
    () => assertM5DeclaredTransition(transitions, 'render', 'publish'),
    /正式 Pipeline 未声明 transition：render->publish/,
  );
});

test('M5 chaos 恢复只信任与当前 Case、Project、Run 和固定渲染 fixture 完全一致的 Work Product', async () => {
  const targetCaseId = 'abababab-abab-4bab-8bab-abababababab';
  const projectId = '12121212-1212-4121-8121-121212121212';
  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const contract = getM5RoutineExecutionContract('m5-render');
  const product = buildM5LocalChaosRenderWorkProductFixture(contract, targetCaseId);
  const input = {
    contract,
    product,
    targetCaseId,
    projectId,
    assignment:{
      issueId:'66666666-6666-4666-8666-666666666666',
      runId,
      pipelineCaseId:targetCaseId,
      projectId,
      routineKey:'m5-render',
      agentId:'content-creator',
    },
    paperclipRuns:[{
      id:runId,
      status:'failed',
      agentId:'55555555-5555-4555-8555-555555555555',
    }],
  };

  await assert.doesNotReject(() => validateLocalChaosRenderWorkProduct(input));

  const drifted = structuredClone(product);
  drifted.metadata.artifact.checksum = `sha256:${'c'.repeat(64)}`;
  await assert.rejects(
    () => validateLocalChaosRenderWorkProduct({ ...input, product:drifted }),
    /local_chaos_render_work_product_drift/,
  );
});

test('M5 chaos ledger 安全审计拒绝凭据字段、Bearer 值和绝对路径', () => {
  const audit = inspectM5LocalLedgerSafety({
    authorization:'Bearer local-test-value',
    artifact:'/Users/example/private/output.mp4',
  });
  assert.equal(audit.passed, false);
  assert.equal(audit.credentialFields, 1);
  assert.equal(audit.credentialValues, 1);
  assert.equal(audit.absolutePaths, 1);
});
