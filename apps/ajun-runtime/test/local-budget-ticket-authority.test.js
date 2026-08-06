import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalBudgetTicketAuthority } from '../src/local-budget-ticket-authority.js';
import { verifySignedBudgetTicket } from '../../../integrations/paperclip/plugins/content-autonomy/src/signed-budget-ticket.js';

const run = {
  companyId:'11111111-1111-4111-8111-111111111111',
  agentId:'22222222-2222-4222-8222-222222222222',
  projectId:'33333333-3333-4333-8333-333333333333',
  runId:'44444444-4444-4444-8444-444444444444',
};

test('本机预算票据私钥0600持久化，重启后公钥和验签保持一致', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-budget-ticket-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'ticket.pem');
  const first = await LocalBudgetTicketAuthority.open(file);
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o077, 0);
  const second = await LocalBudgetTicketAuthority.open(file);
  assert.equal(second.publicKey, first.publicKey);
  const parameters = { actionId:'action:image:authority:1', prompt:'test', outputPath:'a.png' };
  const now = new Date();
  const ticket = second.sign({
    run,
    actionId:parameters.actionId,
    operation:'image_generate',
    maximumCostCents:3,
    parameters,
    scopes:[
      { scopeType:'company', scopeId:run.companyId, remainingAmount:10 },
      { scopeType:'agent', scopeId:run.agentId, remainingAmount:10 },
      { scopeType:'project', scopeId:run.projectId, remainingAmount:10 },
    ],
    now,
  });
  const result = verifySignedBudgetTicket({
    ticket,
    publicKey:first.publicKey,
    run,
    actionId:parameters.actionId,
    operation:'image_generate',
    maximumCostCents:3,
    parameters,
    now,
  });
  assert.equal(result.allowed, true);
});

test('本机预算票据拒绝权限过宽或公私钥错配', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-budget-ticket-invalid-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'ticket.pem');
  await LocalBudgetTicketAuthority.open(file);
  await fs.chmod(file, 0o644);
  await assert.rejects(
    LocalBudgetTicketAuthority.open(file),
    /0600/,
  );
});
