import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyCompatibilityPatch,
  patchHtmlSource,
  patchUiSource,
  resolveCompatibilityTargets,
  rollbackCompatibilityPatch,
  transformHtmlSource,
  transformUiSource,
  translateUiText,
} from '../compat/paperclip-2026-722-zh-cn.ts';
import { main as applyMain } from '../scripts/apply-paperclip-2026-722-zh-cn.mjs';
import { main as rollbackMain } from '../scripts/rollback-paperclip-2026-722-zh-cn.mjs';

const UI_ORIGINAL = 'const Y6="en",H4t={"./locales/zh-CN.json":F4t};Uh.use(oPt).init(Y4t).catch(e=>{});const J4t=gPt;';
const UI_ZH_CN = transformUiSource(UI_ORIGINAL);
const HTML_ORIGINAL = '<!doctype html><html lang="en" class="dark"><script type="module" crossorigin src="/assets/index-Cd3JwXvD.js"></script></html>';
const HTML_ZH_CN = transformHtmlSource(HTML_ORIGINAL);
const SOURCE_HASHES = {
  uiOriginalSha:sha256(UI_ORIGINAL),
  uiPatchedSha:sha256(UI_ZH_CN),
  htmlOriginalSha:sha256(HTML_ORIGINAL),
  htmlPatchedSha:sha256(HTML_ZH_CN),
};

test('简体中文补丁启用内置资源、主控制台翻译层和缓存隔离入口', () => {
  assert.equal(patchUiSource(UI_ORIGINAL, SOURCE_HASHES), UI_ZH_CN);
  assert.equal(patchUiSource(UI_ZH_CN, SOURCE_HASHES), UI_ZH_CN);
  assert.match(UI_ZH_CN, /__agentArmyPaperclipZhCn/);
  assert.match(UI_ZH_CN, /paperclip\.ui\.language/);
  assert.match(UI_ZH_CN, /agent-army-language-toggle/);
  assert.match(UI_ZH_CN, /aaZhObserver\.disconnect/);
  assert.equal(patchHtmlSource(HTML_ORIGINAL, SOURCE_HASHES), HTML_ZH_CN);
  assert.match(HTML_ZH_CN, /lang="zh-CN"/);
  assert.match(HTML_ZH_CN, /agent-army-zh-cn=2026\.722\.0-v5/);
  assert.equal(translateUiText('Dashboard'), '总览');
  assert.equal(translateUiText('Open actions for 小R'), '打开小R的操作菜单');
  assert.equal(translateUiText('updated 3h ago'), '更新于3小时前');
  assert.throws(() => patchUiSource(`${UI_ORIGINAL}changed`, SOURCE_HASHES), /拒绝修改未知版本/);
});

test('版本锁定补丁可幂等应用并从可信备份回滚', async (context) => {
  const fixture = await materializePaperclipFixture(context);
  const options = { paperclipEntry:fixture.paperclipEntry };
  const targets = await resolveCompatibilityTargets(options);
  assert.equal(targets.uiFile, await fs.realpath(fixture.uiFile));
  assert.equal(targets.htmlFile, await fs.realpath(fixture.htmlFile));

  assert.deepEqual(pick(await applyCompatibilityPatch(options, SOURCE_HASHES)), {
    changed:true,
    status:'applied',
  });
  assert.equal(await fs.readFile(fixture.uiFile, 'utf8'), UI_ZH_CN);
  assert.equal(await fs.readFile(fixture.htmlFile, 'utf8'), HTML_ZH_CN);
  assert.deepEqual(pick(await applyCompatibilityPatch(options, SOURCE_HASHES)), {
    changed:false,
    status:'already_applied',
  });
  assert.deepEqual(pick(await rollbackCompatibilityPatch(options, SOURCE_HASHES)), {
    changed:true,
    status:'rolled_back',
  });
  assert.equal(await fs.readFile(fixture.uiFile, 'utf8'), UI_ORIGINAL);
  assert.equal(await fs.readFile(fixture.htmlFile, 'utf8'), HTML_ORIGINAL);
});

test('未知版本、歧义入口和缺少显式确认均失败关闭', async (context) => {
  const unknownVersion = await materializePaperclipFixture(context, { version:'2099.1.0' });
  await assert.rejects(
    resolveCompatibilityTargets({ paperclipEntry:unknownVersion.paperclipEntry }),
    /只允许 Paperclip 2026\.722\.0/,
  );
  const ambiguous = await materializePaperclipFixture(context, { extraScript:true });
  await assert.rejects(
    resolveCompatibilityTargets({ paperclipEntry:ambiguous.paperclipEntry }),
    /入口脚本不唯一/,
  );
  await assert.rejects(applyMain([]), /显式确认/);
  await assert.rejects(rollbackMain([]), /显式确认/);
});

async function materializePaperclipFixture(context, { version = '2026.722.0', extraScript = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-zh-cn-fixture-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const paperclipRoot = path.join(root, 'node_modules', 'paperclipai');
  const serverRoot = path.join(root, 'node_modules', '@paperclipai', 'server');
  const paperclipEntry = path.join(paperclipRoot, 'dist', 'index.js');
  const uiFile = path.join(serverRoot, 'ui-dist', 'assets', 'index-Cd3JwXvD.js');
  await fs.mkdir(path.dirname(paperclipEntry), { recursive:true });
  await fs.mkdir(path.dirname(uiFile), { recursive:true });
  await fs.writeFile(path.join(paperclipRoot, 'package.json'), JSON.stringify({
    name:'paperclipai',
    version,
  }));
  await fs.writeFile(path.join(serverRoot, 'package.json'), JSON.stringify({
    name:'@paperclipai/server',
    version,
  }));
  await fs.writeFile(paperclipEntry, '');
  await fs.writeFile(uiFile, UI_ORIGINAL);
  const htmlFile = path.join(serverRoot, 'ui-dist', 'index.html');
  let html = HTML_ORIGINAL;
  if (extraScript) html = html.replace('</html>', '<script type="module" src="/assets/index-other.js"></script></html>');
  if (extraScript) await fs.writeFile(path.join(path.dirname(uiFile), 'index-other.js'), UI_ORIGINAL);
  await fs.writeFile(htmlFile, html);
  return { paperclipEntry, uiFile, htmlFile };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pick(value) {
  return { changed:value.changed, status:value.status };
}
