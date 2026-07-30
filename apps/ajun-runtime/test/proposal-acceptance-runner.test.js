import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProposalAcceptanceRunner } from '../src/proposal-acceptance-runner.js';

const instance = { testInstanceId:'test-1' };

test('小R受限测试只把主题和公开来源交给研究执行器', async () => {
  let received = null;
  const runner = new ProposalAcceptanceRunner({ intelResearcher:{ async execute(task) { received = task; return { status:'succeeded', artifactRefs:[{ title:'研究报告', location:'runtime://test/research', validation:{ exists:true, readable:true, nonEmpty:true } }] }; } } });
  const result = await runner.run({ proposal:{ requestedCapabilities:['content.public.fetch', 'github.public.search', 'github.public.read'], candidateManifest:{ agentId:'intel-researcher', acceptedTaskTypes:['research.intel-report'] } }, testInstance:instance, topic:'本地 Agent 治理', sourceUrls:['https://example.com/public'] });
  assert.equal(result.status, 'succeeded');
  assert.equal(received.assigneeAgentId, 'intel-researcher');
  assert.equal(received.input.topic, '本地 Agent 治理');
  assert.deepEqual(received.input.sourceUrls, ['https://example.com/public']);
});

test('小R受限测试拒绝缺少必要输入或越权白名单', async () => {
  const runner = new ProposalAcceptanceRunner();
  await assert.rejects(() => runner.run({ proposal:{ requestedCapabilities:['content.public.fetch', 'github.public.write'], candidateManifest:{ agentId:'intel-researcher', acceptedTaskTypes:['research.intel-report'] } }, testInstance:instance, topic:'x' }), /没有可自动验证/);
});

test('小拆受限测试只接收明确引用的任务和证据模式', async () => {
  let received = null;
  const runner = new ProposalAcceptanceRunner({
    videoContentAnalyst:{ async execute(task) {
      received = task;
      return { status:'succeeded', artifactRefs:[{ title:'完整拆解', location:'file:///tmp/analysis.md', validation:{ exists:true, readable:true, nonEmpty:true } }] };
    } }
  });
  const result = await runner.run({
    proposal:{
      proposalId:'proposal-video',
      requestedCapabilities:['army.task.status.read', 'content.artifact.read', 'content.analysis.write'],
      candidateManifest:{ agentId:'video-content-analyst', name:'小拆', acceptedTaskTypes:['content.video-benchmark-analysis', 'content.performance-review'] },
      acceptanceTask:{ taskType:'content.video-benchmark-analysis', title:'受限拆解' }
    },
    testInstance:instance,
    sourceTaskIds:['media-confirmed-1'],
    depth:'full',
    evidenceMode:'formal',
    focus:'开场证据'
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(received.taskType, 'content.video-benchmark-analysis');
  assert.equal(received.input.depth, 'full');
  assert.equal(received.input.evidenceMode, 'formal');
  assert.deepEqual(received.input.context.sourceTaskIds, ['media-confirmed-1']);
});

test('小创受限测试必须引用上游任务并明确平台', async () => {
  const runner = new ProposalAcceptanceRunner({
    contentCreator:{ async execute(task) {
      return { status:'succeeded', artifactRefs:[{ title:`${task.input.platforms.length} 个平台草稿`, location:'file:///tmp/draft.md', validation:{ exists:true, readable:true, nonEmpty:true } }] };
    } }
  });
  const proposal = {
    proposalId:'proposal-creator',
    requestedCapabilities:['army.task.status.read', 'content.artifact.read', 'content.draft.write'],
    candidateManifest:{ agentId:'content-creator', name:'小创', acceptedTaskTypes:['content.platform-draft'] },
    acceptanceTask:{ taskType:'content.platform-draft', title:'受限创作' }
  };
  await assert.rejects(() => runner.run({ proposal, testInstance:instance, sourceTaskIds:['analysis-1'] }), /明确目标平台/);
  const result = await runner.run({ proposal, testInstance:instance, sourceTaskIds:['confirmed-1', 'analysis-1'], platforms:['douyin'] });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].title, '1 个平台草稿');
});

test('微信聊天取件员受限测试只调用合成 Vault 验收器', async () => {
  let received = null;
  const runner = new ProposalAcceptanceRunner({
    wechatLocalVault:{
      async run(input) {
        received = input;
        return {
          status:'succeeded',
          artifactRefs:[{
            title:'微信聊天受控读取合成验收报告',
            location:'file:///tmp/wechat-acceptance.json',
            validation:{ exists:true, readable:true, nonEmpty:true, syntheticOnly:true, realChatRead:false }
          }]
        };
      }
    }
  });
  const proposal = {
    proposalId:'proposal-wechat',
    requestedCapabilities:['wechat.local-vault.chat.read'],
    candidateManifest:{ agentId:'wechat-chat-retriever', acceptedTaskTypes:['wechat.chat.retrieval.request'] }
  };

  const result = await runner.run({ proposal, testInstance:instance });

  assert.equal(result.status, 'succeeded');
  assert.equal(received.proposal.proposalId, 'proposal-wechat');
  assert.equal(result.artifactRefs[0].validation.realChatRead, false);
});

test('内联受限验收稿只落受控目录，并明确不代表真实视频听审', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proposal-content-acceptance-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  let receivedArtifacts = null;
  const runner = new ProposalAcceptanceRunner({
    artifactsDir:root,
    videoContentAnalyst:{ async execute(_task, options) {
      receivedArtifacts = options.sourceArtifacts;
      return { status:'succeeded', artifactRefs:[{ title:'完整拆解', location:'file:///tmp/analysis.md', validation:{ exists:true, readable:true, nonEmpty:true } }] };
    } }
  });
  const result = await runner.run({
    proposal:{
      proposalId:'proposal-video-inline',
      requestedCapabilities:['army.task.status.read', 'content.artifact.read', 'content.analysis.write'],
      candidateManifest:{ agentId:'video-content-analyst', acceptedTaskTypes:['content.video-benchmark-analysis'] },
      acceptanceTask:{ taskType:'content.video-benchmark-analysis' }
    },
    testInstance:{ testInstanceId:'test-inline-1' },
    acceptanceTranscript:'[00:00] 这是只用于受限技术验收的安全稿件。\n[00:05] 它不代表真人已经完整听审真实视频。',
    depth:'full'
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(receivedArtifacts[0].validation.restrictedAcceptanceOnly, true);
  assert.equal(receivedArtifacts[0].validation.realVideoReview, false);
  assert.ok(receivedArtifacts[0].location.startsWith(`file://${root}/`));
});
