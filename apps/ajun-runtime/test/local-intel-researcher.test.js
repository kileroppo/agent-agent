import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalIntelResearcher } from '../src/local-intel-researcher.ts';

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

test('小R 拆分来源 Module 后仍保留可覆写发现、读取和运行时 Adapter 接缝', async () => {
  const calls = [];
  const worker = new LocalIntelResearcher({ now });
  worker.discover = async () => {
    calls.push('discover');
    return { urls:['https://example.com/runtime'], searched:true, searchCalls:1 };
  };
  worker.readSources = async () => {
    calls.push('read');
    return {
      sources:[{
        kind:'public_web',
        title:'运行时接缝',
        source:'https://example.com/runtime',
        summary:'来源 Module 仍通过公开扩展点读取。',
        contentHash:'a'.repeat(64),
        fetchedAt:now().toISOString(),
      }],
      failures:[],
    };
  };

  const result = await worker.execute({ taskId:'intel-runtime-seam', input:{ topic:'运行时接缝' } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, ['discover', 'read']);

  const replacementCalls = [];
  const replacementWorker = new LocalIntelResearcher({ now });
  replacementWorker.publicWebFetch = {
    async acquire({ sourceUrl }) {
      replacementCalls.push(sourceUrl);
      return {
        sourceRef:sourceUrl,
        title:'替换后 Adapter',
        text:'实例创建后替换的 Adapter 仍然生效。',
        contentHash:'b'.repeat(64),
        fetchedAt:now().toISOString(),
      };
    },
  };
  const replacement = await replacementWorker.execute({
    taskId:'intel-runtime-adapter',
    input:{ topic:'Adapter 替换', sourceUrl:'https://example.com/replacement' },
  });
  assert.equal(replacement.status, 'succeeded');
  assert.deepEqual(replacementCalls, ['https://example.com/replacement']);
});

test('小R 没有来源且读取失败时明确 needs_input，不编造报告', async () => {
  const worker = new LocalIntelResearcher({ now, publicWebFetch:{ async acquire() { throw new Error('无法读取'); } }, publicWebSearch:{ async search() { return { results:[{ url:'https://example.com/a' }] }; } } });
  const result = await worker.execute({ taskId:'intel-fail', input:{ topic:'研究主题' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'research_sources_unavailable');
  assert.match(result.error.userMessage, /公开来源/);
});

test('小R 不把抓取失败页和跳转占位页当作研究证据', async () => {
  let analyzedSources = null;
  const worker = new LocalIntelResearcher({
    now,
    publicWebFetch:{
      async acquire({ sourceUrl }) {
        const placeholder = sourceUrl.endsWith('/placeholder');
        return {
          sourceRef:sourceUrl,
          title:placeholder ? '未提供标题的公开来源' : '义乌天气',
          text:placeholder
            ? 'Please click here if the page does not redirect automatically . . .'
            : '义乌今天小雨，明天多云。',
          contentHash:(placeholder ? 'a' : 'b').repeat(64),
          fetchedAt:now().toISOString(),
        };
      },
    },
    researchAdvisor:{
      async analyze({ sources }) {
        analyzedSources = sources;
        return {
          background:'背景', findings:['义乌今天小雨'],
          claims:[{ claimId:'claim-1', text:'义乌今天小雨', sourceIds:['source-2'], evidenceFragments:[{ sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'义乌今天小雨，明天多云。' }] }],
          conclusion:'义乌今天小雨', recommendations:[], openQuestions:[], basis:'公开天气正文', aiAssisted:true,
        };
      },
    },
  });
  const result = await worker.execute({
    taskId:'intel-placeholder-filter',
    taskType:'research.intel-report',
    input:{ topic:'义乌天气', sourceUrls:['https://example.com/placeholder', 'https://weather.example.com/yiwu'] },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(analyzedSources.length, 1);
  assert.equal(analyzedSources[0].source, 'https://weather.example.com/yiwu');
  assert.equal(result.artifactRefs[0].data.sources[0].evidenceEligible, false);
  assert.equal(result.artifactRefs[0].data.sources[0].evidenceExclusionReason, 'fetch_error_or_redirect_placeholder');
  assert.equal(result.artifactRefs[0].validation.evidenceSourceCount, 1);
});

test('小R 的 Grok 公开 X 检索只有绑定公开来源链接后才生成标准研究报告', async () => {
  const worker = new LocalIntelResearcher({
    now,
    grokConsult:{
      async health() { return { status:'ready' }; },
      async searchX() {
        return { text:'公开讨论集中在运行稳定性。来源：https://x.com/example/status/123', route:'yichen-grok-consult-mcp' };
      },
    },
  });

  const result = await worker.execute({ taskId:'intel-grok', taskType:'research.intel-report', input:{ title:'用 Grok 搜索 X/Twitter 上的 Agent 讨论' } });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].type, 'intel_research_report');
  assert.equal(result.artifactRefs[0].validation.sourceUrlsPresent, true);
  assert.equal(result.artifactRefs[0].data.conclusion, '公开讨论集中在运行稳定性。来源：https://x.com/example/status/123');
  assert.deepEqual(result.artifactRefs[0].data.sources, [{ title:'公开 X 来源 1', source:'https://x.com/example/status/123' }]);
});

test('Grok 查询文本没有公开来源链接时转为待测试而不冒充研究成功', async () => {
  const worker = new LocalIntelResearcher({
    now,
    grokConsult:{
      async health() { return { status:'ready' }; },
      async searchX() { return { text:'只有一段未附来源的结论。', route:'yichen-grok-consult-mcp' }; },
    },
  });

  const result = await worker.execute({ taskId:'intel-grok-no-source', taskType:'research.intel-report', input:{ title:'用 Grok 搜索 Twitter 上的 Agent 讨论' } });

  assert.equal(result.status, 'waiting_test');
  assert.equal(result.error.code, 'grok_public_sources_missing');
  assert.equal(result.artifactRefs[0].type, 'intel_x_search_raw_result');
  assert.equal(result.artifactRefs[0].validation.sourceUrlsPresent, false);
});

test('小R 会将主题扩展为六路查询，并在网页搜索无结果时用中性词回退 GitHub 元数据', async () => {
  const publicQueries = [];
  let githubQuery = null;
  const worker = new LocalIntelResearcher({
    now,
    publicWebFetch:{ async acquire() { throw new Error('不应读取空搜索结果'); } },
    publicWebSearch:{ async search({ query }) { publicQueries.push(query); return { results:[] }; } },
    githubSearch:{ async search({ query }) { githubQuery = query; return { searchedAt:now().toISOString(), results:[{ fullName:'example/agent-governance', description:'Public agent governance controls.', url:'https://github.com/example/agent-governance' }] }; } }
  });
  const result = await worker.execute({ taskId:'intel-governance', assigneeAgentId:'intel-researcher', input:{ topic:'帮我研究 Agent 军团的权限治理，给结论和建议。' } });
  assert.equal(publicQueries.length, 6);
  assert.equal(publicQueries[0], 'agent governance');
  assert.match(publicQueries.join('\n'), /official data report regulation research/);
  assert.match(publicQueries.join('\n'), /criticism limitations.*debunked/);
  assert.equal(githubQuery, 'agent governance');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].data.sources[0].kind, 'github_metadata');
  assert.equal(result.artifactRefs[0].data.researchMethod.queryPlan.length, 6);
  assert.equal(result.artifactRefs[0].data.researchMethod.coverage.queryCount, 6);
  assert.equal(result.artifactRefs[0].data.researchMethod.epistemicPolicy.clickbaitTerms, 'discovery_only');
});

test('小R 六路发现后按证据价值选择五条来源并保留可审计方法账本', async () => {
  const searched = [];
  let activeSearches = 0;
  let maxActiveSearches = 0;
  const worker = new LocalIntelResearcher({
    now,
    publicWebSearch:{
      async search({ query }) {
        activeSearches += 1;
        maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
        await new Promise((resolve) => setImmediate(resolve));
        const index = searched.push(query);
        activeSearches -= 1;
        return {
          results:[{
            url:`https://source-${index}.example.com/report`,
            title:`第 ${index} 路候选`,
          }],
        };
      },
    },
    publicWebFetch:{
      async acquire({ sourceUrl }) {
        const index = Number(sourceUrl.match(/source-(\d+)/)?.[1] || 1);
        return {
          sourceRef:sourceUrl,
          title:`已读取来源 ${index}`,
          text:`来源 ${index} 只证明它明确写出的事实。`,
          contentHash:index.toString(16).repeat(64),
          fetchedAt:now().toISOString(),
          truncated:false,
        };
      },
    },
  });

  const result = await worker.execute({
    taskId:'intel-diverse-search',
    assigneeAgentId:'intel-researcher',
    input:{ topic:'人工智能行业发展' },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(searched.length, 6);
  assert.equal(maxActiveSearches, 1);
  const report = result.artifactRefs[0].data;
  assert.equal(report.sources.length, 5);
  assert.deepEqual(report.researchMethod.coverage.selectedLaneIds, [
    'primary',
    'practice',
    'investigative',
    'counterevidence',
    'baseline',
  ]);
  assert.equal(report.sources.every((source) => source.discovery?.laneIds?.length === 1), true);
  assert.equal(report.researchMethod.sourceAssessments.every((item) => item.interestConflict === 'not_established'), true);
  assert.equal(report.researchMethod.claimLedger.every((item) => item.evidenceLevel === 'single_source_fragment'), true);
  assert.equal(report.researchMethod.claimLedger.every((item) => item.independence === 'not_established'), true);
  assert.equal(result.artifactRefs[0].validation.searchDiversityMet, true);
  assert.deepEqual(result.usage.tools[0], { id:'public-web-search', name:'公开网页搜索', calls:6 });
});

test('天气查询使用城市专用检索并拒绝同页搜索中的无关结果', async () => {
  const searched = [];
  const pages = new Map([
    ['https://www.weather.com.cn/weather/101210904.shtml', {
      title:'义乌天气预报,义乌7天天气预报',
      text:'全国 浙江 金华 义乌 16日（今天）小雨 25℃ 17日小雨转多云 33℃ / 24℃ 18日多云 34℃ / 25℃ 19日晴转多云 34℃ / 24℃ 20日中雨转小雨 34℃ / 25℃ 21日小雨转阴 33℃ / 24℃ 22日中雨转小雨 32℃ / 25℃',
    }],
    ['https://www.weather.com.cn/weather1dn/101210904.shtml', {
      title:'义乌天气预报 - 中国天气网',
      text:'义乌天气 16日小雨 25℃，17日小雨转多云 33℃ / 24℃，18日多云 34℃ / 25℃。',
    }],
    ['https://www.nmc.cn/publish/forecast/AZJ/yiwu.html', {
      title:'义乌-天气预报 - 中央气象台',
      text:'当前位置 浙江省 义乌天气预报 7天预报 08/16 25℃ 小雨，08/17 33℃ 24℃ 小雨转多云。',
    }],
  ]);
  const worker = new LocalIntelResearcher({
    now,
    publicWebSearch:{
      async search({ query }) {
        searched.push(query);
        if (query.includes('7天天气预报')) return { results:[
          { url:'https://status.example.com/fedex', title:'FedEx system down' },
          { url:'https://www.weather.com.cn/weather/101210904.shtml', title:'义乌天气预报,义乌7天天气预报' },
        ] };
        if (query.includes('中国天气网')) return { results:[
          { url:'https://www.weather.com.cn/weather1dn/101210904.shtml', title:'义乌天气预报 - 中国天气网' },
        ] };
        return { results:[
          { url:'https://www.nmc.cn/publish/forecast/AZJ/yiwu.html', title:'义乌-天气预报 - 中央气象台' },
        ] };
      },
    },
    publicWebFetch:{
      async acquire({ sourceUrl }) {
        const page = pages.get(sourceUrl);
        assert.ok(page, `不应读取无关搜索结果：${sourceUrl}`);
        return {
          sourceRef:sourceUrl,
          ...page,
          contentHash:(sourceUrl.includes('nmc.cn') ? 'c' : sourceUrl.includes('1dn') ? 'b' : 'a').repeat(64),
          fetchedAt:now().toISOString(),
        };
      },
    },
  });

  const result = await worker.execute({
    taskId:'intel-yiwu-weather',
    taskType:'research.intel-report',
    input:{ title:'查下最近一周义乌天气' },
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(searched, [
    '义乌 7天天气预报',
    '义乌 天气 中国天气网',
    '义乌 天气 中央气象台',
  ]);
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.data.sources.length, 3);
  assert.equal(artifact.data.sources.every((source) => source.topicRelevant === true), true);
  assert.equal(artifact.data.sources.some((source) => source.summary.includes('33℃')), true);
  assert.equal(artifact.data.researchMethod.coverage.candidateCount, 3);
  assert.equal(artifact.validation.topicRelevanceMet, true);
  assert.equal(artifact.validation.searchDiversityMet, true);
  assert.equal(artifact.validation.counterEvidenceSearched, true);
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
  assert.equal(
    research.artifactRefs[0].data.contentOpportunity.schemaVersion,
    'agent.army/content-opportunity/v1',
  );
  assert.equal(research.artifactRefs[0].data.contentOpportunity.opportunitySignals.length, 1);
  assert.equal(
    research.artifactRefs[0].data.contentOpportunity.originalAngles[0].treatment.includes('重新创作'),
    true,
  );
  assert.equal(research.artifactRefs[0].data.contentOpportunity.researchSafety.interactions, false);
  assert.match(research.artifactRefs[0].data.contentOpportunity.unproven.join('\n'), /公开互动不等于销量/);
  assert.equal(research.artifactRefs[0].validation.contentOpportunityPresent, true);
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
