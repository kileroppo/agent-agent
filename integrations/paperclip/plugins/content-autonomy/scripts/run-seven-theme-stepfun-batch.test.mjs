import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPaperclipPaidBridge,
  DEFAULT_TTS_TRANSPORT_REVISION,
  executeSevenThemeBatch,
  readAndArchivePriorLedger,
  SEVEN_THEMES,
  structuredQuality,
  validateNarrationAudio,
} from './run-seven-theme-stepfun-batch.mjs';

const creatorRun = {
  companyId:'11111111-1111-4111-8111-111111111111',
  agentId:'22222222-2222-4222-8222-222222222222',
  projectId:'33333333-3333-4333-8333-333333333333',
  runId:'44444444-4444-4444-8444-444444444444',
};
const analystRun = {
  ...creatorRun,
  agentId:'55555555-5555-4555-8555-555555555555',
  runId:'66666666-6666-4666-8666-666666666666',
};
const creatorIssueId = '77777777-7777-4777-8777-777777777777';
const analystIssueId = '88888888-8888-4888-8888-888888888888';
const goalId = '99999999-9999-4999-8999-999999999999';

test('7主题生成14图7旁白14次视觉观察并逐action确认费用', async () => {
  const harness = mockHarness();
  let writtenLedger;
  const ledger = await executeSevenThemeBatch({
    batchVersion:'mock-v1',
    creatorTools:harness.creatorTools,
    analystTools:harness.analystTools,
    creatorRun,
    analystRun,
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.commitCost,
    providerCallCount:() => harness.providerCalls,
    probeNarration:harness.probeNarration,
    writeLedger:async (value) => { writtenLedger = structuredClone(value); },
  });

  assert.equal(ledger.themeCount, 7);
  assert.deepEqual(ledger.expectedAssets, {
    images:14,
    narrations:7,
    visionObservations:14,
  });
  assert.equal(harness.providerCalls, 35);
  assert.equal(ledger.ttsTransportRevision, DEFAULT_TTS_TRANSPORT_REVISION);
  assert.equal(ledger.expectedNewProviderCalls, 35);
  assert.equal(ledger.confirmedReplay, 0);
  assert.equal(ledger.lifetimeProviderCalls, 35);
  assert.equal(harness.commits.length, 35);
  assert.equal(new Set(harness.commits.map((item) => item.actionId)).size, 35);
  assert.equal(harness.commits.filter((item) => item.role === 'content-creator').length, 21);
  assert.equal(harness.commits.filter((item) => item.role === 'video-content-analyst').length, 14);
  assert.equal(harness.commits.every((item) =>
    item.issueId === (item.role === 'content-creator' ? creatorIssueId : analystIssueId)
    && item.goalId === goalId), true);
  assert.equal(ledger.themes.every((item) => item.selectedCandidate === 2), true);
  assert.equal(ledger.replay.providerCalls, 0);
  assert.equal(ledger.replay.actions.length, 35);
  const ledgerActions = ledgerActionEntries(ledger);
  assert.equal(ledgerActions.length, 35);
  assert.equal(ledgerActions.every((item) =>
    /^sha256:[a-f0-9]{64}$/.test(item.parameterChecksum)), true);
  assert.equal(new Set(ledgerActions.map((item) =>
    `${item.operation}:${item.parameterChecksum}`)).size, 35);
  const actionChecksums = new Map(ledgerActions.map((item) => [
    `${item.actionId}:${item.operation}`,
    item.parameterChecksum,
  ]));
  assert.equal(ledger.replay.actions.every((item) =>
    item.parameterChecksum === actionChecksums.get(`${item.actionId}:${item.operation}`)), true);
  assert.equal(ledger.execution.peakProviderConcurrency, 4);
  assert.equal(harness.peakProviderConcurrency, 4);
  assert.equal(harness.peakCommitConcurrency, 1);
  assert.equal(ledger.themes.every((item) =>
    item.narration.audio.durationSeconds === 36.5
    && item.narration.audio.codec === 'mp3'), true);
  assert.deepEqual(writtenLedger, ledger);

  const serialized = JSON.stringify(ledger);
  assert.doesNotMatch(serialized, /mock-provider-observation|旁白正文|STEPFUN_API_KEY|Bearer\s/);
  assert.doesNotMatch(serialized, /"prompt"|"promptText"|"narrationText"|"observation"/);
});

