import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAcceptanceEvidence,
  findRef,
  parseArguments,
  requireBrowserApprovalToken,
  resolveEvidenceOutputPath,
  writeEvidenceAtomically,
} from '../scripts/run-local-cua-acceptance.mjs';
import {
  LOCAL_ACCEPTANCE_ALLOWED_TOOLS,
  LOCAL_ACCEPTANCE_CONFIRMATION,
  buildBoundedSessionPolicy,
  createLocalFixtureRequestHandler,
  evaluateCuaPreflight,
  resolveAcceptanceUploadPath,
  validateLoopbackOrigin,
  versionAtLeast
} from '../src/index.ts';

test('本地 CUA 在启动 daemon 前拒绝缺失的一次性 browser approval token', () => {
  assert.throws(
    () => requireBrowserApprovalToken(undefined),
    { code:'browser_consent_required' },
  );
  assert.throws(
    () => requireBrowserApprovalToken('   '),
    { code:'browser_consent_required' },
  );
  assert.equal(requireBrowserApprovalToken(' single-use-token '), 'single-use-token');
});

async function request({ port, pathName = '/', host }) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname:'127.0.0.1',
      port,
      path:pathName,
      headers:host ? { Host:host } : {}
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => body += chunk);
      response.on('end', () => resolve({
        status:response.statusCode,
        headers:response.headers,
        body
      }));
    });
    request.on('error', reject);
  });
}

test('CuaDriver 版本门禁按 0.14.1 比较', () => {
  assert.equal(versionAtLeast('cua-driver 0.14.1 (aarch64-macos)'), true);
  assert.equal(versionAtLeast('0.15.0'), true);
  assert.equal(versionAtLeast('0.14.0'), false);
  assert.equal(versionAtLeast('unknown'), false);
});

test('本地 CUA 验收默认关闭且需要双重确认', () => {
  const permissions = {
    accessibility:true,
    screen_recording:true,
    source:{ bundle_id:'com.trycua.driver' }
  };
  assert.throws(
    () => evaluateCuaPreflight({
      enabled:false,
      confirmation:LOCAL_ACCEPTANCE_CONFIRMATION,
      version:'0.14.1',
      permissions
    }),
    { code:'local_cua_acceptance_disabled' }
  );
  assert.throws(
    () => evaluateCuaPreflight({
      enabled:true,
      confirmation:'wrong',
      version:'0.14.1',
      permissions
    }),
    { code:'local_cua_acceptance_disabled' }
  );
});

test('缺少屏幕录制权限时在任何浏览器动作前硬停', () => {
  assert.throws(
    () => evaluateCuaPreflight({
      enabled:true,
      confirmation:LOCAL_ACCEPTANCE_CONFIRMATION,
      version:'0.14.1',
      permissions:{
        accessibility:true,
        screen_recording:false,
        source:{ bundle_id:'com.trycua.driver' }
      }
    }),
    { code:'screen_recording_required' }
  );
});

test('只有 CuaDriver app 的两项权限都满足才通过', () => {
  assert.deepEqual(
    evaluateCuaPreflight({
      enabled:true,
      confirmation:LOCAL_ACCEPTANCE_CONFIRMATION,
      version:'0.14.1',
      permissions:{
        accessibility:true,
        screen_recording:true,
        screen_recording_capturable:true,
        source:{ bundle_id:'com.trycua.driver' }
      }
    }),
    { passed:true, tccIdentity:'com.trycua.driver' }
  );
});

test('拒绝终端或其他宿主的权限状态冒充 CuaDriver app', () => {
  assert.throws(
    () => evaluateCuaPreflight({
      enabled:true,
      confirmation:LOCAL_ACCEPTANCE_CONFIRMATION,
      version:'0.14.1',
      permissions:{
        accessibility:true,
        screen_recording:true,
        source:{ bundle_id:'com.apple.Terminal' }
      }
    }),
    { code:'cua_identity_mismatch' }
  );
});

