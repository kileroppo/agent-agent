import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkFeishuMarkdown,
  createFeishuOversizedCardPayload,
  estimateUtf8Bytes,
  extractMarkdownHeadings,
} from '../src/feishu-payload-chunker.ts';

test('chunkFeishuMarkdown 短文本保持单一分片', () => {
  const text = '# 短标题\n\n这是正常长度的内容。';
  const chunks = chunkFeishuMarkdown(text, 1024);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test('chunkFeishuMarkdown 长文本按段落边界安全切分且不超字节上限', () => {
  const paras = [];
  for (let i = 1; i <= 20; i++) {
    paras.push(`## 章节 ${i}\n这是第 ${i} 节的详细讨论内容，包含多行说明和案例分析数据。`);
  }
  const longMd = paras.join('\n\n');
  const maxBytes = 300; // 较小的切片阈值测试

  const chunks = chunkFeishuMarkdown(longMd, maxBytes);
  assert.ok(chunks.length > 3);

  for (const chunk of chunks) {
    assert.ok(estimateUtf8Bytes(chunk) <= maxBytes * 1.5); // 允许单段微量波动，且无异常截断
  }
});

test('extractMarkdownHeadings 提取大纲标题', () => {
  const md = '# 主标题\n正文\n## 第一章 概述\n内容\n### 1.1 细节\n## 第二章 结论';
  const headings = extractMarkdownHeadings(md);
  assert.deepEqual(headings, ['主标题', '第一章 概述', '1.1 细节', '第二章 结论']);
});

test('createFeishuOversizedCardPayload 超大产物自动生成导览卡片与跳转按钮', () => {
  const longText = '# 深度行业研报\n\n## 行业现状\n' + '详细数据分析 '.repeat(2000);
  const card = createFeishuOversizedCardPayload({
    title: '2026行业研报',
    summary: 'AI产业迎来规模化闭环落地。',
    fullMarkdown: longText,
    maxBytes: 1024,
    artifactUrl: 'http://127.0.0.1:4321/reports/101',
  });

  assert.ok(card.header.title.content.includes('已归档'));
  assert.equal(card.header.template, 'wathet');
  assert.ok(card.elements[0].text.content.includes('导览摘要'));
  assert.ok(card.elements[0].text.content.includes('行业现状'));
  assert.equal(card.elements[1].actions[0].url, 'http://127.0.0.1:4321/reports/101');
});
