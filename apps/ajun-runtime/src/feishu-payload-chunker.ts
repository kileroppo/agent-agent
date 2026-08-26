export type OversizedCardOptions = {
  title: string;
  summary?: string;
  fullMarkdown: string;
  artifactUrl?: string;
  maxBytes?: number;
  tags?: string[];
};

const DEFAULT_MAX_CHUNK_BYTES = 12 * 1024; // 12 KB 安全阈值 (远低于飞书 30KB 上限)

export function estimateUtf8Bytes(text: string): number {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

export function chunkFeishuMarkdown(markdown: string, maxBytes = DEFAULT_MAX_CHUNK_BYTES): string[] {
  const content = String(markdown || '').trim();
  if (!content) return [];
  if (estimateUtf8Bytes(content) <= maxBytes) return [content];

  const paragraphs = content.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';
  let inCodeBlock = false;

  for (const para of paragraphs) {
    const codeBlockCount = (para.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      inCodeBlock = !inCodeBlock;
    }

    const testChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
    if (estimateUtf8Bytes(testChunk) <= maxBytes && !inCodeBlock) {
      currentChunk = testChunk;
    } else if (estimateUtf8Bytes(testChunk) <= maxBytes && inCodeBlock) {
      currentChunk = testChunk;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      if (estimateUtf8Bytes(para) <= maxBytes) {
        currentChunk = para;
      } else {
        // 单个超大段落（如超大代码块或未分段文本）按行切分
        const lines = para.split('\n');
        let lineChunk = '';
        for (const line of lines) {
          const testLineChunk = lineChunk ? `${lineChunk}\n${line}` : line;
          if (estimateUtf8Bytes(testLineChunk) <= maxBytes) {
            lineChunk = testLineChunk;
          } else {
            if (lineChunk) chunks.push(lineChunk);
            lineChunk = line;
          }
        }
        if (lineChunk) currentChunk = lineChunk;
      }
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

export function extractMarkdownHeadings(markdown: string, maxItems = 6): string[] {
  const lines = String(markdown || '').split('\n');
  const headings: string[] = [];
  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match && match[1]) {
      headings.push(match[1].trim());
      if (headings.length >= maxItems) break;
    }
  }
  return headings;
}

export function createFeishuOversizedCardPayload({
  title,
  summary,
  fullMarkdown,
  artifactUrl = 'http://127.0.0.1:4321/task-records',
  maxBytes = DEFAULT_MAX_CHUNK_BYTES,
}: OversizedCardOptions): Record<string, unknown> {
  const bytes = estimateUtf8Bytes(fullMarkdown);
  const isOversized = bytes > maxBytes;
  const chunks = chunkFeishuMarkdown(fullMarkdown, maxBytes);
  const headings = extractMarkdownHeadings(fullMarkdown);

  if (!isOversized) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: fullMarkdown },
        },
      ],
    };
  }

  // 超长产物降级为导览摘要卡片
  const previewText = summary || chunks[0]?.slice(0, 800) || '完整成果已生成。';
  const outlineMd = headings.length > 0
    ? `\n\n**📑 章节大纲**：\n${headings.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '';

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📄 ${title}（全文已归档）` },
      template: 'wathet',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**💡 导览摘要**：\n${previewText}${outlineMd}\n\n*(全文共 ${Math.round(bytes / 1024)}KB，已生成 ${chunks.length} 处分段，可在网页查看完整图文)*`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📖 查看完整报告与产物' },
            type: 'primary',
            url: artifactUrl,
          },
        ],
      },
    ],
  };
}