test('回放已确认批次不触发Provider且不重复创建费用事件', async () => {
  const harness = mockHarness();
  const input = {
    batchVersion:'same-version',
    creatorTools:harness.creatorTools,
    analystTools:harness.analystTools,
    creatorRun,
    analystRun,
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.commitCost,
    providerCallCount:() => harness.providerCalls,
    probeNarration:harness.probeNarration,
    writeLedger:async () => undefined,
  };
  await executeSevenThemeBatch(input);
  const providerAfterFirst = harness.providerCalls;
  const commitsAfterFirst = harness.commits.length;
  await executeSevenThemeBatch(input);
  assert.equal(harness.providerCalls, providerAfterFirst);
  assert.equal(harness.commits.length, commitsAfterFirst + 35);
  assert.equal(harness.costEvents.size, 35);
});

test('replay-only在状态缺失或参数漂移时于Provider和cost claim前失败', async (context) => {
  for (const mode of ['missing', 'drift']) {
    await context.test(mode, async () => {
      const harness = replayOnlyBridgeHarness(mode);
      const parameters = {
        actionId:'m5_replay_only_image_v1',
        prompt:'stable prompt',
        outputPath:'provider/test.png',
        seed:1,
        textMode:false,
      };
      await assert.rejects(
        harness.bridge.creatorTools.image(parameters, creatorRun),
        /replay-only 拒绝/,
      );
      assert.equal(harness.providerCalls, 0);
      assert.equal(harness.costClaims, 0);
      assert.equal(harness.budgetReads, 0);
      assert.equal(harness.toolCalls, 1);
    });
  }
});

test('replay-only只读复用35条confirmed精确上下文且不签预算、不调用Provider或cost claim', async () => {
  const harness = replayOnlyBridgeHarness('confirmed');
  const ledger = await executeSevenThemeBatch({
    batchVersion:'replay-only-v1',
    replayOnly:true,
    creatorTools:harness.bridge.creatorTools,
    analystTools:harness.bridge.analystTools,
    creatorRun,
    analystRun,
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.bridge.commitCost,
    providerCallCount:harness.bridge.providerCallCount,
    providerRequestCount:harness.bridge.providerRequestCount,
    probeNarration:async () => ({
      durationSeconds:36.5,
      codec:'mp3',
      sampleRate:24_000,
      channels:1,
    }),
    writeLedger:async () => undefined,
  });

  assert.equal(ledger.status, 'succeeded');
  assert.equal(ledger.totalProviderCalls, 0);
  assert.equal(ledger.totalProviderRequests, 0);
  assert.equal(ledger.expectedNewProviderCalls, 0);
  assert.equal(ledger.confirmedReplay, 35);
  assert.equal(ledger.pendingCostRecovery, 0);
  assert.equal(ledger.replay.providerCalls, 0);
  assert.equal(ledger.replay.actions.length, 35);
  assert.equal(ledger.execution.replayOnly, true);
  assert.equal(harness.providerCalls, 0);
  assert.equal(harness.costClaims, 0);
  assert.equal(harness.budgetReads, 0);
  assert.equal(harness.toolCalls, 35);
});

