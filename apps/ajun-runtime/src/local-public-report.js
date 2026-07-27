import { extractReportFocus } from './public-report-presentation.js';

export class LocalPublicReport {
  constructor({ publicWebFetch, publicWebSearch = null, comparisonAdvisor = null, refineAdvisor = null, now = () => new Date(), environment = process.env } = {}) {
    this.publicWebFetch = publicWebFetch;
    this.publicWebSearch = publicWebSearch;
    this.comparisonAdvisor = comparisonAdvisor;
    this.refineAdvisor = refineAdvisor;
    this.now = now;
    this.testFailureTitle = String(environment?.AJUN_TEST_PUBLIC_REPORT_FAILURE_TITLE || '').trim();
    this.testFailuresRemaining = Math.min(Math.max(Number(environment?.AJUN_TEST_PUBLIC_REPORT_FAILURE_COUNT) || 0, 0), 2);
  }

  supports(agent) { return agent?.runtime?.kind === 'proposal-public-report'; }

  async execute(task) {
    this.triggerControlledFailure(task);
    let sourceUrls = sourceList(task.input);
    let search = null;
    if (!sourceUrls.length) {
      if (!this.publicWebSearch?.search) return waitingForSources(this.now());
      try {
        search = await this.publicWebSearch.search({ query:discoveryQuery(task.input?.query || task.input?.title), limit:3 });
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
    const unavailableSources = [];
    for (const sourceUrl of sourceUrls) {
      try {
        pages.push(await this.publicWebFetch.acquire({ sourceUrl }));
      } catch (error) {
        unavailableSources.push({
          source: publicSourceRef(sourceUrl),
          code: error?.code || 'public_source_unavailable',
          message: String(error?.message || '公开网页暂时不可读取。').slice(0, 240)
        });
      }
    }
    if (!pages.length) return unreadableSources(this.now(), unavailableSources);
    const completedAt = this.now().toISOString();
    const sources = pages.map((page) => ({ source:page.sourceRef, title:page.title || '未提供标题的公开网页', summary:summarize(page.text), fetchedAt:page.fetchedAt, truncated:page.truncated }));
    const comparison = sources.length > 1 ? await this.compareSources(sources) : null;
    const refinement = sources.length === 1 ? await this.refineSource(sources[0]) : null;
    const report = {
      source:sources[0].source, title:sources[0].title, summary:summaryFor(sources, comparison, refinement, unavailableSources.length), fetchedAt:completedAt,
      truncated:sources.some((page) => page.truncated), sourceCount:sources.length, sources,
      ...(unavailableSources.length ? { unavailableSources } : {}),
      ...(search ? { search:{ query:search.query, searchedAt:search.searchedAt, results:search.results.map((item) => ({ source:item.url, title:item.title })) } } : {}),
      ...(sources.length > 1 ? { comparison } : { refinement })
    };
    return {
      status: 'succeeded', currentStage: 'public_report_ready',
      execution: { executor: task.assigneeAgentId, mode: search ? 'public_search_and_read' : sources.length > 1 ? 'public_read_comparison' : 'public_read_report', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: 'report_ready' },
      usage: { tools:[...(search ? [{ id:'public-web-search', name:'公开网页搜索', calls:1 }] : []), { id:'public-web-fetch', name:'公开网页读取', calls:sourceUrls.length }] },
      artifactRefs: [{ artifactId: `public-report:${task.taskId}`, taskId: task.taskId, type: 'public_web_report', title: sources.length > 1 ? '公开网页对比报告' : '公开网页中文摘要', location: `runtime://${task.taskId}/public-web-report`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true, publicReadOnly: true, sourceCount:sources.length, sourceAttemptCount:sourceUrls.length }, createdAt: completedAt, data: report }]
    };
  }

  triggerControlledFailure(task) {
    const title = String(task?.input?.title || '').trim();
    if (!this.testFailureTitle || title !== this.testFailureTitle || this.testFailuresRemaining < 1) return;
    this.testFailuresRemaining -= 1;
    const error = new Error('受控公开资料执行故障；仅用于真实恢复链路验收。');
    error.code = 'controlled_public_report_failure';
    error.category = 'transient';
    error.retryable = true;
    throw error;
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

  async refineSource(source) {
    const fallback = {
      aiAssisted:false,
      status:'mechanical_summary',
      notice:'仅机械摘要，未做中文提炼。',
      mechanicalSummary:source.summary,
      basis:'仅根据已读取的公开网页内容'
    };
    if (!this.refineAdvisor?.refine) return fallback;
    try {
      const refinement = await this.refineAdvisor.refine({ source });
      return refinement ? { ...refinement, aiAssisted:true, status:'refined' } : fallback;
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

function unreadableSources(now, unavailableSources) {
  return {
    status: 'needs_input', currentStage: 'public_sources_unavailable',
    error: {
      code: 'public_sources_unavailable',
      userMessage: '没有得到可读取的公开来源。请补充一到五条能直接打开的公开网页链接，或换一个更具体的主题；这个员工不会登录、不会读取私密内容。',
      category: 'needs_input', stage: 'input', occurredAt: now.toISOString(),
      unavailableSources
    }
  };
}

function sourceList(input) {
  return [...new Set([...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []), input?.sourceUrl].map((value) => String(value || '').trim()).filter(Boolean))];
}

function discoveryQuery(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (/agent\s*(?:军团)?\s*(?:权限)?治理|权限治理/i.test(title)) return 'Agent governance official documentation';
  return title
    .replace(/^(?:请|帮我|帮忙)?(?:查找|搜索|找)(?:一|二|三|四|五|[0-9]+)?(?:个|条)?/u, '')
    .replace(/(?:公开)?(?:资料|网页|文章)(?:，|,)?(?:并)?(?:给我)?(?:中文)?(?:重点|摘要|报告)?[。！!]*$/u, '')
    .trim() || title;
}

function summaryFor(sources, comparison, refinement, unavailableCount = 0) {
  const notice = unavailableCount ? `另有 ${unavailableCount} 条公开来源本次无法读取，已忽略。` : '';
  if (sources.length === 1) {
    if (!refinement?.aiAssisted) return `${refinement?.notice || '仅机械摘要，未做中文提炼。'} 原文摘要：${sources[0].summary}${notice}`.slice(0, 3600);
    const keyPoints = refinement.keyPoints?.length ? `中文重点：${refinement.keyPoints.join('；')}。` : '';
    const recommendation = refinement.recommendation ? `建议：${refinement.recommendation}` : '';
    return `${keyPoints}${recommendation}${notice}`.slice(0, 3600);
  }
  const common = comparison?.commonPoints?.length ? `共同点：${comparison.commonPoints.join('；')}。` : '';
  const differences = comparison?.differences?.length ? `主要差别：${comparison.differences.join('；')}。` : '';
  const recommendation = comparison?.recommendation ? `建议：${comparison.recommendation}` : '';
  return `已整理 ${sources.length} 份公开资料。${common}${differences}${recommendation}${notice}`.slice(0, 3600);
}

function publicSourceRef(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {}
  return '未提供有效公开链接';
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
  const compact = extractReportFocus(text);
  if (!compact) return '网页没有可用正文。';
  const parts = compact.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  return parts.slice(0, 3).join(' ').slice(0, 900);
}
