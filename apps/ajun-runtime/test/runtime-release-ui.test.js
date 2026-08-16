import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveConsoleRoute } from '../public/console-navigation.js';
import { releaseActionAvailability, releaseStageView } from '../public/runtime-release-console.js';

const publicRoot = new URL('../public/', import.meta.url);

test('系统页提供固定的版本管理入口，不暴露命令或路径输入', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const releaseSection = html.match(/<section id="module-release"[\s\S]*?<\/section>\s*<\/section>/)?.[0] || '';

  assert.deepEqual(resolveConsoleRoute('#release'), { page:'release', group:'system' });
  assert.match(releaseSection, /检查新版/);
  assert.match(releaseSection, /发布新版/);
  assert.match(releaseSection, /退回上一版/);
  assert.match(releaseSection, /自动恢复旧版/);
  assert.doesNotMatch(releaseSection, /<input|<textarea|<select/);
});

test('只有干净且检查就绪的 main 候选版本可发布', () => {
  assert.deepEqual(releaseActionAvailability({ state:'ready', candidate:{ clean:true }, rollback:{ releaseHash:'old' } }), {
    checking:false,
    canPublish:true,
    canRollback:true,
  });
  assert.equal(releaseActionAvailability({ state:'ready', candidate:{ clean:false } }).canPublish, false);
  assert.equal(releaseActionAvailability({ state:'verifying', candidate:{ clean:true }, rollback:{ releaseHash:'old' } }).canRollback, false);
});

test('发布进度来自真实助手状态，没有伪造百分比', async () => {
  const stages = releaseStageView({ action:'publish', state:'freezing' });
  assert.deepEqual(stages.map((item) => item.state), ['done', 'done', 'done', 'active', 'pending', 'pending']);

  const script = await readFile(new URL('runtime-release-console.js', publicRoot), 'utf8');
  assert.match(script, /api\('\/api\/owner-action-session'\)/);
  assert.match(script, /publish_current_commit/);
  assert.match(script, /rollback_previous_release/);
  assert.match(script, /A君正在重启，等待重新连接/);
  assert.doesNotMatch(script, /percent|progress\s*=/i);
});
