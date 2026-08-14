import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCostEventSchema } from '@paperclipai/shared';
import {
  buildFinalEncodeArgs,
  parseBlackDetect,
  parseEbur128,
  writeM5ArtifactPackage,
  validateArtifactLineage
} from '../src/media-tools.ts';
import { sha256 } from '../src/policy.ts';
import {
  paidActionStateKey,
  paidParameterChecksum,
  paperclipResponseBytes,
  StepFunContentTools,
} from '../src/stepfun-tools.ts';
import {
  callRecord,
  costForImage,
  costForTts,
  costForVision
} from '../src/call-record.ts';

const run = {
  agentId:'11111111-1111-4111-8111-111111111111',
  runId:'22222222-2222-4222-8222-222222222222',
  companyId:'33333333-3333-4333-8333-333333333333',
  projectId:'44444444-4444-4444-8444-444444444444'
};
const rates = {
  visionInputPerMillionTokens:100,
  visionOutputPerMillionTokens:200,
  imagePerGeneration:3,
  ttsPerThousandCharacters:4
};
const stepfunSecretRef = {
  type:'secret_ref',
  secretId:'55555555-5555-4555-8555-555555555555',
  version:'latest'
};

test('StepFun调用记录脱敏并生成Paperclip费用事件契约', () => {
  const record = callRecord({
    run,
    actionId:'action:vision:1',
    model:'step-3.7-flash',
    operation:'vision',
    prompt:'token=abc /Users/pengaro/private.png 判断画面',
    usage:{ inputTokens:10, outputTokens:5 },
    costCents:costForVision({ prompt_tokens:10, completion_tokens:5 }, rates)
  });
  assert.equal(record.promptMetadata.characters, [...'token=abc /Users/pengaro/private.png 判断画面'].length);
  assert.equal(Object.hasOwn(record, 'promptSummary'), false);
  assert.match(record.promptChecksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal(createCostEventSchema.safeParse(record.costEvent).success, true);
  assert.equal(record.costEvent.billingType, 'metered_api');
  assert.equal(record.costEvent.heartbeatRunId, run.runId);
});

test('图片和TTS按负责人配置费率保守向上取整', () => {
  assert.equal(costForImage(rates), 3);
  assert.equal(Math.ceil(costForTts('一'.repeat(250), rates)), 1);
});

test('调用记录只保留允许字段和prompt哈希，不保留自由文本', () => {
  const record = callRecord({
    run,
    actionId:'action:secret:1',
    model:'step-3.7-flash',
    operation:'vision',
    prompt:'Bearer secret api_key=xyz /Users/alice/file.png',
    costCents:1
  });
  assert.equal(JSON.stringify(record).includes('Bearer secret'), false);
  assert.equal(JSON.stringify(record).includes('/Users/alice'), false);
});

test('最终编码命令固定且不接受调用方滤镜或Shell字符串', () => {
  const args = buildFinalEncodeArgs('/safe/input.mov', '/safe/output.mp4');
  assert.deepEqual(args.slice(0, 6), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i']);
  assert.ok(args.includes('loudnorm=I=-15:LRA=7:TP=-1.5'));
  assert.ok(args.includes('libx264'));
  assert.equal(args.at(-1), '/safe/output.mp4');
  assert.equal(args.some((item) => /;|&&|\|\|/.test(item)), false);
});

test('FFmpeg黑帧和EBU R128输出按最终Summary解析', () => {
  const black = parseBlackDetect(`
Duration: 00:00:40.00
[blackdetect] black_start:0 black_end:0.08 black_duration:0.08
[blackdetect] black_start:39.9 black_end:40 black_duration:0.1
`);
  assert.equal(black.startsWithBlack, true);
  assert.equal(black.endsWithBlack, true);
  assert.equal(black.totalSeconds, 0.18);

  const loudness = parseEbur128(`
I: -70.0 LUFS Peak: -20.0 dBFS
Summary:
  Integrated loudness:
    I: -15.2 LUFS
  True peak:
    Peak: -1.5 dBFS
`);
  assert.deepEqual(loudness, { integratedLufs:-15.2, truePeakDb:-1.5 });
});

test('固定产物清单逐文件核验真实哈希和最小血缘', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-artifacts-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await writeArtifactFixture(root);
  const result = await validateArtifactLineage({
    localFolders:{ status:async () => ({ healthy:true, realPath:root }) }
  }, { manifestPath:'artifact-manifest.tson' }, run);
  assert.equal(result.data.passed, true, result.data.errors.join(' '));
});

test('固定产物包写入器从三份可信成片和真实封面生成子目录账本并回读通过', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-artifact-writer-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-artifact-outside-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  context.after(() => fs.rm(outsideRoot, { recursive:true, force:true }));
  const videos = {};
  for (const platform of ['master', 'douyin', 'xiaohongshu']) {
    const relativePath = `source/${platform}.mp4`;
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive:true });
    const bytes = Buffer.from(`fixture:${platform}`);
    await fs.writeFile(absolutePath, bytes);
    videos[platform] = { path:relativePath, checksum:sha256(bytes) };
  }
  const coverBytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from('fixture-cover'),
  ]);
  await fs.writeFile(path.join(root, 'source', 'frame-001.png'), coverBytes);
  const outsideTarget = path.join(outsideRoot, 'must-not-change.json');
  await fs.writeFile(outsideTarget, 'outside-unchanged');
  await fs.mkdir(path.join(root, 'packages', 'content-v1'), { recursive:true });
  await fs.symlink(
    outsideTarget,
    path.join(root, 'packages', 'content-v1', 'douyin.copy.json'),
  );
  const lineage = {
    schemaVersion:1,
    contentVersionId:'content-v1',
    sourceTaskId:'task-v1',
    generatedBy:'reviewer',
    createdAt:'2026-07-30T00:00:00.000Z',
    parents:[],
  };
  const ctx = {
    localFolders:{
      status:async () => ({
        healthy:true,
        writable:true,
        realPath:root,
      }),
    },
  };
  const result = await writeM5ArtifactPackage(ctx, {
    outputDir:'packages/content-v1',
    videos,
    copies:{
      douyin:{ title:'抖音标题', body:'抖音正文', tags:['AI Agent'] },
      xiaohongshu:{ title:'小红书标题', body:'小红书正文', tags:['AI工具'] },
    },
    coverSourcePath:'source/frame-001.png',
    sources:{
      sources:[
        { ref:'source-1', kind:'official_document' },
        { ref:'source-2', kind:'project_evidence' },
      ],
      thirdPartyMedia:[],
      aiGeneratedMedia:[],
    },
    review:{
      schemaVersion:1,
      passed:true,
      failures:[],
      checks:{ subtitleLayout:{ passed:true } },
    },
    lineage,
  }, run);
  assert.equal(result.data.manifestPath, 'packages/content-v1/artifact-manifest.tson');
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(result.data.manifestChecksum));

  const validation = await validateArtifactLineage(
    ctx,
    { manifestPath:result.data.manifestPath },
    run,
  );
  assert.equal(validation.data.passed, true, validation.data.errors.join(' '));
  assert.equal(
    await fs.readFile(path.join(root, 'packages/content-v1/cover.png')).then(sha256),
    sha256(coverBytes),
  );
  assert.equal(await fs.readFile(outsideTarget, 'utf8'), 'outside-unchanged');
  assert.equal(
    (await fs.lstat(path.join(root, 'packages/content-v1/douyin.copy.json'))).isSymbolicLink(),
    false,
  );
});

