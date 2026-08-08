import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('运行台提供只对本机所有者可见的 AI 成本账本和任务归属提示', async () => {
  const [html, script] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-module="billing" data-owner-only/);
  assert.match(html, /id="module-billing"[^>]*data-owner-only/);
  assert.match(html, /AI 成本账本/);
  assert.match(html, /消费流水/);
  assert.match(html, /id="billing-search"/);
  assert.match(html, /data-billing-view="unattributed"/);
  assert.match(html, /id="billing-load-more"/);
  assert.match(script, /function renderBilling\(\)/);
  assert.match(script, /filterBillingEntries/);
  assert.match(script, /BILLING_PAGE_SIZE/);
  assert.match(script, /function billingOption\(value, label\)/);
  assert.match(script, /未归属任务/);
  assert.match(script, /不代表没有发生消费/);
  assert.match(script, /当前全部为 Hermes 估算，不是 Provider 最终账单/);
});
