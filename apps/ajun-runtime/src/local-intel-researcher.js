import { createHash } from 'node:crypto';
import { fallbackResearch } from './hermes-intel-research-advisor.js';

const CONTROLLED_SOURCE_MATERIAL = Symbol.for(
  'agent.army.openResearch.controlledSourceMaterial',
);
const MAX_RESEARCH_SOURCES = 5;
const DISCOVERY_RESULTS_PER_LANE = 2;
const DISCOVERY_LANE_SELECTION_PRIORITY = Object.freeze([
  'primary',
  'practice',
  'investigative',
  'counterevidence',
  'baseline',
  'expert',
]);

export class LocalIntelResearcher {
  constructor({ publicWebFetch, publicWebSearch = null, githubSearch = null, publicReport = null, githubResearch = null, researchAdvisor = null, grokConsult = null, now = () => new Date() } = {}) {
    this.publicWebFetch = publicWebFetch;
    this.publicWebSearch = publicWebSearch;
    this.githubSearch = githubSearch;
    this.publicReport = publicReport;
    this.githubResearch = githubResearch;
    this.researchAdvisor = researchAdvisor;
    this.grokConsult = grokConsult;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'intel-researcher'; }

  async execute(task, { roleToolContext = null } = {}) {
    if (shouldUseGrok(task)) return this.executeGrokSearch(task);
    if (task?.taskType === 'report.public-material') {
      if (!this.publicReport?.execute) return needsInput(this.now(), 'public_report_unavailable', '小R的公开网页整理能力暂时不可用。');
      return this.publicReport.execute(task, { roleToolContext });
    }
    if (task?.taskType === 'research.github-search') {
      if (!this.githubResearch?.execute) return needsInput(this.now(), 'github_research_unavailable', '小R的公开 GitHub 检索能力暂时不可用。');
      return this.githubResearch.execute(task, { roleToolContext });
    }
    const isCampaignResearch = task?.taskType === 'content.campaign-research';
    const isCampaignEvidence = task?.taskType === 'content.campaign-evidence';
    const topic = String(
      task?.input?.topic
      || task?.input?.context?.pipelineCase?.fields?.theme
      || task?.input?.title
      || '',
    ).trim();
    if (!topic) return needsInput(this.now(), 'research_topic_required', '请说明要研究的主题。小R只会读取公开来源，不会猜测研究目标。');
    let sourceUrls = sourceList(task?.input);
    let discovery = null;
    if (sourceUrls.length > MAX_RESEARCH_SOURCES) return needsInput(this.now(), 'research_source_limit_exceeded', '一次最多研究五条公开网页来源；请分批发送，避免遗漏资料。');
    if (!sourceUrls.length) {
      discovery = await this.discover(topic, roleToolContext);
      sourceUrls = discovery.urls;
    }
    const { sources, failures } = await this.readSources(
      sourceUrls,
      roleToolContext,
      sourceReadModes(task?.input),
      discovery?.candidatesByUrl,
    );
    if (!sources.length && discovery?.githubSources?.length) sources.push(...discovery.githubSources);
    if (!sources.length) return needsInput(this.now(), 'research_sources_unavailable', `${failures[0] || discovery?.failures?.[0] || '没有得到可读取的公开来源。'} 请补充公开来源链接或换一个更具体的主题。`);
    const preparedSources = prepareResearchSources(sources);
    const evidenceSources = preparedSources.filter((source) => source.evidenceEligible === true);
    if ((isCampaignResearch || isCampaignEvidence) && evidenceSources.length < 2) {
      return needsInput(
        this.now(),
        'campaign_research_minimum_sources',
        `M5 内容研究至少需要两个同时具有 URL、抓取时间和内容哈希的公开正文来源，当前只有 ${evidenceSources.length} 个；GitHub 搜索元数据不能直接算证据。`,
      );
    }
    const analysis = await this.analyze(topic, evidenceSources);
    const completedAt = this.now().toISOString();
    const researchMethod = buildResearchMethod({
      discovery,
      sources:preparedSources,
      claims:analysis.claims,
    });
    const report = isCampaignEvidence
      ? campaignEvidencePackage({ task, topic, sources:evidenceSources, analysis, completedAt, researchMethod })
      : {
          ...(isCampaignResearch ? { schemaVersion:'agent.army/campaign-research/v2' } : {}),
          topic,
          sources:preparedSources,
          ...analysis,
          researchMethod,
          ...(isCampaignResearch ? {
            contentOpportunity:buildContentOpportunity({
              task,
              topic,
              sources:evidenceSources,
              analysis,
              researchMethod,
            }),
          } : {}),
        };
    const tools = [];
    if (discovery?.searched) tools.push({ id:'public-web-search', name:'公开网页搜索', calls:discovery.searchCalls || 1 });
    if (discovery?.githubSearched) tools.push({ id:'github-public-search', name:'公开 GitHub 项目检索', calls:1 });
    if (sourceUrls.length) tools.push({ id:'public-web-fetch', name:'公开网页读取', calls:sources.filter((source) => source.kind === 'public_web').length });
    return {
      status:'succeeded',
      currentStage:isCampaignEvidence
        ? 'campaign_evidence_ready'
        : isCampaignResearch ? 'campaign_research_ready' : 'intel_research_ready',
      execution:{ executor:task.assigneeAgentId || 'intel-researcher', mode:discovery ? 'public_discovery_and_research' : 'provided_sources_research', startedAt:task.execution?.startedAt || completedAt, finishedAt:completedAt, outcome:'research_ready' },
      usage:{ tools:tools.filter((tool) => tool.calls > 0) },
      artifactRefs:[{
        artifactId:`${isCampaignEvidence ? 'campaign-evidence' : isCampaignResearch ? 'campaign-research' : 'intel-research'}:${task.taskId}`,
        taskId:task.taskId,
        type:isCampaignEvidence
          ? 'evidence_package'
          : isCampaignResearch ? 'campaign_research_report' : 'intel_research_report',
        title:`${topic} ${isCampaignEvidence ? '证据包' : '研究报告'}`,
        location:`runtime://${task.taskId}/${isCampaignEvidence ? 'campaign-evidence' : isCampaignResearch ? 'campaign-research' : 'intel-research-report'}`,
        mimeType:'application/json',
        accessScope:'local-owner',
        createdAt:completedAt,
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          publicReadOnly:true,
          sourceCount:preparedSources.length,
          evidenceSourceCount:evidenceSources.length,
          minimumSourcesMet:!isCampaignResearch && !isCampaignEvidence ? undefined : evidenceSources.length >= 2,
          claimEvidenceBound:report.claims?.every(validClaimEvidenceBinding) === true,
          searchDiversityMet:discovery ? researchMethod.coverage.searchDiversityMet : undefined,
          counterEvidenceSearched:discovery ? researchMethod.coverage.counterEvidenceSearched : undefined,
          contentOpportunityPresent:isCampaignResearch
            ? report.contentOpportunity?.schemaVersion === 'agent.army/content-opportunity/v1'
            : undefined,
          structured:true,
        },
        data:report
      }]
    };
  }

  async executeGrokSearch(task) {
    if (!this.grokConsult) return needsInput(this.now(), 'grok_consult_unavailable', '小R的 Grok 受控插件尚未接入。');
    const health = await this.grokConsult.health();
    if (health.status !== 'ready') return needsInput(this.now(), 'grok_login_required', health.safeMessage);
    const query = String(task?.input?.topic || task?.input?.title || '').trim();
    const result = await this.grokConsult.searchX({ query, hours:24, maxResults:10 });
    const completedAt = this.now().toISOString();
    const text = String(result.text || '').trim();
    const sourceUrls = publicUrls(text).slice(0, 10);
    if (!text || !sourceUrls.length) {
      return {
        status:'waiting_test',
        currentStage:'grok_public_x_research_requires_review',
        execution:{ executor:'intel-researcher', mode:'yichen-grok-consult-mcp', finishedAt:completedAt, outcome:'source_evidence_missing' },
        usage:{ tools:[{ id:'yichen-grok-consult', name:'Grok 公开 X 检索', calls:1 }] },
        error:{
          code:'grok_public_sources_missing',
          message:'Grok 返回了文本，但没有可核验的公开来源链接。',
          userMessage:'小R拿到了 Grok 查询文本，但没有可核验的公开 X 来源链接；已转为待测试，不冒充完整研究报告。',
          category:'manual',
          stage:'grok_public_x_research',
          retryable:false,
          occurredAt:completedAt,
        },
        artifactRefs:[{
          artifactId:`grok-consult-raw:${task.taskId}`,
          taskId:task.taskId,
          type:'intel_x_search_raw_result',
          title:`${query} Grok 公开检索原始结果`,
          location:`runtime://${task.taskId}/grok-consult-raw`,
          mimeType:'text/plain',
          accessScope:'local-owner',
          createdAt:completedAt,
          validation:{ exists:true, readable:true, nonEmpty:Boolean(text), publicReadOnly:true, sourceUrlsPresent:false, route:result.route },
          data:{ query, result:text, route:result.route },
        }],
      };
    }
    const report = {
      schemaVersion:'agent.army/intel-x-search-report/v1',
      topic:query,
      background:'通过受控 Grok 插件检索最近 24 小时的公开 X/Twitter 内容。',
      findings:[text.slice(0, 4_000)],
      conclusion:text.slice(0, 4_000),
      recommendations:['打开下列公开来源逐条复核后再用于业务决策。'],
      openQuestions:['当前结果是否覆盖了足够多的独立公开账号，仍需人工判断。'],
      sources:sourceUrls.map((source, index) => ({ title:`公开 X 来源 ${index + 1}`, source })),
      route:result.route,
      generatedAt:completedAt,
    };
    return {
      status:'succeeded', currentStage:'grok_public_x_research_ready',
      execution:{ executor:'intel-researcher', mode:'yichen-grok-consult-mcp', finishedAt:completedAt, outcome:'research_ready' },
      usage:{ tools:[{ id:'yichen-grok-consult', name:'Grok 公开 X 检索', calls:1 }] },
      artifactRefs:[{ artifactId:`grok-consult:${task.taskId}`, taskId:task.taskId, type:'intel_research_report', title:`${query} Grok 公开检索`, location:`runtime://${task.taskId}/grok-consult`, mimeType:'application/json', accessScope:'local-owner', createdAt:completedAt, validation:{ exists:true, readable:true, nonEmpty:true, publicReadOnly:true, structured:true, sourceCount:sourceUrls.length, sourceUrlsPresent:true, route:result.route }, data:report }],
    };
  }

  async synthesizeVerifiedReport({
    task,
    runId,
    sourceObservations = [],
  } = {}) {
    if (task?.taskType !== 'research.open-investigation') {
      throw new Error('小R受控报告执行器只接受开放研究任务。');
    }
    const safeRunId = String(runId || '').trim();
    if (!safeRunId) throw new Error('小R受控报告执行器缺少当前 Paperclip Run。');
    const topic = String(
      task?.input?.topic
      || task?.input?.title
      || task?.input?.goalSpec?.objective
      || '',
    ).trim();
    if (!topic) throw new Error('小R受控报告执行器缺少研究主题。');
    const sources = verifiedObservationSources(sourceObservations);
    if (sources.length < 2) {
      throw new Error('小R受控报告执行器至少需要两个真实公开来源 Observation。');
    }
    const analysis = await this.analyze(topic, sources);
    if (!reportClaimsBoundToSources(analysis, sources)) {
      throw new Error('小R受控报告没有把事实结论逐项绑定到真实来源 Observation。');
    }
    const completedAt = this.now().toISOString();
    const report = {
      schemaVersion:'agent.army/intel-research-report/v1',
      topic,
      runId:safeRunId,
      sources,
      ...analysis,
      researchMethod:buildResearchMethod({ sources, claims:analysis.claims }),
      sourceObservationIds:sources.map((source) => source.observationId),
      generatedAt:completedAt,
      limitation:'报告只陈述当前受控适配器已核验的公开来源证据，不使用任务正文自报结果。',
    };
    const checksum = `sha256:${createHash('sha256')
      .update(JSON.stringify(report))
      .digest('hex')}`;
    return {
      artifactId:`intel-research:${task.taskId}:${safeRunId}`,
      taskId:String(task.taskId || '').trim(),
      type:'intel_research_report',
      title:`${topic} 研究报告`,
      location:`runtime://${task.taskId}/intel-research-report`,
      mimeType:'application/json',
      checksum,
      accessScope:'local-owner',
      createdAt:completedAt,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        publicReadOnly:true,
        sourceCount:sources.length,
        minimumSourcesMet:true,
        claimEvidenceBound:true,
        currentRun:true,
      },
      data:report,
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
            : await this.publicWebSearch.search({ query:lane.query, limit:DISCOVERY_RESULTS_PER_LANE });
          return { lane, search };
        } catch (error) {
          return { lane, error };
        }
      }));
      for (const attempt of attempts) {
        if (attempt.error) {
          failures.push(`${attempt.lane.label}：${attempt.error?.message || '公开搜索暂时无法读取。'}`);
          continue;
        }
        completedLaneIds.push(attempt.lane.id);
        const results = Array.isArray(attempt.search?.results) ? attempt.search.results : [];
        if (results.some((item) => publicSourceUrl(item?.url))) resultLaneIds.push(attempt.lane.id);
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
        const candidatesByUrl = new Map(selected.map((candidate) => [candidate.url, candidate]));
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
          candidatesByUrl,
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
          urls:[], searched:Boolean(this.publicWebSearch), searchCalls, githubSearched:true, failures,
          queryPlan, completedLaneIds, resultLaneIds, candidateCount:candidates.size,
          selectedLaneIds:[], candidatesByUrl:new Map(),
          githubSources:search.results.map((item) => ({
            kind:'github_metadata',
            title:item.fullName,
            source:item.url,
            summary:item.description || '仓库没有提供描述。',
            fetchedAt:search.searchedAt,
            truncated:false,
            evidenceEligible:false,
            evidenceExclusionReason:'github_metadata_only',
          }))
        };
      } catch (error) { failures.push(error?.message || '公开 GitHub 来源暂时无法读取。'); }
    }
    return {
      urls:[], searched:Boolean(this.publicWebSearch), searchCalls,
      githubSearched:Boolean(this.githubSearch), githubSources:[], failures,
      queryPlan, completedLaneIds, resultLaneIds, candidateCount:candidates.size,
      selectedLaneIds:[], candidatesByUrl:new Map(),
    };
  }

  async readSources(urls, roleToolContext = null, readModes = new Map(), candidatesByUrl = new Map()) {
    const sources = []; const failures = [];
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
          : await this.publicWebFetch.acquire({ sourceUrl });
        sources.push({
          kind:readMode === 'pdf' ? 'public_pdf' : readMode === 'dynamic' ? 'public_dynamic_web' : 'public_web',
          title:page.title || '未提供标题的公开来源',
          source:page.sourceRef,
          summary:summarize(page.text),
          contentHash:page.contentHash || null,
          fetchedAt:page.fetchedAt,
          truncated:Boolean(page.truncated),
          discovery:sourceDiscoveryMetadata(candidatesByUrl?.get?.(sourceUrl)),
        });
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

function shouldUseGrok(task) {
  const text = `${task?.input?.title || ''}\n${task?.input?.description || ''}\n${task?.input?.topic || ''}`;
  return /\bGrok\b|(?:搜索|查|研究).{0,8}(?:X\/Twitter|Twitter|推特)|(?:X\/Twitter|Twitter|推特).{0,8}(?:搜索|查|研究)/i.test(text);
}

function publicUrls(text) {
  return [...new Set(
    [...String(text || '').matchAll(/https?:\/\/[^\s<>()\[\]{}"'，。；：！？、【】（）《》“”‘’]+/gi)]
      .map((match) => match[0].replace(/[.,;:!?]+$/g, ''))
      .filter((url) => /^https?:\/\//i.test(url)),
  )];
}

function campaignEvidencePackage({ task, topic, sources, analysis, completedAt, researchMethod }) {
  const sourceRefs = sources.map((source, index) => ({
    sourceId:String(source.sourceId || `source-${index + 1}`),
    title:String(source.title || `来源 ${index + 1}`).slice(0, 300),
    url:String(source.url || source.source || '').slice(0, 1000),
    fetchedAt:source.fetchedAt || completedAt,
    kind:source.kind || 'public_web',
    contentHash:String(source.contentHash || '').slice(0, 64) || null,
    evidenceFragments:Array.isArray(source.evidenceFragments)
      ? source.evidenceFragments.map((fragment) => ({
          fragmentId:String(fragment.fragmentId || '').slice(0, 120),
          text:String(fragment.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
        })).filter((fragment) => fragment.fragmentId && fragment.text)
      : [],
  }));
  const claims = (Array.isArray(analysis.claims) ? analysis.claims : [])
    .map((claim, index) => normalizeClaim(claim, sourceRefs, index))
    .filter((claim) =>
      claim
      && claim.sourceIds.length >= 2
      && validClaimEvidenceBinding(claim)
    );
  if (!claims.length) {
    const error = new Error('M5 证据包没有逐项绑定至少两个来源及原文片段的结论，拒绝生成空证据包。');
    error.code = 'campaign_evidence_claims_missing';
    error.category = 'quality';
    error.retryable = true;
    throw error;
  }
  return {
    schemaVersion:'agent.army/evidence-package/v2',
    topic,
    scheduledDate:task.input?.context?.pipelineCase?.fields?.scheduledDate || null,
    sources:sourceRefs,
    claims,
    prohibitedStatements:[
      '来源没有直接支持的数字或效果承诺',
      '把测试、配置或本机页面说成真实平台发布',
      '敏感数据、账号信息、Token、Cookie 或本机路径',
    ],
    sourceMinimum:2,
    researchMethod,
    generatedAt:completedAt,
  };
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

function normalizeClaim(claim, sources, index) {
  const text = String(claim?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const sourceById = new Map(sources.map((source) => [String(source.sourceId), source]));
  const sourceIds = [...new Set(
    (Array.isArray(claim?.sourceIds) ? claim.sourceIds : [])
      .map(String)
      .filter((sourceId) => sourceById.has(sourceId)),
  )];
  const evidenceFragments = (Array.isArray(claim?.evidenceFragments) ? claim.evidenceFragments : [])
    .flatMap((fragment) => {
      const sourceId = String(fragment?.sourceId || '');
      const source = sourceById.get(sourceId);
      const fragmentId = String(fragment?.fragmentId || '').slice(0, 120);
      const fragmentText = String(fragment?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
      const sourceFragment = source?.evidenceFragments?.find((candidate) =>
        candidate.fragmentId === fragmentId
        && candidate.text === fragmentText
      );
      return sourceFragment ? [{ sourceId, fragmentId, text:fragmentText }] : [];
    });
  if (!text || !sourceIds.length) return null;
  return {
    claimId:String(claim?.claimId || `claim-${index + 1}`).slice(0, 120),
    text,
    sourceIds,
    evidenceFragments,
    status:'requires_script_faithfulness',
  };
}

function validClaimEvidenceBinding(claim) {
  if (
    !String(claim?.text || '').trim()
    || !Array.isArray(claim?.sourceIds)
    || !claim.sourceIds.length
    || !Array.isArray(claim?.evidenceFragments)
  ) return false;
  const fragmentSourceIds = new Set(
    claim.evidenceFragments
      .filter((fragment) => String(fragment?.fragmentId || '').trim() && String(fragment?.text || '').trim())
      .map((fragment) => String(fragment.sourceId || '')),
  );
  return claim.sourceIds.every((sourceId) => fragmentSourceIds.has(String(sourceId)));
}

function verifiedObservationSources(observations) {
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

function reportClaimsBoundToSources(analysis, sources) {
  const claims = Array.isArray(analysis?.claims) ? analysis.claims : [];
  if (!claims.length) return false;
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  return claims.every((claim) => {
    if (!validClaimEvidenceBinding(claim)) return false;
    return claim.sourceIds.every((sourceId) => {
      const source = byId.get(String(sourceId));
      if (!source) return false;
      return claim.evidenceFragments
        .filter((fragment) => String(fragment?.sourceId) === String(sourceId))
        .every((fragment) => source.evidenceFragments.some((candidate) =>
          candidate.fragmentId === fragment.fragmentId
          && candidate.text === fragment.text
        ));
    });
  });
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

function sourceList(input) { return [...new Set([...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []), input?.sourceUrl].map((value) => String(value || '').trim()).filter(Boolean))]; }
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

function buildContentOpportunity({ task, topic, sources, analysis, researchMethod }) {
  const claims = Array.isArray(analysis?.claims) ? analysis.claims : [];
  const platform = String(task?.input?.platform || '').trim() || null;
  const timeWindow = String(task?.input?.timeWindow || '').trim() || null;
  const opportunitySignals = claims.slice(0, 5).map((claim) => ({
    claimId:String(claim?.claimId || ''),
    signal:String(claim?.text || claim?.claim || claim?.statement || claim?.finding || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    sourceIds:[...new Set((claim?.sourceIds || []).map(String).filter(Boolean))],
    evidenceStrength:(claim?.sourceIds || []).length >= 2
      ? 'multiple_source_fragments'
      : 'single_source_fragment',
    proofBoundary:'公开互动、搜索结果和单个高表现样本只能作为需求发现信号，不证明销量、转化或可复制因果。',
  })).filter((item) => item.signal && item.sourceIds.length);
  return {
    schemaVersion:'agent.army/content-opportunity/v1',
    researchQuestion:topic,
    platform,
    timeWindow,
    sampleLimit:MAX_RESEARCH_SOURCES,
    sourceCount:sources.length,
    opportunitySignals,
    originalAngles:opportunitySignals.slice(0, 3).map((item, index) => ({
      angleId:`angle-${index + 1}`,
      premise:item.signal,
      treatment:'只复用需求和结构启发；标题、开场、论证、案例与措辞必须重新创作。',
      evidenceRefs:item.sourceIds,
    })),
    researchSafety:{
      publicReadOnly:true,
      mainAccountAutomation:false,
      interactions:false,
      publishing:false,
      counterEvidenceSearched:researchMethod?.coverage?.counterEvidenceSearched === true,
    },
    unproven:[
      '公开互动不等于销量、收入或转化。',
      '一次高表现不等于稳定规律。',
      '没有对照实验时不得把结构相关性写成因果。',
    ],
  };
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
    const candidate = pool.find((item) => item.laneIds.has(laneId) && !selectedUrls.has(item.url));
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

function buildResearchMethod({ discovery = null, sources = [], claims = [] } = {}) {
  const queryPlan = Array.isArray(discovery?.queryPlan)
    ? discovery.queryPlan.map((lane) => ({ ...lane }))
    : [];
  const selectedLaneIds = distinct(discovery?.selectedLaneIds || []);
  const resultLaneIds = distinct(discovery?.resultLaneIds || []);
  const requiredDiversity = ['primary', 'practice', 'investigative', 'counterevidence'];
  const sourceById = new Map(sources.map((source) => [String(source?.sourceId || ''), source]));
  const sourceAssessments = sources.map((source) => ({
    sourceId:String(source?.sourceId || ''),
    discoveryLaneIds:distinct(source?.discovery?.laneIds || []),
    evidenceEligible:source?.evidenceEligible === true,
    authority:'not_inferred_from_search_rank_or_title',
    interestConflict:'not_established',
    independence:'not_established',
  }));
  const claimLedger = (Array.isArray(claims) ? claims : []).map((claim) => {
    const sourceIds = distinct(claim?.sourceIds || []);
    const domains = distinct(sourceIds.flatMap((sourceId) => {
      const source = sourceById.get(String(sourceId));
      try { return [new URL(source?.url || source?.source).hostname.toLowerCase()]; }
      catch { return []; }
    }));
    return {
      claimId:String(claim?.claimId || ''),
      sourceIds,
      claimNature:'source_supported_statement',
      evidenceLevel:sourceIds.length >= 2 ? 'multiple_source_fragments' : 'single_source_fragment',
      independence:sourceIds.length < 2
        ? 'not_established'
        : domains.length >= 2
          ? 'multiple_domains_not_proven_independent'
          : 'multiple_sources_same_domain',
      counterEvidenceStatus:'not_identified_at_claim_level',
    };
  });
  return {
    schemaVersion:'agent.army/research-method/v1',
    strategy:queryPlan.length ? 'multi_lane_discovery' : 'provided_sources_review',
    queryPlan,
    coverage:{
      queryCount:Number(discovery?.searchCalls || 0),
      completedLaneIds:distinct(discovery?.completedLaneIds || []),
      resultLaneIds,
      selectedLaneIds,
      candidateCount:Number(discovery?.candidateCount || 0),
      selectedSourceCount:sources.length,
      omittedLaneIds:queryPlan.map((lane) => lane.id).filter((laneId) => !selectedLaneIds.includes(laneId)),
      searchDiversityMet:requiredDiversity.every((laneId) => resultLaneIds.includes(laneId))
        && selectedLaneIds.length >= MAX_RESEARCH_SOURCES,
      counterEvidenceSearched:Number(discovery?.searchCalls || 0) > 0
        && queryPlan.some((lane) => lane.id === 'counterevidence'),
    },
    epistemicPolicy:{
      searchRankIsTruthSignal:false,
      authorityLabelIsTruthSignal:false,
      clickbaitTerms:'discovery_only',
      primaryOrIndependentCorroborationRequiredForStrongClaim:true,
      searchSnippetIsEvidence:false,
    },
    sourceAssessments,
    claimLedger,
    limitations:[
      '不同域名不等于真正独立来源，转载链和共同上游仍需人工或后续研究核对。',
      '利益冲突只有在原文明确披露或出现可核验证据时才能确认；当前默认不推断。',
      '反向搜索已执行不等于已经找到反证；每条主张仍须按证据片段判断。',
    ],
  };
}

function distinct(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function discoveryQuery(topic) {
  const value = String(topic || '');
  if (/(?:agent|智能体).{0,12}(?:治理|管控|权限)|(?:治理|管控|权限).{0,12}(?:agent|智能体)/i.test(value)) return 'agent governance';
  if (/多智能体|multi[\s-]?agent/i.test(value)) return 'multi-agent governance';
  return value;
}
function needsInput(now, code, userMessage) { return { status:'needs_input', currentStage:code, error:{ code, userMessage, category:'needs_input', stage:'input', occurredAt:now.toISOString() } }; }
function summarize(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = compact.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  return (sentences.length ? sentences.slice(0, 3).join(' ') : compact).slice(0, 900) || '公开网页没有可用正文。';
}
