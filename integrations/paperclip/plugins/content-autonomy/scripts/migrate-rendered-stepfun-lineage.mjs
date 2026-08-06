#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateArtifactLineage } from '../src/media-tools.js';
import { safeRelativePath, sha256 } from '../src/policy.js';

const REQUIRED_ARTIFACTS = Object.freeze([
  'master.mp4',
  'douyin.mp4',
  'xiaohongshu.mp4',
  'douyin.copy.json',
  'xiaohongshu.copy.json',
  'cover.png',
  'sources.json',
  'review.json',
  'lineage.json',
]);

const args = parseArgs(process.argv.slice(2));
const workspace = await canonicalDirectory(args.workspace);
const ledgerPath = await existingRegularFile(workspace, args.ledger);
const renderRoot = await existingDirectory(workspace, args.renderRoot);
const outputRelative = safeRelativePath(args.outputRoot);
const output = path.resolve(workspace, outputRelative);
assertInside(workspace, output);
await rejectExisting(output);

const ledgerBytes = await fs.readFile(ledgerPath);
const ledger = parseJson(ledgerBytes, 'provider_ledger_invalid');
validateLedger(ledger);
const ledgerChecksum = sha256(ledgerBytes);
const staging = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
await fs.mkdir(staging, { recursive:false, mode:0o700 });

const report = {
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  externalPublished:false,
  providerCalls:0,
  sourceLedger:{
    path:path.relative(workspace, ledgerPath).replaceAll(path.sep, '/'),
    checksum:ledgerChecksum,
    batchVersion:ledger.batchVersion,
    confirmedActions:35,
  },
  themes:[],
};

try {
  for (const [index, theme] of ledger.themes.entries()) {
    const directoryName = `topic-${String(index + 1).padStart(2, '0')}-${theme.id}`;
    const sourceDirectory = await existingDirectory(
      renderRoot,
      directoryName,
      { root:renderRoot },
    );
    const destinationDirectory = path.join(staging, directoryName);
    await fs.mkdir(destinationDirectory, { mode:0o700 });
    for (const fileName of REQUIRED_ARTIFACTS) {
      const source = await existingRegularFile(sourceDirectory, fileName, { root:sourceDirectory });
      await fs.copyFile(source, path.join(destinationDirectory, fileName));
      await fs.chmod(path.join(destinationDirectory, fileName), 0o600);
    }

    const selected = theme.candidates.find((candidate) =>
      candidate.outputPath === theme.selectedPath
      && candidate.outputChecksum === theme.selectedChecksum
    );
    if (!selected) fail('provider_selected_candidate_missing');
    validateConfirmedAction(selected, 'image_generate');
    validateConfirmedAction(selected.vision, 'vision');
    validateConfirmedAction(theme.narration, 'tts');

    const sourcesPath = path.join(destinationDirectory, 'sources.json');
    const sources = parseJson(await fs.readFile(sourcesPath), 'sources_invalid');
    if (!Array.isArray(sources.aiGeneratedMedia) || sources.aiGeneratedMedia.length !== 1) {
      fail('ai_source_count_invalid');
    }
    const generated = sources.aiGeneratedMedia[0];
    if (
      generated.ref !== selected.outputPath
      || generated.sourceChecksum !== selected.outputChecksum
      || generated.model !== selected.model
      || sources.narration?.checksum !== theme.narration.outputChecksum
      || sources.narration?.model !== theme.narration.model
    ) {
      fail('provider_artifact_binding_mismatch');
    }
    Object.assign(generated, {
      sourceTaskId:selected.actionId,
      checksum:selected.outputChecksum,
      promptChecksum:theme.promptChecksum,
      costEventId:selected.costEventId,
      vision:{
        sourceTaskId:selected.vision.actionId,
        model:selected.vision.model,
        costEventId:selected.vision.costEventId,
        observationChecksum:selected.quality?.observationChecksum,
      },
      providerLedgerChecksum:ledgerChecksum,
    });
    Object.assign(sources.narration, {
      sourceTaskId:theme.narration.actionId,
      promptChecksum:theme.narrationChecksum,
      costEventId:theme.narration.costEventId,
      providerLedgerChecksum:ledgerChecksum,
    });
    await writeJsonAtomic(sourcesPath, sources);

    const lineagePath = path.join(destinationDirectory, 'lineage.json');
    const lineage = parseJson(await fs.readFile(lineagePath), 'lineage_invalid');
    lineage.parents = [
      ...(Array.isArray(lineage.parents) ? lineage.parents : []),
      {
        kind:'stepfun_provider_ledger',
        path:report.sourceLedger.path,
        checksum:ledgerChecksum,
        batchVersion:ledger.batchVersion,
        themeId:theme.id,
      },
    ];
    await writeJsonAtomic(lineagePath, lineage);

    const manifestPath = path.join(destinationDirectory, 'artifact-manifest.json');
    const manifest = parseJson(
      await fs.readFile(path.join(sourceDirectory, 'artifact-manifest.json')),
      'artifact_manifest_invalid',
    );
    manifest.lineage = lineage;
    for (const fileName of REQUIRED_ARTIFACTS) {
      const bytes = await fs.readFile(path.join(destinationDirectory, fileName));
      manifest.files[fileName] = {
        path:fileName,
        checksum:sha256(bytes),
        bytes:bytes.length,
      };
    }
    await writeJsonAtomic(manifestPath, manifest);

    const relativeManifest = path.posix.join(
      outputRelative,
      directoryName,
      'artifact-manifest.json',
    );
    const validationRoot = path.dirname(output);
    const validationContext = {
      localFolders:{
        status:async () => ({
          healthy:true,
          writable:true,
          realPath:validationRoot,
        }),
      },
    };
    // Validate while the directory still has its random staging name.
    const stagingRelative = path.posix.join(
      path.basename(staging),
      directoryName,
      'artifact-manifest.json',
    );
    const validation = await validateArtifactLineage(
      validationContext,
      { manifestPath:stagingRelative },
      { companyId:'00000000-0000-4000-8000-000000000000' },
    );
    if (!validation.data.passed) {
      fail(`artifact_validation_failed:${validation.data.errors.join('|')}`);
    }
    report.themes.push({
      themeId:theme.id,
      manifestPath:relativeManifest,
      imageActionId:selected.actionId,
      imageCostEventId:selected.costEventId,
      visionActionId:selected.vision.actionId,
      visionCostEventId:selected.vision.costEventId,
      ttsActionId:theme.narration.actionId,
      ttsCostEventId:theme.narration.costEventId,
      validated:true,
    });
  }
  await writeJsonAtomic(path.join(staging, 'lineage-migration-report.json'), report);
  await fs.rename(staging, output);
} catch (error) {
  await fs.rm(staging, { recursive:true, force:true });
  throw error;
}

