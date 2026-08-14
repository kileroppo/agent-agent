import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { coded } from './policy.ts';
export const WENYAN_RUNNER_SCHEMA = 'agent.army/wenyan-cli-runner/v1';
export const WECHAT_DRAFT_PLATFORM = 'wechat_official_account';
const MEDIA_ID_PATTERN = /发布成功，Media ID:\s*([^\s]+)/u;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,500}$/;
const SAFE_THEME = /^[A-Za-z0-9._-]{1,80}$/;
const DEFAULT_TIMEOUT_MS = 120000;
export class WenyanCliRunner {
    contract: any;
    execFile: any;
    executablePath: any;
    temporaryRoot: any;
    timeoutMs: any;
    constructor({ executablePath = 'wenyan', execFile = null, temporaryRoot = os.tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS, }: any = {}) {
        if (!path.isAbsolute(temporaryRoot)) {
            throw coded('wenyan_temporary_root_invalid', 'Wenyan 临时目录必须是绝对路径。');
        }
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
            throw coded('wenyan_timeout_invalid', 'Wenyan 超时必须在 1 到 300 秒之间。');
        }
        this.executablePath = executablePath;
        this.execFile = execFile || promisify(nodeExecFile);
        this.temporaryRoot = temporaryRoot;
        this.timeoutMs = timeoutMs;
        this.contract = Object.freeze({
            schemaVersion: WENYAN_RUNNER_SCHEMA,
            allowedCommands: Object.freeze(['--version', 'publish']),
            createsDraftOnly: true,
            groupSend: false,
            arbitraryCommand: false,
            credentialsPersisted: false,
        });
    }
    async preflight() {
        const result = await this.run(['--version'], safeChildEnvironment());
        const version = String(result?.stdout || '').trim().split(/\s+/).at(-1) || null;
        if (!version || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
            throw coded('wenyan_version_unverified', '无法核验 Wenyan CLI 版本。');
        }
        return Object.freeze({ available: true, version });
    }
    async createDraft({ files, articlePath, credential, theme = 'default', highlight = 'solarized-light' }: any = {}) {
        const safeFiles = validateFiles(files, articlePath);
        validateCredential(credential);
        if (!SAFE_THEME.test(theme) || !SAFE_THEME.test(highlight)) {
            throw coded('wenyan_theme_invalid', 'Wenyan 主题或代码高亮主题不在安全字符范围内。');
        }
        const workdir = await fs.mkdtemp(path.join(this.temporaryRoot, 'agent-army-wenyan-'));
        await fs.chmod(workdir, 0o700);
        try {
            for (const file of safeFiles) {
                const destination = path.join(workdir, file.relativePath);
                await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
                const handle = await fs.open(destination, 'wx', 0o400);
                try {
                    for await (const chunk of file.createReadStream()) {
                        await writeAll(handle, chunk);
                    }
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
            }
            const result = await this.run([
                'publish',
                '-f', articlePath,
                '-t', theme,
                '--highlight', highlight,
                '--app-id', credential.appId,
            ], safeChildEnvironment({
                WECHAT_APP_ID: credential.appId,
                WECHAT_APP_SECRET: credential.appSecret,
            }), { cwd: workdir });
            const mediaId = String(result?.stdout || '').match(MEDIA_ID_PATTERN)?.[1] || null;
            if (!mediaId || mediaId.length > 256) {
                throw coded('wenyan_draft_receipt_unverified', 'Wenyan 没有返回可核验的公众号草稿 Media ID。');
            }
            return Object.freeze({
                state: 'draft_created',
                externalDraftId: mediaId,
                evidence: `wenyan:draft:${mediaId}`,
            });
        }
        finally {
            await fs.rm(workdir, { recursive: true, force: true });
        }
    }
    async run(args: any, env: any, { cwd }: any = {}) {
        try {
            return await this.execFile(this.executablePath, args, {
                cwd,
                env,
                timeout: this.timeoutMs,
                maxBuffer: 64 * 1024,
                encoding: 'utf8',
                windowsHide: true,
            });
        }
        catch (error: any) {
            const safeCode = String(error?.code || 'wenyan_cli_failed');
            const output = `${String(error?.stdout || '')}\n${String(error?.stderr || '')}`;
            if (/invalid ip|whitelist|白名单/i.test(output)) {
                throw coded('wenyan_ip_whitelist_required', '公众号 IP 白名单未放行，草稿写入已停止。');
            }
            if (/invalid appid|invalid secret|credential/i.test(output)) {
                throw coded('wenyan_credential_rejected', '公众号凭据被拒绝，草稿写入已停止。');
            }
            const wrapped = coded('wenyan_cli_failed', 'Wenyan CLI 执行失败；未保留命令输出或凭据。');
            wrapped.causeCode = safeCode;
            throw wrapped;
        }
    }
}
export class WechatWenyanConnector {
    clock: any;
    connectorMode: any;
    costReportingMode: any;
    credentialResolver: any;
    platform: any;
    runner: any;
    constructor({ runner, credentialResolver, clock = () => new Date() }: any = {}) {
        if (runner?.contract?.schemaVersion !== WENYAN_RUNNER_SCHEMA
            || runner.contract.createsDraftOnly !== true
            || runner.contract.groupSend !== false
            || typeof runner?.preflight !== 'function'
            || typeof runner?.createDraft !== 'function') {
            throw coded('wenyan_runner_invalid', '公众号连接器必须注入只建草稿、不群发的受控 Wenyan runner。');
        }
        if (typeof credentialResolver !== 'function') {
            throw coded('wechat_secret_resolver_required', '公众号连接器必须注入 Secret Reference 解析器。');
        }
        this.platform = WECHAT_DRAFT_PLATFORM;
        this.connectorMode = 'real:wechat_wenyan_cli';
        this.costReportingMode = 'local_zero';
        this.runner = runner;
        this.credentialResolver = credentialResolver;
        this.clock = clock;
    }
    async createDraft(request: any) {
        await this.runner.preflight();
        const credential = await this.credentialResolver({
            secretRef: request.secretRef,
            accountRef: request.accountRef,
            capability: 'create_wechat_draft',
        });
        validateResolvedCredential(credential, request);
        const result = await this.runner.createDraft({
            files: request.files,
            articlePath: request.articlePath,
            credential: { appId: credential.appId, appSecret: credential.appSecret },
            theme: request.theme,
            highlight: request.highlight,
        });
        return {
            ...result,
            accountRef: request.accountRef,
            draftCreatedAt: this.clock().toISOString(),
        };
    }
}
function validateFiles(files: any, articlePath: any) {
    if (!Array.isArray(files) || files.length < 1 || files.length > 25) {
        throw coded('wenyan_file_manifest_invalid', '公众号草稿必须提供 1 到 25 个已审核文件。');
    }
    if (!SAFE_RELATIVE_PATH.test(String(articlePath || '')) || !/\.md$/i.test(articlePath)) {
        throw coded('wenyan_article_path_invalid', '公众号正文必须是受控目录内的 Markdown 相对路径。');
    }
    const paths = new Set();
    const normalized = files.map((file: any) => {
        const relativePath = String(file?.relativePath || '').replaceAll('\\', '/');
        if (!SAFE_RELATIVE_PATH.test(relativePath)
            || paths.has(relativePath)
            || typeof file?.createReadStream !== 'function') {
            throw coded('wenyan_file_manifest_invalid', '公众号草稿文件清单包含不安全路径、重复路径或缺少只读租约。');
        }
        paths.add(relativePath);
        return { relativePath, createReadStream: file.createReadStream };
    });
    if (!paths.has(articlePath)) {
        throw coded('wenyan_article_path_invalid', '公众号正文不在已审核文件清单内。');
    }
    return normalized;
}
function validateCredential(value: any) {
    if (!value || typeof value.appId !== 'string' || !value.appId.trim()
        || typeof value.appSecret !== 'string' || !value.appSecret.trim()) {
        throw coded('wechat_credential_invalid', '公众号临时凭据结构无效。');
    }
}
function validateResolvedCredential(value: any, request: any) {
    validateCredential(value);
    if (value.secretRef !== request.secretRef || value.accountRef !== request.accountRef) {
        throw coded('wechat_credential_scope_mismatch', '公众号 Secret Reference 与批准账号不一致。');
    }
}
function safeChildEnvironment(extra: any = {}) {
    return Object.freeze({
        PATH: String(process.env.PATH || '/usr/bin:/bin'),
        LANG: String(process.env.LANG || 'en_US.UTF-8'),
        LC_ALL: String(process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8'),
        TMPDIR: String(process.env.TMPDIR || os.tmpdir()),
        ...extra,
    });
}
async function writeAll(handle: any, value: any) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten === 0) {
            throw coded('wenyan_temporary_write_failed', 'Wenyan 临时文件写入失败。');
        }
        offset += bytesWritten;
    }
}
