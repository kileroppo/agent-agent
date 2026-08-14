import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CUA_PLATFORM_ORIGINS,
  CUA_PROFILE_LEASE_SCHEMA,
  CUA_SELECTOR_BUNDLE_SCHEMA,
  buildPlatformCuaSessionPolicy,
  loadApprovedSelectorBundle,
  selectorBundleChecksum,
  validateApprovedProfileLease,
  validateApprovedSelectorBundle,
} from '../src/index.ts';

const NOW = new Date('2026-07-30T08:00:00.000Z');

test('selector bundle 必须由未过期 Paperclip 批准和规范哈希共同绑定', () => {
  const bundle = approvedBundle();
  const validated = validateApprovedSelectorBundle(bundle, {
    platform:'douyin',
    clock:() => new Date(NOW),
  });

  assert.equal(validated.bundleVersion, '1.2.0');
  assert.equal(validated.approval.selectorChecksum, selectorBundleChecksum(bundle));
  assert.equal(validated.selectorMap.actions.submit_publish.label, '发布');
  assert.equal(Object.isFrozen(validated.selectorMap), true);

  assert.throws(
    () => validateApprovedSelectorBundle({
      ...bundle,
      approval:{ ...bundle.approval, selectorChecksum:'sha256:'.padEnd(71, '0') },
    }, {
      platform:'douyin',
      clock:() => new Date(NOW),
    }),
    { code:'cua_selector_bundle_approval_invalid' },
  );
  assert.throws(
    () => validateApprovedSelectorBundle({
      ...bundle,
      approval:{ ...bundle.approval, expiresAt:NOW.toISOString() },
    }, {
      platform:'douyin',
      clock:() => new Date(NOW),
    }),
    { code:'cua_selector_bundle_approval_invalid' },
  );
});

test('selector bundle 缺少账号核验、固定五步动作或强回执定位任一字段都拒绝', () => {
  for (const [field, mutate] of [
    ['identity.accountTextPattern', (bundle) => { delete bundle.selectorMap.identity.accountTextPattern; }],
    ['actions.upload_media.label', (bundle) => { delete bundle.selectorMap.actions.upload_media.label; }],
    ['actions.set_title.label', (bundle) => { delete bundle.selectorMap.actions.set_title.label; }],
    ['actions.set_body.label', (bundle) => { delete bundle.selectorMap.actions.set_body.label; }],
    ['actions.set_tags.label', (bundle) => { delete bundle.selectorMap.actions.set_tags.label; }],
    ['actions.submit_publish.label', (bundle) => { delete bundle.selectorMap.actions.submit_publish.label; }],
    ['result.successText', (bundle) => { delete bundle.selectorMap.result.successText; }],
    ['result.contentIdPattern', (bundle) => { delete bundle.selectorMap.result.contentIdPattern; }],
    ['result.evidencePathPrefix', (bundle) => { delete bundle.selectorMap.result.evidencePathPrefix; }],
  ]) {
    const bundle = approvedBundle();
    mutate(bundle);
    bundle.approval.selectorChecksum = selectorBundleChecksum(bundle);

    assert.throws(
      () => validateApprovedSelectorBundle(bundle, {
        platform:'douyin',
        clock:() => new Date(NOW),
      }),
      { code:'cua_selector_bundle_invalid' },
      field,
    );
  }
});

test('笔记管理回读模式必须绑定管理页、就绪文本和平台状态', () => {
  const bundle = approvedBundle('xiaohongshu');
  bundle.selectorMap.result = {
    ...bundle.selectorMap.result,
    mode:'management_detail',
    managementPath:'/new/note-manager',
    managementReadyText:'笔记管理',
    publishedStatusTexts:['审核中', '已发布'],
  };
  bundle.approval.platform = 'xiaohongshu';
  bundle.approval.selectorChecksum = selectorBundleChecksum(bundle);

  const validated = validateApprovedSelectorBundle(bundle, {
    platform:'xiaohongshu',
    clock:() => new Date(NOW),
  });
  assert.equal(validated.selectorMap.result.mode, 'management_detail');

  for (const mutate of [
    (value) => { delete value.selectorMap.result.managementPath; },
    (value) => { value.selectorMap.result.managementPath = '//example.com/escape'; },
    (value) => { delete value.selectorMap.result.managementReadyText; },
    (value) => { value.selectorMap.result.publishedStatusTexts = []; },
  ]) {
    const invalid = structuredClone(bundle);
    mutate(invalid);
    invalid.approval.selectorChecksum = selectorBundleChecksum(invalid);
    assert.throws(
      () => validateApprovedSelectorBundle(invalid, {
        platform:'xiaohongshu',
        clock:() => new Date(NOW),
      }),
      { code:'cua_selector_bundle_invalid' },
    );
  }
});

