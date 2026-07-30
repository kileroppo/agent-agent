import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalIntelResearcher } from '../src/local-intel-researcher.js';

const now = () => new Date('2026-07-23T00:00:00.000Z');

test('小R 使用给定公开来源产出结构化研究报告', async () => {
  const worker = new LocalIntelResearcher({ now, publicWebFetch:{ async acquire({ sourceUrl }) { return { sourceRef:sourceUrl, title:'公开资料', text:'第一项事实。第二项事实。', contentHash:'a'.repeat(64), fetchedAt:now().toISOString(), truncated:false }; } }, researchAdvisor:{ async analyze({ topic, sources }) { assert.equal(topic, '研究 Agent 运行时'); assert.equal(sources.length, 2); return { background:'背景', findings:['发现'], claims:[{ claimId:'claim-1', text:'发现', sourceIds:['source-1'], evidenceFragments:[{ sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'第一项事实。 第二项事实。' }] }], conclusion:'结论', recommendations:['建议'], openQuestions:['问题'], basis:'仅根据已读取的公开来源内容', aiAssisted:true }; } } });
  const result = await worker.execute({ taskId:'intel-1', assigneeAgentId:'intel-researcher', input:{ topic:'研究 Agent 运行时', sourceUrls:['https://example.com/a', 'https://example.com/b'] } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].type, 'intel_research_report');
  assert.equal(result.artifactRefs[0].data.conclusion, '结论');
  assert.deepEqual(result.artifactRefs[0].data.claims[0].sourceIds, ['source-1']);
  assert.equal(result.artifactRefs[0].data.claims[0].evidenceFragments[0].fragmentId, 'source-1-fragment-1');
  assert.equal(result.artifactRefs[0].validation.structured, true);
});

test('小R 没有来源且读取失败时明确 needs_input，不编造报告', async () => {
  const worker = new LocalIntelResearcher({ now, publicWebFetch:{ async acquire() { throw new Error('无法读取'); } }, publicWebSearch:{ async search() { return { results:[{ url:'https://example.com/a' }] }; } } });
  const result = await worker.execute({ taskId:'intel-fail', input:{ topic:'研究主题' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'research_sources_unavailable');
  assert.match(result.error.userMessage, /公开来源/);
});

test('小R 会将中文 Agent 权限治理主题转为公开可检索词，并在网页搜索无结果时回退 GitHub 元数据', async () => {
  let publicQuery = null;
  let githubQuery = null;
  const worker = new LocalIntelResearcher({
    now,
    publicWebFetch:{ async acquire() { throw new Error('不应读取空搜索结果'); } },
    publicWebSearch:{ async search({ query }) { publicQuery = query; return { results:[] }; } },
    githubSearch:{ async search({ query }) { githubQuery = query; return { searchedAt:now().toISOString(), results:[{ fullName:'example/agent-governance', description:'Public agent governance controls.', url:'https://github.com/example/agent-governance' }] }; } }
  });
  const result = await worker.execute({ taskId:'intel-governance', assigneeAgentId:'intel-researcher', input:{ topic:'帮我研究 Agent 军团的权限治理，给结论和建议。' } });
  assert.equal(publicQuery, 'agent governance');
  assert.equal(githubQuery, 'agent governance');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].data.sources[0].kind, 'github_metadata');
});

test('M5 研究和证据阶段生成不同的专用产物且至少绑定两个来源', async () => {
  const worker = new LocalIntelResearcher({
    now,
    publicWebFetch:{
      async acquire({ sourceUrl }) {
        return {
          sourceRef:sourceUrl,
          title:`公开资料 ${sourceUrl.at(-1)}`,
          text:'公开资料支持一个可核验结论。',
          contentHash:(sourceUrl.endsWith('/a') ? 'a' : 'b').repeat(64),
          fetchedAt:now().toISOString(),
          truncated:false,
        };
      },
    },
    researchAdvisor:{
      async analyze() {
        return {
          background:'背景',
          findings:['两个来源共同支持事实一'],
          claims:[{
            claimId:'claim-1',
            text:'两个来源共同支持事实一',
            sourceIds:['source-1', 'source-2'],
            evidenceFragments:[
              { sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'公开资料支持一个可核验结论。' },
              { sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'公开资料支持一个可核验结论。' },
            ],
          }],
          conclusion:'结论一',
          recommendations:['建议'],
          openQuestions:[],
          basis:'仅根据已读取的公开来源',
          aiAssisted:true,
        };
      },
    },
  });
  const context = {
    pipelineCase:{
      fields:{
        theme:'真实 Agent 工作流',
        scheduledDate:'2026-07-31',
      },
    },
  };
  const sourceUrls = ['https://example.com/a', 'https://example.com/b'];
  const research = await worker.execute({
    taskId:'m5-research',
    taskType:'content.campaign-research',
    input:{ context, sourceUrls },
  });
  const evidence = await worker.execute({
    taskId:'m5-evidence',
    taskType:'content.campaign-evidence',
    input:{ context, sourceUrls },
  });

  assert.equal(research.artifactRefs[0].type, 'campaign_research_report');
  assert.equal(research.artifactRefs[0].data.schemaVersion, 'agent.army/campaign-research/v2');
  assert.deepEqual(research.artifactRefs[0].data.claims[0].sourceIds, ['source-1', 'source-2']);
  assert.equal(research.artifactRefs[0].data.claims[0].evidenceFragments.length, 2);
  assert.equal(evidence.artifactRefs[0].type, 'evidence_package');
  assert.equal(evidence.artifactRefs[0].data.schemaVersion, 'agent.army/evidence-package/v2');
  assert.equal(evidence.artifactRefs[0].data.sources.length, 2);
  assert.deepEqual(evidence.artifactRefs[0].data.claims[0].sourceIds, ['source-1', 'source-2']);
  assert.equal(evidence.artifactRefs[0].data.claims[0].evidenceFragments.length, 2);
});

