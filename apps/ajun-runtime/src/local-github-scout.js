export class LocalGithubScout {
  constructor({ githubSearch, now = () => new Date() } = {}) {
    this.githubSearch = githubSearch;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'github-scout'; }

  async execute(task) {
    const input = task?.input || {};
    if (String(input.repo || '').trim()) return this.read(task, input);
    if (String(input.query || input.title || '').trim()) return this.search(task, input);
    return needsInput(this.now(), 'github_query_required', '请说明要找什么 GitHub 项目，或给出公开 owner/repo 和可选文件路径。');
  }

  async search(task, input) {
    try {
      const search = await this.githubSearch.search({ query:input.query || input.title, limit:5 });
      if (!search.results.length) return needsInput(this.now(), 'github_no_results', '没有找到匹配的公开 GitHub 项目。请换一组更具体的关键词后再试。');
      const completedAt = this.now().toISOString();
      const report = {
        query:search.query, searchedAt:search.searchedAt, results:search.results.map((item) => ({ ...item, assessment:assess(item) })),
        conclusion:`已按 star 排序整理 ${search.results.length} 个公开 GitHub 项目；活跃度只依据本次读取的最近更新时间判断。`
      };
      return succeeded(task, completedAt, 'github_search_ready', 'github_search', 'github-public-search', '公开 GitHub 项目检索', 1, {
        type:'research_github_report', title:'GitHub 公开项目检索报告', location:`runtime://${task.taskId}/github-search-report`, data:report,
        validation:{ exists:true, readable:true, nonEmpty:true, publicReadOnly:true, sourceCount:search.results.length }
      });
    } catch (error) { return failure(this.now(), error); }
  }

  async read(task, input) {
    try {
      const file = await this.githubSearch.readRepo({ repo:input.repo, path:input.path || 'README' });
      if (!file.text.trim()) return needsInput(this.now(), 'github_empty_file', '这个公开 GitHub 文件没有可用文本内容。请换一个 README 或公开文本文件。');
      const completedAt = this.now().toISOString();
      const report = {
        repo:file.repo, path:file.path, source:`https://github.com/${file.repo}${file.path === 'README' ? '' : `/blob/HEAD/${file.path}`}`,
        fetchedAt:file.fetchedAt, truncated:file.truncated, summary:summarize(file.text),
        basis:'仅根据本次读取的公开 GitHub 文件内容。'
      };
      return succeeded(task, completedAt, 'github_code_read_ready', 'github_read', 'github-public-read', '公开 GitHub 文件读取', 1, {
        type:'github_code_read', title:`${file.repo} 的 ${file.path}`, location:`runtime://${task.taskId}/github-code-read`, data:report,
        validation:{ exists:true, readable:true, nonEmpty:true, publicReadOnly:true }
      });
    } catch (error) { return failure(this.now(), error); }
  }
}

function succeeded(task, completedAt, stage, mode, toolId, toolName, calls, artifact) {
  return {
    status:'succeeded', currentStage:stage,
    execution:{ executor:task.assigneeAgentId || 'github-scout', mode, startedAt:task.execution?.startedAt || completedAt, finishedAt:completedAt, outcome:'report_ready' },
    usage:{ tools:[{ id:toolId, name:toolName, calls }] },
    artifactRefs:[{ artifactId:`github-scout:${task.taskId}`, taskId:task.taskId, mimeType:'application/json', accessScope:'local-owner', createdAt:completedAt, ...artifact }]
  };
}

function failure(now, error) {
  const code = error?.code || 'github_unavailable';
  const userMessage = code === 'github_rate_limited'
    ? 'GitHub 公开接口暂时限流，请稍后重试，或换一个更具体的关键词。'
    : `${error?.message || 'GitHub 公开接口暂时无法读取。'} 你可以稍后重试，或换一个公开仓库/关键词。`;
  return needsInput(now, code, userMessage);
}

function needsInput(now, code, userMessage) {
  return { status:'needs_input', currentStage:code, error:{ code, userMessage, category:'needs_input', stage:'input', occurredAt:now.toISOString() } };
}

function assess(item) {
  const stars = Number(item.stars || 0);
  const updatedAt = Date.parse(item.updatedAt || '');
  const ageDays = Number.isFinite(updatedAt) ? Math.max(0, Math.floor((Date.now() - updatedAt) / 86_400_000)) : null;
  const popularity = stars >= 10_000 ? '关注度很高' : stars >= 1_000 ? '关注度较高' : stars >= 100 ? '有一定社区使用' : '社区信号有限';
  const activity = ageDays === null ? '最近更新时间未提供' : ageDays <= 90 ? '近三个月仍有更新' : ageDays <= 365 ? '近一年有更新' : '超过一年未见更新';
  return `${popularity}；${item.language ? `主要语言为 ${item.language}` : '主要语言未提供'}；${activity}。`;
}

function summarize(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()).filter((line) => line && !/^[-*_`]+$/.test(line));
  return lines.slice(0, 8).join(' ').slice(0, 1800) || '该文件没有可提炼的文本要点。';
}
