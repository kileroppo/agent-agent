#!/usr/bin/env node
/**
 * tools/create-feishu-doc.mjs
 * 
 * Standalone Feishu docx creator CLI for Skill-Driven Agent.
 * 
 * Usage:
 *   node tools/create-feishu-doc.mjs --title "AI技术分享整理" --content-file /tmp/summary.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// Automatically load local .env if available in common locations
try {
  process.loadEnvFile();
} catch {}

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'apps/xiaod-media-transcriber/.env'),
  path.resolve(process.cwd(), 'apps/ajun-runtime/.env')
];

for (const ep of envPaths) {
  try {
    process.loadEnvFile(ep);
  } catch {}
}

function parseArgs(args) {
  const options = {
    title: '',
    content: '',
    contentFile: '',
    appId: process.env.LARK_APP_ID || process.env.FEISHU_APP_ID || '',
    appSecret: process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET || '',
    userOpenId: process.env.LARK_USER_OPEN_ID || process.env.FEISHU_USER_OPEN_ID || ''
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title' && args[i + 1]) {
      options.title = args[++i];
    } else if (args[i] === '--content-file' && args[i + 1]) {
      options.contentFile = args[++i];
    } else if (args[i] === '--content' && args[i + 1]) {
      options.content = args[++i];
    } else if (args[i] === '--app-id' && args[i + 1]) {
      options.appId = args[++i];
    } else if (args[i] === '--app-secret' && args[i + 1]) {
      options.appSecret = args[++i];
    } else if (args[i] === '--user-id' && args[i + 1]) {
      options.userOpenId = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      options.help = true;
    }
  }
  return options;
}

function inlineElements(value) {
  const elements = [];
  const parts = String(value).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  for (const part of parts) {
    const bold = part.startsWith('**') && part.endsWith('**');
    const content = bold ? part.slice(2, -2) : part;
    if (content) elements.push({ text_run: { content, ...(bold ? { text_element_style: { bold: true } } : {}) } });
  }
  return elements.length ? elements : [{ text_run: { content: String(value) } }];
}

function markdownToBlocks(markdown) {
  let firstMeaningfulLine = true;
  return markdown.split('\n').flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line || line === '---' || line.startsWith('>')) return [];
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (firstMeaningfulLine && heading?.[1].length === 1) {
      firstMeaningfulLine = false;
      return [];
    }
    firstMeaningfulLine = false;
    if (heading) {
      const level = heading[1].length;
      const blockType = level === 1 ? 3 : level === 2 ? 4 : 5;
      const key = level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
      return [{ block_type: blockType, [key]: { elements: inlineElements(heading[2]) } }];
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) return [{ block_type: 12, bullet: { elements: inlineElements(bullet[1]) } }];
    return [{ block_type: 2, text: { elements: inlineElements(line) } }];
  });
}

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.title || (!options.content && !options.contentFile)) {
    console.log(`
Usage:
  node tools/create-feishu-doc.mjs --title <TITLE> (--content <TEXT> | --content-file <FILE>) [options]

Options:
  --title         Title of the Feishu docx
  --content       Markdown content text string
  --content-file  Path to Markdown text file
  --app-id        Feishu/Lark App ID (default: env LARK_APP_ID)
  --app-secret    Feishu/Lark App Secret (default: env LARK_APP_SECRET)
  --user-id       Feishu/Lark User open_id to grant full access (default: env LARK_USER_OPEN_ID)
  --help, -h      Show this help message
`);
    process.exit(options.help ? 0 : 1);
  }

  if (!options.appId || !options.appSecret) {
    console.error('[create-feishu-doc] 缺少飞书凭据 (LARK_APP_ID / LARK_APP_SECRET)');
    console.log(JSON.stringify({
      status: 'error',
      error: 'Missing LARK_APP_ID or LARK_APP_SECRET in environment'
    }, null, 2));
    process.exit(1);
  }

  let markdown = options.content;
  if (options.contentFile) {
    markdown = await fs.readFile(path.resolve(options.contentFile), 'utf-8');
  }

  try {
    // 1. Get Tenant Access Token
    console.error('[create-feishu-doc] 获取飞书租户凭证...');
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret })
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.code !== 0 || !tokenJson.tenant_access_token) {
      throw new Error(tokenJson.msg || '无法获取飞书租户凭证');
    }
    const token = tokenJson.tenant_access_token;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    // 2. Create document
    console.error(`[create-feishu-doc] 创建文档: "${options.title}" ...`);
    const createRes = await fetch('https://open.feishu.cn/open-apis/docx/v1/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: options.title })
    });
    const createJson = await createRes.json();
    if (createJson.code !== 0) {
      throw new Error(createJson.msg || '创建飞书文档失败');
    }
    const documentId = createJson.data?.document?.document_id || createJson.data?.document_id;
    if (!documentId) throw new Error('飞书未返回 document_id');

    const docUrl = `https://feishu.cn/docx/${documentId}`;
    console.error(`[create-feishu-doc] 文档已创建: ${docUrl}，正在写入内容...`);

    // 3. Write blocks in batches
    const blocks = markdownToBlocks(markdown);
    const batches = chunk(blocks, 50);

    for (let i = 0; i < batches.length; i++) {
      console.error(`[create-feishu-doc] 写入批次 ${i + 1}/${batches.length} ...`);
      const writeRes = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ index: -1, children: batches[i] })
      });
      const writeJson = await writeRes.json();
      if (writeJson.code !== 0) {
        throw new Error(writeJson.msg || `写入第 ${i + 1} 批正文失败`);
      }
      if (batches.length > 1 && i < batches.length - 1) {
        await delay(300);
      }
    }

    // 4. Grant user permissions if open_id provided
    let permissionGranted = false;
    if (options.userOpenId) {
      console.error(`[create-feishu-doc] 为用户 ${options.userOpenId} 授权...`);
      const permRes = await fetch(`https://open.feishu.cn/open-apis/drive/v1/permissions/${documentId}/members?type=docx&need_notification=false`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          member_type: 'openid',
          member_id: options.userOpenId,
          perm: 'full_access'
        })
      });
      const permJson = await permRes.json();
      if (permJson.code === 0) {
        permissionGranted = true;
      } else {
        console.error(`[create-feishu-doc] 授权提示: ${permJson.msg}`);
      }
    }

    const output = {
      status: 'success',
      documentId,
      url: docUrl,
      title: options.title,
      blocksCount: blocks.length,
      permissionGranted
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(`[create-feishu-doc] 失败: ${error.message}`);
    console.log(JSON.stringify({
      status: 'error',
      error: error.message
    }, null, 2));
    process.exit(1);
  }
}

main();
