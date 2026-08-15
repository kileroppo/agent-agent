import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createConsoleNavigation,
  resolveConsoleRoute,
} from '../public/console-navigation.js';
import {
  renderAttentionDetail,
  taskAttentionView,
} from '../public/task-record-detail-view.js';

const publicRoot = new URL('../public/', import.meta.url);
const taskId = '11111111-1111-4111-8111-111111111111';

test('四个主导航收敛日常路径，旧 hash 仍打开原页面', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const primaryModules = [...html.matchAll(/class="module-link[^>]*" data-module="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(primaryModules, ['overview', 'records', 'system', 'tools']);
  assert.deepEqual(resolveConsoleRoute('#now'), { page:'overview', group:'overview' });
  assert.deepEqual(resolveConsoleRoute('#runs'), { page:'records', group:'records' });
  assert.deepEqual(resolveConsoleRoute('#employees'), { page:'employees', group:'system' });
  assert.deepEqual(resolveConsoleRoute('#billing'), { page:'billing', group:'system' });
  assert.deepEqual(resolveConsoleRoute('#campaigns'), { page:'campaigns', group:'tools' });
});

test('任务 pathname 是详情真相，切往其他 hash 时清除详情 pathname', () => {
  let pathname = `/tasks/${taskId}`;
  let hash = '';
  const activated = [];
  const replacements = [];
  const navigation = createConsoleNavigation({
    getPathname:() => pathname,
    getHash:() => hash,
    replaceLocation:(value) => replacements.push(value),
    activate:(page, options) => activated.push([page, options.navigationGroup]),
  });

  navigation.initialize();
  assert.deepEqual(activated, [['records', 'records']]);

  hash = '#system';
  navigation.locationChanged();
  assert.deepEqual(replacements, ['/#system']);
  assert.deepEqual(activated.at(-1), ['system', 'system']);

  pathname = '/';
  hash = '#records';
  navigation.locationChanged();
  assert.deepEqual(activated.at(-1), ['records', 'records']);
});

test('attention 只接受安全动作键并保留恢复任务链接', () => {
  const view = taskAttentionView({
    paperclipIssue:{ identifier:'AGE-1462', detailUrl:'http://127.0.0.1:3100/issues/AGE-1462' },
    presentation:{
      attention:{
        kind:'failed',
        headline:'本轮未完成',
        cause:'视觉通道没有接通。',
        impact:'没有产出视觉判断。',
        remainingRisks:null,
        actions:[
          { actionKey:'text-only', label:'仅用转录继续', emphasis:'primary', confirmation:'确认改为仅文本？', endpoint:'https://invalid.example' },
          { actionKey:'text-only', label:'重复动作' },
          { actionKey:'../../escape', label:'危险动作' },
        ],
        verification:{
          status:'verified', message:'只读诊断完成。', taskId, detailPath:`/tasks/${taskId}`,
          diagnosis:{
            conclusion:'Paperclip 执行链结束，但没有形成可验证产物。',
            evidence:'故障代码 paperclip_hermes_failed；阶段 paperclip_hermes。',
            impact:'原任务仍未完成，已有记录保持不变。',
            nextAction:'检查 Paperclip 执行记录，再决定是否修复或重跑。',
          },
        },
        technical:{ code:'controlled_provider_vision_required', stage:'paperclip_hermes' },
      },
    },
  });

  assert.equal(view.remainingRisks, '');
  assert.deepEqual(view.actions, [{ actionKey:'text-only', label:'仅用转录继续', emphasis:'primary', confirmation:'确认改为仅文本？' }]);
  assert.equal(view.verification.status, 'verified');
  assert.equal(view.verification.diagnosis.conclusion, 'Paperclip 执行链结束，但没有形成可验证产物。');
  assert.equal(view.technical.code, 'controlled_provider_vision_required');
  const html = renderAttentionDetail(view, null, escapeHtml);
  assert.match(html, /Paperclip 执行失败[\s\S]*未生成可验证产物，原任务未完成/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:3100\/issues\/AGE-1462"[\s\S]*打开 Paperclip 失败记录/);
  assert.match(html, /诊断依据[\s\S]*诊断记录/);
  assert.doesNotMatch(html, /诊断完成|<strong>影响<\/strong>|<strong>下一步<\/strong>|为什么这样判断/);
  assert.doesNotMatch(html, /发生了什么|剩余风险|还没有执行恢复动作/);
  assert.equal((html.match(/record-attention-primary/g) || []).length, 1);

  const confirmingHtml = renderAttentionDetail(view, {
    status:'confirming',
    actionKey:'text-only',
    message:'确认改为仅文本？',
  }, escapeHtml);
  assert.match(confirmingHtml, /role="alert"/);
  assert.match(confirmingHtml, /data-attention-confirm="text-only"/);
  assert.match(confirmingHtml, /data-attention-cancel/);
  assert.equal((confirmingHtml.match(/确认改为仅文本？/g) || []).length, 1);
});

test('恢复动作固定走本机安全路径并带并发与幂等保护', async () => {
  const script = await readFile(new URL('task-record-workbench.js', publicRoot), 'utf8');

  assert.match(script, /api\('\/api\/owner-action-session'\)/);
  assert.match(script, /\/api\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/recovery-actions\/\$\{encodeURIComponent\(action\.actionKey\)\}/);
  assert.match(script, /'Idempotency-Key':\s*idempotencyKey/);
  assert.match(script, /'X-Ajun-Owner-Action':\s*nonce/);
  assert.match(script, /expectedUpdatedAt:\s*task\.updatedAt \|\| null/);
  assert.doesNotMatch(script, /action\.(?:endpoint|url|method)/);
  assert.doesNotMatch(script, /task\.(?:error|routing|requester)/);
  assert.match(script, /task-record-detail-view\.js/);
  assert.match(script, /data-attention-confirm/);
  assert.match(script, /data-attention-cancel/);
  assert.doesNotMatch(script, /window\.confirm\(confirmation\)/);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[character]);
}
