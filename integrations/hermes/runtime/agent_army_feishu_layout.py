"""Semantic Feishu layout for Agent Army replies.

The content model stays Markdown.  This module parses it into structural blocks
and maps relationships between blocks to Feishu post rows.  It deliberately
does not call a model: layout remains deterministic, fast, and free of extra
token cost while no longer depending on whatever blank lines the model emitted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Optional

from markdown_it import MarkdownIt
from markdown_it.token import Token


BlockKind = Literal[
    "document_title",
    "section_heading",
    "paragraph",
    "bullet_item",
    "ordered_item",
    "table",
    "code",
    "quote",
    "rule",
]


@dataclass(frozen=True)
class SemanticBlock:
    kind: BlockKind
    markdown: str
    start_line: int
    end_line: int


_MARKDOWN = MarkdownIt("commonmark").enable("table")


def _slice_lines(lines: List[str], span: Optional[List[int]]) -> str:
    if not span:
        return ""
    return "\n".join(lines[span[0] : span[1]]).strip()


def _inline_is_strong_only(token: Optional[Token]) -> bool:
    if token is None or token.type != "inline" or not token.children:
        return False
    children = [
        child
        for child in token.children
        if child.type not in {"softbreak", "hardbreak"}
        and not (child.type == "text" and not child.content)
    ]
    if len(children) < 3 or children[0].type != "strong_open" or children[-1].type != "strong_close":
        return False
    depth = 0
    for index, child in enumerate(children):
        if child.type == "strong_open":
            depth += 1
        elif child.type == "strong_close":
            depth -= 1
            if depth == 0 and index != len(children) - 1:
                return False
        elif depth <= 0:
            return False
    return depth == 0


def _paragraph_line_kind(line: str) -> BlockKind:
    inline = _MARKDOWN.parseInline(line)
    token = inline[0] if inline else None
    return "section_heading" if _inline_is_strong_only(token) else "paragraph"


def _paragraph_blocks(raw: str, start_line: int) -> List[SemanticBlock]:
    blocks: List[SemanticBlock] = []
    buffered: List[str] = []
    buffer_start = start_line

    def flush() -> None:
        nonlocal buffered, buffer_start
        if buffered:
            blocks.append(
                SemanticBlock(
                    kind="paragraph",
                    markdown="\n".join(buffered).strip(),
                    start_line=buffer_start,
                    end_line=buffer_start + len(buffered),
                )
            )
            buffered = []

    for offset, line in enumerate(raw.splitlines() or [raw]):
        kind = _paragraph_line_kind(line)
        if kind == "section_heading":
            flush()
            blocks.append(
                SemanticBlock(
                    kind=kind,
                    markdown=line.strip(),
                    start_line=start_line + offset,
                    end_line=start_line + offset + 1,
                )
            )
            buffer_start = start_line + offset + 1
        else:
            if not buffered:
                buffer_start = start_line + offset
            buffered.append(line)
    flush()
    return blocks


def _canonicalize_semantic_boundaries(content: str) -> str:
    """Give strong-only headings structural boundaries before block parsing."""
    output: List[str] = []
    for line in content.splitlines():
        if _paragraph_line_kind(line) == "section_heading":
            if output and output[-1].strip():
                output.append("")
            output.append(line.strip())
            output.append("")
            continue
        if not line.strip():
            if output and output[-1] != "":
                output.append("")
            continue
        output.append(line)
    while output and not output[-1].strip():
        output.pop()
    return "\n".join(output)


def parse_semantic_blocks(content: str) -> List[SemanticBlock]:
    """Parse top-level Markdown into stable layout blocks."""
    content = _canonicalize_semantic_boundaries(content)
    lines = content.splitlines()
    tokens = _MARKDOWN.parse(content)
    blocks: List[SemanticBlock] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.level != 0:
            index += 1
            continue
        span = token.map or [0, 0]
        raw = _slice_lines(lines, token.map)

        if token.type == "paragraph_open":
            inline = tokens[index + 1] if index + 1 < len(tokens) else None
            if _inline_is_strong_only(inline) and raw.count("\n") == 0:
                blocks.append(SemanticBlock("section_heading", raw, span[0], span[1]))
            else:
                blocks.extend(_paragraph_blocks(raw, span[0]))
        elif token.type == "heading_open":
            blocks.append(SemanticBlock("section_heading", raw, span[0], span[1]))
        elif token.type in {"bullet_list_open", "ordered_list_open"}:
            kind: BlockKind = "bullet_item" if token.type == "bullet_list_open" else "ordered_item"
            list_level = token.level + 1
            cursor = index + 1
            while cursor < len(tokens):
                item = tokens[cursor]
                if item.type == token.type.replace("_open", "_close") and item.level == token.level:
                    break
                if item.type == "list_item_open" and item.level == list_level and item.map:
                    item_raw = _slice_lines(lines, item.map)
                    blocks.append(SemanticBlock(kind, item_raw, item.map[0], item.map[1]))
                cursor += 1
            index = cursor
        elif token.type == "table_open":
            blocks.append(SemanticBlock("table", raw, span[0], span[1]))
        elif token.type in {"fence", "code_block"}:
            blocks.append(SemanticBlock("code", raw or token.content, span[0], span[1]))
        elif token.type == "blockquote_open":
            blocks.append(SemanticBlock("quote", raw, span[0], span[1]))
        elif token.type == "hr":
            blocks.append(SemanticBlock("rule", raw or "---", span[0], span[1]))
        index += 1

    first_heading = next((i for i, block in enumerate(blocks) if block.kind == "section_heading"), None)
    if first_heading is not None:
        block = blocks[first_heading]
        blocks[first_heading] = SemanticBlock("document_title", block.markdown, block.start_line, block.end_line)
    return blocks


def _needs_section_gap(previous: SemanticBlock, current: SemanticBlock) -> bool:
    if current.kind == "section_heading":
        return previous.kind not in {"document_title", "section_heading"}
    if current.kind in {"code", "table", "quote"}:
        return previous.kind not in {"document_title", "section_heading"}
    if current.kind == "paragraph" and previous.kind == "paragraph":
        return current.start_line > previous.end_line
    return False


def build_semantic_post_rows(content: str) -> List[List[Dict[str, str]]]:
    """Render semantic blocks using native-row, section-gap, and atomic tiers."""
    blocks = parse_semantic_blocks(content)
    if not blocks:
        return [[{"tag": "md", "text": content}]]

    rows: List[List[Dict[str, str]]] = []
    previous: Optional[SemanticBlock] = None
    for block in blocks:
        if previous is not None and _needs_section_gap(previous, block):
            rows.append([{"tag": "text", "text": "\u00a0"}])
        rows.append([{"tag": "md", "text": block.markdown}])
        previous = block
    return rows
