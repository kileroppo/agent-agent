import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderM5SocialCardPackage, validateM5SocialCardProps } from '../src/social-card-tools.ts';
import { sha256 } from '../src/policy.ts';

const run = {
  agentId:'11111111-1111-4111-8111-111111111111',
  runId:'22222222-2222-4222-8222-222222222222',
  companyId:'33333333-3333-4333-8333-333333333333',
  projectId:'44444444-4444-4444-8444-444444444444',
};

test('受控静态卡工具校验素材血缘并返回不可变 1080×1440 PNG 卡包', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-social-card-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const fixture = await writeFixture(root);
  const calls = [];
  const result = await renderM5SocialCardPackage(workspaceContext(root), {
    outputDir:'campaigns/case-1/social-cards',
    props:fixture.props,
  }, run, {
    executeFile:async (executable, args) => {
      calls.push({ executable, args });
      const output = args[args.indexOf('--output') + 1];
      const cards = [];
      for (const [index, card] of fixture.props.cards.entries()) {
        const file = `xhs-${String(index + 1).padStart(2, '0')}-${card.id}.png`;
        const bytes = fakePng(1080, 1440, `card-${card.id}`);
        await fs.writeFile(path.join(output, file), bytes);
        cards.push({
          id:card.id,
          file,
          width:1080,
          height:1440,
          bytes:bytes.length,
          checksum:sha256(bytes),
        });
      }
      await fs.writeFile(
        path.join(output, 'social-card-render-manifest.tson'),
        JSON.stringify({ schemaVersion:1, platform:'xiaohongshu', cards }),
      );
      return { stdout:'', stderr:'' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.match(calls[0].args[0], /render-social-card-package\.mjs$/);
  assert.equal(result.data.schemaVersion, 'agent.army/social-card-package/v1');
  assert.equal(result.data.platform, 'xiaohongshu');
  assert.equal(result.data.cards.length, 3);
  assert.equal(result.data.checks.externalNetworkUsed, false);
  assert.deepEqual(result.data.cards.map((card) => [card.width, card.height]), [
    [1080, 1440], [1080, 1440], [1080, 1440],
  ]);
  assert.equal(
    (await fs.stat(path.join(root, result.data.cards[0].relativePath))).mode & 0o777,
    0o600,
  );
});

test('静态卡 props 拒绝越界版式、外部图片和缺失版权依据', async () => {
  const invalid = validProps('sha256:' + 'a'.repeat(64), 'assets/frame.png', 'sha256:' + 'b'.repeat(64));
  invalid.rightsBasis = '';
  invalid.cards[0].kind = 'arbitrary-html';
  invalid.cards[1].imageSrc = 'https://example.com/tracker.png';
  const validation = validateM5SocialCardProps(invalid);
  assert.equal(validation.passed, false);
  assert.match(validation.errors.join(' '), /版权依据/);
  assert.match(validation.errors.join(' '), /白名单/);
  assert.match(validation.errors.join(' '), /可信素材账本/);
});

test('静态卡工具拒绝素材哈希漂移和覆盖既有产物', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-social-card-deny-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const fixture = await writeFixture(root);
  await fs.writeFile(path.join(root, 'assets/frame.png'), 'tampered');
  await assert.rejects(
    renderM5SocialCardPackage(workspaceContext(root), {
      outputDir:'campaigns/case-1/social-cards',
      props:fixture.props,
    }, run, { executeFile:async () => assert.fail('素材漂移时不应启动渲染器') }),
    { code:'social_card_asset_checksum_mismatch' },
  );

  await fs.writeFile(path.join(root, 'assets/frame.png'), fixture.assetBytes);
  await fs.mkdir(path.join(root, 'campaigns/case-1/social-cards'), { recursive:true });
  await assert.rejects(
    renderM5SocialCardPackage(workspaceContext(root), {
      outputDir:'campaigns/case-1/social-cards',
      props:fixture.props,
    }, run),
    { code:'social_card_output_exists' },
  );
});

async function writeFixture(root) {
  const assetBytes = fakePng(1080, 1440, 'trusted-source');
  const relativePath = 'assets/frame.png';
  await fs.mkdir(path.join(root, 'assets'), { recursive:true });
  await fs.writeFile(path.join(root, relativePath), assetBytes);
  return {
    assetBytes,
    props:validProps(
      'sha256:' + 'a'.repeat(64),
      relativePath,
      sha256(assetBytes),
    ),
  };
}

function validProps(bindingHash, assetPath, assetChecksum) {
  return {
    platform:'xiaohongshu',
    title:'Agent军团可信交付',
    subtitle:'从任务到可核验产物',
    sourceLabel:'公开来源与本机自产素材',
    rightsBasis:'仓库自有素材，仅用于本地候选产物验证',
    templateBinding:{ bindingHash },
    assetLedger:[{ relativePath:assetPath, checksum:assetChecksum }],
    cards:[
      { id:'cover', kind:'cover', headline:'别把运行当完成', body:'完成必须落到可核验产物。', bullets:['任务边界', '真实回执', '人工验收'] },
      { id:'evidence', kind:'evidence', headline:'证据进入同一条链', body:'素材、模板和输出都有稳定哈希。', bullets:['素材账本', '固定尺寸'], imageSrc:assetPath },
      { id:'checklist', kind:'checklist', headline:'交付前逐项核对', body:'发布仍由独立审批门禁控制。', bullets:['代码与测试', '本地运行', '外部证据'] },
    ],
  };
}

function workspaceContext(root) {
  return {
    localFolders:{
      status:async () => ({ healthy:true, writable:true, realPath:root }),
    },
  };
}

function fakePng(width, height, body) {
  const suffix = Buffer.from(body);
  const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  const bytes = Buffer.alloc(24 + suffix.length + iend.length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  suffix.copy(bytes, 24);
  iend.copy(bytes, 24 + suffix.length);
  return bytes;
}
