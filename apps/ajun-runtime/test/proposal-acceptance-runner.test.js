import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalAcceptanceRunner } from '../src/proposal-acceptance-runner.js';

const instance = { testInstanceId:'test-1' };

test('小G受限测试只把白名单关键词交给公开 GitHub 执行器', async () => {
  let received = null;
  const runner = new ProposalAcceptanceRunner({ githubScout:{ async execute(task) { received = task; return { status:'succeeded', artifactRefs:[{ title:'GitHub 检索报告', location:'runtime://test/github', validation:{ exists:true, readable:true, nonEmpty:true } }] }; } } });
  const result = await runner.run({ proposal:{ requestedCapabilities:['github.public.search', 'github.public.read'], candidateManifest:{ agentId:'github-scout', acceptedTaskTypes:['research.github-search'] } }, testInstance:instance, query:'node http server' });
  assert.equal(result.status, 'succeeded');
  assert.equal(received.assigneeAgentId, 'github-scout');
  assert.equal(received.input.query, 'node http server');
});

test('小R受限测试只把主题和公开来源交给研究执行器', async () => {
  let received = null;
  const runner = new ProposalAcceptanceRunner({ intelResearcher:{ async execute(task) { received = task; return { status:'succeeded', artifactRefs:[{ title:'研究报告', location:'runtime://test/research', validation:{ exists:true, readable:true, nonEmpty:true } }] }; } } });
  const result = await runner.run({ proposal:{ requestedCapabilities:['content.public.fetch', 'github.public.search', 'github.public.read'], candidateManifest:{ agentId:'intel-researcher', acceptedTaskTypes:['research.intel-report'] } }, testInstance:instance, topic:'本地 Agent 治理', sourceUrls:['https://example.com/public'] });
  assert.equal(result.status, 'succeeded');
  assert.equal(received.assigneeAgentId, 'intel-researcher');
  assert.equal(received.input.topic, '本地 Agent 治理');
  assert.deepEqual(received.input.sourceUrls, ['https://example.com/public']);
});

test('小G、小R受限测试拒绝缺少必要输入或越权白名单', async () => {
  const runner = new ProposalAcceptanceRunner();
  await assert.rejects(() => runner.run({ proposal:{ requestedCapabilities:['github.public.search', 'github.public.read'], candidateManifest:{ agentId:'github-scout', acceptedTaskTypes:['research.github-search'] } }, testInstance:instance }), /关键词/);
  await assert.rejects(() => runner.run({ proposal:{ requestedCapabilities:['content.public.fetch', 'github.public.write'], candidateManifest:{ agentId:'intel-researcher', acceptedTaskTypes:['research.intel-report'] } }, testInstance:instance, topic:'x' }), /没有可自动验证/);
});
