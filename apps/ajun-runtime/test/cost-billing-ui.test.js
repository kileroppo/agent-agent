import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('运行台提供只对本机所有者可见的 AI 成本账本和任务归属提示', async () => {
  const [html, script, ledger] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/billing-ledger-workbench.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /href="#billing" data-context-page="billing" data-owner-only/);
  assert.doesNotMatch(html, /data-module="billing"/);
  assert.match(html, /id="module-billing"[^>]*data-owner-only/);
  assert.match(html, /AI 成本账本/);
  assert.match(html, /消费流水/);
  assert.match(html, /id="billing-search"/);
  assert.match(html, /data-billing-view="task"/);
  assert.match(html, /data-billing-view="agent_session"/);
  assert.match(html, /data-billing-view="system"/);
  assert.match(html, /data-billing-view="unattributed"/);
  assert.match(html, /id="billing-load-more"/);
  assert.match(html, /id="billing-workbench" class="record-workbench billing-workbench"/);
  assert.match(html, /id="billing-entry-detail" class="record-detail billing-entry-detail"/);
  assert.match(html, /id="billing-cost-health"[^>]*role="status"/);
  assert.match(script, /function renderBilling\(\)/);
  assert.match(script, /function renderBillingCostHealth\(health\)/);
  assert.match(script, /缓存命中、调用量、推理占比和费用覆盖/);
  assert.match(script, /成本需要处理/);
  assert.match(script, /createBillingLedgerWorkbench/);
  assert.match(ledger, /filterBillingEntries/);
  assert.match(ledger, /BILLING_PAGE_SIZE/);
  assert.match(ledger, /data-billing-entry-ref/);
  assert.match(ledger, /state\.detailOpen = true/);
  assert.match(ledger, /选择一条流水查看用量和归属/);
  assert.match(ledger, /独立 Agent 会话/);
  assert.match(ledger, /系统调用/);
  assert.match(ledger, /未识别来源/);
  assert.match(script, /不等同于具体业务任务/);
  assert.match(script, /当前全部为 Hermes 估算，不是 Provider 最终账单/);
});
