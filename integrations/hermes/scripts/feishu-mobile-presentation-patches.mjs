import { replaceRequired } from './patch-support.mjs';

export function upgradeFeishuMobilePresentationPatch(source) {
  return upgradeFeishuPostBlockRowsPatch(upgradeFeishuMobileMessagePatch(source));
}

function insert(source, marker, replacement) {
  return replaceRequired(
    source,
    marker,
    replacement,
    `Hermes 当前 Feishu 适配器结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`,
  );
}

function upgradeFeishuPostBlockRowsPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_SEMANTIC_LAYOUT_V1')) return source;
  let result = source;
  const current = '    if "```" not in content:\n        return [[{"tag": "md", "text": content}]]';
  const legacyV1 = `    if "\`\`\`" not in content:
        # AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V1: Feishu collapses blank lines
        # inside one md element. Preserve intentional breathing room as real
        # post rows, with a non-breaking spacer row between semantic blocks.
        blocks = [block.strip() for block in re.split(r"\\n{2,}", content) if block.strip()]
        if len(blocks) <= 1:
            return [[{"tag": "md", "text": content}]]
        rows: List[List[Dict[str, str]]] = []
        for block_index, block in enumerate(blocks):
            if block_index:
                rows.append([{"tag": "text", "text": "\\u00a0"}])
            rows.append([{"tag": "md", "text": block}])
        return rows`;
  const v2 = `    if "\`\`\`" not in content:
        # AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V2: use three stable spacing tiers.
        # Adjacent semantic lines become adjacent post rows; section breaks get
        # one spacer row; markdown tables stay together so they still render.
        blocks = [block.strip() for block in re.split(r"\\n{2,}", content) if block.strip()]
        table_separator_re = re.compile(r"(?m)^\\s*\\|?\\s*:?-{3,}.*\\|\\s*$")
        rows: List[List[Dict[str, str]]] = []
        for block_index, block in enumerate(blocks):
            if block_index:
                rows.append([{"tag": "text", "text": "\\u00a0"}])
            block_lines = [line.rstrip() for line in block.splitlines() if line.strip()]
            if table_separator_re.search(block):
                rows.append([{"tag": "md", "text": block}])
                continue
            for line in block_lines:
                rows.append([{"tag": "md", "text": line}])
        return rows or [[{"tag": "md", "text": content}]]`;
  if (!result.includes('AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V2')) {
    if (result.includes(legacyV1)) result = result.replace(legacyV1, v2);
    else if (result.includes(current)) result = result.replace(current, v2);
  }
  const v2Start = `    if "\`\`\`" not in content:
        # AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V2: use three stable spacing tiers.`;
  if (!result.includes(v2Start)) return result;
  return result.replace(
    v2Start,
    `    # AGENT_ARMY_FEISHU_SEMANTIC_LAYOUT_V1: derive rows from Markdown AST.
    try:
        from .agent_army_layout import build_semantic_post_rows
    except ImportError:
        build_semantic_post_rows = None
    if build_semantic_post_rows is not None:
        return build_semantic_post_rows(content)

${v2Start}`
  );
}

function upgradeFeishuMobileMessagePatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V9')) return source;
  if (
    source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V2')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V1')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V3')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V4')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V5')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V6')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V7')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V8')
  ) {
    const helperStart = source.search(/# AGENT_ARMY_FEISHU_MOBILE_FORMAT_V[12345678]:/);
    const helperEnd = source.indexOf('\n_MARKDOWN_HINT_RE = re.compile(', helperStart);
    if (helperStart < 0 || helperEnd < 0) return source;
    return `${source.slice(0, helperStart)}${feishuMobileMessageHelpers}\n${source.slice(helperEnd)}`;
  }
  if (!source.includes('_MARKDOWN_HINT_RE = re.compile(')) return source;
  let result = insert(
    source,
    '_MARKDOWN_HINT_RE = re.compile(\n',
    `${feishuMobileMessageHelpers}\n\n_MARKDOWN_HINT_RE = re.compile(\n`
  );
  result = result.replace(
    '        formatted = self.format_message(content)\n',
    '        # AGENT_ARMY_FEISHU_MOBILE_FORMAT_V1: adapt density and wide tables before rendering.\n        content = _agent_army_format_feishu_message(content)\n        formatted = self.format_message(content)\n'
  );
  result = result.replace(
    '        content = self.format_message(content)\n        try:\n            msg_type, payload = self._build_outbound_payload(content)\n',
    '        content = _agent_army_format_feishu_message(content)\n        content = self.format_message(content)\n        try:\n            msg_type, payload = self._build_outbound_payload(content)\n'
  );
  return result;
}

