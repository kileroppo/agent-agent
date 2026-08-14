#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CUA_SELECTOR_BUNDLE_SCHEMA,
  loadApprovedSelectorBundle,
  selectorBundleChecksum,
} from '../src/cua-trust-contracts.ts';
import { coded } from '../src/policy.ts';

export const FREEZE_CONFIRMATION = 'I_ACCEPT_FREEZE_M5_CUA_SELECTOR_BUNDLE';
export const PAPERCLIP_SELECTOR_APPROVAL_SNAPSHOT_SCHEMA =
  'agent.army/paperclip-cua-selector-approvals/v1';
export const SELECTOR_BUNDLE_MANIFEST_SCHEMA =
  'agent.army/cua-selector-bundle-manifest/v1';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const REPOSITORY_ROOT = path.resolve(GATEWAY_ROOT, '../../..');
const DEFAULT_CANDIDATE_ROOT = path.join(
  REPOSITORY_ROOT,
  'work/m5-publisher-gateway/selector-candidates',
);
const DEFAULT_FROZEN_ROOT = path.join(
  REPOSITORY_ROOT,
  'work/m5-publisher-gateway/selector-bundles',
);
const MAX_INPUT_BYTES = 256 * 1024;
const PAPERCLIP_REF_PATTERN = /^paperclip:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EXPECTED_DOCUMENT_KEYS = Object.freeze([
  'bundleVersion',
  'origin',
  'platform',
  'schemaVersion',
  'selectorMap',
]);
const EXPECTED_SNAPSHOT_KEYS = Object.freeze([
  'approvals',
  'capturedAt',
  'schemaVersion',
  'snapshotId',
  'source',
]);
const EXPECTED_APPROVAL_KEYS = Object.freeze([
  'approvalRef',
  'bundleChecksum',
  'bundleVersion',
  'expiresAt',
  'platform',
  'selectorChecksum',
  'source',
  'status',
]);
const FORBIDDEN_KEY = /(authorization|cookie|credential|loginstate|password|secret|token)/i;

export async function inspectSelectorBundleCandidate(options = {}) {
  const audited = await auditCandidate({ ...options, allowExpired:true });
  return inspectionResult(audited);
}