process.stdout.write(`${JSON.stringify({
  status:'migrated_and_validated',
  outputRoot:outputRelative,
  themes:report.themes.length,
  providerCalls:0,
  externalPublished:false,
  ledgerChecksum,
}, null, 2)}\n`);

function parseArgs(values) {
  const parsed = {};
  const allowed = new Set(['--workspace', '--ledger', '--render-root', '--output-root']);
  for (let index = 0; index < values.length; index += 2) {
    if (!allowed.has(values[index]) || !values[index + 1]) fail('argument_invalid');
    parsed[values[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = values[index + 1];
  }
  if (!parsed.workspace || !parsed.ledger || !parsed.renderRoot || !parsed.outputRoot) {
    fail('argument_missing');
  }
  if (!path.isAbsolute(parsed.workspace)) fail('workspace_must_be_absolute');
  return parsed;
}

function validateLedger(ledger) {
  if (
    ledger?.schemaVersion !== 'agent.army/stepfun-seven-theme-batch/v1'
    || ledger?.provider !== 'stepfun'
    || ledger?.status !== 'succeeded'
    || ledger?.themeCount !== 7
    || !Array.isArray(ledger?.themes)
    || ledger.themes.length !== 7
    || ledger?.replay?.providerCalls !== 0
    || ledger?.confirmedReplay !== 35
    || ledger?.pendingCostRecovery !== 0
  ) {
    fail('provider_ledger_not_confirmed');
  }
  const actions = ledger.themes.flatMap((theme) => [
    ...theme.candidates.flatMap((candidate) => [candidate, candidate.vision]),
    theme.narration,
  ]);
  if (actions.length !== 35) fail('provider_action_count_invalid');
  for (const action of actions) validateConfirmedAction(action, action?.operation);
}

function validateConfirmedAction(action, operation) {
  if (
    action?.operation !== operation
    || !String(action?.actionId || '')
    || !String(action?.model || '')
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(action?.costEventId || ''))
    || !Number.isInteger(action?.costCents)
    || action.costCents < 0
    || action.replayed !== true
    || action.providerCallReplayed !== false
  ) {
    fail(`provider_action_unconfirmed:${operation}`);
  }
}

async function canonicalDirectory(value, relative = '', options = {}) {
  const candidate = relative ? path.resolve(value, safeRelativePath(relative)) : path.resolve(value);
  const root = options.root || candidate;
  assertInside(root, candidate, { allowRoot:true });
  const stat = await fs.lstat(candidate).catch(() => null);
  const real = await fs.realpath(candidate).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !real || real !== candidate) {
    fail('directory_invalid');
  }
  return real;
}

async function existingDirectory(value, relative, options = {}) {
  return canonicalDirectory(value, relative, options);
}

async function existingRegularFile(value, relative, options = {}) {
  const root = options.root || value;
  const candidate = path.resolve(value, safeRelativePath(relative));
  assertInside(root, candidate);
  const stat = await fs.lstat(candidate).catch(() => null);
  const real = await fs.realpath(candidate).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || !real || real !== candidate) fail('file_invalid');
  return real;
}

function assertInside(root, candidate, options = {}) {
  if (
    candidate !== root
    && !candidate.startsWith(`${root}${path.sep}`)
    || (!options.allowRoot && candidate === root)
  ) {
    fail('path_escape');
  }
}

async function rejectExisting(value) {
  if (await fs.lstat(value).then(() => true).catch(() => false)) fail('output_exists');
  const parent = await fs.realpath(path.dirname(value));
  assertInside(await fs.realpath(args.workspace), parent, { allowRoot:true });
}

function parseJson(bytes, code) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
    return value;
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  }
}

async function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fs.writeFile(temporary, bytes, { mode:0o600, flag:'wx' });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  } finally {
    await fs.rm(temporary, { force:true });
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code.split(':')[0];
  throw error;
}
