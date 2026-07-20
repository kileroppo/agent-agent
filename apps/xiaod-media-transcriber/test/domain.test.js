import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, composeDelivery, mechanicalDraft, qualityCheck, validatePublicHttpUrl } from '../src/domain.js';
import { markdownToBlocks } from '../src/pipeline.js';

test('rejects internal and malformed URLs', () => {
  assert.equal(validatePublicHttpUrl('http://127.0.0.1:3000/a').ok, false);
  assert.equal(validatePublicHttpUrl('file:///private/a.mp3').ok, false);
  assert.equal(validatePublicHttpUrl('https://www.example.com/watch').ok, true);
});

test('cleans common VTT markers, timestamps, speaker labels, and repeated lines', () => {
  const source = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n[说话人 1] 大家好。\n\n2\n00:00:03.000 --> 00:00:04.000\n大家好。\n\nSpeaker 2: 今天聊产品。';
  assert.equal(cleanTranscript(source), '大家好。\n今天聊产品。');
});

test('mechanical draft remains a transcript-style draft and reports manual review', () => {
  const draft = mechanicalDraft('测试', '第一句。第二句。第三句。第四句。第五句。');
  assert.match(draft, /# 测试/);
  const quality = qualityCheck(draft, { usedRefiner: false });
  assert.equal(quality.passed, false);
  assert.match(quality.issues.join('\n'), /未启用语义整理模型/);
});

test('delivery keeps the reading guide and the complete proofread text as separate layers', () => {
  const markdown = composeDelivery('直播记录', '## 概述\n\n内容范围。\n\n## 主题详述\n\n### 具体主题\n\n论证。\n\n## 核心观点与洞察\n\n### 具体洞察\n\n依据。', '第一句。\n第二句。\n第三句。\n第四句。\n第五句。');
  assert.match(markdown, /^# 直播记录/m);
  assert.match(markdown, /## 内容导览/);
  assert.match(markdown, /## 完整校对文本/);
  assert.match(markdown, /第一句。第二句。第三句。第四句。/);
});

test('Feishu delivery keeps heading hierarchy and bold emphasis without duplicating document H1', () => {
  const blocks = markdownToBlocks('# 文档标题\n\n## 内容导览\n\n正文含有**重点信息**。\n\n- 一个要点');
  assert.equal(blocks.some((block) => block.heading1?.elements?.[0]?.text_run?.content === '文档标题'), false);
  assert.equal(blocks[0].heading2.elements[0].text_run.content, '内容导览');
  assert.deepEqual(blocks[1].text.elements.map((element) => element.text_run.content), ['正文含有', '重点信息', '。']);
  assert.equal(blocks[1].text.elements[1].text_run.text_element_style.bold, true);
  assert.equal(blocks[2].block_type, 12);
});
