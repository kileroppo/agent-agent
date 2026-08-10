import assert from 'node:assert/strict';
import test from 'node:test';
import { BILLING_PAGE_SIZE, filterBillingEntries } from '../public/billing-entry-filter.js';

test('消费流水按任务、Agent 会话、系统与未识别四类筛选', () => {
  const entries = [
    { agentId:'ajun', model:'deepseek-v4-flash', attribution:{ status:'task', taskTitle:'日报' } },
    { agentId:'xiaod', model:'whisper', attribution:{ status:'agent_session' } },
    { agentId:'operator', model:'deepseek-v4-flash', attribution:{ status:'system' } },
    { agentId:'unknown', model:'unknown', attribution:{ status:'unattributed' } },
  ];
  assert.equal(BILLING_PAGE_SIZE, 24);
  assert.deepEqual(filterBillingEntries(entries, { query:'日报' }), [entries[0]]);
  assert.deepEqual(filterBillingEntries(entries, { agentId:'xiaod', view:'agent_session' }), [entries[1]]);
  assert.deepEqual(filterBillingEntries(entries, { view:'task' }), [entries[0]]);
  assert.deepEqual(filterBillingEntries(entries, { view:'system' }), [entries[2]]);
  assert.deepEqual(filterBillingEntries(entries, { view:'unattributed' }), [entries[3]]);
});