test('缺少parameterChecksum的旧成功账本仍可读取并零Provider回放35条action', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-legacy-ledger-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const harness = mockHarness();
  let firstLedger;
  const input = {
    batchVersion:'legacy-ledger-v1',
    creatorTools:harness.creatorTools,
    analystTools:harness.analystTools,
    creatorRun,
    analystRun,
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.commitCost,
    providerCallCount:() => harness.providerCalls,
    probeNarration:harness.probeNarration,
    writeLedger:async (value) => { firstLedger = structuredClone(value); },
  };
  await executeSevenThemeBatch(input);
  const legacyLedger = structuredClone(firstLedger);
  for (const action of ledgerActionEntries(legacyLedger)) {
    delete action.parameterChecksum;
  }
  for (const action of legacyLedger.replay.actions) {
    delete action.parameterChecksum;
  }
  await fs.writeFile(
    path.join(root, 'ledger.json'),
    `${JSON.stringify(legacyLedger, null, 2)}\n`,
    { mode:0o600 },
  );

  const prior = await readAndArchivePriorLedger(root);
  assert.equal(prior.archivedFile, null);
  assert.equal(prior.priorLifetimeProviderCalls, 35);
  const providerBeforeReplay = harness.providerCalls;
  const replayLedger = await executeSevenThemeBatch({
    ...input,
    priorLifetimeProviderCalls:prior.priorLifetimeProviderCalls,
    writeLedger:async () => undefined,
  });
  assert.equal(harness.providerCalls, providerBeforeReplay);
  assert.equal(replayLedger.totalProviderCalls, 0);
  assert.equal(replayLedger.confirmedReplay, 35);
  assert.equal(replayLedger.replay.actions.length, 35);
  assert.equal(ledgerActionEntries(replayLedger).every((item) =>
    /^sha256:[a-f0-9]{64}$/.test(item.parameterChecksum)), true);
});

