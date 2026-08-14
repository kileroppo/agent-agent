import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
export class KnowledgeArchiveWriter {
    autoWorkRoot: any;
    contentRoot: any;
    now: any;
    python: any;
    run: any;
    constructor({ autoWorkRoot, contentRoot = null, python = process.env.AGENT_ARMY_PYTHON || 'python3', run = runCommand, now = (): any => new Date() }: any = {}) {
        this.autoWorkRoot = path.resolve(autoWorkRoot || '');
        this.contentRoot = contentRoot ? path.resolve(contentRoot) : null;
        this.python = python;
        this.run = run;
        this.now = now;
    }
    async write({ taskId, idempotencyKey, title, markdown }: any = {}): Promise<any> {
        const safeTaskId: any = safeId(taskId);
        const safeKey: any = String(idempotencyKey || '').trim().slice(0, 240);
        if (!safeTaskId || !safeKey)
            throw new KnowledgeArchiveError('知识归档缺少任务编号或幂等标识。');
        const base: any = await this.resolveContentRoot();
        const archiveDir: any = path.resolve(base, 'Agent军团');
        assertWithin(base, archiveDir);
        await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
        await fs.chmod(archiveDir, 0o700);
        const date: any = this.now().toISOString().slice(0, 10);
        const stem: any = `${date}-${slug(title)}-${safeTaskId.slice(0, 8)}`;
        const prepared: any = withFrontmatter(redactSensitive(markdown), { taskId: safeTaskId, idempotencyKey: safeKey, generatedAt: this.now().toISOString() });
        const checksum: any = sha256(prepared);
        for (let version: any = 1; version <= 100; version += 1) {
            const suffix: any = version === 1 ? '' : `-v${version}`;
            const filePath: any = path.resolve(archiveDir, `${stem}${suffix}.md`);
            assertWithin(archiveDir, filePath);
            try {
                const existing: any = await fs.readFile(filePath, 'utf8');
                if (frontmatterValue(existing, 'idempotencyKey') === safeKey)
                    return verifiedResult(filePath, existing, true);
                continue;
            }
            catch (error: any) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            await fs.writeFile(filePath, prepared, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            return verifiedResult(filePath, prepared, false);
        }
        throw new KnowledgeArchiveError('同名知识笔记版本过多，已停止写入。');
    }
    async resolveContentRoot(): Promise<any> {
        if (this.contentRoot)
            return this.contentRoot;
        if (!this.autoWorkRoot || this.autoWorkRoot === path.parse(this.autoWorkRoot).root)
            throw new KnowledgeArchiveError('Auto-work 根目录未配置。');
        const scriptsDir: any = path.join(this.autoWorkRoot, 'scripts');
        const runtimePath: any = path.join(scriptsDir, 'content_system_runtime.py');
        await fs.access(runtimePath);
        const code: any = [
            'import sys',
            `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
            'from content_system_runtime import content_library_root',
            'print(content_library_root())'
        ].join(';');
        const output: any = await this.run(this.python, ['-c', code], { timeoutMs: 10000 });
        const resolved: any = path.resolve(String(output || '').trim());
        if (!resolved || resolved === path.parse(resolved).root)
            throw new KnowledgeArchiveError('统一内容库路径解析失败。');
        return resolved;
    }
}
export class KnowledgeArchiveError extends Error {
}
async function verifiedResult(filePath: any, content: any, duplicate: any): Promise<any> {
    const stat: any = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1)
        throw new KnowledgeArchiveError('知识笔记写入后为空。');
    const readback: any = await fs.readFile(filePath, 'utf8');
    return {
        filePath,
        checksum: sha256(readback),
        bytes: stat.size,
        readable: readback === content,
        duplicate
    };
}
function withFrontmatter(markdown: any, metadata: any): any {
    const body: any = String(markdown || '').replace(/^---[\s\S]*?---\s*/m, '').trim();
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
function redactSensitive(value: any): any {
    return String(value || '')
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret)\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
}
function frontmatterValue(markdown: any, key: any): any {
    const match: any = String(markdown || '').match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim() || '';
}
function slug(value: any): any {
    return String(value || '知识归档').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || '知识归档';
}
function safeId(value: any): any {
    const text: any = String(value || '').trim();
    return /^[a-zA-Z0-9-]{8,100}$/.test(text) ? text : '';
}
function assertWithin(root: any, target: any): any {
    const base: any = path.resolve(root);
    const resolved: any = path.resolve(target);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`))
        throw new KnowledgeArchiveError('知识归档路径越界。');
}
function sha256(value: any): any {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
function runCommand(command: any, args: any, { timeoutMs }: any): any {
    return new Promise((resolve: any, reject: any): any => execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 }, (error: any, stdout: any): any => error ? reject(error) : resolve(stdout)));
}
