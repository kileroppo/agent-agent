const MAX_REPLY_CHARS: any = 520;
const TARGET_PARAGRAPH_CHARS: any = 150;
export function formatPublicReportReply(report: any, { taskTitle = '' }: any = {}): any {
    const sources: any = Array.isArray(report?.sources) && report.sources.length
        ? report.sources
        : [{ title: report?.title, source: report?.source }];
    const title: any = clean(report?.title) || clean(taskTitle) || '公开网页';
    const summary: any = summaryParagraphs(report?.summary);
    const sourceLines: any = sources.slice(0, 5).map((source: any, index: any): any => {
        const label: any = clean(source?.title) || `资料 ${index + 1}`;
        const url: any = clean(source?.source);
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
export function summaryParagraphs(value: any): any {
    const compact: any = extractReportFocus(value).slice(0, MAX_REPLY_CHARS);
    if (!compact)
        return [];
    const units: any = compact.split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
    const paragraphs: any[] = [];
    let current: any = '';
    for (const unit of units.length ? units : [compact]) {
        for (const part of splitLongUnit(unit)) {
            if (current && current.length + part.length > TARGET_PARAGRAPH_CHARS) {
                paragraphs.push(current);
                current = '';
            }
            current += part;
        }
    }
    if (current)
        paragraphs.push(current);
    return paragraphs.slice(0, 4);
}
export function extractReportFocus(value: any): any {
    const compact: any = clean(value);
    const marker: any = /(?:内容总结|核心摘要|文章摘要)\s*(?:📋\s*复制内容)?\s*/.exec(compact);
    if (!marker)
        return compact;
    const focused: any = compact.slice(marker.index + marker[0].length).replace(/^\d+[.、]\s*/, '').trim();
    return focused || compact;
}
function splitLongUnit(value: any): any {
    if (value.length <= TARGET_PARAGRAPH_CHARS)
        return [value];
    const parts: any = value.split(/(?<=[，、:：])\s*/).filter(Boolean);
    if (parts.length > 1)
        return parts.flatMap((part: any): any => splitLongUnit(part));
    return Array.from({ length: Math.ceil(value.length / TARGET_PARAGRAPH_CHARS) }, (_: any, index: any): any => value.slice(index * TARGET_PARAGRAPH_CHARS, (index + 1) * TARGET_PARAGRAPH_CHARS));
}
function clean(value: any): any { return String(value || '').replace(/\s+/g, ' ').trim(); }