test('M5 研究单一来源时不会推进', async () => {
  const worker = new LocalIntelResearcher({
    now,
    publicWebFetch:{
      async acquire({ sourceUrl }) {
        return {
          sourceRef:sourceUrl,
          title:'唯一来源',
          text:'单一来源。',
          contentHash:'a'.repeat(64),
          fetchedAt:now().toISOString(),
          truncated:false,
        };
      },
    },
  });
  const result = await worker.execute({
    taskId:'m5-one-source',
    taskType:'content.campaign-research',
    input:{
      context:{ pipelineCase:{ fields:{ theme:'真实 Agent 工作流' } } },
      sourceUrls:['https://example.com/only'],
    },
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'campaign_research_minimum_sources');
});

test('M5 不把 GitHub 搜索元数据或缺少正文哈希的网页算作证据来源', async () => {
  const githubOnly = new LocalIntelResearcher({
    now,
    publicWebFetch:{ async acquire() { throw new Error('没有公开网页正文'); } },
    publicWebSearch:{ async search() { return { results:[] }; } },
    githubSearch:{ async search() {
      return {
        searchedAt:now().toISOString(),
        results:[
          { fullName:'example/a', description:'metadata a', url:'https://github.com/example/a' },
          { fullName:'example/b', description:'metadata b', url:'https://github.com/example/b' },
        ],
      };
    } },
  });
  const metadataResult = await githubOnly.execute({
    taskId:'m5-github-metadata',
    taskType:'content.campaign-research',
    input:{ topic:'Agent 治理' },
  });
  assert.equal(metadataResult.status, 'needs_input');
  assert.equal(metadataResult.error.code, 'campaign_research_minimum_sources');
  assert.match(metadataResult.error.userMessage, /GitHub 搜索元数据不能直接算证据/);

  const missingHash = new LocalIntelResearcher({
    now,
    publicWebFetch:{ async acquire({ sourceUrl }) {
      return {
        sourceRef:sourceUrl,
        title:'网页正文',
        text:'可读但没有内容哈希。',
        fetchedAt:now().toISOString(),
      };
    } },
  });
  const hashResult = await missingHash.execute({
    taskId:'m5-missing-hash',
    taskType:'content.campaign-research',
    input:{
      topic:'Agent 治理',
      sourceUrls:['https://example.com/a', 'https://example.com/b'],
    },
  });
  assert.equal(hashResult.status, 'needs_input');
  assert.equal(hashResult.error.code, 'campaign_research_minimum_sources');
});

test('小R 按来源类型只通过岗位上下文调用动态网页和 PDF 适配器', async () => {
  const calls = [];
  const worker = new LocalIntelResearcher({
    now,
    publicWebFetch:{ async acquire() { throw new Error('不应旁路公开读取'); } },
  });
  const roleToolContext = {
    async execute(input) {
      calls.push(input);
      return {
        sourceRef:input.url,
        title:input.toolId,
        text:'一项经过受控适配器读取的公开事实。',
        contentHash:'a'.repeat(64),
        fetchedAt:now().toISOString(),
      };
    },
  };
  const dynamicUrl = 'https://example.com/app';
  const pdfUrl = 'https://example.com/report.pdf';
  const result = await worker.execute({
    taskId:'intel-controlled-sources',
    taskType:'research.intel-report',
    input:{
      topic:'核对两类公开来源',
      sourceUrls:[dynamicUrl, pdfUrl],
      dynamicSourceUrls:[dynamicUrl],
      pdfSourceUrls:[pdfUrl],
    },
  }, { roleToolContext });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map((call) => call.toolId), [
    'content.public.dynamic.read',
    'content.public.pdf.read',
  ]);
  assert.deepEqual(result.artifactRefs[0].data.sources.map((source) => source.kind), [
    'public_dynamic_web',
    'public_pdf',
  ]);
  assert.equal(result.artifactRefs[0].data.sources.every((source) => source.contentHash === 'a'.repeat(64)), true);
});
