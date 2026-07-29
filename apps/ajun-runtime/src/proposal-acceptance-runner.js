import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class ProposalAcceptanceRunner {
  constructor({ publicReport, intelResearcher = null, videoContentAnalyst = null, contentCreator = null, artifactsDir = null, now = () => new Date() } = {}) {
    this.publicReport = publicReport;
    this.intelResearcher = intelResearcher;
    this.videoContentAnalyst = videoContentAnalyst;
    this.contentCreator = contentCreator;
    this.artifactsDir = artifactsDir ? path.resolve(artifactsDir) : null;
    this.now = now;
  }

  async run({
    proposal,
    testInstance,
    sourceUrl = '',
    sourceUrls = [],
    query = null,
    topic = null,
    title = null,
    sourceTaskIds = [],
    depth = 'fast',
    evidenceMode = 'formal',
    focus = null,
    platforms = [],
    contentGoal = null,
    metrics = null,
    acceptanceTranscript = null
  }) {
    const agentId = proposal?.candidateManifest?.agentId;
    const task = {
      taskId: `proposal-test:${testInstance.testInstanceId}`,
      assigneeAgentId: agentId,
      taskType:proposal?.acceptanceTask?.taskType || proposal?.candidateManifest?.acceptedTaskTypes?.[0],
      idempotencyKey:`proposal-acceptance:${proposal?.proposalId || testInstance.testInstanceId}`,
      input:{
        title:title || proposal?.acceptanceTask?.title || proposal?.candidateManifest?.name,
        sourceUrl,
        sourceUrls,
        query,
        topic,
        depth,
        evidenceMode,
        focus,
        platforms,
        contentGoal,
        metrics,
        context:{ sourceTaskIds }
      }
    };
    if (agentId === 'intel-researcher' && exactCapabilities(proposal, ['content.public.fetch', 'github.public.search', 'github.public.read'])) {
      if (!topic) throw new Error('小R的受限测试需要一个研究主题。');
      return this.intelResearcher?.execute(task) || Promise.reject(new Error('小R受限测试执行器不可用。'));
    }
    if (proposal.requestedCapabilities?.includes('content.public.fetch') && proposal.candidateManifest?.acceptedTaskTypes?.join(',') === 'report.public-material') return this.publicReport.execute(task);
    if (agentId === 'video-content-analyst' && exactCapabilities(proposal, ['army.task.status.read', 'content.artifact.read', 'content.analysis.write'])) {
      if (!this.videoContentAnalyst) throw new Error('小拆受限测试执行器不可用。');
      if (acceptanceTranscript) {
        const transcriptArtifact = await this.writeAcceptanceTranscript({ proposal, testInstance, text:acceptanceTranscript });
        return this.videoContentAnalyst.execute(task, { sourceArtifacts:[transcriptArtifact], allowAdvisor:false });
      }
      if (!sourceTaskIds.length) throw new Error('小拆受限测试必须明确引用确认稿任务或提供受控验收稿。');
      return this.videoContentAnalyst.execute(task);
    }
    if (agentId === 'content-creator' && (
      exactCapabilities(proposal, ['army.task.status.read', 'content.artifact.read', 'content.draft.write'])
      || exactCapabilities(proposal, ['army.task.status.read', 'content.artifact.read', 'content.draft.write', 'content.public.search', 'content.public.read'])
    )) {
      if (!this.contentCreator) throw new Error('小创受限测试执行器不可用。');
      if (!platforms.length) throw new Error('小创受限测试必须明确目标平台。');
      if (acceptanceTranscript) {
        if (!this.videoContentAnalyst) throw new Error('小创受限测试缺少正式拆解执行器。');
        const transcriptArtifact = await this.writeAcceptanceTranscript({ proposal, testInstance, text:acceptanceTranscript });
        const analysisTask = {
          ...task,
          taskId:`${task.taskId}:analysis`,
          taskType:'content.video-benchmark-analysis',
          assigneeAgentId:'video-content-analyst',
          input:{ ...task.input, depth:'full', evidenceMode:'formal' }
        };
        const analysis = await this.videoContentAnalyst.execute(analysisTask, { sourceArtifacts:[transcriptArtifact], allowAdvisor:false });
        const analysisArtifact = analysis?.artifactRefs?.find((item) => item.type === 'video_content_analysis_report');
        if (analysis?.status !== 'succeeded' || !analysisArtifact) throw new Error('小创受限测试未能生成正式拆解前置产物。');
        return this.contentCreator.execute(task, { sourceArtifacts:[transcriptArtifact, analysisArtifact], allowAdvisor:false });
      }
      if (!sourceTaskIds.length) throw new Error('小创受限测试必须引用确认稿和正式拆解。');
      return this.contentCreator.execute(task);
    }
    throw new Error('当前草案没有可自动验证的受限试用范围。');
  }

  async writeAcceptanceTranscript({ proposal, testInstance, text }) {
    if (!this.artifactsDir) throw new Error('受限验收产物目录未配置。');
    const content = String(text || '').trim();
    if (content.length < 40 || content.length > 80_000) throw new Error('受控验收稿长度必须在 40 到 80000 字符之间。');
    const directory = path.resolve(this.artifactsDir, safeSegment(proposal.proposalId), safeSegment(testInstance.testInstanceId));
    if (!directory.startsWith(`${this.artifactsDir}${path.sep}`)) throw new Error('受限验收产物路径越界。');
    await fs.mkdir(directory, { recursive:true });
    const filePath = path.join(directory, 'confirmed-acceptance-transcript.md');
    const markdown = [
      '---',
      'schemaVersion: agent.army/restricted-acceptance-transcript/v1',
      'humanConfirmed: true',
      'realVideoReview: false',
      'purpose: restricted-technical-acceptance-only',
      `generatedAt: ${this.now().toISOString()}`,
      '---',
      '',
      '# 受限技术验收稿',
      '',
      content,
      ''
    ].join('\n');
    await fs.writeFile(filePath, markdown, { encoding:'utf8', mode:0o600 });
    return {
      artifactId:`restricted-confirmed-transcript:${testInstance.testInstanceId}`,
      taskId:`proposal-test:${testInstance.testInstanceId}`,
      type:'confirmed_transcript',
      title:'受限技术验收确认稿（非真实视频听审）',
      location:pathToFileURL(filePath).href,
      mimeType:'text/markdown',
      checksum:crypto.createHash('sha256').update(markdown).digest('hex'),
      accessScope:'local-owner',
      createdAt:this.now().toISOString(),
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        humanConfirmed:true,
        restrictedAcceptanceOnly:true,
        realVideoReview:false
      }
    };
  }
}

function exactCapabilities(proposal, expected) {
  const capabilities = proposal?.requestedCapabilities || [];
  return capabilities.length === expected.length && expected.every((item) => capabilities.includes(item));
}

function safeSegment(value) {
  return String(value || 'test').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'test';
}
