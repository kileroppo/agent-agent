import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export class KnowledgeArchiveWriter {
  constructor({
    autoWorkRoot,
    contentRoot = null,
    python = process.env.AGENT_ARMY_PYTHON || 'python3',
    run = runCommand,
    now = () => new Date()
  } = {}) {
    this.autoWorkRoot = path.resolve(autoWorkRoot || '');
    this.contentRoot = contentRoot ? path.resolve(contentRoot) : null;
    this.python = python;
    this.run = run;
    this.now = now;
  }

  async write({ taskId, idempotencyKey, title, markdown } = {}) {
    const safeTaskId = safeId(taskId);
    const safeKey = String(idempotencyKey || '').trim().slice(0, 240);
    if (!safeTaskId || !safeKey) throw new KnowledgeArchiveError('知识归档缺少任务编号或幂等标识。');
    const base = await this.resolveContentRoot();
    const archiveDir = path.resolve(base, 'Agent军团');
    assertWithin(base, archiveDir);
    await fs.mkdir(archiveDir, { recursive:true });
    const date = this.now().toISOString().slice(0, 10);
    const stem = `${date}-${slug(title)}-${safeTaskId.slice(0, 8)}`;
    const prepared = withFrontmatter(redactSensitive(markdown), { taskId:safeTaskId, idempotencyKey:safeKey, generatedAt:this.now().toISOString() });
    const checksum = sha256(prepared);
    for (let version = 1; version <= 100; version += 1) {
      const suffix = version === 1 ? '' : `-v${version}`;
      const filePath = path.resolve(archiveDir, `${stem}${suffix}.md`);
      assertWithin(archiveDir, filePath);
      try {
        const existing = await fs.readFile(filePath, 'utf8');
        if (frontmatterValue(existing, 'idempotencyKey') === safeKey) return verifiedResult(filePath, existing, true);
        continue;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.writeFile(filePath, prepared, { encoding:'utf8', flag:'wx', mode:0o600 });
      return verifiedResult(filePath, prepared, false);
    }
    throw new KnowledgeArchiveError('同名知识笔记版本过多，已停止写入。');
  }

  async resolveContentRoot() {
    if (this.contentRoot) return this.contentRoot;
    if (!this.autoWorkRoot || this.autoWorkRoot === path.parse(this.autoWorkRoot).root) throw new KnowledgeArchiveError('Auto-work 根目录未配置。');
    const scriptsDir = path.join(this.autoWorkRoot, 'scripts');
    const runtimePath = path.join(scriptsDir, 'content_system_runtime.py');
    await fs.access(runtimePath);
    const code = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      'from content_system_runtime import content_library_root',
      'print(content_library_root())'
    ].join(';');
    const output = await this.run(this.python, ['-c', code], { timeoutMs:10_000 });
    const resolved = path.resolve(String(output || '').trim());
    if (!resolved || resolved === path.parse(resolved).root) throw new KnowledgeArchiveError('统一内容库路径解析失败。');
    return resolved;
  }
}

export class KnowledgeArchiveError extends Error {}

async function verifiedResult(filePath, content, duplicate) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1) throw new KnowledgeArchiveError('知识笔记写入后为空。');
  const readback = await fs.readFile(filePath, 'utf8');
  return {
    filePath,
    checksum:sha256(readback),
    bytes:stat.size,
    readable:readback === content,
    duplicate
  };
}

function withFrontmatter(markdown, metadata) {
  const body = String(markdown || '').replace(/^---[\s\S]*?---\s*/m, '').trim();
  return [
    '---',
    'schemaVersion: agent.army/knowledge-summary/v1',
    `taskId: ${metadata.taskId}`,
    `idempotencyKey: ${metadata.idempotencyKey}`,
    `generatedAt: ${metadata.generatedAt}`,
    '---',
    '',
    body,
    ''
  ].join('\n');
}

function redactSensitive(value) {
  return String(value || '')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret)\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
}

function frontmatterValue(markdown, key) {
  const match = String(markdown || '').match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() || '';
}

function slug(value) {
  return String(value || '知识归档').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || '知识归档';
}

function safeId(value) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9-]{8,100}$/.test(text) ? text : '';
}

function assertWithin(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new KnowledgeArchiveError('知识归档路径越界。');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function runCommand(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout:timeoutMs, maxBuffer:16 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
