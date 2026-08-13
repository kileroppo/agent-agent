const CONTROLLED_SOURCE_MATERIAL = Symbol.for(
  'agent.army.openResearch.controlledSourceMaterial',
);

export const MAX_RESEARCH_SOURCES = 5;

const DISCOVERY_RESULTS_PER_LANE = 2;
const DISCOVERY_LANE_SELECTION_PRIORITY = Object.freeze([
  'primary',
  'practice',
  'investigative',
  'counterevidence',
  'baseline',
  'expert',
]);

export class OpenResearchSourceAcquisition {
  constructor({ publicWebFetch, publicWebSearch = null, githubSearch = null } = {}) {
    this.publicWebFetch = publicWebFetch;
    this.publicWebSearch = publicWebSearch;
    this.githubSearch = githubSearch;
  }

  async acquire({
    task,
    topic,
    roleToolContext = null,
    discover = (value, context) => this.discover(value, context),
    readSources = (...args) => this.readSources(...args),
  } = {}) {
    const isCampaignResearch = task?.taskType === 'content.campaign-research';
    const isCampaignEvidence = task?.taskType === 'content.campaign-evidence';
    let sourceUrls = sourceList(task?.input);
    let discovery = null;
    if (sourceUrls.length > MAX_RESEARCH_SOURCES) {
      return unavailable(
        'research_source_limit_exceeded',
        '一次最多研究五条公开网页来源；请分批发送，避免遗漏资料。',
      );
    }
    if (!sourceUrls.length) {
      discovery = await discover(topic, roleToolContext);
      sourceUrls = discovery.urls;
    }
    const { sources, failures } = await readSources(
      sourceUrls,
      roleToolContext,
      sourceReadModes(task?.input),
      discovery?.candidatesByUrl,
      task,
    );
    if (!sources.length && discovery?.githubSources?.length) {
      sources.push(...discovery.githubSources);
    }
    if (!sources.length) {
      return unavailable(
        'research_sources_unavailable',
        `${failures[0] || discovery?.failures?.[0] || '没有得到可读取的公开来源。'} 请补充公开来源链接或换一个更具体的主题。`,
      );
    }
    const preparedSources = prepareResearchSources(sources);
    const evidenceSources = preparedSources.filter((source) => source.evidenceEligible === true);
    if ((isCampaignResearch || isCampaignEvidence) && evidenceSources.length < 2) {
      return unavailable(
        'campaign_research_minimum_sources',
        `M5 内容研究至少需要两个同时具有 URL、抓取时间和内容哈希的公开正文来源，当前只有 ${evidenceSources.length} 个；GitHub 搜索元数据不能直接算证据。`,
      );
    }
    const usageTools = [];
    if (discovery?.searched) {
      usageTools.push({
        id:'public-web-search',
        name:'公开网页搜索',
        calls:discovery.searchCalls || 1,
      });
    }
    if (discovery?.githubSearched) {
      usageTools.push({ id:'github-public-search', name:'公开 GitHub 项目检索', calls:1 });
    }
    if (sourceUrls.length) {
      usageTools.push({
        id:'public-web-fetch',
        name:'公开网页读取',
        calls:sources.filter((source) => source.kind === 'public_web').length,
      });
    }
    return {
      ready:true,
      discovery,
      preparedSources,
      evidenceSources,
      executionMode:discovery
        ? 'public_discovery_and_research'
        : 'provided_sources_research',
      usageTools:usageTools.filter((tool) => tool.calls > 0),
    };
  }

