import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createSignedBudgetTicket,
  verifySignedBudgetTicket,
} from '../src/signed-budget-ticket.ts';

const pair = crypto.generateKeyPairSync('ed25519');
const run = {
  companyId:'11111111-1111-4111-8111-111111111111',
  agentId:'22222222-2222-4222-8222-222222222222',
  projectId:'33333333-3333-4333-8333-333333333333',
  runId:'44444444-4444-4444-8444-444444444444',
};
const scopes = [
  { scopeType:'company', scopeId:run.companyId, remainingAmount:600 },
  { scopeType:'agent', scopeId:run.agentId, remainingAmount:600 },
  { scopeType:'project', scopeId:run.projectId, remainingAmount:600 },
];
const parameters = {
  actionId:'action:image:ticket:1',
  prompt:'不进入票据明文',
  outputPath:'cover.png',
};

test('签名预算票据绑定公司岗位项目Run、action、参数和费用', () => {
  const now = new Date('2026-07-30T00:00:00.000Z');
  const ticket = createSignedBudgetTicket({
    privateKey:pair.privateKey,
    run,
    actionId:parameters.actionId,
    operation:'image_generate',
    maximumCostCents:3,
    parameters,
    scopes,
    now,
  });
  const result = verifySignedBudgetTicket({
    ticket,
    publicKey:pair.publicKey,
    run,
    actionId:parameters.actionId,
    operation:'image_generate',
    maximumCostCents:3,
    parameters:{ ...parameters, budgetTicket:ticket },
    now,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reservedCents, 3);
  assert.equal(result.scopes.company.scopeId, run.companyId);
});

test('签名预算票据拒绝改参数、改Run、改费用、过期和伪造签名', () => {
  const now = new Date('2026-07-30T00:00:00.000Z');
  const ticket = createSignedBudgetTicket({
    privateKey:pair.privateKey,
    run,
    actionId:parameters.actionId,
    operation:'image_generate',
    maximumCostCents:3,
    parameters,
    scopes,
    now,
    ttlSeconds:30,
  });
  const base = {
    ticket,
    publicKey:pair.publicKey,
    run,
    actionId:parameters.actionId,
    operation:'image_generate',
    maximumCostCents:3,
    parameters,
    now,
  };
  for (const override of [
    { parameters:{ ...parameters, outputPath:'other.png' } },
    { run:{ ...run, runId:'55555555-5555-4555-8555-555555555555' } },
    { maximumCostCents:4 },
    { now:new Date('2026-07-30T00:01:00.000Z') },
    { ticket:`${ticket.slice(0, -2)}xx` },
  ]) {
    assert.throws(
      () => verifySignedBudgetTicket({ ...base, ...override }),
      /Provider 未调用/,
    );
  }
});
