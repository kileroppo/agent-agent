#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublisherRuntime,
  publishIdempotencyKey,
} from '../src/index.ts';

const CONFIRMATION = 'I_ACCEPT_LOCAL_FAKE_MP4_ACCEPTANCE';
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repositoryRoot = path.resolve(packageRoot, '../../..');
const singleSourceRoot = path.join(
  repositoryRoot,
  'work/m5-content-autonomy/stepfun-seven-theme-render/m5v2/topic-01-t01-execution-loop',
);
const sevenDaySourceRoot = path.join(
  repositoryRoot,
  'work/m5-content-autonomy/stepfun-seven-theme-render/m5v2',
);
const defaultOutput = path.join(
  repositoryRoot,
  'work/m5-publisher-gateway/acceptance/fake-mp4-2026-07-30-v4',
);
const reviewChecks = Object.freeze({
  facts:true,
  privacy:true,
  rights:true,
  media:true,
  claims:true,
  grantScope:true,
  duplicate:true,
});
const checkpoints = Object.freeze([
  ['2h', 2],
  ['24h', 24],
  ['72h', 72],
]);

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.confirmation !== CONFIRMATION) {
    fail(
      'fake_mp4_acceptance_confirmation_required',
      `本地双假平台 MP4 验收需要 --confirm ${CONFIRMATION}。`,
    );
  }
  const outputDirectory = await prepareOutputDirectory(args.output);
  const ledgerPath = path.join(outputDirectory, 'publisher-ledger.json');
  const evidencePath = path.join(outputDirectory, 'acceptance-evidence.json');
  const artifacts = await loadApprovedArtifacts(args.sourceSet);
  // 2026-07-30 16:00 in Asia/Shanghai. The gateway deliberately validates
  // scheduledDate against the execution date in that timezone.
  let current = new Date('2026-07-30T08:00:00.000Z');
  const controlEvents = [];
  const paperclipControl = createPaperclipControl(controlEvents);

  let runtime = createRuntime({ ledgerPath, paperclipControl, clock:() => new Date(current) });
  const publishResults = [];
  for (const artifact of artifacts) {
    current = new Date(artifact.simulatedPublishedAt);
    runtime.connectors[artifact.platform].scenarios.push({
      type:'success',
      publishedAt:current.toISOString(),
    });
    const request = buildRequest(artifact);
    publishResults.push(await runtime.publish(request));
  }

  const metricRuns = [];
  for (const published of publishResults) {
    for (const [checkpoint, hours] of checkpoints) {
      current = new Date(Date.parse(published.receipt.publishedAt) + hours * 3_600_000);
      runtime = createRuntime({ ledgerPath, paperclipControl, clock:() => new Date(current) });
      const result = await runtime.collectMetricSnapshot({
        campaignId:published.receipt.campaignId,
        receiptId:published.receipt.receiptId,
        collectionKey:`${published.receipt.receiptId}:${checkpoint}`,
        collectedAt:current.toISOString(),
      });
      metricRuns.push({
        checkpoint,
        receiptId:published.receipt.receiptId,
        replayed:result.replayed,
        snapshotId:result.snapshot.snapshotId,
      });
    }
  }

  const replayReceipt = publishResults[0].receipt;
  current = new Date(Date.parse(replayReceipt.publishedAt) + 72 * 3_600_000);
  runtime = createRuntime({ ledgerPath, paperclipControl, clock:() => new Date(current) });
  const replay = await runtime.collectMetricSnapshot({
    campaignId:replayReceipt.campaignId,
    receiptId:replayReceipt.receiptId,
    collectionKey:`${replayReceipt.receiptId}:72h`,
    collectedAt:current.toISOString(),
  });
  if (!replay.replayed) fail('fake_metric_replay_missing', '72h 指标跨重启没有命中持久化重放。');

  const receipts = [];
  for (const published of publishResults) {
    const receipt = await runtime.getReceipt(published.receipt.receiptId);
    if (!receipt || receipt.metricSnapshots.length !== 3) {
      fail('fake_receipt_incomplete', '假平台回执缺少固定 2h、24h、72h 指标快照。');
    }
    receipts.push({
      receiptId:receipt.receiptId,
      platform:receipt.platform,
      contentVersionId:receipt.contentVersionId,
      contentChecksum:receipt.contentChecksum,
      externalContentId:receipt.externalContentId,
      evidence:receipt.evidence,
      connectorMode:receipt.connectorMode,
      publishedAt:receipt.publishedAt,
      metricSnapshots:receipt.metricSnapshots.map((snapshot) => ({
        snapshotId:snapshot.snapshotId,
        collectionKey:snapshot.collectionKey,
        collectedAt:snapshot.collectedAt,
        metrics:snapshot.metrics,
      })),
    });
  }
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  const wallClockEvidenceWrittenAt = new Date().toISOString();
  const evidence = {
    schemaVersion:args.sourceSet === 'seven-day'
      ? 'agent.army/fake-seven-day-publisher-acceptance/v1'
      : 'agent.army/fake-mp4-publisher-acceptance/v2',
    mode:'local-fake-platforms',
    sourceSet:args.sourceSet,
    campaignId:'campaign-m5-fake-mp4-acceptance',
    completedAt:wallClockEvidenceWrittenAt,
    realPlatformTouched:false,
    externalPublished:false,
    timeline:{
      kind:'simulated_checkpoints',
      wallClockEvidenceWrittenAt,
      simulatedPublishedAt:receipts[0]?.publishedAt || null,
      checkpoints:['2h', '24h', '72h'],
      actualPlatformElapsedTime:false,
    },
    sourceArtifacts:artifacts.map((artifact) => ({
      platform:artifact.platform,
      topicKey:artifact.topicKey,
      scheduledDate:artifact.scheduledDate,
      basename:path.basename(artifact.mediaPath),
      checksum:artifact.checksum,
      bytes:artifact.bytes,
      reviewPassed:true,
    })),
    receipts,
    restartRecovery:{
      runtimeConstructionCount:2 + publishResults.length * checkpoints.length,
      checkpoints:['2h', '24h', '72h'],
      replaySnapshotId:replay.snapshot.snapshotId,
      replayed:true,
    },
    costRecords:Object.values(ledger.costRecords || {}).map((record) => ({
      costRecordId:record.costRecordId,
      connectorMode:record.connectorMode,
      operation:record.operation,
      amountUsd:record.amountUsd,
      state:record.state,
    })),
    control:{
      assertionCount:controlEvents.filter((item) => item.kind === 'assert').length,
      pauseCount:controlEvents.filter((item) => item.kind === 'pause').length,
    },
    totals:{
      publishedReceipts:receipts.length,
      metricSnapshots:receipts.reduce((sum, receipt) => sum + receipt.metricSnapshots.length, 0),
      realPlatformCalls:0,
      totalCostUsd:Object.values(ledger.costRecords || {})
        .reduce((sum, record) => sum + Number(record.amountUsd || 0), 0),
    },
  };
  await writePrivateExclusive(evidencePath, evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

function createRuntime({ ledgerPath, paperclipControl, clock }) {
  return createPublisherRuntime({
    mode:'fake',
    workspaceRoot:repositoryRoot,
    ledgerPath,
    paperclipControl,
    clock,
  });
}

function buildRequest(artifact) {
  const grant = campaignGrant();
  const request = {
    campaignId:'campaign-m5-fake-mp4-acceptance',
    grant,
    platform:artifact.platform,
    contentVersionId:`m5-local-${artifact.topicKey}-v1-${artifact.platform}`,
    contentChecksum:artifact.checksum,
    scheduledDate:artifact.scheduledDate,
    mediaPath:path.relative(repositoryRoot, artifact.mediaPath),
    title:artifact.copy.title,
    body:artifact.copy.body,
    tags:artifact.copy.tags,
    reviewReport:{ status:'passed', checks:{ ...reviewChecks } },
  };
  request.idempotencyKey = publishIdempotencyKey(request);
  return request;
}

function campaignGrant() {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{
      douyin:'account:fake:douyin',
      xiaohongshu:'account:fake:xiaohongshu',
    },
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-10T00:00:00.000Z',
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:[
      'direct_message',
      'comment',
      'follow',
      'paid_promotion',
      'payment',
      'account_settings',
      'delete_history',
    ],
    budgetCents:625,
  };
}