  async discover(topic, roleToolContext = null) {
    const queryPlan = researchQueryPlan(topic);
    const baseQuery = queryPlan[0].query;
    const failures = [];
    let searchCalls = 0;
    const candidates = new Map();
    const completedLaneIds = [];
    const resultLaneIds = [];
    if (this.publicWebSearch?.search) {
      const attempts = await Promise.all(queryPlan.map(async (lane) => {
        searchCalls += 1;
        try {
          const search = roleToolContext
            ? await roleToolContext.execute({
                toolId:'content.public.search',
                externalSideEffect:'network-read',
                url:'https://html.duckduckgo.com/html/',
                input:{ query:lane.query, limit:DISCOVERY_RESULTS_PER_LANE },
              })
            : await this.publicWebSearch.search({
                query:lane.query,
                limit:DISCOVERY_RESULTS_PER_LANE,
              });
          return { lane, search };
        } catch (error) {
          return { lane, error };
        }
      }));
      for (const attempt of attempts) {
        if (attempt.error) {
          failures.push(
            `${attempt.lane.label}：${attempt.error?.message || '公开搜索暂时无法读取。'}`,
          );
          continue;
        }
        completedLaneIds.push(attempt.lane.id);
        const results = Array.isArray(attempt.search?.results) ? attempt.search.results : [];
        if (results.some((item) => publicSourceUrl(item?.url))) {
          resultLaneIds.push(attempt.lane.id);
        }
        for (const [rank, result] of results.entries()) {
          const url = publicSourceUrl(result?.url);
          if (!url) continue;
          const current = candidates.get(url) || {
            url,
            title:String(result?.title || '').trim().slice(0, 300) || null,
            laneIds:new Set(),
            queries:new Set(),
            ranks:[],
          };
          current.laneIds.add(attempt.lane.id);
          current.queries.add(attempt.lane.query);
          current.ranks.push(rank + 1);
          candidates.set(url, current);
        }
      }
      if (candidates.size) {
        const selected = selectDiverseCandidates(candidates);
        return {
          urls:selected.map((candidate) => candidate.url),
          searched:true,
          searchCalls,
          githubSearched:false,
          failures,
          queryPlan,
          completedLaneIds,
          resultLaneIds,
          candidateCount:candidates.size,
          selectedLaneIds:distinct(selected.flatMap((candidate) => candidate.selectionLaneIds)),
          candidatesByUrl:new Map(selected.map((candidate) => [candidate.url, candidate])),
        };
      }
    }
    if (this.githubSearch?.search) {
      try {
        const search = roleToolContext
          ? await roleToolContext.execute({
              toolId:'github.public.search',
              externalSideEffect:'network-read',
              url:'https://api.github.com/search/repositories',
              input:{ operation:'search', query:baseQuery, limit:3 },
            })
          : await this.githubSearch.search({ query:baseQuery, limit:3 });
        return {
          urls:[],
          searched:Boolean(this.publicWebSearch),
          searchCalls,
          githubSearched:true,
          failures,
          queryPlan,
          completedLaneIds,
          resultLaneIds,
          candidateCount:candidates.size,
          selectedLaneIds:[],
          candidatesByUrl:new Map(),
          githubSources:search.results.map((item) => ({
            kind:'github_metadata',
            title:item.fullName,
            source:item.url,
            summary:item.description || '仓库没有提供描述。',
            fetchedAt:search.searchedAt,
            truncated:false,
            evidenceEligible:false,
            evidenceExclusionReason:'github_metadata_only',
          })),
        };
      } catch (error) {
        failures.push(error?.message || '公开 GitHub 来源暂时无法读取。');
      }
    }
    return {
      urls:[],
      searched:Boolean(this.publicWebSearch),
      searchCalls,
      githubSearched:Boolean(this.githubSearch),
      githubSources:[],
      failures,
      queryPlan,
      completedLaneIds,
      resultLaneIds,
      candidateCount:candidates.size,
      selectedLaneIds:[],
      candidatesByUrl:new Map(),
    };
  }

