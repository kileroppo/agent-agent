import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReportFocus, formatPublicReportReply } from '../src/public-report-presentation.ts';

test('公开网页回执分段呈现摘要并保留来源', () => {
  const reply = formatPublicReportReply({
    title:'直播转录查看器',
    summary:'第一段说明这个页面的用途，包含必要背景。第二段解释整理重点和限制条件。第三段补充可验证的内容来源。',
    sources:[{ title:'直播转录页面', source:'https://sum.lexgogo.site/view/example' }]
  });
  assert.match(reply, /^公开资料报告员已完成：直播转录查看器/m);
  assert.match(reply, /内容概览\n第一段说明/);
  assert.match(reply, /来源\n- 直播转录页面\n  https:\/\/sum\.lexgogo\.site\/view\/example/);
  assert.ok(reply.length < 700);
});

test('网页包含导航时优先从内容总结开始，而不是回传页面工具栏', () => {
  const text = '直播记录 ☀️ 提交任务 原始转录 86,902 字 校对文本 82,258 字 内容总结 📋 复制内容 1. 概述 本场直播讨论 AI Agent 的实践与战略转向。第二段说明团队如何重构工作流。';
  assert.equal(extractReportFocus(text), '概述 本场直播讨论 AI Agent 的实践与战略转向。第二段说明团队如何重构工作流。');
  assert.match(formatPublicReportReply({ title:'直播记录', summary:text, source:'https://example.com' }), /本场直播讨论 AI Agent/);
  assert.doesNotMatch(formatPublicReportReply({ title:'直播记录', summary:text, source:'https://example.com' }), /原始转录 86,902/);
});
