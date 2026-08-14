const MAX_TEXT_CHARS: any = 30000;
const GITHUB_ACCEPT: any = 'application/vnd.github+json';
const GITHUB_USER_AGENT: any = 'agent-army-intel-researcher';
export class GithubSearch {
    fetch: any;
    now: any;
    constructor({ fetchImpl = fetch, now = (): any => new Date() }: any = {}) {
        this.fetch = fetchImpl;
        this.now = now;
    }
    async search({ query, limit = 5 }: any = {}): Promise<any> {
        const safeQuery: any = requiredText(query, '需要 GitHub 搜索关键词。');
        const safeLimit: any = Math.min(10, Math.max(1, Number.parseInt(limit, 10) || 5));
        const url: any = new URL('https://api.github.com/search/repositories');
        url.searchParams.set('q', safeQuery);
        url.searchParams.set('sort', 'stars');
        url.searchParams.set('order', 'desc');
        url.searchParams.set('per_page', String(safeLimit));
        const response: any = await this.request(url);
        const body: any = await json(response);
        return {
            query: safeQuery,
            searchedAt: this.now().toISOString(),
            results: (Array.isArray(body?.items) ? body.items : []).map((item: any): any => ({
                fullName: text(item?.full_name), description: text(item?.description) || null,
                stars: Number(item?.stargazers_count || 0), language: text(item?.language) || null,
                updatedAt: text(item?.updated_at) || null, url: publicGithubUrl(item?.html_url, item?.full_name),
                topics: Array.isArray(item?.topics) ? item.topics.map((topic: any): any => text(topic)).filter(Boolean).slice(0, 10) : []
            })).filter((item: any): any => item.fullName && item.url)
        };
    }
    async readRepo({ repo, path = 'README' }: any = {}): Promise<any> {
        const safeRepo: any = safeRepository(repo);
        const safePath: any = safeContentPath(path);
        const endpoint: any = safePath === 'README'
            ? `https://api.github.com/repos/${safeRepo}/readme`
            : `https://api.github.com/repos/${safeRepo}/contents/${safePath.split('/').map(encodeURIComponent).join('/')}`;
        const response: any = await this.request(endpoint);
        const body: any = await json(response);
        if (!body?.content || String(body.encoding || '').toLowerCase() !== 'base64') {
            throw new GithubSearchError('github_unavailable', '公开仓库文件没有可读取的文本内容。');
        }
        const decoded: any = Buffer.from(String(body.content).replace(/\s/g, ''), 'base64').toString('utf8');
        const truncated: any = decoded.length > MAX_TEXT_CHARS;
        return { repo: safeRepo, path: safePath, text: decoded.slice(0, MAX_TEXT_CHARS), truncated, fetchedAt: this.now().toISOString() };
    }
    async request(url: any): Promise<any> {
        let response: any;
        try {
            response = await this.fetch(String(url), { redirect: 'error', headers: { Accept: GITHUB_ACCEPT, 'User-Agent': GITHUB_USER_AGENT }, signal: AbortSignal.timeout(20000) });
        }
        catch {
            throw new GithubSearchError('github_unavailable', 'GitHub 公开接口暂时无法读取。');
        }
        if (response?.status === 403 && String(response.headers?.get?.('x-ratelimit-remaining') || '') === '0') {
            throw new GithubSearchError('github_rate_limited', 'GitHub 公开接口暂时限流，请稍后重试。');
        }
        if (!response?.ok)
            throw new GithubSearchError('github_unavailable', `GitHub 公开接口返回 ${response?.status || '未知'}。`);
        return response;
    }
}
export class GithubSearchError extends Error {
    code: any;
    constructor(code: any, message: any) { super(message); this.code = code; }
}
async function json(response: any): Promise<any> {
    try {
        return await response.json();
    }
    catch {
        throw new GithubSearchError('github_unavailable', 'GitHub 公开接口返回了无法读取的内容。');
    }
}
function requiredText(value: any, message: any): any {
    const result: any = text(value);
    if (!result)
        throw new GithubSearchError('github_unavailable', message);
    return result;
}
function text(value: any): any { return String(value || '').trim(); }
function safeRepository(value: any): any {
    const repo: any = text(value);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
        throw new GithubSearchError('github_unavailable', '仓库需使用公开 owner/repo 格式。');
    return repo;
}
function safeContentPath(value: any): any {
    const path: any = text(value) || 'README';
    if (path === 'README')
        return path;
    if (path.startsWith('/') || path.split('/').some((part: any): any => !part || part === '.' || part === '..'))
        throw new GithubSearchError('github_unavailable', '只能读取仓库内的公开文件路径。');
    return path;
}
function publicGithubUrl(value: any, fullName: any): any {
    const url: any = text(value);
    return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(url) ? url : `https://github.com/${fullName}`;
}
