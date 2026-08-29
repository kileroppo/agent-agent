#!/usr/bin/env node
/**
 * gateway/feishu-bot.mjs
 * 
 * Ultra-lightweight Skill-Driven Feishu WebSocket Bot Gateway (< 200 lines).
 * Listens to Feishu private messages via official WebSocket (no public IP / no webhook needed).
 * Dispatches requests to skills/ and tools/ directly.
 * 
 * Usage:
 *   node gateway/feishu-bot.mjs
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as lark from '@larksuiteoapi/node-sdk';

const execAsync = promisify(execFile);

// Load env files
try { process.loadEnvFile(); } catch {}
try { process.loadEnvFile(path.resolve(process.cwd(), 'apps/xiaod-media-transcriber/.env')); } catch {}
try { process.loadEnvFile(path.resolve(process.cwd(), 'apps/ajun-runtime/.env')); } catch {}

const APP_ID = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('[feishu-bot] 缺少飞书凭据 (LARK_APP_ID / LARK_APP_SECRET)');
  process.exit(1);
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: 'info' });

async function replyMessage(messageId, text) {
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text })
      }
    });
  } catch (e) {
    console.error(`[feishu-bot] 回复消息失败: ${e.message}`);
  }
}

function detectIntent(text) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) return { type: 'chat', text };
  const url = urlMatch[0];

  if (url.includes('bilibili.com') || url.includes('youtube.com') || url.includes('youtu.be') || /\.(mp3|mp4|wav|m4a)$/i.test(url)) {
    return { type: 'video_transcribe', url };
  }
  if (url.includes('github.com')) {
    return { type: 'github_research', url };
  }
  if (url.includes('mp.weixin.qq.com') || url.includes('zhihu.com')) {
    return { type: 'web_article', url };
  }
  return { type: 'web_article', url };
}

async function handleVideoTranscribe(url, messageId) {
  await replyMessage(messageId, '⏳ 已收到音视频整理需求，正在为您提取素材并进行本地语音转录，请稍候...');
  
  // 1. Fetch media
  const { stdout: fetchOut } = await execAsync('node', ['tools/fetch-media.mjs', '--url', url]);
  const fetchResult = JSON.parse(fetchOut);
  if (fetchResult.status !== 'success') {
    throw new Error(fetchResult.error || '获取音视频素材失败');
  }

  let fullTranscript = '';
  const title = fetchResult.title || '音视频精华整理';

  if (fetchResult.type === 'subtitles' && fetchResult.subtitlesFile) {
    fullTranscript = await fs.readFile(fetchResult.subtitlesFile, 'utf-8');
  } else if (fetchResult.audioFile) {
    // 2. Local ASR
    const { stdout: asrOut } = await execAsync('python3', ['tools/transcribe-whisper.py', '--audio', fetchResult.audioFile]);
    const asrResult = JSON.parse(asrOut);
    if (asrResult.status !== 'success' || !asrResult.textFile) {
      throw new Error(asrResult.error || '本地语音转录失败');
    }
    fullTranscript = await fs.readFile(asrResult.textFile, 'utf-8');
  }

  // 3. Create clean document
  const summaryMarkdown = `# 📌 ${title} · 逐字整理与导览\n\n> 来源：${url}\n> 整理人：小D·数字转录助手 (Skill-Driven)\n\n---\n\n## 一、 全文转录内容\n\n${fullTranscript}\n`;
  const tmpFile = path.join('/tmp', `summary_${Date.now()}.md`);
  await fs.writeFile(tmpFile, summaryMarkdown, 'utf-8');

  // 4. Create Feishu docx
  const { stdout: docOut } = await execAsync('node', ['tools/create-feishu-doc.mjs', '--title', `${title}·精华整理`, '--content-file', tmpFile]);
  const docResult = JSON.parse(docOut);

  if (docResult.status === 'success' && docResult.url) {
    await replyMessage(messageId, `🎉 音视频整理完成！\n\n📄 飞书文档已生成：\n${docResult.url}\n\n欢迎点击查阅！`);
  } else {
    throw new Error(docResult.error || '创建飞书文档失败');
  }
}

async function handleGithubResearch(url, messageId) {
  await replyMessage(messageId, '⏳ 已收到开源项目调研需求，正在分析仓库架构与活跃度...');
  const { stdout: ghOut } = await execAsync('node', ['tools/github-research.mjs', '--repo', url]);
  const ghResult = JSON.parse(ghOut);
  if (ghResult.status !== 'success') {
    throw new Error(ghResult.error || '获取 GitHub 仓库信息失败');
  }

  const report = `📊 【开源项目调研】${ghResult.repo}\n\n` +
    `⭐ Stars: ${ghResult.stars} | 🍴 Forks: ${ghResult.forks}\n` +
    `📜 协议: ${ghResult.license || '未声明'}\n` +
    `📝 描述: ${ghResult.description || '无'}\n\n` +
    `🔗 仓库链接: ${ghResult.url}`;

  await replyMessage(messageId, report);
}

async function handleWebArticle(url, messageId) {
  await replyMessage(messageId, '⏳ 正在提取文章正文并归档到飞书...');
  const { stdout: webOut } = await execAsync('node', ['tools/fetch-web-article.mjs', '--url', url]);
  const webResult = JSON.parse(webOut);
  if (webResult.status !== 'success') throw new Error(webResult.error || '文章提取失败');

  const tmpFile = path.join('/tmp', `article_${Date.now()}.md`);
  await fs.writeFile(tmpFile, `# 📖 ${webResult.title}\n\n> 作者：${webResult.author || '未知'}\n> 来源：${url}\n\n---\n\n${webResult.markdown}`, 'utf-8');

  const { stdout: docOut } = await execAsync('node', ['tools/create-feishu-doc.mjs', '--title', `${webResult.title}·文章归档`, '--content-file', tmpFile]);
  const docResult = JSON.parse(docOut);

  if (docResult.status === 'success' && docResult.url) {
    await replyMessage(messageId, `🎉 文章归档完成！\n\n📄 飞书文档：${docResult.url}`);
  }
}

// Event Dispatcher
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const { message } = data;
    if (message.message_type !== 'text') return;

    let contentText = '';
    try {
      contentText = JSON.parse(message.content).text?.trim() || '';
    } catch {
      contentText = message.content;
    }

    if (!contentText) return;
    console.log(`[feishu-bot] 收到消息: "${contentText}" (from ${message.sender?.sender_id?.open_id || 'unknown'})`);

    const intent = detectIntent(contentText);
    try {
      if (intent.type === 'video_transcribe') {
        await handleVideoTranscribe(intent.url, message.message_id);
      } else if (intent.type === 'github_research') {
        await handleGithubResearch(intent.url, message.message_id);
      } else if (intent.type === 'web_article') {
        await handleWebArticle(intent.url, message.message_id);
      } else {
        await replyMessage(message.message_id, `🤖 我是 Agent 军团极简助理！\n\n你可以直接向我发送：\n1. 🎬 B站/YouTube 视频链接 -> 自动转录并交付飞书文档\n2. 🐙 GitHub 仓库链接 -> 自动生成开源调研报告\n3. 📰 微信公众号/知乎文章链接 -> 自动清洗排版并归档飞书文档`);
      }
    } catch (err) {
      console.error(`[feishu-bot] 处理异常: ${err.message}`);
      await replyMessage(message.message_id, `⚠️ 处理任务时出错: ${err.message}`);
    }
  }
});

async function main() {
  console.log('[feishu-bot] 正在通过 WebSocket 启动轻量飞书网关...');
  await wsClient.start({ eventDispatcher });
  console.log('[feishu-bot] ✅ 飞书长连接已就绪！已准备接收飞书单聊消息。');
}

main().catch((err) => {
  console.error('[feishu-bot] 启动失败:', err);
  process.exit(1);
});
