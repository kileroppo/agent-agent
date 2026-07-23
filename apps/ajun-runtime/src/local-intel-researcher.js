import { fallbackResearch } from './hermes-intel-research-advisor.js';

export class LocalIntelResearcher {
  constructor({ publicWebFetch, publicWebSearch = null, githubSearch = null, researchAdvisor = null, now = () => new Date() } = {}) {
    this.publicWebFetch = publicWebFetch;
    this.publicWebSearch = publicWebSearch;
    this.githubSearch = githubSearch;
    this.researchAdvisor = researchAdvisor;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'intel-researcher'; }

  async execute(task) {
    const topic = String(task?.input?.topic || task?.input?.title || '').trim();
    if (!topic) return needsInput(this.now(), 'research_topic_required', '请说明要研究的主题。小R只会读取公开来源，不会猜测研究目标。');
    let sourceUrls = sourceList(task?.input);
    let discovery = null;
    if (sourceUrls.length > 5) return needsInput(this.now(), 'research_source_limit_exceeded', '一次最多研究五条公开网页来源；请分批发送，避免遗漏资料。');
    if (!sourceUrls.length) {
      discovery = await this.discover(topic);
      sourceUrls = discovery.urls;
    }
    const { sources, failures } = await this.readSources(sourceUrls);
    if (!sources.length && discovery?.githubSources?.length) sources.push(...discovery.githubSources);
    if (!sources.length) return needsInput(this.now(), 'research_sources_unavailable', `${failures[0] || '没有得到可读取的公开来源。'} 请补充公开来源链接或换一个更具体的主题。`);
    const analysis = await this.analyze(topic, sources);
    const completedAt = this.now().toISOString();
    const report = { topic, sources, ...analysis };
    const tools = [];
    if (discovery?.searched) tools.push({ id:'public-web-search', name:'公开网页搜索', calls:1 });
    if (discovery?.githubSearched) tools.push({ id:'github-public-search', name:'公开 GitHub 项目检索', calls:1 });
    if (sourceUrls.length) tools.push({ id:'public-web-fetch', name:'公开网页读取', calls:sources.filter((source) => source.kind === 'public_web').length });
    return {
      status:'succeeded', currentStage:'intel_research_ready',
      execution:{ executor:task.assigneeAgentId || 'intel-researcher', mode:discovery ? 'public_discovery_and_research' : 'provided_sources_research', startedAt:task.execution?.startedAt || completedAt, finishedAt:completedAt, outcome:'research_ready' },
      usage:{ tools:tools.filter((tool) => tool.calls > 0) },
      artifactRefs:[{
        artifactId:`intel-research:${task.taskId}`, taskId:task.taskId, type:'intel_research_report', title:`${topic} 研究报告`, location:`runtime://${task.taskId}/intel-research-report`, mimeType:'application/json', accessScope:'local-owner', createdAt:completedAt,
        validation:{ exists:true, readable:true, nonEmpty:true, publicReadOnly:true, sourceCount:sources.length, structured:true }, data:report
      }]
    };
  }

  async discover(topic) {
    if (this.publicWebSearch?.search) {
      try {
        const search = await this.publicWebSearch.search({ query:topic, limit:3 });
        return { urls:search.results.map((item) => item.url).filter(Boolean), searched:true, githubSearched:false };
      } catch {
        // GitHub is a bounded fallback discovery source, not an assertion that
        // every research topic is an open-source topic.
      }
    }
    if (this.githubSearch?.search) {
      try {
        const search = await this.githubSearch.search({ query:topic, limit:3 });
        return {
          urls:[], searched:false, githubSearched:true,
          githubSources:search.results.map((item) => ({ kind:'github_metadata', title:item.fullName, source:item.url, summary:item.description || '仓库没有提供描述。', fetchedAt:search.searchedAt, truncated:false }))
        };
      } catch { /* The caller gets a transparent needs_input result below. */ }
    }
    return { urls:[], searched:Boolean(this.publicWebSearch), githubSearched:Boolean(this.githubSearch), githubSources:[] };
  }

  async readSources(urls) {
    const sources = []; const failures = [];
    for (const sourceUrl of urls) {
      try {
        const page = await this.publicWebFetch.acquire({ sourceUrl });
        sources.push({ kind:'public_web', title:page.title || '未提供标题的公开网页', source:page.sourceRef, summary:summarize(page.text), fetchedAt:page.fetchedAt, truncated:Boolean(page.truncated) });
      } catch (error) { failures.push(error?.message || '公开来源暂时无法读取。'); }
    }
    return { sources, failures };
  }

  async analyze(topic, sources) {
    if (typeof this.researchAdvisor?.analyze !== 'function') return fallbackResearch({ topic, sources });
    try { return await this.researchAdvisor.analyze({ topic, sources }) || fallbackResearch({ topic, sources }); }
    catch { return fallbackResearch({ topic, sources }); }
  }
}

function sourceList(input) { return [...new Set([...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []), input?.sourceUrl].map((value) => String(value || '').trim()).filter(Boolean))]; }
function needsInput(now, code, userMessage) { return { status:'needs_input', currentStage:code, error:{ code, userMessage, category:'needs_input', stage:'input', occurredAt:now.toISOString() } }; }
function summarize(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = compact.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  return (sentences.length ? sentences.slice(0, 3).join(' ') : compact).slice(0, 900) || '公开网页没有可用正文。';
}
