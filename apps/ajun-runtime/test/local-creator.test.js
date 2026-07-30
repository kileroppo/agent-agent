import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalCreator } from '../src/local-creator.js';

const task = {
  taskId: 'task-creator-1',
  input: { title: '创建微信聊天取件员' },
  source: { channel: 'paperclip', eventRef: 'paperclip:issue-1' },
  execution: { startedAt: '2026-07-29T01:00:00.000Z' }
};

const proposal = {
  proposalId: 'proposal-1',
  status: 'draft',
  candidateManifest: { name: '微信聊天取件员' },
  trialReadiness: { message: '等待受控适配器和专项审批。' }
};

test('审核提交失败时保留已创建草案并返回待审核结果', async () => {
  const creator = new LocalCreator({
    proposals: {
      create: async () => proposal,
      submit: async () => {
        throw new Error('审核官尚未形成可验证结论');
      }
    },
    now: () => new Date('2026-07-29T02:00:00.000Z')
  });

  const result = await creator.execute(task);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.currentStage, 'agent_proposal_drafted');
  assert.equal(result.execution.outcome, 'draft');
  assert.deepEqual(result.artifactRefs[0].data.reviewSubmission, {
    status: 'pending',
    reason: '审核官尚未形成可验证结论'
  });
});

test('审核提交成功时返回已提交结果', async () => {
  const creator = new LocalCreator({
    proposals: {
      create: async () => proposal,
      submit: async () => ({ ...proposal, status: 'pending_approval' })
    },
    now: () => new Date('2026-07-29T02:00:00.000Z')
  });

  const result = await creator.execute(task);

  assert.equal(result.currentStage, 'agent_proposal_submitted');
  assert.equal(result.execution.outcome, 'pending_approval');
  assert.deepEqual(result.artifactRefs[0].data.reviewSubmission, { status: 'submitted' });
});

test('创建官生成能力复用证据、缺口、最小沙箱实验和修订建议，同时复用proposal service', async () => {
  let createInput;
  let createdProposal;
  const creator = new LocalCreator({
    proposals:{
      async create(input) {
        createInput = input;
        createdProposal = {
          ...proposal,
          candidateManifest:{ name:'公开资料核验员' },
          trialReadiness:{ status:'needs_capability', message:'缺少真实执行能力。' }
        };
        return createdProposal;
      },
      async submit() {
        return { ...createdProposal, status:'pending_approval' };
      }
    },
    now:() => new Date('2026-07-29T02:00:00.000Z')
  });
  const result = await creator.execute(task, { proposalInput:{
    requestedOutcome:'核验公开资料并交付证据表',
    candidateName:'公开资料核验员',
    acceptedTaskTypes:['research.verify-public-source'],
    requestedCapabilities:['content.public.fetch', 'evidence.table.write'],
    capabilityCatalog:[
      {
        capabilityId:'content.public.fetch',
        source:'existing-adapter',
        version:'1.2.0',
        auditStatus:'passed',
        evidenceRefs:['integrations/access/content-acquisition-center.js']
      }
    ],
    acceptanceTitle:'用一条公开网页生成证据表'
  } });
  const design = result.artifactRefs[0].data.capabilityDesign;
  assert.deepEqual(createInput.requestedCapabilities, ['content.public.fetch', 'evidence.table.write']);
  assert.equal(design.reuseEvidence[0].recommendation, 'reuse_existing');
  assert.equal(design.gaps[0].capabilityId, 'evidence.table.write');
  assert.deepEqual(design.sandboxExperiment.targetCapabilities, ['evidence.table.write']);
  assert.equal(design.sandboxExperiment.productionActivationAuthorized, false);
  assert.equal(design.revisionAdvice.some((item) => item.includes('evidence.table.write')), true);
  assert.equal(design.revisionAdvice.includes('缺少真实执行能力。'), true);
});