  async readSources(
    urls,
    roleToolContext = null,
    readModes = new Map(),
    candidatesByUrl = new Map(),
    task = null,
  ) {
    const sources = [];
    const failures = [];
    for (const sourceUrl of urls) {
      try {
        const readMode = readModes.get(sourceUrl)
          || (/\.pdf(?:$|[?#])/i.test(sourceUrl) ? 'pdf' : 'static');
        const toolId = readMode === 'pdf'
          ? 'content.public.pdf.read'
          : readMode === 'dynamic'
            ? 'content.public.dynamic.read'
            : 'content.public.fetch';
        const page = roleToolContext
          ? await roleToolContext.execute({
              toolId,
              externalSideEffect:'network-read',
              url:sourceUrl,
              input:{ sourceUrl },
            })
          : await this.publicWebFetch.acquire({ sourceUrl, task });
        sources.push({
          kind:readMode === 'pdf'
            ? 'public_pdf'
            : readMode === 'dynamic' ? 'public_dynamic_web' : 'public_web',
          title:page.title || '未提供标题的公开来源',
          source:page.sourceRef,
          summary:summarize(page.text),
          contentHash:page.contentHash || null,
          fetchedAt:page.fetchedAt,
          truncated:Boolean(page.truncated),
          discovery:sourceDiscoveryMetadata(candidatesByUrl?.get?.(sourceUrl)),
        });
      } catch (error) {
        failures.push(error?.message || '公开来源暂时无法读取。');
      }
    }
    return { sources, failures };
  }

  fromVerifiedObservations(observations) {
    const unique = new Map();
    for (const observation of Array.isArray(observations) ? observations : []) {
      const evidence = observation?.result?.sourceEvidence;
      const source = publicSourceUrl(evidence?.url);
      const fetchedAt = validTimestamp(evidence?.fetchedAt);
      const contentHash = validContentHash(evidence?.contentHash);
      const observationId = String(observation?.observationId || '').trim();
      const sourceId = String(evidence?.sourceId || '').trim();
      const fragmentId = String(evidence?.evidenceFragment?.fragmentId || '').trim();
      const fragmentText = String(evidence?.evidenceFragment?.text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 900);
      const controlledSummary = String(
        observation?.[CONTROLLED_SOURCE_MATERIAL]?.summary || '',
      ).replace(/\s+/g, ' ').trim().slice(0, 900);
      if (
        observation?.schemaVersion !== 'agent.army/tool-observation/v1'
        || observation?.outcome !== 'succeeded'
        || observation?.classification !== 'source_verified'
        || observation?.provenance !== 'trusted_role_tool_adapter'
        || !observationId
        || !sourceId
        || !source
        || !fetchedAt
        || !contentHash
        || !fragmentId
        || !fragmentText
      ) continue;
      unique.set(`${source}|${contentHash}`, {
        kind:String(evidence.kind || 'public_web'),
        observationId,
        sourceId,
        title:String(evidence.title || '未提供标题的公开来源').slice(0, 300),
        source,
        url:source,
        fetchedAt,
        contentHash,
        summary:controlledSummary || fragmentText,
        evidenceEligible:true,
        evidenceFragments:[{
          fragmentId,
          text:controlledSummary || fragmentText,
        }],
      });
    }
    return [...unique.values()];
  }
}

function prepareResearchSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source, index) => {
    const sourceId = `source-${index + 1}`;
    const url = publicSourceUrl(source?.source);
    const fetchedAt = validTimestamp(source?.fetchedAt);
    const contentHash = validContentHash(source?.contentHash);
    const summary = String(source?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 900);
    const metadataOnly = source?.kind === 'github_metadata';
    const evidenceEligible = !metadataOnly && Boolean(url && fetchedAt && contentHash && summary);
    return {
      ...source,
      sourceId,
      url,
      fetchedAt:fetchedAt || source?.fetchedAt || null,
      contentHash,
      evidenceEligible,
      evidenceExclusionReason:evidenceEligible
        ? null
        : metadataOnly
          ? 'github_metadata_only'
          : 'missing_url_fetched_at_content_hash_or_text',
      evidenceFragments:evidenceEligible
        ? [{ fragmentId:`${sourceId}-fragment-1`, text:summary }]
        : [],
    };
  });
}

