/**
 * Safe text sanitization and human-readable summarization utilities.
 * Strips raw HTML tags, cleans markdown image/badge links, and decodes HTML entities.
 */

export function cleanHumanReadableText(text: unknown): string {
    if (typeof text !== 'string') return '';
    let result = text;
    // Decode common HTML entities
    result = result
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ');
    // Strip raw HTML tags (e.g. <p align="center">, <a href="...">, <img ...>, <em>, </em>, etc.)
    result = result.replace(/<[^>]+>/g, ' ');
    // Strip markdown badge image links: [![alt](img_url)](target_url) -> ""
    result = result.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ');
    // Strip markdown image syntax: ![alt](url) -> ""
    result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    // Convert markdown link [text](url) -> text (or empty if text is just a URL / empty)
    result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, (_match, linkText) => {
        const trimmed = String(linkText || '').trim();
        if (/^https?:\/\//i.test(trimmed) || /badge|coverage|workflow/i.test(trimmed)) {
            return '';
        }
        return trimmed;
    });
    // Remove raw Markdown headings, bold/italics markers
    result = result.replace(/[*_~`]{1,3}/g, '');
    // Normalize excessive whitespace while preserving single newlines
    const lines = result.split(/\r?\n/)
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .filter(line => line.length > 0 && !/^[-=_*#`|/\\]+$/.test(line));
    result = lines.join('\n');
    result = result.replace(/\n{3,}/g, '\n\n').trim();
    return result;
}

export function summarizeMarkdownOrHtml(text: unknown, maxLines = 6, maxLength = 800): string {
    if (typeof text !== 'string') return '没有可提炼的文本要点。';
    const cleaned = cleanHumanReadableText(text);
    if (!cleaned) return '没有可提炼的文本要点。';
    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
    const selected = lines.slice(0, maxLines).join('\n');
    return selected.slice(0, maxLength).trim() || '没有可提炼的文本要点。';
}