const feishuMobileMessageHelpers = String.raw`# AGENT_ARMY_FEISHU_MOBILE_FORMAT_V9: normalize spacing and emphasis instead of trusting model whitespace.
def _agent_army_table_cells(line: str) -> List[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _agent_army_should_stack_table(headers: List[str], rows: List[List[str]]) -> bool:
    if len(headers) > 3 or len(rows) > 4:
        return True
    widths = []
    for index, header in enumerate(headers):
        values = [header] + [row[index] if index < len(row) else "" for row in rows]
        widths.append(max((len(re.sub(r"[*_~]", "", value)) for value in values), default=0))
    return any(width > 12 for width in widths) or sum(widths) > 28


def _agent_army_stack_table(headers: List[str], rows: List[List[str]]) -> str:
    blocks: List[str] = []
    if len(headers) == 2:
        for row in rows:
            label = row[0] if row else ""
            value = row[1] if len(row) > 1 else ""
            if label or value:
                blocks.append(f"**{label or headers[0]}**\n{value or '—'}")
        return "\n\n".join(blocks)

    for row_index, row in enumerate(rows, start=1):
        title = row[0] if row and row[0] else f"第 {row_index} 项"
        details = []
        for index in range(1, len(headers)):
            value = row[index] if index < len(row) else ""
            if value:
                details.append(f"- **{headers[index]}**：{value}")
        blocks.append(f"**{title}**" + (f"\n{chr(10).join(details)}" if details else ""))
    return "\n\n".join(blocks)


def _agent_army_mobileize_tables(content: str) -> str:
    lines = content.splitlines()
    output: List[str] = []
    index = 0
    separator_re = re.compile(r"^\s*\|?\s*:?-{3,}.*\|\s*$")
    while index < len(lines):
        if (
            index + 1 < len(lines)
            and "|" in lines[index]
            and separator_re.match(lines[index + 1])
        ):
            table_lines = [lines[index], lines[index + 1]]
            cursor = index + 2
            while cursor < len(lines) and "|" in lines[cursor] and lines[cursor].strip():
                table_lines.append(lines[cursor])
                cursor += 1
            headers = _agent_army_table_cells(table_lines[0])
            rows = [_agent_army_table_cells(line) for line in table_lines[2:]]
            if rows and _agent_army_should_stack_table(headers, rows):
                output.extend(_agent_army_stack_table(headers, rows).splitlines())
            else:
                output.extend(table_lines)
            index = cursor
            continue
        output.append(lines[index].rstrip())
        index += 1
    return "\n".join(output)


def _agent_army_wrap_dense_paragraph(block: str) -> str:
    compact = block.strip()
    if (
        len(compact) <= 220
        or "\n" in compact
        or compact.startswith(("#", "-", "*", ">", "|"))
        or re.match(r"^\d+[.)、]\s+\S", compact)
    ):
        return compact
    sentences = [part.strip() for part in re.split(r"(?<=[。！？；])", compact) if part.strip()]
    if len(sentences) < 2:
        return compact
    paragraphs: List[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + len(sentence) > 140:
            paragraphs.append(current)
            current = sentence
        else:
            current += sentence
    if current:
        paragraphs.append(current)
    return "\n\n".join(paragraphs)


def _agent_army_is_section_heading(line: str) -> bool:
    compact = line.strip()
    return bool(
        re.match(r"^#{1,6}\s+\S", compact)
        or re.match(r"^\*\*[^*\n]{1,36}\*\*[：:]?$", compact)
    )


def _agent_army_expand_inline_numbered_items(content: str) -> str:
    """Split a real 1)/2)/3) sequence that a model compressed onto one line."""
    marker_re = re.compile(r"(?<![\w.])(\d{1,2})(?:[)）、]\s*|\.\s+)(?=(?:\*\*)?\S)")
    output: List[str] = []
    for line in content.splitlines():
        matches = list(marker_re.finditer(line))
        numbers = [int(match.group(1)) for match in matches]
        if len(matches) < 2 or numbers != list(range(numbers[0], numbers[0] + len(numbers))):
            output.append(line)
            continue

        prefix = line[:matches[0].start()].rstrip()
        if prefix:
            output.append(prefix)
            output.append("")
        for item_index, match in enumerate(matches):
            end = matches[item_index + 1].start() if item_index + 1 < len(matches) else len(line)
            item = line[match.end():end].strip()
            output.append(f"{match.group(1)}. {item}")
    return "\n".join(output)


def _agent_army_expand_inline_callouts(content: str) -> str:
    """Give concluding notes their own small section instead of burying them in an item."""
    callout_re = re.compile(
        r"(?<=[。！？；])\s*(?:\*\*)?"
        r"(单独说明|补充说明|说明|注意|提醒|下一步|结论|风险)"
        r"[：:](?:\*\*)?\s*"
    )
    output: List[str] = []
    for line in content.splitlines():
        match = callout_re.search(line)
        if not match:
            output.append(line)
            continue
        before = line[:match.start()].rstrip()
        after = line[match.end():].strip()
        if before:
            output.append(before)
            output.append("")
        output.append(f"**{match.group(1)}**")
        if after:
            output.append(after)
    return "\n".join(output)


def _agent_army_strip_inline_bold(text: str) -> str:
    return re.sub(r"\*\*([^*\n]+)\*\*", r"\1", text)


def _agent_army_normalize_emphasis(content: str) -> str:
    """Keep bold for headings and leading labels, not arbitrary model emphasis."""
    list_re = re.compile(r"^(\s*(?:[-*]|\d+[.)、])\s+)(.*)$")
    label_inside_re = re.compile(r"^\*\*([^*\n]{1,32}[：:])\*\*\s*(.*)$")
    label_outside_re = re.compile(r"^\*\*([^*\n]{1,32})\*\*\s*([：:])\s*(.*)$")
    output: List[str] = []
    for line in content.splitlines():
        compact = line.strip()
        if _agent_army_is_section_heading(line) or re.match(r"^#{1,6}\s+\S", compact):
            output.append(line)
            continue

        list_match = list_re.match(line)
        prefix = list_match.group(1) if list_match else ""
        body = list_match.group(2) if list_match else line
        inside_match = label_inside_re.match(body)
        outside_match = label_outside_re.match(body)
        if inside_match:
            label = inside_match.group(1)
            rest = _agent_army_strip_inline_bold(inside_match.group(2)).strip()
            output.append(f"{prefix}**{label}**" + (f" {rest}" if rest else ""))
            continue
        if outside_match:
            label = f"{outside_match.group(1)}{outside_match.group(2)}"
            rest = _agent_army_strip_inline_bold(outside_match.group(3)).strip()
            output.append(f"{prefix}**{label}**" + (f" {rest}" if rest else ""))
            continue
        output.append(f"{prefix}{_agent_army_strip_inline_bold(body)}")
    return "\n".join(output)


def _agent_army_breathe_long_lists(content: str) -> str:
    """Space long numbered procedures; keep ordinary bullet lists consistent."""
    lines = content.splitlines()
    output: List[str] = []
    index = 0
    numbered_item = re.compile(r"^\d+[.)、]\s+\S")
    bullet_item = re.compile(r"^[-*]\s+\S")
    any_item = re.compile(r"^\s*(?:[-*]|\d+[.)、])\s+\S")
    while index < len(lines):
        item_matcher = numbered_item if numbered_item.match(lines[index]) else bullet_item
        if not item_matcher.match(lines[index]):
            output.append(lines[index])
            index += 1
            continue

        items: List[List[str]] = []
        cursor = index
        while cursor < len(lines) and item_matcher.match(lines[cursor]):
            item = [lines[cursor]]
            cursor += 1
            while (
                cursor < len(lines)
                and lines[cursor].strip()
                and not item_matcher.match(lines[cursor])
                and (lines[cursor].startswith((" ", "\t")) or not any_item.match(lines[cursor]))
            ):
                item.append(lines[cursor])
                cursor += 1
            items.append(item)
        lengths = [len(re.sub(r"[*_~\`]", "", " ".join(item))) for item in items]
        spacious = item_matcher is numbered_item and len(items) >= 3 and (
            max(lengths, default=0) > 42
            or (sum(lengths) / max(len(lengths), 1)) > 30
        )
        if (
            spacious
            and output
            and output[-1] != ""
            and not _agent_army_is_section_heading(output[-1])
        ):
            output.append("")
        for item_index, item in enumerate(items):
            if spacious and item_index and output and output[-1] != "":
                output.append("")
            output.extend(item)
        if spacious and cursor < len(lines) and lines[cursor].strip():
            output.append("")
        index = cursor
    return "\n".join(output)


def _agent_army_breathe_sections(content: str) -> str:
    """Canonicalize vertical rhythm regardless of whitespace produced by the model."""
    lines = content.splitlines()
    heading_count = sum(1 for line in lines if _agent_army_is_section_heading(line))
    if heading_count == 0 and len(content) < 280:
        return content
    output: List[str] = []
    for line in lines:
        if _agent_army_is_section_heading(line):
            while output and not output[-1].strip():
                output.pop()
            previous = output[-1].strip() if output else ""
            if previous and not _agent_army_is_section_heading(previous):
                output.append("")
            output.append(line.strip())
            continue
        if not line.strip():
            if output and _agent_army_is_section_heading(output[-1]):
                continue
            if output and output[-1] != "":
                output.append("")
            continue
        output.append(line)
    return "\n".join(output)


def _agent_army_format_feishu_message(content: str) -> str:
    """Adapt hierarchy, list spacing and wide tables for mobile Feishu."""
    if not isinstance(content, str) or not content:
        return content
    fence = chr(96) * 3
    fence_parts = re.split(rf"({re.escape(fence)}[\s\S]*?{re.escape(fence)})", content)
    formatted: List[str] = []
    for index, part in enumerate(fence_parts):
        if index % 2:
            formatted.append(part.rstrip())
            continue
        mobile = _agent_army_expand_inline_callouts(
            _agent_army_normalize_emphasis(
                _agent_army_expand_inline_numbered_items(_agent_army_mobileize_tables(part))
            )
        )
        breathed = _agent_army_breathe_sections(_agent_army_breathe_long_lists(mobile))
        blocks = re.split(r"\n{2,}", breathed)
        formatted.append("\n\n".join(_agent_army_wrap_dense_paragraph(block) for block in blocks if block.strip()))
    return re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", "".join(formatted)).strip()`;
