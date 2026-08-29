#!/usr/bin/env node
/**
 * tools/github-research.mjs
 * 
 * Standalone GitHub research & repository analysis CLI.
 * 
 * Usage:
 *   node tools/github-research.mjs --repo "paperclipai/paperclip"
 *   node tools/github-research.mjs --search "faster whisper"
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// Automatically load local .env if available
try { process.loadEnvFile(); } catch {}
try { process.loadEnvFile(path.resolve(process.cwd(), 'apps/ajun-runtime/.env')); } catch {}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function parseArgs(args) {
  const options = {
    repo: '',
    search: '',
    token: GITHUB_TOKEN,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) {
      options.repo = args[++i];
    } else if (args[i] === '--search' && args[i + 1]) {
      options.search = args[++i];
    } else if (args[i] === '--token' && args[i + 1]) {
      options.token = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      options.help = true;
    }
  }
  return options;
}

function parseRepoSlug(input) {
  if (!input) return null;
  const cleaned = input.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const parts = cleaned.split('/');
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

async function githubFetch(endpoint, token) {
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com/${endpoint.replace(/^\//, '')}`;
  const headers = {
    'User-Agent': 'Agent-Army-Research/1.0',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const res = await fetch(url, { headers });
  if (res.status === 404) {
    throw new Error(`GitHub 资源未找到 (404): ${endpoint}`);
  }
  if (res.status === 403) {
    const msg = await res.text();
    if (msg.includes('rate limit')) {
      throw new Error('GitHub API 调用次数受限，建议在环境变量中配置 GITHUB_TOKEN');
    }
    throw new Error(`GitHub API 权限受阻 (403): ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub API 返回 HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

async function inspectRepo(repoSlug, token) {
  console.error(`[github-research] 正在获取 ${repoSlug} 的详细信息...`);
  
  // 1. Repo info
  const info = await githubFetch(`/repos/${repoSlug}`, token);

  // 2. Recent commits
  let commits = [];
  try {
    const rawCommits = await githubFetch(`/repos/${repoSlug}/commits?per_page=5`, token);
    commits = (rawCommits || []).map(c => ({
      sha: c.sha?.slice(0, 7),
      author: c.commit?.author?.name || c.author?.login,
      date: c.commit?.author?.date,
      message: c.commit?.message?.split('\n')[0]
    }));
  } catch (e) {
    console.error(`[github-research] 获取 commits 提示: ${e.message}`);
  }

  // 3. Latest release
  let latestRelease = null;
  try {
    const rel = await githubFetch(`/repos/${repoSlug}/releases/latest`, token);
    if (rel && rel.tag_name) {
      latestRelease = {
        tag: rel.tag_name,
        name: rel.name,
        publishedAt: rel.published_at,
        body: (rel.body || '').slice(0, 500)
      };
    }
  } catch {}

  // 4. README
  let readme = '';
  try {
    const readmeData = await githubFetch(`/repos/${repoSlug}/readme`, token);
    if (readmeData?.content) {
      readme = Buffer.from(readmeData.content, 'base64').toString('utf-8');
    }
  } catch {}

  return {
    status: 'success',
    type: 'repo_detail',
    repo: repoSlug,
    url: info.html_url,
    description: info.description,
    stars: info.stargazers_count,
    forks: info.forks_count,
    openIssues: info.open_issues_count,
    language: info.language,
    topics: info.topics || [],
    license: info.license?.spdx_id || info.license?.name || null,
    createdAt: info.created_at,
    updatedAt: info.updated_at,
    pushedAt: info.pushed_at,
    latestRelease,
    recentCommits: commits,
    readmeLength: readme.length,
    readmeExcerpt: readme.slice(0, 4000)
  };
}

async function searchRepos(query, token) {
  console.error(`[github-research] 正在搜索 GitHub 仓库: "${query}" ...`);
  const endpoint = `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`;
  const result = await githubFetch(endpoint, token);
  
  const items = (result.items || []).map(r => ({
    name: r.full_name,
    url: r.html_url,
    description: r.description,
    stars: r.stargazers_count,
    forks: r.forks_count,
    language: r.language,
    updatedAt: r.updated_at
  }));

  return {
    status: 'success',
    type: 'search_result',
    query,
    totalCount: result.total_count,
    topRepos: items
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || (!options.repo && !options.search)) {
    console.log(`
Usage:
  node tools/github-research.mjs --repo <OWNER/REPO> [--token <TOKEN>]
  node tools/github-research.mjs --search <QUERY> [--token <TOKEN>]

Options:
  --repo        Target repository slug or URL (e.g. "paperclipai/paperclip")
  --search      Search query to find relevant open-source projects
  --token       GitHub personal access token (optional, default: env GITHUB_TOKEN)
  --help, -h    Show this help message
`);
    process.exit(options.help ? 0 : 1);
  }

  try {
    if (options.repo) {
      const slug = parseRepoSlug(options.repo);
      if (!slug) throw new Error(`无效的仓库名称格式: ${options.repo}，请使用 "owner/repo" 或 GitHub URL`);
      const data = await inspectRepo(slug, options.token);
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (options.search) {
      const data = await searchRepos(options.search, options.token);
      console.log(JSON.stringify(data, null, 2));
      return;
    }
  } catch (error) {
    console.error(`[github-research] 错误: ${error.message}`);
    console.log(JSON.stringify({
      status: 'error',
      error: error.message
    }, null, 2));
    process.exit(1);
  }
}

main();
