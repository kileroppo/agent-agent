const MAX_TEXT_CHARS = 30_000;
const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_USER_AGENT = 'agent-army-github-scout';

export class GithubSearch {
  constructor({ fetchImpl = fetch, now = () => new Date() } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
  }

  async search({ query, limit = 5 } = {}) {
    const safeQuery = requiredText(query, '需要 GitHub 搜索关键词。');
    const safeLimit = Math.min(10, Math.max(1, Number.parseInt(limit, 10) || 5));
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', safeQuery);
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('per_page', String(safeLimit));
    const response = await this.request(url);
    const body = await json(response);
    return {
      query: safeQuery,
      searchedAt: this.now().toISOString(),
      results: (Array.isArray(body?.items) ? body.items : []).map((item) => ({
        fullName: text(item?.full_name), description: text(item?.description) || null,
        stars: Number(item?.stargazers_count || 0), language: text(item?.language) || null,
        updatedAt: text(item?.updated_at) || null, url: publicGithubUrl(item?.html_url, item?.full_name),
        topics: Array.isArray(item?.topics) ? item.topics.map((topic) => text(topic)).filter(Boolean).slice(0, 10) : []
      })).filter((item) => item.fullName && item.url)
    };
  }

  async readRepo({ repo, path = 'README' } = {}) {
    const safeRepo = safeRepository(repo);
    const safePath = safeContentPath(path);
    const endpoint = safePath === 'README'
      ? `https://api.github.com/repos/${safeRepo}/readme`
      : `https://api.github.com/repos/${safeRepo}/contents/${safePath.split('/').map(encodeURIComponent).join('/')}`;
    const response = await this.request(endpoint);
    const body = await json(response);
    if (!body?.content || String(body.encoding || '').toLowerCase() !== 'base64') {
      throw new GithubSearchError('github_unavailable', '公开仓库文件没有可读取的文本内容。');
    }
    const decoded = Buffer.from(String(body.content).replace(/\s/g, ''), 'base64').toString('utf8');
    const truncated = decoded.length > MAX_TEXT_CHARS;
    return { repo:safeRepo, path:safePath, text:decoded.slice(0, MAX_TEXT_CHARS), truncated, fetchedAt:this.now().toISOString() };
  }

  async request(url) {
    let response;
    try {
      response = await this.fetch(String(url), { redirect:'error', headers:{ Accept:GITHUB_ACCEPT, 'User-Agent':GITHUB_USER_AGENT }, signal:AbortSignal.timeout(20_000) });
    } catch {
      throw new GithubSearchError('github_unavailable', 'GitHub 公开接口暂时无法读取。');
    }
    if (response?.status === 403 && String(response.headers?.get?.('x-ratelimit-remaining') || '') === '0') {
      throw new GithubSearchError('github_rate_limited', 'GitHub 公开接口暂时限流，请稍后重试。');
    }
    if (!response?.ok) throw new GithubSearchError('github_unavailable', `GitHub 公开接口返回 ${response?.status || '未知'}。`);
    return response;
  }
}

export class GithubSearchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function json(response) {
  try { return await response.json(); }
  catch { throw new GithubSearchError('github_unavailable', 'GitHub 公开接口返回了无法读取的内容。'); }
}
function requiredText(value, message) { const result = text(value); if (!result) throw new GithubSearchError('github_unavailable', message); return result; }
function text(value) { return String(value || '').trim(); }
function safeRepository(value) {
  const repo = text(value);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new GithubSearchError('github_unavailable', '仓库需使用公开 owner/repo 格式。');
  return repo;
}
function safeContentPath(value) {
  const path = text(value) || 'README';
  if (path === 'README') return path;
  if (path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new GithubSearchError('github_unavailable', '只能读取仓库内的公开文件路径。');
  return path;
}
function publicGithubUrl(value, fullName) {
  const url = text(value);
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(url) ? url : `https://github.com/${fullName}`;
}
