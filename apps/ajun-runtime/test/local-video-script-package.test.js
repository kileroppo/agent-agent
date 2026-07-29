import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalVideoScriptPackage } from '../src/local-video-script-package.js';

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
