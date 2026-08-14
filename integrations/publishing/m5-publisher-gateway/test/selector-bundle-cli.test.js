import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CUA_PLATFORM_ORIGINS,
  CUA_SELECTOR_BUNDLE_SCHEMA,
  selectorBundleChecksum,
} from '../src/index.ts';
import {
  FREEZE_CONFIRMATION,
  PAPERCLIP_SELECTOR_APPROVAL_SNAPSHOT_SCHEMA,
  freezeSelectorBundleCandidate,
  inspectSelectorBundleCandidate,
  parseArguments,
} from '../scripts/manage-cua-selector-bundle.mjs';

const NOW = new Date('2026-07-30T08:00:00.000Z');

async function fixture(context, {
  platform = 'douyin',
  expiresAt = '2026-08-06T00:00:00.000Z',
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'm5-selector-cli-')));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const candidateRoot = path.join(root, 'candidates');
  const frozenRoot = path.join(root, 'frozen');
  await fs.mkdir(candidateRoot, { mode:0o700 });
  const document = {
    schemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:'1.2.0',
    platform,
    origin:CUA_PLATFORM_ORIGINS[platform],
    selectorMap:{
      path:'/fake-creator',
      identity:{
        accountTextPattern:'账号:\\s*([A-Za-z0-9_-]+)',
      },
      actions:{
        upload_media:{ label:'假上传', action:'upload_media' },
        set_title:{ label:'假标题', action:'set_title' },
        set_body:{ label:'假正文', action:'set_body' },
        set_tags:{ label:'假标签', action:'set_tags' },
        submit_publish:{ label:'假发布', action:'submit_publish' },
      },
      result:{
        successText:'发布成功',
        contentIdPattern:'fake-content-[a-z0-9]+',
        evidencePathPrefix:'/content/',
      },
    },
  };
  const candidateName = `${platform}-candidate.json`;
  const candidatePath = path.join(candidateRoot, candidateName);
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await fs.writeFile(candidatePath, bytes, { mode:0o600 });
  const approvalRef = `paperclip:selector-approval:${platform}-1.2.0`;
  const approval = {
    status:'approved',
    source:'paperclip',
    approvalRef,
    platform,
    bundleVersion:document.bundleVersion,
    selectorChecksum:selectorBundleChecksum(document),
    bundleChecksum:`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    expiresAt,
  };
  const snapshotName = 'paperclip-snapshot.json';
  await fs.writeFile(path.join(candidateRoot, snapshotName), `${JSON.stringify({
    schemaVersion:PAPERCLIP_SELECTOR_APPROVAL_SNAPSHOT_SCHEMA,
    source:'paperclip',
    snapshotId:'paperclip:selector-approvals:test',
    capturedAt:'2026-07-30T07:59:00.000Z',
    approvals:[approval],
  }, null, 2)}\n`, { mode:0o600 });
  return {
    candidateRoot,
    frozenRoot,
    candidateName,
    snapshotName,
    approvalRef,
    document,
    approval,
  };
}

test('inspect 只读输出规范哈希和状态，不泄露路径或 selector 细节', async (context) => {
  const input = await fixture(context);

  const result = await inspectSelectorBundleCandidate({
    ...input,
    approvalSnapshot:input.snapshotName,
    clock:() => new Date(NOW),
  });

  assert.deepEqual(result, {
    mode:'inspect',
    readOnly:true,
    schemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:'1.2.0',
    platform:'douyin',
    origin:CUA_PLATFORM_ORIGINS.douyin,
    canonicalChecksum:input.approval.selectorChecksum,
    bundleChecksum:input.approval.bundleChecksum,
    permissions:{
      candidate:'safe',
      approvalSnapshot:'safe',
      frozenMode:'0444',
    },
    approval:{
      snapshotId:'paperclip:selector-approvals:test',
      approvalRef:input.approvalRef,
      status:'approved',
      expiresAt:input.approval.expiresAt,
      expired:false,
    },
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /fake-creator|假上传|selectorMap|candidateRoot|frozenRoot/);
  await assert.rejects(fs.access(input.frozenRoot), { code:'ENOENT' });
});

test('freeze 缺少精确确认串时拒绝且不创建冻结目录', async (context) => {
  const input = await fixture(context);

  await assert.rejects(freezeSelectorBundleCandidate({
    ...input,
    approvalSnapshot:input.snapshotName,
    confirmation:'yes',
    clock:() => new Date(NOW),
  }), { code:'selector_bundle_freeze_confirmation_required' });

  await assert.rejects(fs.access(input.frozenRoot), { code:'ENOENT' });
});

test('freeze 原子不可覆盖写入 0444 bundle 和无路径 manifest', async (context) => {
  const input = await fixture(context);

  const result = await freezeSelectorBundleCandidate({
    ...input,
    approvalSnapshot:input.snapshotName,
    confirmation:FREEZE_CONFIRMATION,
    clock:() => new Date(NOW),
  });

  assert.equal(result.mode, 'freeze');
  assert.equal(result.status, 'frozen');
  assert.equal(result.bundleId, 'douyin:1.2.0');
  assert.deepEqual(Object.keys(result).sort(), [
    'bundleChecksum',
    'bundleId',
    'canonicalChecksum',
    'manifestChecksum',
    'mode',
    'status',
  ]);
  const bundlePath = path.join(input.frozenRoot, 'douyin-1.2.0.json');
  const manifestPath = path.join(input.frozenRoot, 'douyin-1.2.0.manifest.json');
  assert.equal((await fs.lstat(bundlePath)).mode & 0o777, 0o444);
  assert.equal((await fs.lstat(manifestPath)).mode & 0o777, 0o444);
  assert.deepEqual(JSON.parse(await fs.readFile(bundlePath, 'utf8')), input.document);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.bundleId, 'douyin:1.2.0');
  assert.equal(manifest.approval.approvalRef, input.approvalRef);
  assert.doesNotMatch(JSON.stringify(manifest), /fake-creator|假上传|selectorMap|candidate|frozen|(?:^|[\"'])\//);

  await assert.rejects(freezeSelectorBundleCandidate({
    ...input,
    approvalSnapshot:input.snapshotName,
    confirmation:FREEZE_CONFIRMATION,
    clock:() => new Date(NOW),
  }), { code:'selector_bundle_version_exists' });
});

for (const scenario of [
  {
    name:'候选路径穿越',
    mutate:async (input) => ({ candidateName:'../outside.json' }),
    code:'selector_bundle_input_path_invalid',
  },
  {
    name:'候选符号链接',
    mutate:async (input) => {
      await fs.rename(
        path.join(input.candidateRoot, input.candidateName),
        path.join(input.candidateRoot, 'target.json'),
      );
      await fs.symlink('target.json', path.join(input.candidateRoot, input.candidateName));
      return {};
    },
    code:'selector_bundle_input_file_invalid',
  },
  {
    name:'候选权限过宽',
    mutate:async (input) => {
      await fs.chmod(path.join(input.candidateRoot, input.candidateName), 0o622);
      return {};
    },
    code:'selector_bundle_input_permissions_invalid',
  },
  {
    name:'批准快照符号链接',
    mutate:async (input) => {
      await fs.rename(
        path.join(input.candidateRoot, input.snapshotName),
        path.join(input.candidateRoot, 'snapshot-target.json'),
      );
      await fs.symlink('snapshot-target.json', path.join(input.candidateRoot, input.snapshotName));
      return {};
    },
    code:'selector_bundle_input_file_invalid',
  },
  {
    name:'批准快照权限过宽',
    mutate:async (input) => {
      await fs.chmod(path.join(input.candidateRoot, input.snapshotName), 0o666);
      return {};
    },
    code:'selector_bundle_input_permissions_invalid',
  },
]) {
  test(`${scenario.name}被 inspect 和 freeze 共用门禁拒绝`, async (context) => {
    const input = await fixture(context);
    const overrides = await scenario.mutate(input);

    await assert.rejects(inspectSelectorBundleCandidate({
      ...input,
      ...overrides,
      approvalSnapshot:input.snapshotName,
      clock:() => new Date(NOW),
    }), { code:scenario.code });
  });
}

test('候选内容漂移或重复版本均不覆盖已冻结文件', async (context) => {
  const input = await fixture(context);
  await fs.writeFile(
    path.join(input.candidateRoot, input.candidateName),
    `${JSON.stringify({
      ...input.document,
      selectorMap:{ ...input.document.selectorMap, path:'/changed-after-approval' },
    })}\n`,
    { mode:0o600 },
  );

  await assert.rejects(inspectSelectorBundleCandidate({
    ...input,
    approvalSnapshot:input.snapshotName,
    clock:() => new Date(NOW),
  }), { code:'cua_selector_bundle_checksum_mismatch' });
  await assert.rejects(fs.access(input.frozenRoot), { code:'ENOENT' });
});

for (const scenario of [
  {
    name:'冻结目录是符号链接',
    prepare:async (input) => {
      const target = `${input.frozenRoot}-target`;
      await fs.mkdir(target, { mode:0o700 });
      await fs.symlink(target, input.frozenRoot);
    },
    code:'selector_bundle_frozen_root_invalid',
  },
  {
    name:'冻结目录权限过宽',
    prepare:async (input) => {
      await fs.mkdir(input.frozenRoot, { mode:0o777 });
      await fs.chmod(input.frozenRoot, 0o777);
    },
    code:'selector_bundle_frozen_root_invalid',
  },
  {
    name:'冻结目标是符号链接',
    prepare:async (input) => {
      await fs.mkdir(input.frozenRoot, { mode:0o700 });
      const target = path.join(input.frozenRoot, 'unrelated.json');
      await fs.writeFile(target, '{}\n', { mode:0o444 });
      await fs.symlink(target, path.join(input.frozenRoot, 'douyin-1.2.0.json'));
    },
    code:'selector_bundle_frozen_target_unsafe',
  },
]) {
  test(`${scenario.name}时 freeze 硬停且不覆盖`, async (context) => {
    const input = await fixture(context);
    await scenario.prepare(input);

    await assert.rejects(freezeSelectorBundleCandidate({
      ...input,
      approvalSnapshot:input.snapshotName,
      confirmation:FREEZE_CONFIRMATION,
      clock:() => new Date(NOW),
    }), { code:scenario.code });
  });
}

test('inspect 显示批准已过期，freeze 仍按真实时钟硬拒绝', async (context) => {
  const input = await fixture(context, { expiresAt:'2026-07-30T07:00:00.000Z' });

  const inspected = await inspectSelectorBundleCandidate({
    ...input,
    approvalSnapshot:input.snapshotName,
    clock:() => new Date(NOW),
  });
  assert.equal(inspected.approval.expired, true);
  assert.equal(inspected.approval.status, 'expired');

  await assert.rejects(freezeSelectorBundleCandidate({
    ...input,
    approvalSnapshot:input.snapshotName,
    confirmation:FREEZE_CONFIRMATION,
    clock:() => new Date(NOW),
  }), { code:'cua_selector_bundle_approval_invalid' });
});

test('CLI 参数默认 inspect，freeze 只接受精确字段', () => {
  assert.deepEqual(parseArguments([
    '--candidate', 'douyin.json',
    '--approval-snapshot', 'snapshot.json',
    '--approval-ref', 'paperclip:selector-approval:1',
  ]), {
    mode:'inspect',
    candidateName:'douyin.json',
    approvalSnapshot:'snapshot.json',
    approvalRef:'paperclip:selector-approval:1',
    confirmation:'',
  });
  assert.throws(() => parseArguments(['--mode', 'delete']), { code:'selector_bundle_mode_invalid' });
  assert.throws(() => parseArguments(['--unknown', 'x']), { code:'selector_bundle_argument_unknown' });
});