test('固定产物包写入器从已确认Provider账本原生补齐StepFun血缘且无需迁移', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-provider-artifact-writer-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const imageBytes = validPngBytes('provider-image');
  const narrationBytes = Buffer.from('provider-narration');
  const imageChecksum = sha256(imageBytes);
  const narrationChecksum = sha256(narrationBytes);
  const promptChecksum = sha256(Buffer.from('image prompt'));
  const legacyThemePromptChecksum = sha256(Buffer.from('legacy candidate-1 prompt'));
  const narrationPromptChecksum = sha256(Buffer.from('narration prompt'));
  const observationChecksum = sha256(Buffer.from('vision observation'));
  const providerLedgerPath = 'provider/fresh/ledger.json';
  const selectedPath = 'provider/fresh/candidate.png';
  const narrationPath = 'provider/fresh/narration.mp3';
  const providerLedger = {
    schemaVersion:'agent.army/stepfun-seven-theme-batch/v1',
    provider:'stepfun',
    status:'succeeded',
    pendingCostRecovery:0,
    batchVersion:'fresh-v1',
    themes:[{
      id:'fresh-theme',
      promptChecksum:legacyThemePromptChecksum,
      narrationChecksum:narrationPromptChecksum,
      candidates:[{
        actionId:'fresh:image:1',
        operation:'image_generate',
        model:'step-image-edit-2',
        replayed:false,
        providerCallReplayed:false,
        costCents:1,
        costEventId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promptChecksum,
        outputPath:selectedPath,
        outputChecksum:imageChecksum,
        quality:{ observationChecksum },
        vision:{
          actionId:'fresh:vision:1',
          operation:'vision',
          model:'step-3.7-flash',
          replayed:false,
          providerCallReplayed:false,
          costCents:1,
          costEventId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      }],
      narration:{
        actionId:'fresh:tts:1',
        operation:'tts',
        model:'stepaudio-2.5-tts',
        replayed:false,
        providerCallReplayed:false,
        costCents:2,
        costEventId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        outputPath:narrationPath,
        outputChecksum:narrationChecksum,
      },
      selectedPath,
      selectedChecksum:imageChecksum,
    }],
  };
  await fs.mkdir(path.join(root, 'provider', 'fresh'), { recursive:true });
  await fs.writeFile(path.join(root, selectedPath), imageBytes);
  await fs.writeFile(path.join(root, narrationPath), narrationBytes);
  await fs.writeFile(
    path.join(root, providerLedgerPath),
    `${JSON.stringify(providerLedger, null, 2)}\n`,
  );
  const videos = {};
  for (const platform of ['master', 'douyin', 'xiaohongshu']) {
    const relativePath = `source/${platform}.mp4`;
    const bytes = Buffer.from(`fixture:${platform}`);
    await fs.mkdir(path.join(root, 'source'), { recursive:true });
    await fs.writeFile(path.join(root, relativePath), bytes);
    videos[platform] = { path:relativePath, checksum:sha256(bytes) };
  }
  await fs.writeFile(path.join(root, 'source', 'cover.png'), validPngBytes('cover'));
  const lineage = {
    schemaVersion:1,
    contentVersionId:'fresh-content-v1',
    sourceTaskId:'fresh-content-task',
    generatedBy:'content-creator',
    createdAt:'2026-07-31T00:00:00.000Z',
    parents:[{
      kind:'stepfun_provider_ledger',
      path:'provider/old/ledger.json',
      checksum:sha256(Buffer.from('old ledger')),
      batchVersion:'old-v1',
      themeId:'fresh-theme',
    }],
  };
  const ctx = {
    localFolders:{
      status:async () => ({
        healthy:true,
        writable:true,
        realPath:root,
      }),
    },
  };
  const result = await writeM5ArtifactPackage(ctx, {
    outputDir:'packages/fresh-content-v1',
    providerLedgerPath,
    providerThemeId:'fresh-theme',
    videos,
    copies:{
      douyin:{ title:'抖音标题', body:'抖音正文', tags:['AI Agent'] },
      xiaohongshu:{ title:'小红书标题', body:'小红书正文', tags:['AI工具'] },
    },
    coverSourcePath:'source/cover.png',
    sources:{
      sources:[
        { ref:'source-1', kind:'official_document' },
        { ref:'source-2', kind:'project_evidence' },
      ],
      thirdPartyMedia:[],
      aiGeneratedMedia:[{
        ref:selectedPath,
        sourceChecksum:imageChecksum,
        model:'step-image-edit-2',
      }],
      narration:{
        provider:'StepFun',
        model:'stepaudio-2.5-tts',
        checksum:narrationChecksum,
        ref:narrationPath,
      },
    },
    review:{
      schemaVersion:1,
      passed:true,
      failures:[],
      checks:{ subtitleLayout:{ passed:true } },
    },
    lineage,
  }, run);
  assert.equal(result.data.providerBinding.themeId, 'fresh-theme');
  const sources = JSON.parse(await fs.readFile(
    path.join(root, 'packages/fresh-content-v1/sources.json'),
    'utf8',
  ));
  assert.equal(sources.aiGeneratedMedia[0].sourceTaskId, 'fresh:image:1');
  assert.equal(sources.aiGeneratedMedia[0].promptChecksum, promptChecksum);
  assert.equal(sources.aiGeneratedMedia[0].vision.sourceTaskId, 'fresh:vision:1');
  assert.equal(sources.narration.sourceTaskId, 'fresh:tts:1');
  assert.equal(sources.narration.checksum, narrationChecksum);
  assert.equal(
    sources.narration.providerLedgerChecksum,
    result.data.providerBinding.ledgerChecksum,
  );
  const validation = await validateArtifactLineage(
    ctx,
    { manifestPath:result.data.manifestPath },
    run,
  );
  assert.equal(validation.data.passed, true, validation.data.errors.join(' '));
  const writtenLineage = JSON.parse(await fs.readFile(
    path.join(root, 'packages/fresh-content-v1/lineage.json'),
    'utf8',
  ));
  assert.equal(
    writtenLineage.parents.filter((item) =>
      item.kind === 'stepfun_provider_ledger'
      && item.themeId === 'fresh-theme').length,
    1,
  );

  delete sources.aiGeneratedMedia[0].providerLedgerChecksum;
  const sourcesBytes = Buffer.from(`${JSON.stringify(sources, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'packages/fresh-content-v1/sources.json'), sourcesBytes);
  const manifest = JSON.parse(await fs.readFile(
    path.join(root, 'packages/fresh-content-v1/artifact-manifest.tson'),
    'utf8',
  ));
  manifest.files['sources.json'].checksum = sha256(sourcesBytes);
  await fs.writeFile(
    path.join(root, 'packages/fresh-content-v1/artifact-manifest.tson'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const tampered = await validateArtifactLineage(
    ctx,
    { manifestPath:result.data.manifestPath },
    run,
  );
  assert.equal(tampered.data.passed, false);
  assert.match(tampered.data.errors.join(' '), /StepFun 素材必须绑定/);
});

test('固定产物包按同Project插件状态反查逐阶段confirmed action并拒绝未确认视觉', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-confirmed-action-writer-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const imagePath = 'provider/single/generated.png';
  const narrationPath = 'provider/single/narration.mp3';
  const imageBytes = validPngBytes('single-image');
  const narrationBytes = Buffer.from('single-narration');
  const imageChecksum = sha256(imageBytes);
  const narrationChecksum = sha256(narrationBytes);
  await fs.mkdir(path.join(root, 'provider', 'single'), { recursive:true });
  await fs.writeFile(path.join(root, imagePath), imageBytes);
  await fs.writeFile(path.join(root, narrationPath), narrationBytes);
  const videos = {};
  for (const platform of ['master', 'douyin', 'xiaohongshu']) {
    const relativePath = `source/${platform}.mp4`;
    const bytes = Buffer.from(`fixture:${platform}`);
    await fs.mkdir(path.join(root, 'source'), { recursive:true });
    await fs.writeFile(path.join(root, relativePath), bytes);
    videos[platform] = { path:relativePath, checksum:sha256(bytes) };
  }
  const actionRefs = {
    image:'single:image:1',
    vision:'single:vision:1',
    tts:'single:tts:1',
  };
  const costEventIds = {
    image:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    vision:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tts:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
  const paidState = stateStore();
  const confirmedState = ({
    actionId,
    operation,
    model,
    costEventId,
    resultData,
  }) => {
    const record = callRecord({
      run,
      actionId,
      model,
      operation,
      prompt:`fixture:${operation}`,
      costCents:1,
    });
    return {
      actionId,
      operation,
      state:'confirmed',
      agentId:run.agentId,
      companyId:run.companyId,
      projectId:run.projectId,
      runId:run.runId,
      costEventId,
      resultData:{
        model,
        ...resultData,
        callRecord:record,
        costCommit:{
          status:'confirmed',
          costEventId,
          costEvent:record.costEvent,
        },
      },
    };
  };
  const states = {
    image:confirmedState({
      actionId:actionRefs.image,
      operation:'image_generate',
      model:'step-image-edit-2',
      costEventId:costEventIds.image,
      resultData:{ relativePath:imagePath, checksum:imageChecksum },
    }),
    vision:confirmedState({
      actionId:actionRefs.vision,
      operation:'vision',
      model:'step-3.7-flash',
      costEventId:costEventIds.vision,
      resultData:{
        sourcePath:imagePath,
        sourceChecksum:imageChecksum,
        observation:'{"safe":true}',
      },
    }),
    tts:confirmedState({
      actionId:actionRefs.tts,
      operation:'tts',
      model:'stepaudio-2.5-tts',
      costEventId:costEventIds.tts,
      resultData:{ relativePath:narrationPath, checksum:narrationChecksum },
    }),
  };
  for (const [kind, actionId] of Object.entries(actionRefs)) {
    await paidState.set(paidActionStateKey(run.projectId, actionId), states[kind]);
  }
  const ctx = {
    state:paidState,
    localFolders:{
      status:async () => ({ healthy:true, writable:true, realPath:root }),
    },
  };
  const lineage = {
    schemaVersion:1,
    contentVersionId:'single-content-v1',
    sourceTaskId:'single-content-task',
    generatedBy:'reviewer',
    createdAt:'2026-07-31T00:00:00.000Z',
    parents:[],
  };
  const parameters = {
    outputDir:'packages/single-content-v1',
    providerActionRefs:actionRefs,
    videos,
    copies:{
      douyin:{ title:'抖音标题', body:'抖音正文', tags:['AI Agent'] },
      xiaohongshu:{ title:'小红书标题', body:'小红书正文', tags:['AI工具'] },
    },
    coverSourcePath:imagePath,
    sources:{
      sources:[
        { ref:'source-1', kind:'official_document' },
        { ref:'source-2', kind:'project_evidence' },
      ],
      thirdPartyMedia:[],
      aiGeneratedMedia:[{
        ref:imagePath,
        sourceChecksum:imageChecksum,
        model:'step-image-edit-2',
      }],
      narration:{
        provider:'StepFun',
        model:'stepaudio-2.5-tts',
        checksum:narrationChecksum,
        ref:narrationPath,
      },
    },
    review:{
      schemaVersion:1,
      passed:true,
      failures:[],
      checks:{ subtitleLayout:{ passed:true } },
    },
    lineage,
  };
  const result = await writeM5ArtifactPackage(ctx, parameters, run);
  assert.equal(result.data.providerBinding.visionActionId, actionRefs.vision);
  const sources = JSON.parse(await fs.readFile(
    path.join(root, 'packages/single-content-v1/sources.json'),
    'utf8',
  ));
  assert.equal(sources.aiGeneratedMedia[0].sourceTaskId, actionRefs.image);
  assert.equal(sources.aiGeneratedMedia[0].vision.sourceTaskId, actionRefs.vision);
  assert.equal(sources.narration.sourceTaskId, actionRefs.tts);
  const validation = await validateArtifactLineage(
    ctx,
    { manifestPath:result.data.manifestPath },
    run,
  );
  assert.equal(validation.data.passed, true, validation.data.errors.join(' '));

  await paidState.set(
    paidActionStateKey(run.projectId, actionRefs.vision),
    { ...states.vision, state:'cost_event_pending' },
  );
  await assert.rejects(
    writeM5ArtifactPackage(ctx, {
      ...parameters,
      outputDir:'packages/pending-vision',
    }, run),
    { code:'provider_action_unconfirmed' },
  );
});

test('固定产物Provider绑定拒绝半组参数和未确认费用action', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-provider-binding-invalid-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const ctx = {
    localFolders:{
      status:async () => ({ healthy:true, writable:true, realPath:root }),
    },
  };
  await assert.rejects(
    writeM5ArtifactPackage(ctx, {
      outputDir:'packages/invalid',
      providerLedgerPath:'provider/ledger.json',
    }, run),
    { code:'provider_lineage_binding_invalid' },
  );
});

test('固定产物门禁拒绝空文案、版权账本缺失、审核失败和血缘不一致', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-artifacts-invalid-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await writeArtifactFixture(root, {
    'douyin.copy.json':{ title:'', body:'', tags:[] },
    'sources.json':{ sources:[], thirdPartyMedia:null, aiGeneratedMedia:[] },
    'review.json':{
      schemaVersion:1,
      passed:false,
      failures:['字幕越界'],
      checks:{ subtitleLayout:{ passed:false } }
    },
    'lineage.json':{
      schemaVersion:1,
      contentVersionId:'different-version',
      sourceTaskId:'task-v1',
      generatedBy:'content-creator',
      createdAt:new Date().toISOString(),
      parents:[]
    }
  });
  const result = await validateArtifactLineage({
    localFolders:{ status:async () => ({ healthy:true, realPath:root }) }
  }, { manifestPath:'artifact-manifest.tson' }, run);
  assert.equal(result.data.passed, false);
  assert.match(result.data.errors.join('\n'), /douyin.copy.json/);
  assert.match(result.data.errors.join('\n'), /sources.json/);
  assert.match(result.data.errors.join('\n'), /review.json/);
  assert.match(result.data.errors.join('\n'), /lineage.json/);
});

test('StepFun生图模拟调用只写受控目录并返回费用草稿和指标', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const metrics = [];
  let httpCalls = 0;
  let budgetChecks = 0;
  let requestBody = null;
  const paidState = stateStore();
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(() => { budgetChecks += 1; }),
    ctx:{
      config:{ get:async () => ({
        stepfunSecretRef,
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates
      }) },
      secrets:{ resolve:async (receivedRef) => {
        assert.deepEqual(receivedRef, stepfunSecretRef);
        return 'test-secret-not-real';
      } },
      http:{ fetch:async (_url, options) => {
        httpCalls += 1;
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
        data:[{ b64_json:validPngBytes('fake-png').toString('base64') }]
        }), { status:200, headers:{ 'content-type':'application/json' } });
      } },
      state:paidState,
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      metrics:{ write:async (...args) => metrics.push(args) },
      logger:{ warn:() => {} }
    }
  });
  const result = await tools.image({
    actionId:'action:image:cover:7',
    prompt:'竖屏AI Agent示意图',
    outputPath:'generated/cover.png',
    seed:7
  }, run);
  assert.deepEqual(
    await fs.readFile(path.join(root, 'generated/cover.png')),
    validPngBytes('fake-png'),
  );
  assert.equal(requestBody.size, '1360x768');
  assert.equal(result.data.callRecord.costEvent.costCents, 3);
  assert.equal(result.data.callRecord.seed, 7);
  assert.equal(result.data.costReporting, 'metric_written');
  assert.equal(result.data.nextStageAllowed, false);
  assert.equal(result.data.costCommit.status, 'pending_core_cost_event');
  assert.equal(metrics.length, 1);
  assert.doesNotMatch(JSON.stringify({ result, metrics, state:paidState.snapshot() }), /test-secret-not-real/);
  const pending = await captureRejection(tools.image({
    actionId:'action:image:cover:7',
    prompt:'竖屏AI Agent示意图',
    outputPath:'generated/cover.png',
    seed:7
  }, run));
  assert.equal(pending.code, 'cost_event_pending');
  assert.equal(pending.data.costCommit.status, 'pending_core_cost_event');
  assert.equal(httpCalls, 1);

  const claim = await tools.claimCostEvent({
    actionId:'action:image:cover:7'
  }, run);
  assert.equal(claim.data.costCommit.status, 'submitting_core_cost_event');
  assert.match(claim.data.costCommit.submissionId, /^[0-9a-f-]{36}$/);

  await assert.rejects(tools.image({
    actionId:'action:image:cover:7',
    prompt:'竖屏AI Agent示意图',
    outputPath:'generated/cover.png',
    seed:7
  }, run), { code:'cost_event_submitting' });
  assert.equal(httpCalls, 1);

  const confirmed = await tools.confirmCostEvent({
    actionId:'action:image:cover:7',
    submissionId:claim.data.costCommit.submissionId,
    costEventId:'55555555-5555-4555-8555-555555555555'
  }, run);
  assert.equal(confirmed.data.costCommit.status, 'confirmed');
  assert.equal(confirmed.data.nextStageAllowed, true);

  const replay = await tools.image({
    actionId:'action:image:cover:7',
    prompt:'竖屏AI Agent示意图',
    outputPath:'generated/cover.png',
    seed:7
  }, run);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.costCommit.status, 'confirmed');
  assert.equal(httpCalls, 1);
  assert.equal(budgetChecks, 1);
});

test('StepFun明确HTTP 429按分池节流重试并记录请求次数', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-rate-limit-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const responses = [429, 429, 200];
  const sleeps = [];
  let httpCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    minRequestIntervalMs:0,
    maxRateLimitRetries:2,
    maxRetryDelayMs:100,
    sleep:async (milliseconds) => { sleeps.push(milliseconds); },
    random:() => 0,
    ctx:{
      config:{ get:async () => ({
        stepfunSecretRef,
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates,
      }) },
      secrets:{ resolve:async () => 'test-secret-not-real' },
      http:{ fetch:async () => {
        httpCalls += 1;
        const status = responses.shift();
        return new Response(
          status === 200
            ? JSON.stringify({ data:[{ b64_json:validPngBytes('rate-limited-image').toString('base64') }] })
            : JSON.stringify({ error:'rate_limited' }),
          { status, headers:{ 'content-type':'application/json' } },
        );
      } },
      state:stateStore(),
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      metrics:{ write:async () => {} },
      logger:{ warn:() => {} },
    },
  });
  const result = await tools.image({
    actionId:'action:image:rate-limit:1',
    prompt:'不含文字的流程示意图',
    outputPath:'generated/rate-limit.png',
    seed:1,
  }, run);
  assert.equal(httpCalls, 3);
  assert.equal(result.data.providerAttempts, 3);
  assert.equal(result.data.rateLimitRejections, 2);
  assert.equal(sleeps.length, 2);
  assert.equal(result.data.costCommit.status, 'pending_core_cost_event');
});

test('连续429进入可恢复状态；同参数可续跑，改参数仍拒绝', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-rate-resume-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const responses = [429, 429, 200];
  let httpCalls = 0;
  let budgetChecks = 0;
  const paidState = stateStore();
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(() => { budgetChecks += 1; }),
    minRequestIntervalMs:0,
    maxRateLimitRetries:1,
    maxRetryDelayMs:0,
    sleep:async () => {},
    random:() => 0,
    ctx:{
      config:{ get:async () => ({
        stepfunSecretRef,
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates,
      }) },
      secrets:{ resolve:async () => 'test-secret-not-real' },
      http:{ fetch:async () => {
        httpCalls += 1;
        const status = responses.shift();
        return new Response(
          status === 200
            ? JSON.stringify({ data:[{ b64_json:validPngBytes('resumed-image').toString('base64') }] })
            : JSON.stringify({ error:'rate_limited' }),
          { status, headers:{ 'content-type':'application/json' } },
        );
      } },
      state:paidState,
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      metrics:{ write:async () => {} },
      logger:{ warn:() => {} },
    },
  });
  const params = {
    actionId:'action:image:rate-resume:1',
    prompt:'不含文字的证据链示意图',
    outputPath:'generated/resumed.png',
    seed:2,
  };
  await assert.rejects(tools.image(params, run), { code:'stepfun_rate_limited' });
  assert.equal(paidState.snapshot()[0].state, 'rate_limited');
  await assert.rejects(
    tools.image({ ...params, prompt:'已被修改的提示' }, run),
    { code:'paid_action_context_mismatch' },
  );
  assert.equal(httpCalls, 2);
  const resumed = await tools.image(params, run);
  assert.equal(resumed.data.providerAttempts, 1);
  assert.equal(httpCalls, 3);
  assert.equal(budgetChecks, 2);
});

test('历史429迁移只接受精确action、Run和状态快照且幂等', async () => {
  const actionId = 'action:legacy-rate-limit:exact';
  const existing = {
    actionId,
    operation:'image_generate',
    state:'ambiguous',
    agentId:run.agentId,
    companyId:run.companyId,
    projectId:run.projectId,
    runId:run.runId,
    errorCode:'stepfun_request_failed',
    updatedAt:'2026-07-30T12:28:10.232Z',
  };
  const parameterChecksum = paidParameterChecksum({
    actionId,
    prompt:'固定事故参数',
    outputPath:'provider/exact.png',
  });
  const expected = {
    runId:run.runId,
    errorCode:'stepfun_request_failed',
    stateChecksum:sha256(Buffer.from(stableJsonForTest(existing))),
    parameterChecksum,
  };
  const paidState = stateStore();
  await paidState.set({
    scopeKind:'project',
    scopeId:run.projectId,
    namespace:'paid-actions',
    stateKey:sha256(Buffer.from(actionId)).slice('sha256:'.length),
  }, existing);
  const tools = new StepFunContentTools({
    ctx:{ state:paidState },
    legacyRateLimitActions:{ [actionId]:expected },
  });
  const migrated = await tools.reconcileLegacyRateLimit({ actionId }, run);
  assert.equal(migrated.data.state, 'rate_limited');
  assert.equal(migrated.data.providerCalls, 0);
  assert.equal(paidState.snapshot()[0].httpStatus, 429);
  assert.equal(paidState.snapshot()[0].parameterChecksum, parameterChecksum);
  const replay = await tools.reconcileLegacyRateLimit({ actionId }, run);
  assert.equal(replay.data.replayed, true);
  await assert.rejects(
    tools.reconcileLegacyRateLimit(
      { actionId },
      { ...run, runId:'77777777-7777-4777-8777-777777777777' },
    ),
    { code:'legacy_rate_limit_scope_denied' },
  );
});

test('StepFun图片编辑使用官方multipart接口并记录输入输出血缘', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-edit-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const input = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fixture')
  ]);
  await fs.writeFile(path.join(root, 'input.png'), input);
  let request = null;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    minRequestIntervalMs:0,
    ctx:{
      config:{ get:async () => ({
        stepfunSecretRef,
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates
      }) },
      secrets:{ resolve:async () => 'test-secret-not-real' },
      http:{ fetch:async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({
          data:[{ b64_json:validPngBytes('edited-png').toString('base64') }]
        }), { status:200, headers:{ 'content-type':'application/json' } });
      } },
      state:stateStore(),
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      metrics:{ write:async () => {} },
      logger:{ warn:() => {} }
    }
  });

  const result = await tools.imageEdit({
    actionId:'action:image-edit:cover:1',
    inputPath:'input.png',
    prompt:'保留主体，改成竖屏海报',
    outputPath:'edited/output.png',
    seed:11,
    textMode:true
  }, run);

  assert.equal(request.url, 'https://api.stepfun.com/v1/images/edits');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, 'Bearer test-secret-not-real');
  assert.equal(Object.hasOwn(request.options.headers, 'content-type'), false);
  assert.equal(request.options.body.get('model'), 'step-image-edit-2');
  assert.equal(request.options.body.get('prompt'), '保留主体，改成竖屏海报');
  assert.equal(request.options.body.get('seed'), '11');
  assert.equal(request.options.body.get('text_mode'), 'true');
  assert.equal(request.options.body.get('image').type, 'image/png');
  assert.deepEqual(
    await fs.readFile(path.join(root, 'edited/output.png')),
    validPngBytes('edited-png'),
  );
  assert.equal(result.data.callRecord.operation, 'image_edit');
  assert.equal(result.data.callRecord.inputs[0].checksum, sha256(input));
  assert.equal(result.data.callRecord.outputs[0].relativePath, 'edited/output.png');
  assert.equal(result.data.costCommit.status, 'pending_core_cost_event');
});

test('StepFun图片编辑在外发前拒绝伪造MIME和超过12MB的输入', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-edit-invalid-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.writeFile(path.join(root, 'fake.png'), 'not-a-png');
  await fs.writeFile(path.join(root, 'large.png'), Buffer.alloc(12 * 1024 * 1024 + 1, 0x89));
  let httpCalls = 0;
  const tools = new StepFunContentTools({
    ctx:{
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      http:{ fetch:async () => {
        httpCalls += 1;
        throw new Error('不应外发');
      } }
    }
  });
  const base = {
    actionId:'action:image-edit:invalid',
    prompt:'编辑',
    outputPath:'output.png'
  };
  await assert.rejects(tools.imageEdit({ ...base, inputPath:'fake.png' }, run), { code:'invalid_image_mime' });
  await assert.rejects(tools.imageEdit({ ...base, inputPath:'large.png' }, run), { code:'image_too_large' });
  assert.equal(httpCalls, 0);
});

test('StepFun视觉在预算、Secret和Provider前拒绝把非图片文件伪装外发', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-vision-invalid-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.writeFile(path.join(root, 'internal.txt'), 'token=must-not-leave-workspace');
  let budgetChecks = 0;
  let secretReads = 0;
  let providerCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(() => { budgetChecks += 1; }),
    ctx:{
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      config:{ get:async () => {
        throw new Error('非图片输入不应读取配置');
      } },
      secrets:{ resolve:async () => {
        secretReads += 1;
        throw new Error('非图片输入不应读取Secret');
      } },
      http:{ fetch:async () => {
        providerCalls += 1;
        throw new Error('非图片输入不应外发');
      } },
    },
  });

  await assert.rejects(tools.vision({
    actionId:'action:vision:non-image',
    relativePath:'internal.txt',
    prompt:'读取画面',
  }, run), { code:'invalid_image_mime' });
  assert.deepEqual({ budgetChecks, secretReads, providerCalls }, {
    budgetChecks:0,
    secretReads:0,
    providerCalls:0,
  });
});

test('StepFun Provider伪图片、伪MP3和错误扩展名均不写入工作区', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-provider-invalid-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const paidState = stateStore();
  let providerCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    minRequestIntervalMs:0,
    ctx:{
      config:{ get:async () => ({
        stepfunSecretRef,
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates,
      }) },
      secrets:{ resolve:async () => 'test-secret-not-real' },
      http:{ fetch:async (url) => {
        providerCalls += 1;
        return url.endsWith('/audio/speech')
          ? new Response(Buffer.from('not-an-mp3'), { status:200 })
          : new Response(JSON.stringify({
            data:[{ b64_json:Buffer.from('not-an-image').toString('base64') }],
          }), { status:200, headers:{ 'content-type':'application/json' } });
      } },
      state:paidState,
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      metrics:{ write:async () => {} },
      logger:{ warn:() => {} },
    },
  });

  await assert.rejects(tools.image({
    actionId:'action:image:invalid-provider',
    prompt:'生成图片',
    outputPath:'generated.png',
  }, run), { code:'stepfun_image_invalid' });
  await assert.rejects(tools.tts({
    actionId:'action:tts:invalid-provider',
    text:'生成旁白',
    voice:'official-test-voice',
    outputPath:'voice.mp3',
  }, run), { code:'stepfun_tts_invalid' });
  await assert.rejects(tools.image({
    actionId:'action:image:bad-extension',
    prompt:'生成图片',
    outputPath:'generated.mp4',
  }, run), { code:'invalid_image_output' });
  await assert.rejects(tools.tts({
    actionId:'action:tts:bad-extension',
    text:'生成旁白',
    voice:'official-test-voice',
    outputPath:'voice.wav',
  }, run), { code:'invalid_tts_output' });
  assert.equal(providerCalls, 2);
  assert.equal(await fs.readdir(root).then((items) => items.length), 0);
});

test('StepFun Secret解析异常不回显底层文本且不会调用Provider', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-stepfun-secret-error-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  let providerCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    ctx:{
      config:{ get:async () => ({
        stepfunSecretRef,
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates,
      }) },
      secrets:{ resolve:async () => {
        throw new Error('Bearer must-not-leak api_key=must-not-leak');
      } },
      http:{ fetch:async () => {
        providerCalls += 1;
        throw new Error('不应调用Provider');
      } },
      state:stateStore(),
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) },
      metrics:{ write:async () => {} },
      logger:{ warn:() => {} },
    },
  });
  const error = await captureRejection(tools.image({
    actionId:'action:image:secret-error',
    prompt:'生成图片',
    outputPath:'generated.png',
  }, run));
  assert.equal(error.code, 'stepfun_secret_resolve_failed');
  assert.doesNotMatch(error.message, /must-not-leak|api_key|Bearer/i);
  assert.equal(providerCalls, 0);
});

test('费用确认必须匹配原始运行、提交租约和Paperclip费用事件', async () => {
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    ctx:{
      state:stateStore()
    }
  });
  await tools.paidAction(
    { actionId:'action:cost:guard:1' },
    run,
    'image_generate',
    3,
    async () => ({
      content:'fixture',
      data:{
        nextStageAllowed:false,
        costCommit:{
          status:'pending_core_cost_event',
          costEvent:callRecord({
            run,
            actionId:'action:cost:guard:1',
            model:'step-image-edit-2',
            operation:'image_generate',
            prompt:'fixture',
            costCents:3
          }).costEvent
        }
      }
    })
  );
  const claim = await tools.claimCostEvent({ actionId:'action:cost:guard:1' }, run);
  await assert.rejects(
    tools.confirmCostEvent({
      actionId:'action:cost:guard:1',
      submissionId:'66666666-6666-4666-8666-666666666666',
      costEventId:'55555555-5555-4555-8555-555555555555'
    }, run),
    { code:'cost_submission_mismatch' }
  );
  await assert.rejects(
    tools.confirmCostEvent({
      actionId:'action:cost:guard:1',
      submissionId:claim.data.costCommit.submissionId,
      costEventId:'55555555-5555-4555-8555-555555555555'
    }, { ...run, runId:'77777777-7777-4777-8777-777777777777' }),
    { code:'cost_run_context_mismatch' }
  );
});

test('付费动作适配层在构造后仍读取当前依赖并保留可覆写状态转换与产物校验', async () => {
  const initialState = stateStore();
  const replacementState = stateStore();
  const initialContext = { state:initialState };
  const initialBudgetChecker = async () => {
    throw new Error('不应使用构造时预算检查器');
  };
  const tools = new StepFunContentTools({
    ctx:initialContext,
    paidBudgetChecker:initialBudgetChecker,
  });
  assert.equal(tools.ctx, initialContext);
  assert.equal(tools.paidBudgetChecker, initialBudgetChecker);
  assert.ok(tools.inflight instanceof Map);
  assert.ok(tools.legacyRateLimitActions);

  let budgetChecks = 0;
  let transitions = 0;
  let confirmedOutputChecks = 0;
  tools.ctx = { state:replacementState };
  tools.paidBudgetChecker = allowPaidBudget(() => { budgetChecks += 1; });
  const defaultTransition = tools.withCostTransition.bind(tools);
  tools.withCostTransition = async (...args) => {
    transitions += 1;
    return defaultTransition(...args);
  };
  tools.assertConfirmedOutput = async () => {
    confirmedOutputChecks += 1;
  };

  const actionId = 'action:dynamic:dependencies';
  await tools.paidAction(
    { actionId },
    run,
    'fixture_operation',
    1,
    async () => ({
      content:'fixture',
      data:{
        nextStageAllowed:false,
        costCommit:{
          status:'pending_core_cost_event',
          costEvent:callRecord({
            run,
            actionId,
            model:'fixture-model',
            operation:'fixture_operation',
            prompt:'fixture',
            costCents:1,
          }).costEvent,
        },
      },
    }),
  );
  assert.equal(budgetChecks, 1);
  assert.equal(initialState.snapshot().length, 0);
  assert.equal(replacementState.snapshot().length, 1);

  const claim = await tools.claimCostEvent({ actionId }, run);
  await tools.confirmCostEvent({
    actionId,
    submissionId:claim.data.costCommit.submissionId,
    costEventId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }, run);
  const replay = await tools.paidAction(
    { actionId },
    { ...run, runId:'77777777-7777-4777-8777-777777777777', status:'running' },
    'fixture_operation',
    1,
    async () => assert.fail('已确认 action 不应再次执行 Provider'),
  );
  assert.equal(replay.data.replayed, true);
  assert.equal(transitions, 2);
  assert.equal(confirmedOutputChecks, 1);
});

test('confirmed付费action允许同岗位新Run校验产物后只读复用', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-confirmed-cross-run-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const relativePath = 'generated/confirmed.png';
  const bytes = Buffer.from('confirmed-output');
  await fs.mkdir(path.join(root, 'generated'), { recursive:true });
  await fs.writeFile(path.join(root, relativePath), bytes);
  const paidState = stateStore();
  let providerCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    ctx:{
      state:paidState,
      localFolders:{ status:async () => ({ healthy:true, realPath:root }) },
    },
  });
  const actionId = 'action:confirmed:cross-run';
  await tools.paidAction(
    { actionId },
    run,
    'image_generate',
    3,
    async () => {
      providerCalls += 1;
      return {
        content:'fixture',
        data:{
          relativePath,
          checksum:sha256(bytes),
          nextStageAllowed:false,
          costCommit:{
            status:'pending_core_cost_event',
            costEvent:callRecord({
              run,
              actionId,
              model:'step-image-edit-2',
              operation:'image_generate',
              prompt:'fixture',
              costCents:3,
            }).costEvent,
          },
        },
      };
    },
  );
  const claim = await tools.claimCostEvent({ actionId }, run);
  await tools.confirmCostEvent({
    actionId,
    submissionId:claim.data.costCommit.submissionId,
    costEventId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }, run);

  const nextRun = {
    ...run,
    runId:'77777777-7777-4777-8777-777777777777',
    status:'running',
  };
  const replay = await tools.paidAction(
    { actionId },
    nextRun,
    'image_generate',
    3,
    async () => {
      providerCalls += 1;
      throw new Error('不应调用Provider');
    },
  );
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.costCommit.status, 'confirmed');
  assert.equal(providerCalls, 1);
  await assert.rejects(
    tools.paidAction(
      { actionId, speed:1.18 },
      nextRun,
      'image_generate',
      3,
      async () => {
        providerCalls += 1;
        throw new Error('参数漂移时不应调用Provider');
      },
    ),
    { code:'paid_action_context_mismatch' },
  );
  assert.equal(providerCalls, 1);
  await assert.rejects(
    tools.paidAction(
      { actionId },
      { ...nextRun, runId:'ffffffff-ffff-4fff-8fff-ffffffffffff', status:'succeeded' },
      'image_generate',
      3,
      async () => {
        providerCalls += 1;
        throw new Error('不应调用Provider');
      },
    ),
    { code:'cost_run_context_mismatch' },
  );

  const confirmedRecord = paidState.snapshot()[0];
  for (const [label, mismatchedRun] of [
    ['agent', { ...nextRun, agentId:'88888888-8888-4888-8888-888888888888' }],
    ['company', { ...nextRun, companyId:'99999999-9999-4999-8999-999999999999' }],
    ['project', { ...nextRun, projectId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
  ]) {
    const isolatedTools = new StepFunContentTools({
      paidBudgetChecker:allowPaidBudget(),
      ctx:{
        state:{ get:async () => structuredClone(confirmedRecord) },
        localFolders:{ status:async () => ({ healthy:true, realPath:root }) },
      },
    });
    await assert.rejects(
      isolatedTools.paidAction(
        { actionId },
        mismatchedRun,
        'image_generate',
        3,
        async () => {
          providerCalls += 1;
          throw new Error('不应调用Provider');
        },
      ),
      { code:'cost_run_context_mismatch' },
      label,
    );
  }
  assert.equal(providerCalls, 1);
});

test('confirmed付费action在产物哈希篡改时拒绝回放且不调用Provider', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-confirmed-tamper-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const output = path.join(root, 'voice.mp3');
  const bytes = Buffer.from('valid-audio-fixture');
  await fs.writeFile(output, bytes);
  const paidState = stateStore();
  let providerCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    ctx:{
      state:paidState,
      localFolders:{ status:async () => ({ healthy:true, realPath:root }) },
    },
  });
  const actionId = 'action:confirmed:tamper';
  await tools.paidAction(
    { actionId },
    run,
    'tts',
    1,
    async () => {
      providerCalls += 1;
      return {
        content:'fixture',
        data:{
          relativePath:'voice.mp3',
          checksum:sha256(bytes),
          nextStageAllowed:false,
          costCommit:{
            status:'pending_core_cost_event',
            costEvent:callRecord({
              run,
              actionId,
              model:'stepaudio-2.5-tts',
              operation:'tts',
              prompt:'fixture',
              costCents:1,
            }).costEvent,
          },
        },
      };
    },
  );
  const claim = await tools.claimCostEvent({ actionId }, run);
  await tools.confirmCostEvent({
    actionId,
    submissionId:claim.data.costCommit.submissionId,
    costEventId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }, run);
  await fs.writeFile(output, 'tampered');

  await assert.rejects(
    tools.paidAction(
      { actionId },
      { ...run, runId:'77777777-7777-4777-8777-777777777777', status:'running' },
      'tts',
      1,
      async () => {
        providerCalls += 1;
        throw new Error('不应调用Provider');
      },
    ),
    { code:'paid_action_artifact_mismatch' },
  );
  assert.equal(providerCalls, 1);
});

test('confirmed视觉action在输入图片篡改后拒绝跨Run回放且不调用Provider', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-confirmed-vision-tamper-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const sourcePath = 'generated/candidate.png';
  const sourceBytes = Buffer.from('original-image-fixture');
  await fs.mkdir(path.join(root, 'generated'), { recursive:true });
  await fs.writeFile(path.join(root, sourcePath), sourceBytes);
  const paidState = stateStore();
  let providerCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    ctx:{
      state:paidState,
      localFolders:{ status:async () => ({ healthy:true, realPath:root }) },
    },
  });
  const actionId = 'action:vision:confirmed-input';
  await tools.paidAction(
    { actionId },
    run,
    'vision',
    1,
    async () => {
      providerCalls += 1;
      return {
        content:'fixture',
        data:{
          sourcePath,
          sourceChecksum:sha256(sourceBytes),
          observation:'{}',
          nextStageAllowed:false,
          costCommit:{
            status:'pending_core_cost_event',
            costEvent:callRecord({
              run,
              actionId,
              model:'step-3.7-flash',
              operation:'vision',
              prompt:'fixture',
              costCents:1,
            }).costEvent,
          },
        },
      };
    },
  );
  const claim = await tools.claimCostEvent({ actionId }, run);
  await tools.confirmCostEvent({
    actionId,
    submissionId:claim.data.costCommit.submissionId,
    costEventId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  }, run);
  await fs.writeFile(path.join(root, sourcePath), 'tampered-image');

  await assert.rejects(
    tools.paidAction(
      { actionId },
      { ...run, runId:'77777777-7777-4777-8777-777777777777', status:'running' },
      'vision',
      1,
      async () => {
        providerCalls += 1;
        throw new Error('不应调用Provider');
      },
    ),
    { code:'paid_action_artifact_mismatch' },
  );
  assert.equal(providerCalls, 1);
});

test('pending、submitting和ambiguous付费action仍严格绑定原Run', async () => {
  const paidState = stateStore();
  let providerCalls = 0;
  const tools = new StepFunContentTools({
    paidBudgetChecker:allowPaidBudget(),
    ctx:{ state:paidState },
  });
  const pendingId = 'action:pending:original-run';
  await tools.paidAction(
    { actionId:pendingId },
    run,
    'vision',
    1,
    async () => {
      providerCalls += 1;
      return {
        content:'fixture',
        data:{
          nextStageAllowed:false,
          costCommit:{
            status:'pending_core_cost_event',
            costEvent:callRecord({
              run,
              actionId:pendingId,
              model:'step-3.7-flash',
              operation:'vision',
              prompt:'fixture',
              costCents:1,
            }).costEvent,
          },
        },
      };
    },
  );
  const nextRun = {
    ...run,
    runId:'77777777-7777-4777-8777-777777777777',
    status:'running',
  };
  await assert.rejects(
    tools.paidAction({ actionId:pendingId }, nextRun, 'vision', 1, async () => {}),
    { code:'cost_run_context_mismatch' },
  );
  await tools.claimCostEvent({ actionId:pendingId }, run);
  await assert.rejects(
    tools.paidAction({ actionId:pendingId }, nextRun, 'vision', 1, async () => {}),
    { code:'cost_run_context_mismatch' },
  );

  const ambiguousId = 'action:ambiguous:original-run';
  await assert.rejects(
    tools.paidAction(
      { actionId:ambiguousId },
      run,
      'vision',
      1,
      async () => {
        providerCalls += 1;
        throw new Error('provider result unknown');
      },
    ),
    /provider result unknown/,
  );
  await assert.rejects(
    tools.paidAction({ actionId:ambiguousId }, nextRun, 'vision', 1, async () => {}),
    { code:'cost_run_context_mismatch' },
  );
  assert.equal(providerCalls, 2);
});

test('TTS只允许负责人登记的官方音色且克隆音色先行拒绝', async () => {
  const tools = new StepFunContentTools({
    ctx:{
      state:stateStore(),
      config:{ get:async () => ({
        stepfunSecretRef,
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates
      }) }
    }
  });
  await assert.rejects(tools.tts({
    actionId:'action:tts:unknown',
    text:'测试',
    voice:'unknown-voice',
    outputPath:'voice.mp3'
  }, run), { code:'tts_voice_not_allowed' });
  await assert.rejects(tools.tts({
    actionId:'action:tts:clone',
    text:'测试',
    voice:'clone:someone',
    outputPath:'voice.mp3'
  }, run), { code:'voice_clone_denied' });
});

test('Paperclip Base64二进制响应无损还原且原生Response保持不变', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0xef, 0xbf, 0xbd, 0x41]);
  const bridged = new Response(bytes.toString('base64'), {
    headers:{ 'x-paperclip-body-encoding':'base64' },
  });
  assert.deepEqual(await paperclipResponseBytes(bridged), bytes);
  assert.deepEqual(await paperclipResponseBytes(new Response(bytes)), bytes);
  await assert.rejects(
    paperclipResponseBytes(new Response('abc', {
      headers:{ 'x-paperclip-body-encoding':'rot13' },
    })),
    { code:'paperclip_body_encoding_invalid' },
  );
});

test('四个StepFun付费工具缺少可信预算检查器时在Secret和Provider前失败关闭', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-budget-guard-missing-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await writeValidPng(path.join(root, 'input.png'));
  let secretReads = 0;
  let providerCalls = 0;
  const paidState = stateStore();
  const tools = new StepFunContentTools({
    ctx:paidToolContext({
      root,
      state:paidState,
      onSecretRead:() => { secretReads += 1; },
      onProviderCall:() => { providerCalls += 1; },
    }),
  });

  for (const [operation, invoke] of paidToolInvocations(tools)) {
    const error = await captureRejection(invoke());
    assert.equal(error.code, 'paid_budget_checker_unavailable', operation);
  }
  assert.equal(secretReads, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(paidState.snapshot(), []);
});

test('四个StepFun付费工具必须取得匹配公司、岗位、Project的原子预算预留', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-budget-guard-denied-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await writeValidPng(path.join(root, 'input.png'));
  const checks = [];
  let secretReads = 0;
  let providerCalls = 0;
  const checker = async (request) => {
    checks.push(structuredClone(request));
    return {
      ...run,
      allowed:false,
    };
  };
  const tools = new StepFunContentTools({
    paidBudgetChecker:checker,
    ctx:paidToolContext({
      root,
      state:stateStore(),
      onSecretRead:() => { secretReads += 1; },
      onProviderCall:() => { providerCalls += 1; },
    }),
  });

  for (const [operation, invoke] of paidToolInvocations(tools)) {
    const error = await captureRejection(invoke());
    assert.equal(error.code, 'paid_budget_insufficient', operation);
  }
  assert.deepEqual(checks.map((item) => item.operation), [
    'vision',
    'image_generate',
    'image_edit',
    'tts',
  ]);
  for (const check of checks) {
    assert.equal(check.companyId, run.companyId);
    assert.equal(check.agentId, run.agentId);
    assert.equal(check.projectId, run.projectId);
    assert.equal(check.runId, run.runId);
    assert.ok(Number.isSafeInteger(check.maximumCostCents) && check.maximumCostCents > 0);
  }
  assert.equal(secretReads, 0);
  assert.equal(providerCalls, 0);
});

test('预算回执缺少任一层级、身份错配或预留不足时均不接触Provider', async () => {
  const baseDecision = {
    ...run,
    allowed:true,
    reservationId:'66666666-6666-4666-8666-666666666666',
    reservedCents:3,
    scopes:{
      company:{ scopeId:run.companyId, allowed:true, remainingCents:10 },
      agent:{ scopeId:run.agentId, allowed:true, remainingCents:10 },
      project:{ scopeId:run.projectId, allowed:true, remainingCents:10 },
    },
  };
  for (const [label, decision, code] of [
    ['公司错配', { ...baseDecision, companyId:'77777777-7777-4777-8777-777777777777' }, 'paid_budget_context_mismatch'],
    ['岗位预算缺失', { ...baseDecision, scopes:{ ...baseDecision.scopes, agent:undefined } }, 'paid_budget_scope_invalid'],
    ['Project余额不足', {
      ...baseDecision,
      scopes:{
        ...baseDecision.scopes,
        project:{ ...baseDecision.scopes.project, remainingCents:2 },
      },
    }, 'paid_budget_scope_invalid'],
    ['原子预留不足', { ...baseDecision, reservedCents:2 }, 'paid_budget_insufficient'],
  ]) {
    let invoked = 0;
    const tools = new StepFunContentTools({
      paidBudgetChecker:async () => decision,
      ctx:{ state:stateStore() },
    });
    const error = await captureRejection(tools.paidAction(
      { actionId:`action:budget:${label.length}` },
      run,
      'image_generate',
      3,
      async () => {
        invoked += 1;
        return { content:'不应执行', data:{} };
      },
    ));
    assert.equal(error.code, code, label);
    assert.equal(invoked, 0, label);
  }
});

test('预算检查器异常文本不会进入工具错误或泄露凭据', async () => {
  const tools = new StepFunContentTools({
    paidBudgetChecker:async () => {
      throw new Error('Bearer should-never-leak api_key=also-secret');
    },
    ctx:{ state:stateStore() },
  });
  const error = await captureRejection(tools.paidAction(
    { actionId:'action:budget:error' },
    run,
    'image_generate',
    3,
    async () => ({ content:'不应执行', data:{} }),
  ));
  assert.equal(error.code, 'paid_budget_check_failed');
  assert.doesNotMatch(error.message, /should-never-leak|also-secret|api_key|Bearer/i);
});

test('工具执行层拒绝旧字符串Secret且不会尝试解析值', async () => {
  let resolveCalls = 0;
  const tools = new StepFunContentTools({
    ctx:{
      config:{ get:async () => ({
        stepfunSecretRef:'legacy-secret-value-must-not-leak',
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:rates
      }) },
      secrets:{ resolve:async () => {
        resolveCalls += 1;
        return 'should-not-resolve';
      } }
    }
  });
  const error = await captureRejection(tools.config());
  assert.equal(error.code, 'stepfun_secret_ref_invalid');
  assert.doesNotMatch(error.message, /legacy-secret-value-must-not-leak/);
  assert.equal(resolveCalls, 0);
});

test('StepFun二进制输出拒绝借助符号链接写出工作区', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-output-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-output-outside-'));
  context.after(() => Promise.all([
    fs.rm(root, { recursive:true, force:true }),
    fs.rm(outside, { recursive:true, force:true })
  ]));
  await fs.symlink(outside, path.join(root, 'generated'));
  const tools = new StepFunContentTools({
    ctx:{
      localFolders:{ status:async () => ({ healthy:true, writable:true, realPath:root }) }
    }
  });
  await assert.rejects(
    tools.writeBinary(run.companyId, 'generated/escape.png', Buffer.from('blocked')),
    { code:'symlink_escape' }
  );
  await assert.rejects(fs.access(path.join(outside, 'escape.png')));
});

function stateStore() {
  const values = new Map();
  const key = (input) => JSON.stringify(input);
  return {
    get:async (input) => structuredClone(values.get(key(input)) ?? null),
    set:async (input, value) => values.set(key(input), structuredClone(value)),
    delete:async (input) => values.delete(key(input)),
    snapshot:() => structuredClone([...values.values()])
  };
}

function stableJsonForTest(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJsonForTest(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function allowPaidBudget(onCheck = () => {}) {
  return async (request) => {
    onCheck(request);
    return {
      companyId:request.companyId,
      agentId:request.agentId,
      projectId:request.projectId,
      runId:request.runId,
      allowed:true,
      reservationId:'66666666-6666-4666-8666-666666666666',
      reservedCents:request.maximumCostCents,
      scopes:{
        company:{ scopeId:request.companyId, allowed:true, remainingCents:10_000 },
        agent:{ scopeId:request.agentId, allowed:true, remainingCents:10_000 },
        project:{ scopeId:request.projectId, allowed:true, remainingCents:10_000 },
      },
    };
  };
}

function paidToolContext({ root, state, onSecretRead, onProviderCall }) {
  return {
    config:{ get:async () => ({
      stepfunSecretRef,
      stepfunBaseUrl:'https://api.stepfun.com/v1',
      officialTtsVoices:['official-test-voice'],
      costRatesCents:rates,
    }) },
    secrets:{ resolve:async () => {
      onSecretRead();
      return 'test-secret-not-real';
    } },
    http:{ fetch:async () => {
      onProviderCall();
      throw new Error('不应外发');
    } },
    state,
    localFolders:{ status:async () => ({
      healthy:true,
      writable:true,
      realPath:root,
    }) },
    metrics:{ write:async () => {} },
    logger:{ warn:() => {} },
  };
}

function paidToolInvocations(tools) {
  return [
    ['vision', () => tools.vision({
      actionId:'action:budget:vision',
      relativePath:'input.png',
      prompt:'识别画面',
    }, run)],
    ['image_generate', () => tools.image({
      actionId:'action:budget:image',
      prompt:'生成封面',
      outputPath:'generated.png',
    }, run)],
    ['image_edit', () => tools.imageEdit({
      actionId:'action:budget:edit',
      inputPath:'input.png',
      prompt:'编辑封面',
      outputPath:'edited.png',
    }, run)],
    ['tts', () => tools.tts({
      actionId:'action:budget:tts',
      text:'生成旁白',
      voice:'official-test-voice',
      outputPath:'voice.mp3',
    }, run)],
  ];
}

async function writeValidPng(filePath) {
  await fs.writeFile(filePath, validPngBytes('fixture'));
}

function validPngBytes(label = 'fixture') {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label),
  ]);
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('预期 Promise 拒绝。');
}

async function writeArtifactFixture(root, overrides = {}) {
  const lineage = {
    schemaVersion:1,
    contentVersionId:'content-v1',
    sourceTaskId:'task-v1',
    generatedBy:'content-creator',
    createdAt:new Date().toISOString(),
    parents:[]
  };
  const contents = {
    'master.mp4':Buffer.from('fixture:master.mp4'),
    'douyin.mp4':Buffer.from('fixture:douyin.mp4'),
    'xiaohongshu.mp4':Buffer.from('fixture:xiaohongshu.mp4'),
    'douyin.copy.json':{
      title:'Agent 不只会聊天',
      body:'真实工具结果必须进入下一步。',
      tags:['AI Agent', '工作流']
    },
    'xiaohongshu.copy.json':{
      title:'Agent 执行闭环｜收藏版',
      body:'目标、执行、观察、纠错和恢复。',
      tags:['AI工具', '效率系统']
    },
    'cover.png':Buffer.from('fixture:cover.png'),
    'sources.json':{
      sources:[
        { ref:'source-1', kind:'official_document' },
        { ref:'source-2', kind:'project_evidence' }
      ],
      thirdPartyMedia:[],
      aiGeneratedMedia:[]
    },
    'review.json':{
      schemaVersion:1,
      passed:true,
      failures:[],
      checks:{ subtitleLayout:{ passed:true } }
    },
    'lineage.json':lineage,
    ...overrides
  };
  const files = {};
  for (const [name, value] of Object.entries(contents)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(root, name), bytes);
    files[name] = { path:name, checksum:sha256(bytes) };
  }
  await fs.writeFile(path.join(root, 'artifact-manifest.tson'), JSON.stringify({
    schemaVersion:1,
    files,
    lineage
  }));
}
