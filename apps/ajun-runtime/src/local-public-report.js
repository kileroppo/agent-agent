export class LocalPublicReport {
  constructor({ publicWebFetch, publicWebSearch = null, comparisonAdvisor = null, now = () => new Date() } = {}) {
    this.publicWebFetch = publicWebFetch;
    this.publicWebSearch = publicWebSearch;
    this.comparisonAdvisor = comparisonAdvisor;
    this.now = now;
  }

  supports(agent) { return agent?.runtime?.kind === 'proposal-public-report'; }

  async execute(task) {
    let sourceUrls = sourceList(task.input);
    let search = null;
    if (!sourceUrls.length) {
      if (!this.publicWebSearch?.search) return waitingForSources(this.now());
      try {
        search = await this.publicWebSearch.search({ query:task.input?.title, limit:3 });
        sourceUrls = search.results.map((item) => item.url);
      } catch (error) {
        return { status:'needs_input', currentStage:'public_search_unavailable', error:{ code:error?.code || 'public_search_unavailable', userMessage:`${error?.message || '公开搜索暂时不可用。'} 你也可以直接发一到五条公开网页链接；这个员工不会登录、不会读取私密内容。`, category:'needs_input', stage:'input', occurredAt:this.now().toISOString() } };
      }
    }
    if (sourceUrls.length > 5) {
      return {
        status: 'needs_input', currentStage: 'public_page_limit_exceeded',
        error: { code: 'public_page_limit_exceeded', userMessage: '一次最多对比五条公开网页链接；请分两次发送。这个员工不会偷偷只处理前五条。', category: 'needs_input', stage: 'input', occurredAt: this.now().toISOString() }
      };
    }
    const pages = [];
    for (const sourceUrl of sourceUrls) pages.push(await this.publicWebFetch.acquire({ sourceUrl }));
    const completedAt = this.now().toISOString();
    const sources = pages.map((page) => ({ source:page.sourceRef, title:page.title || '未提供标题的公开网页', summary:summarize(page.text), fetchedAt:page.fetchedAt, truncated:page.truncated }));
    const comparison = sources.length > 1 ? await this.compareSources(sources) : null;
    const report = {
      source:sources[0].source, title:sources[0].title, summary:summaryFor(sources, comparison), fetchedAt:completedAt,
      truncated:sources.some((page) => page.truncated), sourceCount:sources.length, sources,
      ...(search ? { search:{ query:search.query, searchedAt:search.searchedAt, results:search.results.map((item) => ({ source:item.url, title:item.title })) } } : {}),
      ...(sources.length > 1 ? { comparison } : {})
    };
    return {
      status: 'succeeded', currentStage: 'public_report_ready',
      execution: { executor: task.assigneeAgentId, mode: search ? 'public_search_and_read' : sources.length > 1 ? 'public_read_comparison' : 'public_read_report', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: 'report_ready' },
      usage: { tools:[...(search ? [{ id:'public-web-search', name:'公开网页搜索', calls:1 }] : []), { id:'public-web-fetch', name:'公开网页读取', calls:sources.length }] },
      artifactRefs: [{ artifactId: `public-report:${task.taskId}`, taskId: task.taskId, type: 'public_web_report', title: sources.length > 1 ? '公开网页对比报告' : '公开网页中文摘要', location: `runtime://${task.taskId}/public-web-report`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true, publicReadOnly: true, sourceCount:sources.length }, createdAt: completedAt, data: report }]
    };
  }

  async compareSources(sources) {
    const fallback = fallbackComparison(sources);
    if (!this.comparisonAdvisor?.compare) return fallback;
    try {
      const analysis = await this.comparisonAdvisor.compare({ sources });
      return analysis ? { ...fallback, ...analysis, aiAssisted:true } : fallback;
    } catch {
      return fallback;
    }
  }
}

function waitingForSources(now) {
  return {
    status: 'needs_input', currentStage: 'public_page_required',
    error: { code: 'public_page_required', userMessage: '请发送一到五条能直接打开的公开网页链接；这个员工不会登录、不会读取私密内容。', category: 'needs_input', stage: 'input', occurredAt: now.toISOString() }
  };
}

function sourceList(input) {
  return [...new Set([...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []), input?.sourceUrl].map((value) => String(value || '').trim()).filter(Boolean))];
}

function summaryFor(sources, comparison) {
  if (sources.length === 1) return sources[0].summary;
  const common = comparison?.commonPoints?.length ? `共同点：${comparison.commonPoints.join('；')}。` : '';
  const differences = comparison?.differences?.length ? `主要差别：${comparison.differences.join('；')}。` : '';
  const recommendation = comparison?.recommendation ? `建议：${comparison.recommendation}` : '';
  return `已整理 ${sources.length} 份公开资料。${common}${differences}${recommendation}`.slice(0, 3600);
}

function fallbackComparison(sources) {
  return {
    title:'公开资料对比',
    items:sources.map((page, index) => ({ number:index + 1, title:page.title, source:page.source, summary:page.summary })),
    commonPoints:[],
    differences:sources.map((page, index) => `资料${index + 1}《${page.title}》的重点：${page.summary}`).slice(0, 4),
    recommendation:'请先根据各资料的重点确认你最关心的比较维度；当前没有补充任何未读取的信息。',
    basis:'仅根据已读取的公开网页内容',
    aiAssisted:false
  };
}

function summarize(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '网页没有可用正文。';
  const parts = compact.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  return parts.slice(0, 3).join(' ').slice(0, 900);
}
