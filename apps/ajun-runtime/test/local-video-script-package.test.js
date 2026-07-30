import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalVideoScriptPackage } from '../src/local-video-script-package.js';

test('M5 脚本把同一 Case 的证据结论逐字绑定到至少两个来源', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-script-evidence-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const evidenceTask = {
    taskId:'m5-evidence-task',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'evidence:m5',
      type:'evidence_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        schemaVersion:'agent.army/evidence-package/v2',
        sources:[
          {
            sourceId:'source-1',
            url:'https://example.com/a',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'a'.repeat(64),
            kind:'public_web',
            evidenceFragments:[{ fragmentId:'source-1-fragment-1', text:'来源 A 原文。' }],
          },
          {
            sourceId:'source-2',
            url:'https://example.com/b',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'b'.repeat(64),
            kind:'public_pdf',
            evidenceFragments:[{ fragmentId:'source-2-fragment-1', text:'来源 B 原文。' }],
          },
        ],
        claims:[{
          claimId:'claim-1',
          text:'Paperclip 管流程，Hermes 执行岗位任务。',
          sourceIds:['source-1', 'source-2'],
          evidenceFragments:[
            { sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'来源 A 原文。' },
            { sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'来源 B 原文。' },
          ],
        }],
        prohibitedStatements:['无来源效果承诺'],
      },
    }],
  };
  const visualTask = {
    taskId:'m5-visual-task',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'visual:m5',
      type:'visual_analysis_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        insights:[{
          insightId:'visual-1',
          finding:'使用产品流程画面承接该结论。',
          frameRef:'frame-1',
          timestamp:'00:03',
          evidenceKind:'keyframe',
        }],
      },
    }],
  };
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(root, 'out'),
  });
  const result = await executor.execute({
    taskId:'m5-script-task',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  }, { allowAdvisor:false });
  const script = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded');
  assert.match(script.fullScript, /Paperclip 管流程，Hermes 执行岗位任务/);
  assert.deepEqual(script.factBindings[0].sourceIds, ['source-1', 'source-2']);
  assert.equal(script.factBindings[0].evidenceFragments.length, 2);
  assert.equal(script.visualAnalysisBindings[0].frameRef, 'frame-1');
  assert.equal(script.visualAnalysisBindings[0].timestamp, '00:03');
  assert.equal(script.shots[0].evidenceKind, 'keyframe');
  assert.equal(script.sources.length, 2);
  const sourcesFile = script.productionFiles.find((file) => file.fileName === 'sources.md');
  const sourcesText = await fs.readFile(new URL(sourcesFile.location), 'utf8');
  assert.match(sourcesText, /https:\/\/example\.com\/a/);
  assert.match(sourcesText, /a{64}/);
});

test('M5 脚本缺少 VisualAnalysisPackage 时拒绝继续', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-script-visual-required-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const evidenceTask = {
    taskId:'m5-evidence-only',
    artifactRefs:[{
      artifactId:'evidence:m5-only',
      type:'evidence_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        schemaVersion:'agent.army/evidence-package/v2',
        sources:[
          {
            sourceId:'source-1',
            url:'https://example.com/a',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'a'.repeat(64),
            kind:'public_web',
            evidenceFragments:[{ fragmentId:'source-1-f1', text:'来源 A。' }],
          },
          {
            sourceId:'source-2',
            url:'https://example.com/b',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'b'.repeat(64),
            kind:'public_pdf',
            evidenceFragments:[{ fragmentId:'source-2-f1', text:'来源 B。' }],
          },
        ],
        claims:[{
          claimId:'claim-1',
          text:'有来源结论。',
          sourceIds:['source-1', 'source-2'],
          evidenceFragments:[
            { sourceId:'source-1', fragmentId:'source-1-f1', text:'来源 A。' },
            { sourceId:'source-2', fragmentId:'source-2-f1', text:'来源 B。' },
          ],
        }],
      },
    }],
  };
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask] },
    artifactsDir:path.join(root, 'out'),
  });
  const result = await executor.execute({
    taskId:'m5-script-without-visual',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{ paperclipRoutineKey:'m5-script', sourceTaskIds:[evidenceTask.taskId] },
    },
  }, { allowAdvisor:false });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'm5_visual_analysis_package_required');
});

