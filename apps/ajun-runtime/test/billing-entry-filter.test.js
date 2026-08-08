import assert from 'node:assert/strict';
import test from 'node:test';
import { BILLING_PAGE_SIZE, filterBillingEntries } from '../public/billing-entry-filter.js';

test('消费流水复用记录页的搜索、归属筛选和 24 条分批展示规则', () => {
  const entries = [
    { agentId:'ajun', model:'deepseek-v4-flash', attribution:{ status:'task', taskTitle:'日报' } },
    { agentId:'xiaod', model:'whisper', attribution:{ status:'unattributed' } },
  ];
  assert.equal(BILLING_PAGE_SIZE, 24);
  assert.deepEqual(filterBillingEntries(entries, { query:'日报' }), [entries[0]]);
  assert.deepEqual(filterBillingEntries(entries, { agentId:'xiaod', view:'unattributed' }), [entries[1]]);
  assert.deepEqual(filterBillingEntries(entries, { view:'attributed' }), [entries[0]]);
});