function createPaperclipControl(events) {
  return {
    async assertPublishAllowed({ campaignId, checkedAt }) {
      events.push({ kind:'assert', campaignId, checkedAt });
      return {
        campaignId,
        grantStatus:'active',
        currentStage:'campaign_active',
        canonicalGrant:campaignGrant(),
      };
    },
    async pauseCampaignAndDisableCron(input) {
      events.push({ kind:'pause', campaignId:input.campaignId, reason:input.reason });
      return {
        campaignId:input.campaignId,
        grantStatus:'paused',
        cronStatus:'disabled',
        controlEventId:'fake-acceptance-pause',
      };
    },
  };
}

async function loadApprovedArtifacts(sourceSet) {
  const sourceDirectories = sourceSet === 'seven-day'
    ? await sevenDaySourceDirectories()
    : [singleSourceRoot];
  const artifacts = [];
  for (let dayIndex = 0; dayIndex < sourceDirectories.length; dayIndex += 1) {
    const sourceRoot = sourceDirectories[dayIndex];
    const topicKey = path.basename(sourceRoot);
    const scheduledDate = addUtcDays('2026-07-30', dayIndex);
    const simulatedPublishedAt = `${scheduledDate}T08:00:00.000Z`;
    const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'artifact-manifest.json'), 'utf8'));
    const review = JSON.parse(await fs.readFile(path.join(sourceRoot, 'review.json'), 'utf8'));
  if (
    review?.checks?.visualAssets?.passed !== true
    || review?.checks?.subtitleLayout?.passed !== true
  ) {
    fail('source_review_failed', '源成片的视觉素材或字幕布局审核未通过。');
  }
    for (const platform of ['douyin', 'xiaohongshu']) {
      if (review?.checks?.[platform]?.passed !== true) {
        fail('source_review_failed', `${topicKey}/${platform} 成片机器审核未通过。`);
      }
      const mediaPath = path.join(sourceRoot, `${platform}.mp4`);
      const bytes = await fs.readFile(mediaPath);
      const checksum = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      if (
        checksum !== manifest?.files?.[`${platform}.mp4`]?.checksum
        || bytes.length !== manifest?.files?.[`${platform}.mp4`]?.bytes
      ) {
        fail('source_artifact_drift', `${topicKey}/${platform} 成片与审核 manifest 不一致。`);
      }
      artifacts.push({
        topicKey,
        platform,
        scheduledDate,
        simulatedPublishedAt,
        mediaPath,
        checksum,
        bytes:bytes.length,
        copy:JSON.parse(await fs.readFile(path.join(sourceRoot, `${platform}.copy.json`), 'utf8')),
      });
    }
  }
  return artifacts;
}