test('selector bundle 文件拒绝越界、符号链接、宽写权限和批准后漂移', async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'm5-selector-bundle-')));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const bundle = approvedBundle();
  const file = path.join(root, 'douyin-v1.2.0.json');
  await fs.writeFile(file, `${JSON.stringify(stripApproval(bundle), null, 2)}\n`, {
    encoding:'utf8',
    mode:0o600,
  });
  const fileBytes = await fs.readFile(file);
  const fileChecksum = `sha256:${crypto.createHash('sha256').update(fileBytes).digest('hex')}`;
  const approval = {
    ...bundle.approval,
    bundleChecksum:fileChecksum,
  };

  const loaded = await loadApprovedSelectorBundle({
    file,
    trustedRoot:root,
    approval,
    platform:'douyin',
    clock:() => new Date(NOW),
  });
  assert.equal(loaded.bundleVersion, '1.2.0');

  const link = path.join(root, 'linked.json');
  await fs.symlink(file, link);
  await assert.rejects(
    loadApprovedSelectorBundle({
      file:link,
      trustedRoot:root,
      approval,
      platform:'douyin',
      clock:() => new Date(NOW),
    }),
    { code:'cua_selector_bundle_file_invalid' },
  );

  await fs.chmod(file, 0o622);
  await assert.rejects(
    loadApprovedSelectorBundle({
      file,
      trustedRoot:root,
      approval,
      platform:'douyin',
      clock:() => new Date(NOW),
    }),
    { code:'cua_selector_bundle_permissions_invalid' },
  );
});

test('命名 Profile lease 精确绑定平台、账号和有效期，拒绝夹带登录材料', () => {
  const lease = approvedProfileLease();
  const validated = validateApprovedProfileLease(lease, {
    platform:'douyin',
    accountRef:'account:douyin:primary',
    clock:() => new Date(NOW),
  });
  assert.equal(validated.profileName, 'm5-douyin-primary');
  assert.deepEqual(Object.keys(validated).sort(), [
    'accountRef',
    'expiresAt',
    'identityClaim',
    'leaseRef',
    'platform',
    'profileName',
    'schemaVersion',
    'source',
    'status',
  ]);

  assert.throws(
    () => validateApprovedProfileLease(
      { ...lease, cookie:'forbidden' },
      {
        platform:'douyin',
        accountRef:'account:douyin:primary',
        clock:() => new Date(NOW),
      },
    ),
    { code:'cua_profile_lease_invalid' },
  );
  assert.throws(
    () => validateApprovedProfileLease(lease, {
      platform:'douyin',
      accountRef:'account:douyin:wrong',
      clock:() => new Date(NOW),
    }),
    { code:'cua_profile_lease_invalid' },
  );
});

test('命名 Profile lease 的账号身份声明 kind 或 value 任一无效都拒绝', () => {
  for (const [field, mutate] of [
    ['identityClaim.kind', (lease) => { lease.identityClaim.kind = 'page_text'; }],
    ['identityClaim.value', (lease) => { lease.identityClaim.value = 'sha256:invalid'; }],
  ]) {
    const lease = approvedProfileLease();
    mutate(lease);

    assert.throws(
      () => validateApprovedProfileLease(lease, {
        platform:'douyin',
        accountRef:'account:douyin:primary',
        clock:() => new Date(NOW),
      }),
      { code:'cua_profile_lease_invalid' },
      field,
    );
  }
});

test('bounded policy 精确声明获批命名隔离 Profile', () => {
  const policy = buildPlatformCuaSessionPolicy({
    platform:'douyin',
    readableDirectory:'/tmp/m5-cua-upload',
    profileMode:'isolated_named',
    profileName:'m5-douyin-primary',
  });
  assert.match(policy, /kind: isolated/);
  assert.doesNotMatch(policy, /name:/);
  assert.doesNotMatch(policy, /kind: isolated_(?:new|named)/);
  assert.throws(
    () => buildPlatformCuaSessionPolicy({
      platform:'douyin',
      readableDirectory:'/tmp/m5-cua-upload',
      profileMode:'isolated_named',
      profileName:'..\/bad',
    }),
    { code:'invalid_browser_profile' },
  );
});

function approvedBundle(platform = 'douyin') {
  const origin = CUA_PLATFORM_ORIGINS[platform];
  const document = {
    schemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:'1.2.0',
    platform,
    origin,
    selectorMap:{
      path:'/creator',
      identity:{
        accountTextPattern:'账号:\\s*([A-Za-z0-9_-]+)',
      },
      actions:{
        upload_media:{ label:'上传视频', action:'upload_media' },
        set_title:{ label:'标题', action:'set_title' },
        set_body:{ label:'正文', action:'set_body' },
        set_tags:{ label:'标签', action:'set_tags' },
        submit_publish:{ label:'发布', action:'submit_publish' },
      },
      result:{
        successText:'发布成功',
        contentIdPattern:'dy-content-[a-z0-9]+',
        evidencePathPrefix:'/content/',
      },
    },
  };
  return {
    ...document,
    approval:{
      source:'paperclip',
      status:'approved',
      approvalRef:'paperclip:cua-selector:douyin-v1.2.0',
      platform,
      bundleVersion:'1.2.0',
      selectorChecksum:selectorBundleChecksum(document),
      expiresAt:'2026-08-06T00:00:00.000Z',
    },
  };
}

function stripApproval(bundle) {
  const { approval:ignored, ...document } = bundle;
  return document;
}

function approvedProfileLease() {
  return {
    schemaVersion:CUA_PROFILE_LEASE_SCHEMA,
    source:'paperclip',
    status:'approved',
    leaseRef:'paperclip:cua-profile-lease:douyin-primary',
    platform:'douyin',
    accountRef:'account:douyin:primary',
    profileName:'m5-douyin-primary',
    identityClaim:{
      kind:'page_identity_sha256',
      value:`sha256:${crypto.createHash('sha256').update('douyin-primary-user').digest('hex')}`,
    },
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
}