test('bounded policy 只开放精确本地 origin、隔离 profile、单层只读目录和必要 typed tools', () => {
  const policy = buildBoundedSessionPolicy({
    origin:'http://127.0.0.1:4387',
    readableDirectory:'/tmp/m5-cua-fixtures',
    browserExecutable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });
  assert.match(policy, /mode: bounded/);
  assert.match(policy, /expires_after: 15m/);
  assert.match(policy, /kind: isolated/);
  assert.match(policy, /origins:\n      - about:blank/);
  assert.match(policy, /"http:\/\/127\.0\.0\.1:4387"/);
  assert.match(
    policy,
    /executable: "\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome"/
  );
  assert.match(policy, /launch: true\n      windows: all\n      terminate: driver_launched/);
  assert.match(policy, /dir: "\/tmp\/m5-cua-fixtures"\n        recursive: false/);
  assert.match(policy, /display: false/);
  assert.match(policy, /write: \[\]/);
  assert.match(policy, /terminate: \[\]/);
  assert.match(policy, /deny:\n  tools:\n    - page/);
  for (const tool of LOCAL_ACCEPTANCE_ALLOWED_TOOLS) {
    assert.match(policy, new RegExp(`    - ${tool}\\n`));
  }
  for (const forbidden of ['get_desktop_state', 'get_window_state', 'click', 'type_text', 'launch_app', 'browser_download']) {
    assert.doesNotMatch(policy, new RegExp(`    - ${forbidden}\\n`));
  }
  assert.throws(
    () => buildBoundedSessionPolicy({
      origin:'http://127.0.0.1:4387',
      readableDirectory:'/tmp/m5-cua-fixtures',
      browserExecutable:'/tmp/untrusted-browser'
    }),
    { code:'unsupported_browser_executable' }
  );
});

test('bounded policy 拒绝外部域名、localhost 别名、路径和根目录', () => {
  for (const origin of [
    'https://127.0.0.1:4387',
    'http://localhost:4387',
    'http://127.0.0.1:4387/path',
    'http://example.com:4387'
  ]) {
    assert.throws(() => validateLoopbackOrigin(origin), { code:'invalid_acceptance_origin' });
  }
  assert.throws(
    () => buildBoundedSessionPolicy({
      origin:'http://127.0.0.1:4387',
      readableDirectory:'/'
    }),
    { code:'invalid_acceptance_directory' }
  );
});

test('测试文件必须位于获准目录内且符号链接不能越界', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-cua-path-test-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside.txt');
  await fs.mkdir(allowed);
  await fs.writeFile(path.join(allowed, 'fixture.txt'), 'fixture');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(allowed, 'escape.txt'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));

  const valid = await resolveAcceptanceUploadPath(allowed, 'fixture.txt');
  assert.equal(valid.file, await fs.realpath(path.join(allowed, 'fixture.txt')));
  await assert.rejects(
    resolveAcceptanceUploadPath(allowed, outside),
    { code:'acceptance_upload_outside_directory' }
  );
  await assert.rejects(
    resolveAcceptanceUploadPath(allowed, 'escape.txt'),
    { code:'acceptance_upload_outside_directory' }
  );
});

