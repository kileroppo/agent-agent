/* global Buffer, process */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SEVEN_THEMES } from "../../../integrations/paperclip/plugins/content-autonomy/scripts/run-seven-theme-stepfun-batch.mjs";

const exec = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "../..");
const renderScript = path.join(appRoot, "scripts/render-m5-local-dryrun.mjs");

test("恢复账本按通用35动作不变量完成零渲染preflight", async (context) => {
  const fixture = await createRecoveryLedgerFixture({
    newProviderCalls: 20,
    confirmedReplay: 15,
    pendingCostRecovery: 0,
    lifetimeProviderCalls: 41,
  });
  context.after(() => fs.rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const renderOutput = path.join(
    fixture.workspaceRoot,
    "stepfun-seven-theme-render",
    fixture.batchVersion,
  );
  const legacyRepositoryOutput = path.join(
    repositoryRoot,
    "work/m5-content-autonomy/stepfun-seven-theme-render",
    fixture.batchVersion,
  );
  await fs.rm(renderOutput, { recursive: true, force: true });
  await fs.rm(legacyRepositoryOutput, { recursive: true, force: true });

  const { stdout } = await exec(process.execPath, [
    renderScript,
    "--stepfun-ledger",
    fixture.ledgerPath,
    "--preflight-only",
  ], { cwd: appRoot, timeout: 30_000 });
  const result = JSON.parse(stdout);

  assert.deepEqual(result, {
    status: "preflight_passed",
    batchVersion: fixture.batchVersion,
    themes: 7,
    logicalActions: 35,
    newProviderCalls: 20,
    confirmedReplay: 15,
    pendingCostRecovery: 0,
    lifetimeProviderCalls: 41,
    replayActions: 35,
    replayProviderCalls: 0,
    rendered: false,
    externalPublished: false,
  });
  await assert.rejects(fs.access(renderOutput), { code: "ENOENT" });
  await assert.rejects(fs.access(legacyRepositoryOutput), { code: "ENOENT" });
});

test("preflight接受待确认费用恢复并将其计入35动作不变量", async (context) => {
  const fixture = await createRecoveryLedgerFixture({
    newProviderCalls: 20,
    confirmedReplay: 13,
    pendingCostRecovery: 2,
    lifetimeProviderCalls: 41,
  });
  context.after(() => fs.rm(fixture.workspaceRoot, { recursive: true, force: true }));

  const { stdout } = await exec(process.execPath, [
    renderScript,
    "--stepfun-ledger",
    fixture.ledgerPath,
    "--preflight-only",
  ], { cwd: appRoot, timeout: 30_000 });
  const result = JSON.parse(stdout);

  assert.equal(result.pendingCostRecovery, 2);
  assert.equal(
    result.newProviderCalls + result.confirmedReplay + result.pendingCostRecovery,
    result.logicalActions,
  );
});

test("preflight拒绝把恢复账本的新Provider调用数误当成35", async (context) => {
  const fixture = await createRecoveryLedgerFixture({
    newProviderCalls: 20,
    confirmedReplay: 15,
    pendingCostRecovery: 0,
    lifetimeProviderCalls: 41,
  });
  context.after(() => fs.rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const ledger = JSON.parse(await fs.readFile(fixture.ledgerPath, "utf8"));
  ledger.totalProviderCalls = 35;
  ledger.expectedNewProviderCalls = 35;
  await fs.writeFile(fixture.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    exec(process.execPath, [
      renderScript,
      "--stepfun-ledger",
      fixture.ledgerPath,
      "--preflight-only",
    ], { cwd: appRoot, timeout: 30_000 }),
    /stepfun_batch_ledger_invalid/,
  );
});

test("渲染临时素材只进入workspace且普通失败会清理当前与中断残留目录", async (context) => {
  const fixture = await createRecoveryLedgerFixture({
    newProviderCalls: 20,
    confirmedReplay: 15,
    pendingCostRecovery: 0,
    lifetimeProviderCalls: 41,
  });
  const renderOutput = path.join(
    fixture.workspaceRoot,
    "stepfun-seven-theme-render",
    fixture.batchVersion,
  );
  const legacyRepositoryOutput = path.join(
    repositoryRoot,
    "work/m5-content-autonomy/stepfun-seven-theme-render",
    fixture.batchVersion,
  );
  const stagingParent = path.join(
    fixture.workspaceRoot,
    "render-public-staging",
    fixture.batchVersion,
  );
  const staleRoot = path.join(
    stagingParent,
    `run-999999-${crypto.randomUUID()}`,
  );
  const activeRoot = path.join(
    stagingParent,
    `run-${process.pid}-${crypto.randomUUID()}`,
  );
  const fakeBin = path.join(fixture.workspaceRoot, "fake-bin");
  const ffmpegLog = path.join(fixture.workspaceRoot, "ffmpeg-outputs.jsonl");
  await fs.mkdir(staleRoot, { recursive: true });
  await fs.mkdir(activeRoot, { recursive: true });
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(staleRoot, "orphan"), "stale\n");
  await fs.writeFile(path.join(activeRoot, "owner"), "active\n");
  const canonicalStagingParent = await fs.realpath(stagingParent);
  await fs.writeFile(
    path.join(fakeBin, "ffmpeg"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args.at(-1);
fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify({ output, args }) + "\\n");
if (args.includes("-frames:v")) {
  fs.writeFileSync(output, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  process.exit(0);
}
process.stderr.write("intentional audio normalization failure\\n");
process.exit(9);
`,
    { mode: 0o755 },
  );
  context.after(async () => {
    await fs.rm(renderOutput, { recursive: true, force: true });
    await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    exec(process.execPath, [
      renderScript,
      "--stepfun-ledger",
      fixture.ledgerPath,
    ], {
      cwd: appRoot,
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        FAKE_FFMPEG_LOG: ffmpegLog,
      },
    }),
    /intentional audio normalization failure|exit code 9/,
  );

  const calls = (await fs.readFile(ffmpegLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.filter((call) => call.args.includes("-frames:v")).length, 11);
  assert.ok(calls.every((call) => {
    const relative = path.relative(canonicalStagingParent, call.output);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  }), JSON.stringify(calls.map((call) => call.output)));
  assert.ok(calls.every((call) =>
    !call.output.startsWith(`${path.join(appRoot, "public")}${path.sep}`)));
  assert.deepEqual(await fs.readdir(stagingParent), [path.basename(activeRoot)]);
  assert.equal(await fs.readFile(path.join(activeRoot, "owner"), "utf8"), "active\n");
  await assert.rejects(fs.access(staleRoot), { code: "ENOENT" });
  assert.equal((await fs.lstat(renderOutput)).isDirectory(), true);
  await assert.rejects(fs.access(legacyRepositoryOutput), { code: "ENOENT" });
});

test("StepFun输出目录含软链时失败关闭且不写出workspace", async (context) => {
  const fixture = await createRecoveryLedgerFixture({
    newProviderCalls: 20,
    confirmedReplay: 15,
    pendingCostRecovery: 0,
    lifetimeProviderCalls: 41,
  });
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m5-render-outside-"));
  context.after(async () => {
    await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });
  await fs.symlink(
    outsideRoot,
    path.join(fixture.workspaceRoot, "stepfun-seven-theme-render"),
  );

  await assert.rejects(
    exec(process.execPath, [
      renderScript,
      "--stepfun-ledger",
      fixture.ledgerPath,
    ], { cwd: appRoot, timeout: 30_000 }),
    /render_public_path_invalid/,
  );
  assert.deepEqual(await fs.readdir(outsideRoot), []);
});

async function createRecoveryLedgerFixture({
  newProviderCalls,
  confirmedReplay,
  pendingCostRecovery,
  lifetimeProviderCalls,
}) {
  assert.equal(newProviderCalls + confirmedReplay + pendingCostRecovery, 35);
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m5-render-preflight-"));
  const batchVersion = `pf-${crypto.randomUUID().slice(0, 8)}`;
  const batchRoot = path.join(workspaceRoot, "provider", "7-theme", batchVersion);
  await fs.mkdir(batchRoot, { recursive: true });
  const replayActions = [];
  let actionOrdinal = 0;
  const paidAction = (themeId, operation, outputPath = null, outputChecksum = null) => {
    actionOrdinal += 1;
    const action = {
      actionId: `m5_7theme_fixture_${themeId}_${operation}_${actionOrdinal}`,
      operation,
      model: operation === "tts" ? "stepaudio-2.5-tts" : "step-image-edit-2",
      replayed: actionOrdinal <= confirmedReplay,
      providerCallReplayed:
        actionOrdinal > confirmedReplay
        && actionOrdinal <= confirmedReplay + pendingCostRecovery,
      costCents: 1,
      costEventId: crypto.randomUUID(),
      outputChecksum,
      outputPath,
    };
    replayActions.push({
      actionId: action.actionId,
      operation,
      replayed: true,
    });
    return action;
  };

  const themes = [];
  for (const source of SEVEN_THEMES) {
    const themeRoot = path.join(batchRoot, source.id);
    await fs.mkdir(themeRoot, { recursive: true });
    const candidates = [];
    for (const index of [1, 2]) {
      const relativePath = `provider/7-theme/${batchVersion}/${source.id}/candidate-${index}.png`;
      const bytes = Buffer.from(`fixture-image-${source.id}-${index}`);
      await fs.writeFile(path.join(workspaceRoot, relativePath), bytes);
      const checksum = hash(bytes);
      candidates.push({
        index,
        ...paidAction(source.id, "image_generate", relativePath, checksum),
        quality: {
          score: 90 + index,
          composition: 90,
          visualClarity: 92,
          textFree: true,
          brandSafe: true,
          risks: [],
        },
        vision: paidAction(source.id, "vision"),
      });
    }
    const narrationPath = `provider/7-theme/${batchVersion}/${source.id}/narration.mp3`;
    const narrationBytes = Buffer.from(`fixture-audio-${source.id}`);
    await fs.writeFile(path.join(workspaceRoot, narrationPath), narrationBytes);
    themes.push({
      id: source.id,
      title: source.title,
      promptChecksum: hash(Buffer.from(`prompt-${source.id}`)),
      narrationChecksum: hash(Buffer.from(source.narration)),
      narrationCharacters: [...source.narration].length,
      candidates,
      narration: {
        ...paidAction(source.id, "tts", narrationPath, hash(narrationBytes)),
        audio: {
          durationSeconds: 36,
          codec: "mp3",
          sampleRate: 44_100,
          channels: 2,
        },
      },
      selectedCandidate: 2,
      selectedPath: candidates[1].outputPath,
      selectedChecksum: candidates[1].outputChecksum,
    });
  }
  assert.equal(actionOrdinal, 35);

  const ledger = {
    schemaVersion: "agent.army/stepfun-seven-theme-batch/v1",
    generatedAt: new Date().toISOString(),
    batchVersion,
    ttsTransportRevision: "paperclip-b64-v1",
    provider: "stepfun",
    officialVoice: "cixingnansheng",
    themeCount: 7,
    expectedAssets: { images: 14, narrations: 7, visionObservations: 14 },
    totalProviderCalls: newProviderCalls,
    lifetimeProviderCalls,
    expectedNewProviderCalls: newProviderCalls,
    confirmedReplay,
    pendingCostRecovery,
    execution: {
      maxProviderConcurrency: 4,
      peakProviderConcurrency: 4,
      coreCostCommitConcurrency: 1,
    },
    themes,
    replay: { providerCalls: 0, actions: replayActions },
  };
  const ledgerPath = path.join(batchRoot, "ledger.json");
  await fs.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { workspaceRoot, batchVersion, ledgerPath };
}

function hash(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
