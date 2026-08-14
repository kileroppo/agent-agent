import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('字幕补正 API 和网页入口保持 AI 主稿、局部补正与版本冲突契约', async () => {
  const [server, html, client] = await Promise.all([
    fs.readFile(new URL('src/server.ts', root), 'utf8'),
    fs.readFile(new URL('public/index.html', root), 'utf8'),
    fs.readFile(new URL('public/app.js', root), 'utf8'),
  ]);

  assert.match(server, /get\('\/api\/jobs\/:id\/transcript-revision'/);
  assert.match(server, /post\('\/api\/jobs\/:id\/transcript-revisions'/);
  assert.match(server, /readTranscriptRevision\(store\.get\(req\.params\.id\)\)/);
  assert.match(server, /reviseTranscript\(\{ store, job:store\.get\(req\.params\.id\), input:req\.body \|\| \{\} \}\)/);

  assert.match(html, /AI 初稿 · 人工辅助/);
  assert.match(html, /不要求完整听审/);
  assert.match(html, /不调用模型，也不会自动更新或外发飞书文档/);
  assert.match(client, /\['completed', 'awaiting_delivery'\]\.includes\(job\.status\).*confirmedTranscriptPath/);
  assert.match(client, /expectedVersion:\s*activeRevisionVersion/);
  assert.match(client, /correctedTranscript:\s*data\.get\('correctedTranscript'\)/);
  assert.match(client, /correctionSummary:\s*data\.get\('correctionSummary'\)/);
  assert.match(client, /editorRef:\s*data\.get\('editorRef'\)/);
  assert.match(client, /response\.status === 409/);
  assert.match(client, /当前编辑未覆盖服务器内容/);
});