test('本地假平台页面只绑定 127.0.0.1 Host，提供健康检查且禁止网络外连', async (t) => {
  const html = '<!doctype html><title>local fixture</title>';
  const server = http.createServer(createLocalFixtureRequestHandler(html));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const page = await request({ port });
  assert.equal(page.status, 200);
  assert.equal(page.body, html);
  assert.match(page.headers['content-security-policy'], /connect-src 'none'/);
  assert.match(page.headers['content-security-policy'], /form-action 'none'/);

  const health = await request({ port, pathName:'/api/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok:true, mode:'local-fake-platform' });

  const poisonedHost = await request({ port, host:'evil.example' });
  assert.equal(poisonedHost.status, 421);
});

test('fixture HTML 无外部资源、fetch、真实平台域名或 Cookie 读取', async () => {
  const html = await fs.readFile(new URL('../acceptance/fake-platform.html', import.meta.url), 'utf8');
  assert.match(html, /本地假平台发布验收/);
  assert.match(html, /type="file"/);
  assert.match(html, /data-testid="fake-publish-receipt"/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /document\.cookie/);
  assert.doesNotMatch(html, /douyin\.com|xiaohongshu\.com/);
});

test('本地验收要求显式 evidence-output，且同名多个页面 ref 时拒绝猜测', () => {
  assert.throws(
    () => parseArguments(['--confirm', LOCAL_ACCEPTANCE_CONFIRMATION]),
    { code:'evidence_output_required' },
  );
  assert.equal(
    findRef({
      nodes:[{ ref:'title-1', name:'标题', actions:['type'] }],
    }, '标题', 'type'),
    'title-1',
  );
  assert.throws(
    () => findRef({
      nodes:[
        { ref:'title-1', name:'标题', actions:['type'] },
        { ref:'title-2', accessible_name:'标题输入框', actions:['type'] },
      ],
    }, '标题', 'type'),
    { code:'browser_ref_ambiguous' },
  );
});

test('CUA 验收证据只含白名单字段并以0600原子创建，拒绝越界、符号链接和覆盖', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-cua-evidence-workspace-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-cua-evidence-outside-'));
  const evidenceDirectory = path.join(workspace, 'evidence');
  await fs.mkdir(evidenceDirectory);
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive:true, force:true }),
    fs.rm(outside, { recursive:true, force:true }),
  ]));
  const evidence = createAcceptanceEvidence({
    platform:'fake-douyin',
    origin:'http://127.0.0.1:4387',
    cuaDriverVersion:'cua-driver 0.14.1 (aarch64-macos)',
    uploadBasename:'sample-upload.txt',
    uploadSha256:`sha256:${'a'.repeat(64)}`,
    uploadBytes:123,
    policySha256:`sha256:${'b'.repeat(64)}`,
    contentId:'local-fake-douyin-0123456789abcdef',
    startedAt:'2026-07-30T00:00:00.000Z',
    completedAt:'2026-07-30T00:01:00.000Z',
    approvalToken:'must-not-persist',
    uploadPath:'/private/must-not-persist',
    apiKey:'must-not-persist',
  });
  assert.deepEqual(Object.keys(evidence), [
    'schemaVersion',
    'platform',
    'origin',
    'cuaDriverVersion',
    'profileMode',
    'upload',
    'policySha256',
    'contentId',
    'startedAt',
    'completedAt',
    'realPlatformTouched',
  ]);
  assert.deepEqual(Object.keys(evidence.upload), ['basename', 'sha256', 'bytes']);
  assert.doesNotMatch(JSON.stringify(evidence), /must-not-persist|\/private\//);

  const resolved = await resolveEvidenceOutputPath(workspace, 'evidence/receipt.json');
  const written = await writeEvidenceAtomically(resolved.file, evidence);
  assert.deepEqual(written.mode, '0600');
  const stats = await fs.lstat(resolved.file);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(stats.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(resolved.file, 'utf8')), evidence);

  await assert.rejects(
    writeEvidenceAtomically(resolved.file, { overwritten:true }),
    { code:'evidence_output_exists' },
  );
  assert.deepEqual(JSON.parse(await fs.readFile(resolved.file, 'utf8')), evidence);
  await assert.rejects(
    resolveEvidenceOutputPath(workspace, path.join(outside, 'outside.json')),
    { code:'evidence_output_outside_workspace' },
  );
  await fs.symlink(path.join(outside, 'target.json'), path.join(evidenceDirectory, 'symlink.json'));
  await assert.rejects(
    resolveEvidenceOutputPath(workspace, 'evidence/symlink.json'),
    { code:'evidence_output_symlink' },
  );
  await fs.symlink(outside, path.join(workspace, 'linked-outside'));
  await assert.rejects(
    resolveEvidenceOutputPath(workspace, 'linked-outside/receipt.json'),
    { code:'evidence_output_symlink' },
  );
});
