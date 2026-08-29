#!/usr/bin/env node
/**
 * tools/fetch-web-article.mjs
 * 
 * Standalone web article & content extractor CLI (WeChat, Zhihu, Tech Blogs, Public Web).
 * 
 * Usage:
 *   node tools/fetch-web-article.mjs --url "https://mp.weixin.qq.com/s/xxx"
 *   node tools/fetch-web-article.mjs --url "https://zhuanlan.zhihu.com/p/xxx"
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

function parseArgs(args) {
  const options = { url: '', outputFile: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      options.url = args[++i];
    } else if (args[i] === '--output-file' && args[i + 1]) {
      options.outputFile = path.resolve(args[++i]);
    } else if (args[i] === '--help' || args[i] === '-h') {
      options.help = true;
    }
  }
  return options;
}

function cleanHtmlToMarkdown(html) {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Convert headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');

  // Convert paragraphs and linebreaks
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<br\s*[\/]?>/gi, '\n');
  text = text.replace(/<hr\s*[\/]?>/gi, '\n---\n');

  // Convert bold and italic
  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');

  // Convert code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Convert links
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Normalize consecutive empty lines
  return text.split('\n').map(l => l.trim()).filter((l, i, arr) => l || (i > 0 && arr[i - 1])).join('\n').trim();
}

function extractWeChatArticle(html) {
  const titleMatch = html.match(/<h1[^>]*class=["'][^"']*activity-name[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
  const authorMatch = html.match(/<a[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i)
    || html.match(/<meta[^>]*name=["']author["'][^>]*content=["']([^"']*)["']/i);
  const contentMatch = html.match(/<div[^>]*id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i);

  const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  const rawAuthor = authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  const rawContent = contentMatch ? contentMatch[1] : '';

  return {
    title: rawTitle,
    author: rawAuthor,
    markdown: cleanHtmlToMarkdown(rawContent)
  };
}

function extractGeneralArticle(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const authorMatch = html.match(/<meta[^>]*name=["'](?:author|twitter:creator)["'][^>]*content=["']([^"']*)["']/i);

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<div[^>]*class=["'][^"']*(?:post-content|article-content|entry-content|content|markdown-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '网页文章';
  const author = authorMatch ? authorMatch[1].trim() : null;
  const contentHtml = articleMatch ? articleMatch[1] : html;

  return {
    title,
    author,
    markdown: cleanHtmlToMarkdown(contentHtml)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.url) {
    console.log(`
Usage:
  node tools/fetch-web-article.mjs --url <URL> [--output-file <FILE>]

Options:
  --url          Target article URL (WeChat article, Zhihu, Tech Blog, etc.)
  --output-file  Path to save extracted Markdown file (optional)
  --help, -h     Show this help message
`);
    process.exit(options.help ? 0 : 1);
  }

  try {
    console.error(`[fetch-web-article] 正在获取网页内容: ${options.url} ...`);
    const res = await fetch(options.url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP 抓取失败: ${res.status} ${res.statusText}`);
    const html = await res.text();

    const isWeChat = options.url.includes('mp.weixin.qq.com');
    const extracted = isWeChat ? extractWeChatArticle(html) : extractGeneralArticle(html);

    if (options.outputFile) {
      await fs.writeFile(options.outputFile, extracted.markdown, 'utf-8');
      console.error(`[fetch-web-article] 已保存到: ${options.outputFile}`);
    }

    const output = {
      status: 'success',
      url: options.url,
      title: extracted.title,
      author: extracted.author,
      contentLength: extracted.markdown.length,
      markdownExcerpt: extracted.markdown.slice(0, 500),
      markdown: extracted.markdown
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(`[fetch-web-article] 错误: ${error.message}`);
    console.log(JSON.stringify({
      status: 'error',
      error: error.message
    }, null, 2));
    process.exit(1);
  }
}

main();