export async function freezeSelectorBundleCandidate({
  confirmation = '',
  frozenRoot = DEFAULT_FROZEN_ROOT,
  ...options
} = {}) {
  if (confirmation !== FREEZE_CONFIRMATION) {
    throw coded(
      'selector_bundle_freeze_confirmation_required',
      `冻结 selector bundle 需要显式确认：--confirm ${FREEZE_CONFIRMATION}`,
    );
  }
  const audited = await auditCandidate({ ...options, allowExpired:false });
  const canonicalFrozenRoot = await ensureFrozenRoot(frozenRoot);
  const baseName = `${audited.validated.platform}-${audited.validated.bundleVersion}`;
  const bundleTarget = path.join(canonicalFrozenRoot, `${baseName}.json`);
  const manifestTarget = path.join(canonicalFrozenRoot, `${baseName}.manifest.json`);
  await assertVersionAbsent(bundleTarget, manifestTarget);

  const createdAt = normalizeNow(options.clock).toISOString();
  const manifest = {
    schemaVersion:SELECTOR_BUNDLE_MANIFEST_SCHEMA,
    bundleId:`${audited.validated.platform}:${audited.validated.bundleVersion}`,
    bundleSchemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:audited.validated.bundleVersion,
    platform:audited.validated.platform,
    origin:audited.validated.origin,
    canonicalChecksum:audited.canonicalChecksum,
    bundleChecksum:audited.bundleChecksum,
    fileMode:'0444',
    createdAt,
    approval:{
      source:'paperclip',
      snapshotId:audited.snapshot.snapshotId,
      approvalRef:audited.approval.approvalRef,
      status:'approved',
      expiresAt:audited.approval.expiresAt,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestChecksum = sha256(manifestBytes);

  await commitFrozenPair({
    root:canonicalFrozenRoot,
    bundleTarget,
    manifestTarget,
    bundleBytes:audited.candidateBytes,
    manifestBytes,
  });
  return {
    mode:'freeze',
    status:'frozen',
    bundleId:manifest.bundleId,
    canonicalChecksum:audited.canonicalChecksum,
    bundleChecksum:audited.bundleChecksum,
    manifestChecksum,
  };
}

export function parseArguments(argv) {
  const output = {
    mode:'inspect',
    candidateName:'',
    approvalSnapshot:'',
    approvalRef:'',
    confirmation:'',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!['--mode', '--candidate', '--approval-snapshot', '--approval-ref', '--confirm'].includes(option)) {
      throw coded('selector_bundle_argument_unknown', `未知 selector bundle 参数：${option}`);
    }
    if (!value || value.startsWith('--')) {
      throw coded('selector_bundle_argument_missing', `${option} 缺少值。`);
    }
    index += 1;
    if (option === '--mode') output.mode = value;
    if (option === '--candidate') output.candidateName = value;
    if (option === '--approval-snapshot') output.approvalSnapshot = value;
    if (option === '--approval-ref') output.approvalRef = value;
    if (option === '--confirm') output.confirmation = value;
  }
  output.mode = String(output.mode).trim().toLowerCase();
  if (!['inspect', 'freeze'].includes(output.mode)) {
    throw coded('selector_bundle_mode_invalid', 'selector bundle mode 只允许 inspect 或 freeze。');
  }
  return output;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArguments(argv);
  const common = {
    ...options,
    candidateName:args.candidateName,
    approvalSnapshot:args.approvalSnapshot,
    approvalRef:args.approvalRef,
  };
  const result = args.mode === 'freeze'
    ? await freezeSelectorBundleCandidate({ ...common, confirmation:args.confirmation })
    : await inspectSelectorBundleCandidate(common);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function auditCandidate({
  candidateName,
  approvalSnapshot,
  approvalRef,
  candidateRoot = DEFAULT_CANDIDATE_ROOT,
  clock = () => new Date(),
  allowExpired,
}) {
  const now = normalizeNow(clock);
  const root = await canonicalInputRoot(candidateRoot);
  const candidateFile = await readSafeInput(root, candidateName, '候选 selector bundle');
  const snapshotFile = await readSafeInput(root, approvalSnapshot, 'Paperclip 批准快照');
  const document = parseJson(candidateFile.bytes, 'selector_bundle_candidate_json_invalid');
  assertCandidateDocument(document);
  const snapshot = validateApprovalSnapshot(
    parseJson(snapshotFile.bytes, 'selector_bundle_approval_snapshot_json_invalid'),
    now,
  );
  const matches = snapshot.approvals.filter((item) => item?.approvalRef === approvalRef);
  if (matches.length !== 1) {
    throw coded(
      'selector_bundle_approval_ref_invalid',
      'Paperclip 批准引用不存在或不唯一。',
    );
  }
  const approval = matches[0];
  const expiresAt = Date.parse(approval.expiresAt);
  const expired = expiresAt <= now.getTime();
  const validationClock = expired && allowExpired
    ? () => new Date(expiresAt - 1)
    : () => new Date(now);
  const validated = await loadApprovedSelectorBundle({
    file:candidateFile.file,
    trustedRoot:root,
    approval,
    platform:document.platform,
    clock:validationClock,
  });
  const canonicalChecksum = selectorBundleChecksum(document);
  if (canonicalChecksum !== approval.selectorChecksum) {
    throw coded(
      'cua_selector_bundle_checksum_mismatch',
      '候选 selector bundle 规范哈希与 Paperclip 批准不一致。',
    );
  }
  if (expired && !allowExpired) {
    throw coded(
      'cua_selector_bundle_approval_invalid',
      `${document.platform} selector bundle 的 Paperclip 批准已经过期。`,
    );
  }
  return {
    validated,
    candidateBytes:candidateFile.bytes,
    bundleChecksum:sha256(candidateFile.bytes),
    canonicalChecksum,
    snapshot,
    approval:{
      ...approval,
      expiresAt:new Date(expiresAt).toISOString(),
      expired,
    },
  };
}

function inspectionResult(audited) {
  return {
    mode:'inspect',
    readOnly:true,
    schemaVersion:audited.validated.schemaVersion,
    bundleVersion:audited.validated.bundleVersion,
    platform:audited.validated.platform,
    origin:audited.validated.origin,
    canonicalChecksum:audited.canonicalChecksum,
    bundleChecksum:audited.bundleChecksum,
    permissions:{
      candidate:'safe',
      approvalSnapshot:'safe',
      frozenMode:'0444',
    },
    approval:{
      snapshotId:audited.snapshot.snapshotId,
      approvalRef:audited.approval.approvalRef,
      status:audited.approval.expired ? 'expired' : 'approved',
      expiresAt:audited.approval.expiresAt,
      expired:audited.approval.expired,
    },
  };
}

function validateApprovalSnapshot(value, now) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== PAPERCLIP_SELECTOR_APPROVAL_SNAPSHOT_SCHEMA
    || value.source !== 'paperclip'
    || !sameKeys(value, EXPECTED_SNAPSHOT_KEYS)
    || typeof value.snapshotId !== 'string'
    || !PAPERCLIP_REF_PATTERN.test(value.snapshotId)
    || !isCanonicalTimestamp(value.capturedAt)
    || Date.parse(value.capturedAt) > now.getTime()
    || !Array.isArray(value.approvals)
    || value.approvals.length === 0
    || value.approvals.some((approval) => (
      !approval
      || typeof approval !== 'object'
      || Array.isArray(approval)
      || !sameKeys(approval, EXPECTED_APPROVAL_KEYS)
      || approval.status !== 'approved'
      || approval.source !== 'paperclip'
      || typeof approval.approvalRef !== 'string'
      || !PAPERCLIP_REF_PATTERN.test(approval.approvalRef)
      || !['douyin', 'xiaohongshu'].includes(approval.platform)
      || !/^[1-9]\d*\.\d+\.\d+$/.test(String(approval.bundleVersion || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(approval.selectorChecksum || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(approval.bundleChecksum || ''))
      || !isCanonicalTimestamp(approval.expiresAt)
    ))
    || containsForbiddenKey(value)
  ) {
    throw coded(
      'selector_bundle_approval_snapshot_invalid',
      'selector bundle 必须使用结构完整且已捕获的 Paperclip 批准快照。',
    );
  }
  return {
    snapshotId:value.snapshotId,
    approvals:value.approvals.map((approval) => structuredClone(approval)),
  };
}

function assertCandidateDocument(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !sameKeys(value, EXPECTED_DOCUMENT_KEYS)
    || containsForbiddenKey(value)
  ) {
    throw coded(
      'selector_bundle_candidate_invalid',
      '候选 selector bundle 只能包含版本、平台、origin 和 selectorMap，且不能包含凭据材料。',
    );
  }
}

async function canonicalInputRoot(input) {
  const root = path.resolve(String(input || ''));
  if (!path.isAbsolute(String(input || '')) || root === path.parse(root).root) {
    throw coded('selector_bundle_input_root_invalid', '候选输入根目录必须是明确的非根绝对路径。');
  }
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch {
    throw coded('selector_bundle_input_root_invalid', '候选输入根目录不存在或不可读。');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw coded(
      'selector_bundle_input_root_invalid',
      '候选输入根目录必须是不可由组或其他用户写入的普通目录。',
    );
  }
  if (await fs.realpath(root) !== root) {
    throw coded('selector_bundle_input_root_invalid', '候选输入根目录包含符号链接。');
  }
  return root;
}

async function readSafeInput(root, name, label) {
  if (
    typeof name !== 'string'
    || !name
    || path.isAbsolute(name)
    || name.includes('\0')
  ) {
    throw coded('selector_bundle_input_path_invalid', `${label} 名称无效。`);
  }
  const file = path.resolve(root, name);
  if (!isInside(root, file)) {
    throw coded('selector_bundle_input_path_invalid', `${label} 逃逸候选输入根目录。`);
  }
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch {
    throw coded('selector_bundle_input_file_invalid', `${label} 不存在或不可读。`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw coded('selector_bundle_input_file_invalid', `${label} 必须是普通文件，不能是符号链接。`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw coded('selector_bundle_input_permissions_invalid', `${label} 不能允许组或其他用户写入。`);
  }
  if (stat.size <= 0 || stat.size > MAX_INPUT_BYTES || await fs.realpath(file) !== file) {
    throw coded('selector_bundle_input_file_invalid', `${label} 大小无效或路径包含符号链接。`);
  }
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || !opened.isFile()
      || (opened.mode & 0o022) !== 0
      || opened.size <= 0
      || opened.size > MAX_INPUT_BYTES
    ) {
      throw coded('selector_bundle_input_file_changed', `${label} 在安全核验期间发生变化。`);
    }
    return { file, bytes:await handle.readFile() };
  } catch (error) {
    if (error?.isPublisherError) throw error;
    throw coded('selector_bundle_input_file_invalid', `${label} 无法安全读取。`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureFrozenRoot(input) {
  const root = path.resolve(String(input || ''));
  if (!path.isAbsolute(String(input || '')) || root === path.parse(root).root) {
    throw coded('selector_bundle_frozen_root_invalid', '冻结目录必须是明确的非根绝对路径。');
  }
  const parent = path.dirname(root);
  let canonicalParent;
  try {
    canonicalParent = await fs.realpath(parent);
  } catch {
    throw coded('selector_bundle_frozen_root_invalid', '冻结目录父级不存在或不可读。');
  }
  if (canonicalParent !== parent) {
    throw coded('selector_bundle_frozen_root_invalid', '冻结目录父级包含符号链接。');
  }
  let stat = await lstatOrNull(root);
  if (!stat) {
    await fs.mkdir(root, { mode:0o700 });
    stat = await fs.lstat(root);
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o022) !== 0
    || await fs.realpath(root) !== root
  ) {
    throw coded(
      'selector_bundle_frozen_root_invalid',
      '冻结目录必须是不可由组或其他用户写入的普通目录。',
    );
  }
  return root;
}

async function assertVersionAbsent(bundleTarget, manifestTarget) {
  for (const target of [bundleTarget, manifestTarget]) {
    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw coded('selector_bundle_frozen_target_unsafe', '冻结版本目标不是安全普通文件，拒绝覆盖。');
    }
    throw coded('selector_bundle_version_exists', '同平台同版本 selector bundle 已冻结，拒绝覆盖。');
  }
}

async function commitFrozenPair({
  root,
  bundleTarget,
  manifestTarget,
  bundleBytes,
  manifestBytes,
}) {
  const nonce = crypto.randomUUID();
  const bundleTemp = path.join(root, `.bundle-${nonce}.tmp`);
  const manifestTemp = path.join(root, `.manifest-${nonce}.tmp`);
  const linked = [];
  try {
    await writeFrozenTemporary(bundleTemp, bundleBytes);
    await writeFrozenTemporary(manifestTemp, manifestBytes);
    try {
      await fs.link(manifestTemp, manifestTarget);
      linked.push([manifestTarget, manifestTemp]);
      await fs.link(bundleTemp, bundleTarget);
      linked.push([bundleTarget, bundleTemp]);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw coded('selector_bundle_version_exists', '同平台同版本 selector bundle 已冻结，拒绝覆盖。');
      }
      throw error;
    }
  } catch (error) {
    for (const [target, source] of linked.reverse()) {
      await unlinkIfSameInode(target, source);
    }
    if (error?.isPublisherError) throw error;
    throw coded('selector_bundle_freeze_failed', 'selector bundle 原子冻结失败，未覆盖既有版本。');
  } finally {
    await fs.rm(bundleTemp, { force:true }).catch(() => undefined);
    await fs.rm(manifestTemp, { force:true }).catch(() => undefined);
  }
}

async function writeFrozenTemporary(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o444);
  } finally {
    await handle.close();
  }
}

async function unlinkIfSameInode(target, source) {
  try {
    const [targetStat, sourceStat] = await Promise.all([fs.lstat(target), fs.lstat(source)]);
    if (targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) {
      await fs.unlink(target);
    }
  } catch {
    // Fail closed: never unlink a target whose ownership cannot be proven.
  }
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw coded(code, 'selector bundle 输入不是有效 JSON。');
  }
}

function containsForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  return Object.entries(value).some(([key, item]) => (
    FORBIDDEN_KEY.test(key) || containsForbiddenKey(item)
  ));
}

function sameKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function normalizeNow(clock = () => new Date()) {
  const value = clock();
  const now = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw coded('selector_bundle_clock_invalid', 'selector bundle 审计时钟无效。');
  }
  return now;
}

function isCanonicalTimestamp(value) {
  const date = new Date(value);
  return typeof value === 'string'
    && Number.isFinite(date.getTime())
    && date.toISOString() === value;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${String(error?.code || 'selector_bundle_cli_failed')}: ${String(error?.message || error)}\n`,
    );
    process.exitCode = 1;
  });
}
