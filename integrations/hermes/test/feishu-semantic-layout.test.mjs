import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDirectory = path.resolve(here, '../runtime');
const hermesHome = process.env.HERMES_HOME || path.join(homedir(), '.hermes', 'hermes-agent');
const python = process.env.HERMES_PYTHON || path.join(hermesHome, 'venv', 'bin', 'python');

function runLayout(markdown) {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(moduleDirectory)})`,
    'from agent_army_feishu_layout import build_semantic_post_rows, parse_semantic_blocks',
    `content = ${JSON.stringify(markdown)}`,
    'blocks = parse_semantic_blocks(content)',
    'rows = build_semantic_post_rows(content)',
    'print(json.dumps({"kinds": [block.kind for block in blocks], "rows": rows}, ensure_ascii=False))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('语义布局不受 Agent 原文空行数量影响', () => {
  const sparse = runLayout('**军团状态**\n\n\n**员工在线**\n\n- 已验证\n- 已验收\n\n\n**能力实证**\n\n- 已接入');
  const tight = runLayout('**军团状态**\n**员工在线**\n- 已验证\n- 已验收\n**能力实证**\n- 已接入');
  assert.deepEqual(sparse.kinds, [
    'document_title', 'section_heading', 'bullet_item', 'bullet_item', 'section_heading', 'bullet_item',
  ]);
  assert.deepEqual(tight.kinds, sparse.kinds);
  assert.deepEqual(
    sparse.rows.map((row) => row[0].tag),
    ['md', 'md', 'md', 'md', 'text', 'md', 'md'],
  );
  assert.deepEqual(tight.rows, sparse.rows);
});
test('标题首项用相邻原生行，章节边界才使用完整间隔', () => {
  const layout = runLayout('**标题**\n**第一节**\n第一段正文\n\n**第二节**\n- 项目一\n- 项目二');
  assert.deepEqual(layout.kinds, [
    'document_title', 'section_heading', 'paragraph', 'section_heading', 'bullet_item', 'bullet_item',
  ]);
  assert.deepEqual(
    layout.rows.map((row) => [row[0].tag, row[0].text]),
    [
      ['md', '**标题**'],
      ['md', '**第一节**'],
      ['md', '第一段正文'],
      ['text', '\u00a0'],
      ['md', '**第二节**'],
      ['md', '- 项目一'],
      ['md', '- 项目二'],
    ],
  );
});

test('表格和代码块保持原子块，列表按语义项目拆分', () => {
  const layout = runLayout('| 字段 | 状态 |\n| --- | --- |\n| 员工 | 在线 |\n\n```js\nconst ok = true;\n```\n\n1. 第一步\n2. 第二步');
  assert.deepEqual(layout.kinds, ['table', 'code', 'ordered_item', 'ordered_item']);
  assert.equal(layout.rows[0][0].tag, 'md');
  assert.match(layout.rows[0][0].text, /\| --- \| --- \|/);
  assert.ok(layout.rows.some((row) => row[0].text.includes('```js')));
});
