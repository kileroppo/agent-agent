const MAX_REPLY_CHARS = 520;
const TARGET_PARAGRAPH_CHARS = 150;

export function formatPublicReportReply(report, { taskTitle = '' } = {}) {
  const sources = Array.isArray(report?.sources) && report.sources.length
    ? report.sources
    : [{ title:report?.title, source:report?.source }];
  const title = clean(report?.title) || clean(taskTitle) || '公开网页';
  const summary = summaryParagraphs(report?.summary);
  const sourceLines = sources.slice(0, 5).map((source, index) => {
    const label = clean(source?.title) || `资料 ${index + 1}`;
    const url = clean(source?.source);
    return url ? `- ${label}\n  ${url}` : `- ${label}`;
  });
  return [
    `公开资料报告员已完成：${title}`,
    '',
    '内容概览',
    ...(summary.length ? summary : ['网页没有可用正文。']),
    '',
    '来源',
    ...(sourceLines.length ? sourceLines : ['- 来源链接未通过读取确认。'])
  ].join('\n');
}

export function summaryParagraphs(value) {
  const compact = extractReportFocus(value).slice(0, MAX_REPLY_CHARS);
  if (!compact) return [];
  const units = compact.split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
  const paragraphs = [];
  let current = '';
  for (const unit of units.length ? units : [compact]) {
    for (const part of splitLongUnit(unit)) {
      if (current && current.length + part.length > TARGET_PARAGRAPH_CHARS) {
        paragraphs.push(current);
        current = '';
      }
      current += part;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.slice(0, 4);
}

export function extractReportFocus(value) {
  const compact = clean(value);
  const marker = /(?:内容总结|核心摘要|文章摘要)\s*(?:📋\s*复制内容)?\s*/.exec(compact);
  if (!marker) return compact;
  const focused = compact.slice(marker.index + marker[0].length).replace(/^\d+[.、]\s*/, '').trim();
  return focused || compact;
}

function splitLongUnit(value) {
  if (value.length <= TARGET_PARAGRAPH_CHARS) return [value];
  const parts = value.split(/(?<=[，、:：])\s*/).filter(Boolean);
  if (parts.length > 1) return parts.flatMap((part) => splitLongUnit(part));
  return Array.from({ length:Math.ceil(value.length / TARGET_PARAGRAPH_CHARS) }, (_, index) => value.slice(index * TARGET_PARAGRAPH_CHARS, (index + 1) * TARGET_PARAGRAPH_CHARS));
}

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