async function sevenDaySourceDirectories() {
  const entries = await fs.readdir(sevenDaySourceRoot, { withFileTypes:true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('topic-'))
    .map((entry) => path.join(sevenDaySourceRoot, entry.name))
    .sort();
  if (directories.length !== 7) {
    fail('source_campaign_incomplete', `7天验收需要精确7个主题目录，当前为${directories.length}个。`);
  }
  return directories;
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function prepareOutputDirectory(value) {
  const resolved = path.resolve(value || defaultOutput);
  const acceptanceRoot = path.join(repositoryRoot, 'work/m5-publisher-gateway/acceptance');
  if (!resolved.startsWith(`${acceptanceRoot}${path.sep}`)) {
    fail('fake_acceptance_output_invalid', '验收输出必须位于受控 acceptance 工作区内。');
  }
  await fs.mkdir(acceptanceRoot, { recursive:true, mode:0o700 });
  const acceptanceStat = await fs.lstat(acceptanceRoot);
  if (!acceptanceStat.isDirectory() || acceptanceStat.isSymbolicLink()) {
    fail('fake_acceptance_output_invalid', '验收根目录不是受控普通目录。');
  }
  await fs.chmod(acceptanceRoot, 0o700);
  try {
    await fs.lstat(resolved);
    fail('fake_acceptance_output_exists', '验收输出目录已存在，拒绝覆盖历史证据。');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(resolved, { recursive:false, mode:0o700 });
  await fs.chmod(resolved, 0o700);
  return resolved;
}

async function writePrivateExclusive(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseArguments(argv) {
  const output = { confirmation:'', output:defaultOutput, sourceSet:'single' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm') output.confirmation = requireValue(argv[++index], value);
    else if (value === '--output') output.output = requireValue(argv[++index], value);
    else if (value === '--source-set') {
      output.sourceSet = requireValue(argv[++index], value);
      if (!['single', 'seven-day'].includes(output.sourceSet)) {
        fail('fake_acceptance_argument_invalid', '--source-set只允许single或seven-day。');
      }
    }
    else fail('fake_acceptance_argument_invalid', `未知参数：${value}`);
  }
  return output;
}

function requireValue(value, flag) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('fake_acceptance_argument_invalid', `${flag} 缺少值。`);
  }
  return value;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

main().catch((error) => {
  process.stderr.write(`${error.code || 'fake_mp4_acceptance_failed'}: ${error.message}\n`);
  process.exitCode = 1;
});