test('M5 脚本拒绝把 GitHub metadata 或无片段 claim 当证据', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-script-invalid-evidence-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const evidenceTask = {
    taskId:'m5-invalid-evidence-task',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'evidence:invalid',
      type:'evidence_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        schemaVersion:'agent.army/evidence-package/v2',
        sources:[
          {
            sourceId:'source-1',
            url:'https://github.com/example/repo',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'a'.repeat(64),
            kind:'github_metadata',
            evidenceFragments:[{ fragmentId:'source-1-fragment-1', text:'仓库描述。' }],
          },
          {
            sourceId:'source-2',
            url:'https://example.com/b',
            fetchedAt:'2026-07-30T00:00:00.000Z',
            contentHash:'b'.repeat(64),
            kind:'public_web',
            evidenceFragments:[{ fragmentId:'source-2-fragment-1', text:'网页正文。' }],
          },
        ],
        claims:[{
          claimId:'claim-1',
          text:'不能成立的结论。',
          sourceIds:['source-1', 'source-2'],
          evidenceFragments:[],
        }],
      },
    }],
  };
  const executor = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask] },
    artifactsDir:path.join(root, 'out'),
  });
  const result = await executor.execute({
    taskId:'m5-invalid-script-task',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        sourceTaskIds:[evidenceTask.taskId],
      },
    },
  }, { allowAdvisor:false });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'm5_evidence_package_required');
});

test('只给主题时自动复用同会话参考案例并生成五件受控生产包', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-package-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const analysisTask = {
    taskId:'analysis-1',
    status:'succeeded',
    source:{ channel:'feishu', chatRef:'chat-1' },
    updatedAt:'2026-07-28T01:00:00.000Z',
    artifactRefs:[{
      artifactId:'analysis-artifact-1',
      type:'video_content_analysis_report',
      title:'参考视频拆解',
      data:{
        evidenceMode:'formal',
        title:'AI 会不会让人失业',
        summary:'用冲突问题开场，再解释限制条件。',
        reusablePatterns:['冲突设问', '解释前提', '行动收束'],
        modules:[{ name:'爆款结构模板', structureTemplate:{ opening:'冲突设问', body:'解释前提', ending:'行动收束' } }]
      }
    }]
  };
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return [analysisTask]; } },
    artifactsDir:path.join(root, 'artifacts'),
    researcher:{ async execute() {
      return {
        status:'succeeded',
        artifactRefs:[{
          type:'intel_research_report',
          data:{ sources:[{ title:'公开资料', source:'https://example.com/report', summary:'自动化会改变任务结构。', fetchedAt:'2026-07-28T00:00:00.000Z' }] }
        }]
      };
    } }
  });
  const result = await creator.execute({
    taskId:'script-1',
    taskType:'content.video-script-package',
    assigneeAgentId:'content-creator',
    source:{ channel:'feishu', chatRef:'chat-1' },
    input:{ title:'写一个 AI 会不会让人失业的视频脚本' }
  }, { allowAdvisor:false });

  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.type, 'video_script_package');
  assert.equal(artifact.data.referenceMatch.type, 'reference_case');
  assert.equal(artifact.data.platform, 'douyin');
  assert.equal(artifact.validation.fileCount, 5);
  assert.equal(artifact.validation.externalSideEffects, 0);
  assert.deepEqual(artifact.data.productionFiles.map((item) => item.fileName).sort(), [
    'manifest.json', 'script.md', 'shots.json', 'sources.md', 'subtitles.srt'
  ]);
  for (const file of artifact.data.productionFiles) {
    const stat = await fs.stat(new URL(file.location));
    assert.ok(stat.size > 0);
    assert.equal(file.checksum.length, 64);
  }
  assert.match(await fs.readFile(new URL(artifact.location), 'utf8'), /## 完整口播稿/);
  assert.equal(artifact.data.templateLifecycle.caseOnly, true);
});

test('回复用这版后只把上一版升级为 trial，不发布也不生成成片', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-script-approve-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const initialCreator = new LocalVideoScriptPackage({
    store:{ async list() { return []; } },
    artifactsDir:path.join(root, 'artifacts')
  });
  const initial = await initialCreator.execute({
    taskId:'script-draft',
    taskType:'content.video-script-package',
    source:{ channel:'feishu', chatRef:'chat-2' },
    input:{ title:'一个务实的短视频主题', researchMode:'off' }
  }, { allowAdvisor:false });
  const draftTask = {
    taskId:'script-draft',
    status:'succeeded',
    source:{ channel:'feishu', chatRef:'chat-2' },
    artifactRefs:initial.artifactRefs
  };
  const creator = new LocalVideoScriptPackage({
    store:{ async list() { return [draftTask]; } },
    artifactsDir:path.join(root, 'artifacts')
  });
  const approved = await creator.execute({
    taskId:'script-approved',
    taskType:'content.video-script-package',
    source:{ channel:'feishu', chatRef:'chat-2' },
    input:{ title:'采用脚本', approvedForUse:true, sourceScriptTaskId:'script-draft', context:{ sourceTaskIds:['script-draft'] } }
  });
  const artifact = approved.artifactRefs[0];
  assert.equal(artifact.data.templateLifecycle.state, 'trial');
  assert.equal(artifact.data.templateLifecycle.approvedForUse, true);
  assert.equal(artifact.data.publishingStatus, 'draft_only');
  assert.equal(artifact.validation.externalSideEffects, 0);
});
