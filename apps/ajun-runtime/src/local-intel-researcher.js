import { createHash } from 'node:crypto';
import { fallbackResearch } from './hermes-intel-research-advisor.js';

const CONTROLLED_SOURCE_MATERIAL = Symbol.for(
  'agent.army.openResearch.controlledSourceMaterial',
);

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
    if (sourceUrls.length > 5) return needsInput(this.now(), 'research_source_limit_exceeded', '一次最多研究五条公开网页来源；请分批发送，避免遗漏资料。');
    if (!sourceUrls.length) {
      discovery = await this.discover(topic, roleToolContext);
      sourceUrls = discovery.urls;
    }
    const { sources, failures } = await this.readSources(
      sourceUrls,
      roleToolContext,
      sourceReadModes(task?.input),
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
    const report = isCampaignEvidence
      ? campaignEvidencePackage({ task, topic, sources:evidenceSources, analysis, completedAt })
      : {
          ...(isCampaignResearch ? { schemaVersion:'agent.army/campaign-research/v2' } : {}),
          topic,
          sources:preparedSources,
          ...analysis,
        };
    const tools = [];
    if (discovery?.searched) tools.push({ id:'public-web-search', name:'公开网页搜索', calls:1 });
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
    return {
      status:'succeeded', currentStage:'grok_public_x_research_ready',
      execution:{ executor:'intel-researcher', mode:'yichen-grok-consult-mcp', finishedAt:completedAt, outcome:'research_ready' },
      usage:{ tools:[{ id:'yichen-grok-consult', name:'Grok 公开 X 检索', calls:1 }] },
      artifactRefs:[{ artifactId:`grok-consult:${task.taskId}`, taskId:task.taskId, type:'intel_research_report', title:`${query} Grok 公开检索`, location:`runtime://${task.taskId}/grok-consult`, mimeType:'text/plain', accessScope:'local-owner', createdAt:completedAt, validation:{ exists:true, readable:true, nonEmpty:Boolean(result.text), publicReadOnly:true, route:result.route }, data:{ query, result:result.text, route:result.route } }],
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
    const query = discoveryQuery(topic);
    const failures = [];
    if (this.publicWebSearch?.search) {
      try {
        const search = roleToolContext
          ? await roleToolContext.execute({
              toolId:'content.public.search',
              externalSideEffect:'network-read',
              url:'https://html.duckduckgo.com/html/',
              input:{ query, limit:3 },
            })
          : await this.publicWebSearch.search({ query, limit:3 });
        const urls = search.results.map((item) => item.url).filter(Boolean);
        if (urls.length) return { urls, searched:true, githubSearched:false, failures };
      } catch (error) {
        failures.push(error?.message || '公开搜索暂时无法读取。');
        // GitHub is a bounded fallback discovery source, not an assertion that
        // every research topic is an open-source topic.
      }
    }
    if (this.githubSearch?.search) {
      try {
        const search = roleToolContext
          ? await roleToolContext.execute({
              toolId:'github.public.search',
              externalSideEffect:'network-read',
              url:'https://api.github.com/search/repositories',
              input:{ operation:'search', query, limit:3 },
            })
          : await this.githubSearch.search({ query, limit:3 });
        return {
          urls:[], searched:Boolean(this.publicWebSearch), githubSearched:true, failures,
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
    return { urls:[], searched:Boolean(this.publicWebSearch), githubSearched:Boolean(this.githubSearch), githubSources:[], failures };
  }

  async readSources(urls, roleToolContext = null, readModes = new Map()) {
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

function campaignEvidencePackage({ task, topic, sources, analysis, completedAt }) {
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