test('二进制传输修订只重做损坏TTS并复用同batchVersion的图片和视觉action', async () => {
  const harness = mockHarness();
  await assert.rejects(executeSevenThemeBatch({
    batchVersion:'recovery-v1',
    ttsTransportRevision:'paperclip-raw-v1',
    creatorTools:harness.creatorTools,
    analystTools:harness.analystTools,
    creatorRun,
    analystRun,
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.commitCost,
    providerCallCount:() => harness.providerCalls,
    probeNarration:async () => ({
      durationSeconds:12,
      codec:'mp3',
      sampleRate:44_100,
      channels:2,
    }),
    writeLedger:async () => undefined,
  }), /30至44秒/);
  assert.equal(harness.providerCalls, 10);

  const ledger = await executeSevenThemeBatch({
    batchVersion:'recovery-v1',
    ttsTransportRevision:DEFAULT_TTS_TRANSPORT_REVISION,
    recoveryFrom:{
      checksum:`sha256:${'c'.repeat(64)}`,
      providerCalls:10,
      code:'narration_audio_gate_failed',
      ttsRevision:'paperclip-raw-v1',
      archiveFile:`ledger.failed.${'c'.repeat(64)}.json`,
    },
    priorLifetimeProviderCalls:10,
    creatorTools:harness.creatorTools,
    analystTools:harness.analystTools,
    creatorRun:{ ...creatorRun, runId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    analystRun:{ ...analystRun, runId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.commitCost,
    providerCallCount:() => harness.providerCalls,
    probeNarration:harness.probeNarration,
    writeLedger:async () => undefined,
  });
  assert.equal(ledger.batchVersion, 'recovery-v1');
  assert.equal(ledger.ttsTransportRevision, DEFAULT_TTS_TRANSPORT_REVISION);
  assert.equal(ledger.expectedNewProviderCalls, 27);
  assert.equal(ledger.confirmedReplay, 8);
  assert.equal(ledger.totalProviderCalls, 27);
  assert.equal(ledger.lifetimeProviderCalls, 37);
  assert.deepEqual(ledger.recoveryFrom, {
    checksum:`sha256:${'c'.repeat(64)}`,
    providerCalls:10,
    code:'narration_audio_gate_failed',
    ttsRevision:'paperclip-raw-v1',
    archiveFile:`ledger.failed.${'c'.repeat(64)}.json`,
  });
  assert.equal(ledger.replay.providerCalls, 0);
  assert.equal(harness.providerCalls, 37);

  const actionIds = ledger.replay.actions.map((item) => item.actionId);
  assert.equal(actionIds.filter((item) => item.includes('_tts-paperclip-b64-v1_')).length, 4);
  assert.equal(actionIds.filter((item) => item.includes('_tts-paperclip-b64-t04-r3_')).length, 1);
  assert.equal(actionIds.filter((item) => item.includes('_tts-paperclip-b64-t06-r2_')).length, 1);
  assert.equal(actionIds.filter((item) => item.includes('_tts-paperclip-b64-t07-r2_')).length, 1);
  assert.equal(actionIds.some((item) => item.includes('_tts-paperclip-raw-v1_')), false);

  const replayLedger = await executeSevenThemeBatch({
    batchVersion:'recovery-v1',
    ttsTransportRevision:DEFAULT_TTS_TRANSPORT_REVISION,
    recoveryFrom:ledger.recoveryFrom,
    priorLifetimeProviderCalls:ledger.lifetimeProviderCalls,
    creatorTools:harness.creatorTools,
    analystTools:harness.analystTools,
    creatorRun:{ ...creatorRun, runId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    analystRun:{ ...analystRun, runId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.commitCost,
    providerCallCount:() => harness.providerCalls,
    probeNarration:harness.probeNarration,
    writeLedger:async () => undefined,
  });
  assert.equal(replayLedger.totalProviderCalls, 0);
  assert.equal(replayLedger.expectedNewProviderCalls, 0);
  assert.equal(replayLedger.confirmedReplay, 35);
  assert.equal(replayLedger.lifetimeProviderCalls, 37);
  assert.deepEqual(replayLedger.recoveryFrom, ledger.recoveryFrom);
  assert.equal(replayLedger.replay.providerCalls, 0);
});

test('覆盖failed账本前以0600不可覆盖归档并在success重跑时保留恢复血缘且不重复归档', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-ledger-recovery-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const failed = {
    schemaVersion:'agent.army/stepfun-seven-theme-batch/v1',
    batchVersion:'recovery-v1',
    ttsTransportRevision:'paperclip-raw-v1',
    provider:'stepfun',
    status:'failed',
    failure:{
      code:'narration_audio_gate_failed',
      stage:'narration_audio_gate',
      message:'旁白音频门禁失败。',
    },
    totalProviderCalls:10,
    execution:{
      maxProviderConcurrency:4,
      peakProviderConcurrency:4,
      coreCostCommitConcurrency:1,
    },
  };
  await fs.writeFile(path.join(root, 'ledger.json'), `${JSON.stringify(failed, null, 2)}\n`, { mode:0o600 });
  const first = await readAndArchivePriorLedger(root);
  assert.equal(first.priorLifetimeProviderCalls, 10);
  assert.equal(first.recoveryFrom.providerCalls, 10);
  assert.equal(first.recoveryFrom.code, 'narration_audio_gate_failed');
  assert.equal(first.recoveryFrom.ttsRevision, 'paperclip-raw-v1');
  assert.equal(first.archivedFile, first.recoveryFrom.archiveFile);
  const archivePath = path.join(root, first.archivedFile);
  assert.equal((await fs.lstat(archivePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    await fs.readFile(archivePath),
    await fs.readFile(path.join(root, 'ledger.json')),
  );

  const succeeded = {
    schemaVersion:'agent.army/stepfun-seven-theme-batch/v1',
    batchVersion:'recovery-v1',
    ttsTransportRevision:DEFAULT_TTS_TRANSPORT_REVISION,
    provider:'stepfun',
    totalProviderCalls:27,
    lifetimeProviderCalls:37,
    expectedNewProviderCalls:27,
    confirmedReplay:8,
    recoveryFrom:first.recoveryFrom,
  };
  await fs.writeFile(path.join(root, 'ledger.json'), `${JSON.stringify(succeeded, null, 2)}\n`, { mode:0o600 });
  const second = await readAndArchivePriorLedger(root);
  assert.equal(second.archivedFile, null);
  assert.equal(second.priorLifetimeProviderCalls, 37);
  assert.deepEqual(second.recoveryFrom, first.recoveryFrom);
  const archives = (await fs.readdir(root)).filter((item) => item.startsWith('ledger.failed.'));
  assert.deepEqual(archives, [first.archivedFile]);
});

test('结构化质量观察拒绝自由文本、越界分数和缺少安全字段', () => {
  const source = '```json\n{"score":91,"composition":88,"visualClarity":94,"textFree":true,"brandSafe":true,"risks":[]}\n```';
  const quality = structuredQuality(source);
  assert.deepEqual(
    {
      score:quality.score,
      composition:quality.composition,
      visualClarity:quality.visualClarity,
      textFree:quality.textFree,
      brandSafe:quality.brandSafe,
      risks:quality.risks,
      observationCharacters:quality.observationCharacters,
    },
    {
      score:91,
      composition:88,
      visualClarity:94,
      textFree:true,
      brandSafe:true,
      risks:[],
      observationCharacters:[...source].length,
    },
  );
  assert.match(quality.observationChecksum, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => structuredQuality('看起来不错'), /不是有效 JSON/);
  assert.throws(
    () => structuredQuality('{"score":101,"composition":80,"visualClarity":80,"textFree":true,"brandSafe":true}'),
    /score/,
  );
  assert.throws(
    () => structuredQuality('{"score":80,"composition":80,"visualClarity":80}'),
    /textFree/,
  );
  assert.throws(
    () => structuredQuality(
      '{"score":80,"composition":80,"visualClarity":80,"textFree":true,"brandSafe":true}',
      { requirePersonFree:true },
    ),
    /personFree/,
  );
  assert.equal(structuredQuality(
    '{"score":80,"composition":80,"visualClarity":80,"textFree":true,"brandSafe":true,"personFree":true}',
    { requirePersonFree:true },
  ).personFree, true);
});

test('任一主题两张候选均未通过安全门禁时拒绝选择', async () => {
  const harness = mockHarness({ allUnsafe:true });
  await assert.rejects(
    executeSevenThemeBatch({
      batchVersion:'unsafe-v1',
      creatorTools:harness.creatorTools,
      analystTools:harness.analystTools,
      creatorRun,
      analystRun,
      creatorIssueId,
      analystIssueId,
      goalId,
      commitCost:harness.commitCost,
      providerCallCount:() => harness.providerCalls,
      probeNarration:harness.probeNarration,
      writeLedger:async () => undefined,
    }),
    /均未通过/,
  );
  assert.ok(harness.providerCalls >= 5 && harness.providerCalls < 35);
  assert.equal(harness.providerCalls, harness.commits.length);
});

test('主题表固定为7项且画面提示明确禁止文字', () => {
  assert.equal(SEVEN_THEMES.length, 7);
  assert.equal(new Set(SEVEN_THEMES.map((item) => item.id)).size, 7);
  assert.equal(SEVEN_THEMES.every((item) => {
    const count = [...item.narration].length;
    return count >= 150 && count <= 220;
  }), true);
});

test('旁白音频门禁只接受可用于45秒成片的30至44秒音频', () => {
  assert.deepEqual(validateNarrationAudio({
    durationSeconds:36.51234,
    codec:'mp3',
    sampleRate:44_100,
    channels:2,
  }), {
    durationSeconds:36.512,
    codec:'mp3',
    sampleRate:44_100,
    channels:2,
  });
  assert.throws(() => validateNarrationAudio({
    durationSeconds:12,
    codec:'mp3',
    sampleRate:44_100,
    channels:2,
  }), /30至44秒/);
});

test('旁白时长不合格写入脱敏失败ledger且不伪装成成片成功', async () => {
  const harness = mockHarness();
  let failedLedger;
  await assert.rejects(executeSevenThemeBatch({
    batchVersion:'audio-fail-v1',
    creatorTools:harness.creatorTools,
    analystTools:harness.analystTools,
    creatorRun,
    analystRun,
    creatorIssueId,
    analystIssueId,
    goalId,
    commitCost:harness.commitCost,
    providerCallCount:() => harness.providerCalls,
    probeNarration:async () => ({
      durationSeconds:12,
      codec:'mp3',
      sampleRate:44_100,
      channels:2,
    }),
    writeLedger:async (value) => { failedLedger = value; },
  }), /30至44秒/);
  assert.equal(failedLedger.status, 'failed');
  assert.equal(failedLedger.failure.stage, 'narration_audio_gate');
  assert.equal('themes' in failedLedger, false);
});

test('真实桥恢复已完成Provider但待确认费用的action时保留回放标记且Provider计数为零', async () => {
  const calls = [];
  const actionId = 'm5_batch_bridge_image_v1';
  const publicKey = '-----BEGIN PUBLIC KEY-----\nmock-public-key\n-----END PUBLIC KEY-----';
  let confirmed = false;
  const costEvent = {
    agentId:creatorRun.agentId,
    projectId:creatorRun.projectId,
    heartbeatRunId:creatorRun.runId,
    provider:'stepfun',
    biller:'stepfun',
    billingType:'metered_api',
    billingCode:'m5:image_generate',
    model:'step-image-edit-2',
    inputTokens:0,
    cachedInputTokens:0,
    outputTokens:0,
    costCents:1,
    occurredAt:'2026-07-30T00:00:00.000Z',
  };
  const baseData = {
    actionId,
    operation:'image_generate',
    model:'step-image-edit-2',
    relativePath:'provider/test.png',
    checksum:`sha256:${'a'.repeat(64)}`,
    providerCallReplayed:true,
    callRecord:{ costEvent },
  };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path:parsed.pathname, body });
    if (method === 'GET' && parsed.pathname.endsWith('/budgets/overview')) {
      return jsonResponse({ policies:[
        budgetPolicy('company', creatorRun.companyId),
        budgetPolicy('agent', creatorRun.agentId),
        budgetPolicy('project', creatorRun.projectId),
      ] });
    }
    if (method === 'POST' && parsed.pathname === '/api/plugins/tools/execute') {
      assert.equal(body.tool, 'agent-army.content-autonomy:stepfun-image-generate');
      assert.equal(body.runContext.runId, creatorRun.runId);
      assert.equal(typeof body.parameters.budgetTicket, 'string');
      return jsonResponse({
        pluginId:'agent-army.content-autonomy',
        toolName:'stepfun-image-generate',
        result:confirmed
          ? { content:'replayed', data:{
            ...baseData,
            replayed:true,
            nextStageAllowed:true,
            costCommit:{
              status:'confirmed',
              costEventId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          } }
          : { error:'cost_event_pending', data:{
            ...baseData,
            nextStageAllowed:false,
            costCommit:{ status:'pending_core_cost_event' },
          } },
      });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/actions/cost-event-claim')) {
      return jsonResponse({ data:{ content:'claimed', data:{
        ...baseData,
        costCommit:{
          status:'submitting_core_cost_event',
          submissionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          costEvent,
        },
      } } });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/cost-events')) {
      return jsonResponse({
        id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ...body,
      });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/actions/cost-event-confirm')) {
      confirmed = true;
      return jsonResponse({ data:{ content:'confirmed', data:{
        ...baseData,
        nextStageAllowed:true,
        costCommit:{
          status:'confirmed',
          costEventId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      } } });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createPaperclipPaidBridge({
    apiBase:'http://127.0.0.1:3100',
    companyId:creatorRun.companyId,
    projectId:creatorRun.projectId,
    pluginId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    config:{
      budgetTicketPublicKey:publicKey,
      costRatesCents:{
        visionInputPerMillionTokens:35,
        visionOutputPerMillionTokens:112,
        imagePerGeneration:1,
        ttsPerThousandCharacters:9,
      },
    },
    authority:{
      publicKey,
      sign:({ actionId:ticketActionId }) => `signed:${ticketActionId}`,
    },
    runsByRole:{ 'content-creator':creatorRun },
    fetchImpl,
  });
  const parameters = {
    actionId,
    prompt:'not persisted by ledger',
    outputPath:'provider/test.png',
    seed:1,
    textMode:false,
  };
  const pending = await bridge.creatorTools.image(parameters, creatorRun);
  const committed = await bridge.commitCost({
    actionId,
    result:pending,
    role:'content-creator',
  });
  assert.equal(committed.data.costCommit.status, 'confirmed');
  assert.equal(committed.data.providerCallReplayed, true);
  const replay = await bridge.creatorTools.image(parameters, creatorRun);
  assert.equal(replay.data.replayed, true);
  assert.equal(bridge.providerCallCount(), 0);
  assert.deepEqual(calls.filter((item) => item.method === 'POST').map((item) => item.path), [
    '/api/plugins/tools/execute',
    '/api/plugins/cccccccc-cccc-4ccc-8ccc-cccccccccccc/actions/cost-event-claim',
    `/api/companies/${creatorRun.companyId}/cost-events`,
    '/api/plugins/cccccccc-cccc-4ccc-8ccc-cccccccccccc/actions/cost-event-confirm',
    '/api/plugins/tools/execute',
  ]);
});

function replayOnlyBridgeHarness(mode) {
  let providerCalls = 0;
  let costClaims = 0;
  let budgetReads = 0;
  let toolCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === 'GET' && parsed.pathname.endsWith('/budgets/overview')) {
      budgetReads += 1;
      return jsonResponse({}, 500);
    }
    if (method === 'POST' && parsed.pathname.includes('/actions/cost-event-')) {
      costClaims += 1;
      return jsonResponse({}, 500);
    }
    if (method !== 'POST' || parsed.pathname !== '/api/plugins/tools/execute') {
      return jsonResponse({}, 404);
    }
    toolCalls += 1;
    assert.equal('budgetTicket' in body.parameters, false);
    if (mode === 'missing') {
      return jsonResponse({
        pluginId:'agent-army.content-autonomy',
        toolName:body.tool.split(':').at(-1),
        result:{ error:'budget_ticket_required: replay state missing' },
      });
    }
    if (mode === 'drift') {
      return jsonResponse({
        pluginId:'agent-army.content-autonomy',
        toolName:body.tool.split(':').at(-1),
        result:{ error:'paid_action_context_mismatch: parameters changed' },
      });
    }

    const toolName = body.tool.split(':').at(-1);
    const operation = toolName === 'stepfun-vision'
      ? 'vision'
      : toolName === 'stepfun-tts'
        ? 'tts'
        : 'image_generate';
    const model = operation === 'vision'
      ? 'step-3.7-flash'
      : operation === 'tts'
        ? 'stepaudio-2.5-tts'
        : 'step-image-edit-2';
    const candidate = /candidate-(\d)/.exec(
      body.parameters.relativePath || body.parameters.outputPath || '',
    );
    const candidateIndex = Number(candidate?.[1] || 0);
    const outputPath = operation === 'vision' ? null : body.parameters.outputPath;
    return jsonResponse({
      pluginId:'agent-army.content-autonomy',
      toolName,
      result:{
        content:'confirmed replay',
        data:{
          actionId:body.parameters.actionId,
          operation,
          model,
          replayed:true,
          nextStageAllowed:true,
          ...(outputPath ? {
            relativePath:outputPath,
            checksum:`sha256:${cryptoHash(body.parameters.actionId)}`,
          } : {}),
          ...(operation === 'vision' ? {
            observation:JSON.stringify({
              score:candidateIndex === 2 ? 92 : 82,
              composition:candidateIndex === 2 ? 91 : 84,
              visualClarity:candidateIndex === 2 ? 94 : 85,
              textFree:true,
              brandSafe:true,
              personFree:true,
              risks:[],
            }),
          } : {}),
          callRecord:{ costEvent:{ costCents:1 } },
          costCommit:{
            status:'confirmed',
            costEventId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        },
      },
    });
  };
  const bridge = createPaperclipPaidBridge({
    apiBase:'http://127.0.0.1:3100',
    companyId:creatorRun.companyId,
    projectId:creatorRun.projectId,
    pluginId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    config:{
      costRatesCents:{
        visionInputPerMillionTokens:35,
        visionOutputPerMillionTokens:112,
        imagePerGeneration:1,
        ttsPerThousandCharacters:9,
      },
    },
    authority:null,
    runsByRole:{
      'content-creator':creatorRun,
      'video-content-analyst':analystRun,
    },
    fetchImpl,
    replayOnly:true,
  });
  return {
    bridge,
    get providerCalls() { return providerCalls; },
    get costClaims() { return costClaims; },
    get budgetReads() { return budgetReads; },
    get toolCalls() { return toolCalls; },
  };
}

function mockHarness({ allUnsafe = false } = {}) {
  let providerCalls = 0;
  const completed = new Map();
  const commits = [];
  const costEvents = new Map();
  let costCounter = 0;
  let activeProvider = 0;
  let peakProviderConcurrency = 0;
  let activeCommits = 0;
  let peakCommitConcurrency = 0;

  const invoke = async (operation, params, run) => {
    const existing = completed.get(params.actionId);
    if (existing) {
      return {
        content:'replay',
        data:{ ...existing, replayed:true },
      };
    }
    activeProvider += 1;
    peakProviderConcurrency = Math.max(peakProviderConcurrency, activeProvider);
    await new Promise((resolve) => setTimeout(resolve, 4));
    providerCalls += 1;
    const candidate = /candidate-(\d)/.exec(params.relativePath || params.outputPath || '');
    const candidateIndex = Number(candidate?.[1] || 0);
    const observation = operation === 'vision'
      ? JSON.stringify({
        score:candidateIndex === 2 ? 92 : 82,
        composition:candidateIndex === 2 ? 91 : 84,
        visualClarity:candidateIndex === 2 ? 94 : 85,
        textFree:!allUnsafe,
        brandSafe:!allUnsafe,
        personFree:!allUnsafe,
        risks:allUnsafe ? ['watermark'] : [],
      })
      : undefined;
    const outputPath = params.outputPath || null;
    const data = {
      actionId:params.actionId,
      operation,
      model:operation === 'vision'
        ? 'step-3.7-flash'
        : operation === 'tts'
          ? 'stepaudio-2.5-tts'
          : 'step-image-edit-2',
      ...(outputPath ? {
        relativePath:outputPath,
        checksum:`sha256:${String(providerCalls).padStart(64, '0')}`,
      } : {}),
      ...(observation ? { observation:`${observation}` } : {}),
      callRecord:{ costEvent:{ costCents:1 } },
      nextStageAllowed:false,
      costCommit:{ status:'pending_core_cost_event', costEvent:{ costCents:1 } },
    };
    activeProvider -= 1;
    return { content:'new', data };
  };

  const creatorTools = {
    image:(params, run) => invoke('image_generate', params, run),
    tts:(params, run) => invoke('tts', params, run),
  };
  const analystTools = {
    vision:(params, run) => invoke('vision', params, run),
  };
  const commitCost = async (input) => {
    activeCommits += 1;
    peakCommitConcurrency = Math.max(peakCommitConcurrency, activeCommits);
    await new Promise((resolve) => setTimeout(resolve, 1));
    commits.push({
      actionId:input.actionId,
      issueId:input.issueId,
      goalId:input.goalId,
      role:input.role,
    });
    if (input.result?.data?.costCommit?.status === 'confirmed') {
      activeCommits -= 1;
      return input.result;
    }
    costCounter += 1;
    const costEventId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(costCounter).padStart(12, '0')}`;
    costEvents.set(input.actionId, costEventId);
    const data = {
      ...input.result.data,
      nextStageAllowed:true,
      costCommit:{ status:'confirmed', costEventId },
    };
    completed.set(input.actionId, data);
    activeCommits -= 1;
    return { ...input.result, data };
  };
  return {
    creatorTools,
    analystTools,
    commitCost,
    commits,
    costEvents,
    probeNarration:async () => ({
      durationSeconds:36.5,
      codec:'mp3',
      sampleRate:44_100,
      channels:2,
    }),
    get providerCalls() { return providerCalls; },
    get peakProviderConcurrency() { return peakProviderConcurrency; },
    get peakCommitConcurrency() { return peakCommitConcurrency; },
  };
}

function cryptoHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ledgerActionEntries(ledger) {
  return ledger.themes.flatMap((current) => [
    current.narration,
    ...current.candidates.flatMap((candidate) => [candidate, candidate.vision]),
  ]);
}

function budgetPolicy(scopeType, scopeId) {
  return {
    scopeType,
    scopeId,
    metric:'billed_cents',
    isActive:true,
    hardStopEnabled:true,
    paused:false,
    status:'ok',
    remainingAmount:100,
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok:status >= 200 && status < 300,
    status,
    json:async () => structuredClone(value),
  };
}
