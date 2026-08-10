import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionAudit } from '../src/workflow/execution-audit.ts';

test('文本 Advisor 调用不能被未调用视觉 Provider 掩盖', () => {
  const audit = buildExecutionAudit({
    usage:{
      model:{
        status:'reported',
        provider:'deepseek',
        model:'deepseek-v4-flash',
        apiCalls:1,
        inputTokens:5218,
        outputTokens:13466,
      },
      cost:{
        status:'reported',
        amount:0.004501,
        currency:'USD',
        basis:'estimated',
        source:'hermes_estimated_cost_usd',
      },
    },
    artifacts:[{ validation:{ controlledVisionInvoked:false } }],
  });

  assert.equal(audit.modelProvider.status, 'used');
  assert.equal(audit.modelProvider.provider, 'deepseek');
  assert.equal(audit.modelProvider.apiCalls, 1);
  assert.equal(audit.cost.status, 'estimated');
  assert.equal(audit.cost.amount, 0.004501);
  assert.equal(audit.cost.basis, 'estimated');
  assert.equal(audit.cost.source, 'hermes_estimated_cost_usd');
  assert.equal(audit.cost.paidStatus, 'unknown');
  assert.equal(audit.visualProvider.status, 'not_used');
  assert.equal(audit.externalWrite.status, 'not_reported');
});

test('缺少调用和外写回执时保持未知口径，不伪造零副作用', () => {
  const audit = buildExecutionAudit({
    usage:{ model:{ status:'not_reported', apiCalls:0 }, cost:{ status:'not_reported' } },
  });

  assert.equal(audit.modelProvider.status, 'not_reported');
  assert.equal(audit.cost.status, 'not_reported');
  assert.equal(audit.visualProvider.status, 'not_reported');
  assert.equal(audit.externalWrite.status, 'not_reported');
});

test('显式视觉回执独立呈现 Provider 身份和 adapter 报告成本，不冒充已付费', () => {
  const audit = buildExecutionAudit({
    artifacts:[{
      validation:{
        controlledVisionInvoked:true,
        visualExecutionReceiptValid:true,
      },
      data:{
        visualExecutionReceipt:{
          receiptId:'receipt:local-vision-001',
          provider:'local-qwen',
          model:'qwen3.5-9b-mlx',
          costUsd:0,
        },
      },
    }],
  });

  assert.equal(audit.modelProvider.status, 'not_reported');
  assert.equal(audit.visualProvider.status, 'used');
  assert.equal(audit.visualProvider.provider, 'local-qwen');
  assert.equal(audit.visualProvider.model, 'qwen3.5-9b-mlx');
  assert.equal(audit.visualProvider.receiptId, 'receipt:local-vision-001');
  assert.deepEqual(audit.visualProvider.cost, {
    status:'reported',
    amountUsd:0,
    basis:'execution_receipt_adapter_reported',
    paidStatus:'unknown',
  });
});

test('声称调用视觉但缺少可验证回执时保持未知', () => {
  const audit = buildExecutionAudit({
    artifacts:[{ validation:{ controlledVisionInvoked:true } }],
  });

  assert.equal(audit.visualProvider.status, 'unknown');
  assert.equal(audit.visualProvider.receiptId, null);
  assert.equal(audit.visualProvider.cost, null);
});
