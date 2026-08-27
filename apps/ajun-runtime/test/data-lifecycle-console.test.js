import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDataLifecycleConsole } from '../frontend/src/data-lifecycle-console.ts';

const rootUrl = new URL('../public/index.html', import.meta.url);

test('A君控制台 HTML 包含数据闭环模块与关键交互节点', async () => {
  const html = await readFile(rootUrl, 'utf8');

  assert.match(html, /id="module-storage"/);
  assert.match(html, /data-module-page="storage"/);
  assert.match(html, /data-context-page="storage"/);
  assert.match(html, /id="storage-tasks-count"/);
  assert.match(html, /id="storage-events-count"/);
  assert.match(html, /id="storage-eval-count"/);
  assert.match(html, /id="storage-size-bytes"/);
  assert.match(html, /id="storage-check"/);
  assert.match(html, /id="storage-reconcile"/);
});

test('createDataLifecycleConsole 能够拉取状态并正确响应扫描与清理动作', async () => {
  const elements = {
    '#storage-tasks-count': { textContent: '' },
    '#storage-events-count': { textContent: '' },
    '#storage-eval-count': { textContent: '' },
    '#storage-size-bytes': { textContent: '' },
    '#storage-message': { textContent: '' },
    '#storage-ledger': { innerHTML: '' },
    '#storage-check': { disabled: false, addEventListener: (event, handler) => { elements['#storage-check'].onclick = handler; } },
    '#storage-reconcile': { disabled: false, addEventListener: (event, handler) => { elements['#storage-reconcile'].onclick = handler; } },
  };

  const fakeRoot = {
    querySelector: (selector) => elements[selector] || null,
  };

  const apiCalls = [];
  const fakeApi = async (url, options) => {
    apiCalls.push({ url, options });
    if (url === '/api/data-lifecycle') {
      return {
        ok: true,
        dataLifecycle: {
          inspectedAt: '2026-08-27T00:00:00.000Z',
          tasksCount: { tasks: 42, routineTasks: 5 },
          eventsCount: { totalEvents: 120, byClass: { transient: 50, detail: 60, audit: 10 } },
          evalCasesCount: 8,
          dataDirSizeBytes: 1048576,
          contentWorkspaceSizeBytes: 2097152,
        },
      };
    }
    if (url.includes('/api/data-lifecycle/reconcile')) {
      const isDryRun = url.includes('dryRun=true');
      return {
        ok: true,
        result: {
          mode: isDryRun ? 'dry-run' : 'apply',
          totalReclaimedItems: 12,
          totalReclaimedBytes: 5242880,
          tasksPruned: { deleted: { routineTasks: 3, terminalTasks: 2, conversationContexts: 1 } },
          eventsCleaned: { deletedEvents: 6, incidentSummariesCreated: 1 },
          artifactsCleaned: { cleanedFilesCount: 2, cleanedBytes: 5242880 },
        },
      };
    }
    return {};
  };

  const consoleInstance = createDataLifecycleConsole({
    root: fakeRoot,
    api: fakeApi,
    confirmAction: () => true,
  });

  // 1. 页面激活并拉取状态
  consoleInstance.activate();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(elements['#storage-tasks-count'].textContent, '42 项 (例行 5)');
  assert.equal(elements['#storage-events-count'].textContent, '120 条 (临时 50 · 详情 60 · 审计 10)');
  assert.equal(elements['#storage-eval-count'].textContent, '8 个用例');
  assert.match(elements['#storage-size-bytes'].textContent, /3.00 MB/);

  // 2. 触发扫描 (Dry-Run)
  await elements['#storage-check'].onclick();
  assert.match(elements['#storage-message'].textContent, /扫描完成：预计可清理 12 项超期记录/);
  assert.match(elements['#storage-ledger'].innerHTML, /只读预览 \(Dry-Run\)/);

  // 3. 触发立即安全清理 (Apply)
  await elements['#storage-reconcile'].onclick();
  assert.match(elements['#storage-message'].textContent, /清理完成：已安全清理 12 项记录/);
  assert.match(elements['#storage-ledger'].innerHTML, /物理清理 \(Apply\)/);
});