function sourceList(input) {
  return [...new Set([
    ...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []),
    input?.sourceUrl,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function sourceReadModes(input) {
  const modes = new Map();
  for (const url of Array.isArray(input?.dynamicSourceUrls) ? input.dynamicSourceUrls : []) {
    const normalized = String(url || '').trim();
    if (normalized) modes.set(normalized, 'dynamic');
  }
  for (const url of Array.isArray(input?.pdfSourceUrls) ? input.pdfSourceUrls : []) {
    const normalized = String(url || '').trim();
    if (normalized) modes.set(normalized, 'pdf');
  }
  return modes;
}

function researchQueryPlan(topic) {
  const baseQuery = discoveryQuery(topic).replace(/\s+/g, ' ').trim().slice(0, 300);
  const chinese = /[\u3400-\u9fff]/.test(baseQuery);
  const lanes = chinese
    ? [
        ['baseline', '中性基线', '建立定义、范围和基本事实，不预设结论', ''],
        ['primary', '一手证据', '优先发现原始数据、法规、论文和正式报告', '原始数据 法规 论文 官方报告'],
        ['expert', '人物谱系', '发现先驱、代表人物、批评者及其原始作品', '创始人 先驱 专家 批评者 访谈 代表作'],
        ['practice', '实践现场', '发现实施成本、失败复盘和普通从业者经验', '实操 案例 复盘 失败 成本 从业者'],
        ['investigative', '利益审查', '发现处罚、诉讼、利益冲突与可信调查线索', '调查 处罚 诉讼 利益冲突 争议'],
        ['counterevidence', '反向验证', '主动搜索质疑、局限、反例、撤稿与辟谣', '反对 质疑 局限 失败 反例 撤稿 辟谣'],
      ]
    : [
        ['baseline', 'neutral baseline', 'Establish definitions, scope, and baseline facts without assuming a conclusion', ''],
        ['primary', 'primary evidence', 'Find original data, regulation, research, and official reports', 'official data report regulation research'],
        ['expert', 'expert lineage', 'Find pioneers, representative experts, critics, interviews, and original works', 'pioneer leading expert critic interview original work'],
        ['practice', 'practice evidence', 'Find implementation cases, costs, failures, and practitioner lessons', 'case study implementation failure cost practitioner lessons learned'],
        ['investigative', 'interest review', 'Find investigations, enforcement, litigation, conflicts of interest, and controversy', 'investigation enforcement litigation conflict of interest controversy'],
        ['counterevidence', 'counter evidence', 'Actively search for criticism, limitations, failures, counterexamples, and debunking', 'criticism limitations failed counterexample retraction debunked'],
      ];
  return lanes.map(([id, label, purpose, suffix]) => ({
    id,
    label,
    purpose,
    query:suffix ? `${baseQuery} ${suffix}` : baseQuery,
    credibilityPolicy:id === 'investigative'
      ? 'discovery_lead_requires_primary_or_independent_corroboration'
      : 'search_rank_and_wording_are_not_credibility_signals',
  }));
}

function selectDiverseCandidates(candidates) {
  const pool = [...candidates.values()];
  const selected = [];
  const selectedUrls = new Set();
  for (const laneId of DISCOVERY_LANE_SELECTION_PRIORITY) {
    const candidate = pool.find((item) =>
      item.laneIds.has(laneId) && !selectedUrls.has(item.url)
    );
    if (!candidate) continue;
    selected.push(materializeCandidate(candidate, laneId));
    selectedUrls.add(candidate.url);
    if (selected.length >= MAX_RESEARCH_SOURCES) return selected;
  }
  for (const candidate of pool) {
    if (selectedUrls.has(candidate.url)) continue;
    selected.push(materializeCandidate(candidate, [...candidate.laneIds][0] || 'baseline'));
    selectedUrls.add(candidate.url);
    if (selected.length >= MAX_RESEARCH_SOURCES) break;
  }
  return selected;
}

function materializeCandidate(candidate, selectedForLane) {
  return {
    url:candidate.url,
    title:candidate.title,
    laneIds:[...candidate.laneIds],
    queries:[...candidate.queries],
    ranks:[...candidate.ranks],
    selectedForLane,
    selectionLaneIds:[selectedForLane],
  };
}

function sourceDiscoveryMetadata(candidate) {
  if (!candidate) return null;
  return {
    laneIds:[...candidate.laneIds],
    queries:[...candidate.queries],
    ranks:[...candidate.ranks],
    selectedForLane:candidate.selectedForLane,
    candidateTitle:candidate.title,
  };
}

function publicSourceUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function validTimestamp(value) {
  const timestamp = String(value || '').trim();
  return Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
}

function validContentHash(value) {
  const hash = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function discoveryQuery(topic) {
  const value = String(topic || '');
  if (/(?:agent|智能体).{0,12}(?:治理|管控|权限)|(?:治理|管控|权限).{0,12}(?:agent|智能体)/i.test(value)) {
    return 'agent governance';
  }
  if (/多智能体|multi[\s-]?agent/i.test(value)) return 'multi-agent governance';
  return value;
}

function distinct(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function summarize(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = compact.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  return (sentences.length ? sentences.slice(0, 3).join(' ') : compact).slice(0, 900)
    || '公开网页没有可用正文。';
}

function unavailable(code, userMessage) {
  return { ready:false, code, userMessage };
}
