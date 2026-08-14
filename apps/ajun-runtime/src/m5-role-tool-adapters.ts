import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import { prepareWorkspaceFile } from './workspace-path-guard.ts';
import { externalCapabilityEvidence, runExternalCapabilityWithEvents, } from './adapters/external-capability-run-event-bridge.ts';
export function createM5RoleToolAdapters({ publicWebSearch, publicWebFetch, publicDynamicWebReader, publicPdfReader, githubSearch, officeDocuments, officePresentations, governance, store, knowledgeArchive, onRunEvent = null, now = (): any => new Date(), }: any = {}): any {
    return Object.freeze({
        ...(typeof publicWebSearch?.search === 'function'
            ? {
                'ajun-public-search': async ({ input, trustedScope }: any): Promise<any> => runRoleCapability({
                    onRunEvent, now, trustedScope,
                    capabilityId: 'content.public.search', routeId: 'public-web-search', provider: 'public-search',
                    execute: (): any => publicWebSearch.search({ query: input.query, limit: input.limit }),
                }),
            }
            : {}),
        ...(typeof publicWebFetch?.acquire === 'function'
            ? {
                'ajun-public-fetch': async ({ access, trustedScope }: any): Promise<any> => withContentHash(await publicWebFetch.acquire({
                    sourceUrl: access.url,
                    task: trustedScope?.currentTaskId ? {
                        taskId: trustedScope.currentTaskId,
                        assigneeAgentId: trustedScope.currentAgentId,
                        currentStage: trustedScope.currentStepId,
                        workflow: { workflowId: trustedScope.currentWorkflowId, step: { stepId: trustedScope.currentStepId } },
                    } : null,
                })),
            }
            : {}),
        ...(typeof publicDynamicWebReader?.read === 'function'
            ? {
                'hermes-public-browser': async ({ access, trustedScope }: any): Promise<any> => runRoleCapability({
                    onRunEvent, now, trustedScope,
                    capabilityId: 'content.public.dynamic.read', routeId: 'public-web-controlled-browser', provider: 'controlled-chromium',
                    execute: async (): Promise<any> => withContentHash(await publicDynamicWebReader.read({ sourceUrl: access.url })),
                }),
            }
            : {}),
        ...(typeof publicPdfReader?.read === 'function'
            ? {
                'hermes-pdf': async ({ access, trustedScope }: any): Promise<any> => runRoleCapability({
                    onRunEvent, now, trustedScope,
                    capabilityId: 'content.public.pdf.read', routeId: 'public-pdf-reader', provider: 'public-http-pdftotext',
                    execute: async (): Promise<any> => withContentHash(await publicPdfReader.read({ sourceUrl: access.url })),
                }),
            }
            : {}),
        ...(typeof githubSearch?.search === 'function' && typeof githubSearch?.readRepo === 'function'
            ? {
                'github-public': async ({ input, trustedScope }: any): Promise<any> => runRoleCapability({
                    onRunEvent, now, trustedScope,
                    capabilityId: input.operation === 'read' ? 'github.public.read' : 'github.public.search',
                    routeId: 'github-public-api', provider: 'github',
                    execute: async (): Promise<any> => {
                        if (input.operation === 'search') {
                            return githubSearch.search({ query: input.query, limit: input.limit });
                        }
                        if (input.operation === 'read') {
                            return withContentHash(await githubSearch.readRepo({ repo: input.repo, path: input.path }));
                        }
                        throw adapterError('GitHub 受控适配器不支持该操作。', 'role_tool_input_invalid');
                    },
                }),
            }
            : {}),
        ...(typeof store?.list === 'function'
            ? {
                'ajun-task-store': async ({ trustedScope }: any): Promise<any> => {
                    const allowedTaskIds: any = new Set(stringList(trustedScope?.allowedTaskIds));
                    if (!allowedTaskIds.size)
                        return [];
                    return (await store.list()).filter((task: any): any => allowedTaskIds.has(String(task?.taskId || '')));
                },
            }
            : {}),
        'ajun-office-markdown': writeWorkspaceText,
        ...(typeof officeDocuments?.writeDocx === 'function'
            ? {
                'hermes-docx': (context: any): any => officeDocuments.writeDocx(context),
            }
            : {}),
        ...(typeof officeDocuments?.writeXlsx === 'function'
            ? {
                'hermes-xlsx': (context: any): any => officeDocuments.writeXlsx(context),
            }
            : {}),
        ...(typeof officeDocuments?.writePdf === 'function'
            ? {
                'hermes-office-pdf': (context: any): any => officeDocuments.writePdf(context),
            }
            : {}),
        ...(typeof officePresentations?.writePptd === 'function'
            ? {
                'open-kimi-pptd': (context: any): any => officePresentations.writePptd(context),
            }
            : {}),
        ...(typeof officePresentations?.exportPptx === 'function'
            ? {
                'local-pptx': (context: any): any => officePresentations.exportPptx(context),
            }
            : {}),
        ...(typeof governance?.createIssueWorkProduct === 'function'
            && typeof governance?.getIssueWorkProducts === 'function'
            ? {
                'paperclip-work-product': (context: any): any => writePaperclipReportWorkProduct(context, governance),
            }
            : {}),
        ...(typeof knowledgeArchive?.write === 'function'
            ? {
                'content-library': async ({ access, input }: any): Promise<any> => {
                    if (access.scope !== 'agent-army-knowledge-archive'
                        || access.relativePath !== 'Agent军团') {
                        throw adapterError('知识归档目标不属于已授权的 Agent军团 逻辑目录。', 'workspace_scope_denied');
                    }
                    return knowledgeArchive.write({
                        taskId: input.taskId,
                        idempotencyKey: input.idempotencyKey,
                        title: input.title,
                        markdown: input.markdown,
                    });
                },
            }
            : {}),
    });
}
function runRoleCapability({ onRunEvent, now, trustedScope, capabilityId, routeId, provider, execute, }: any): any {
    return runExternalCapabilityWithEvents({
        onRunEvent,
        now,
        context: {
            taskId: String(trustedScope?.currentTaskId || ''),
            workflowId: String(trustedScope?.currentWorkflowId || ''),
            stepId: String(trustedScope?.currentStepId || ''),
            agentId: String(trustedScope?.currentAgentId || ''),
            capabilityId,
            routeId,
            provider,
        },
        execute,
        evidence: externalCapabilityEvidence,
        hasRegisteredFallback: false,
    });
}
async function writePaperclipReportWorkProduct({ access, input, workspaceRoot, trustedScope, }: any, governance: any): Promise<any> {
    const reportKind: any = (({
        'office.report.daily.write': 'daily',
        'office.report.weekly.write': 'weekly',
    }) as any)[access?.toolId];
    if (!reportKind) {
        throw adapterError('Work Product 适配器只接受日报或周报工具。', 'role_tool_input_invalid');
    }
    const issueId: any = String(trustedScope?.paperclipIssueId || '').trim();
    const runId: any = String(trustedScope?.paperclipRunId || '').trim();
    const pipelineCaseId: any = String(trustedScope?.pipelineCaseId || '').trim();
    if (!issueId || !runId) {
        throw adapterError('Work Product 缺少当前 Paperclip Issue/Run 身份。', 'paperclip_scope_invalid');
    }
    const markdown: any = String(input?.markdown || input?.contents || '').replace(/\u0000/g, '').trim();
    const idempotencyKey: any = String(input?.idempotencyKey || '').trim();
    if (!markdown || markdown.length > 500000 || !/^[a-zA-Z0-9:_-]{8,200}$/.test(idempotencyKey)) {
        throw adapterError('日报/周报需要非空 Markdown 和受控幂等键。', 'role_tool_input_invalid');
    }
    const trustedTaskIds: any = new Set(stringList(trustedScope?.allowedTaskIds));
    const requestedTaskIds: any = stringList(input?.sourceTaskIds);
    if (requestedTaskIds.some((taskId: any): any => !trustedTaskIds.has(taskId))) {
        throw adapterError('日报/周报引用了当前任务信封未授权的来源任务。', 'paperclip_scope_invalid');
    }
    const hash: any = crypto.createHash('sha256').update(markdown).digest('hex');
    const externalId: any = `agent-army-office-${reportKind}-${idempotencyKey}`.slice(0, 240);
    const existing: any = workProductItems(await governance.getIssueWorkProducts(issueId))
        .filter((item: any): any => item?.externalId === externalId);
    if (existing.length > 1) {
        throw adapterError('同一日报/周报存在多个 Work Product，拒绝自动选择。', 'work_product_drift');
    }
    if (existing.length === 1) {
        if ((existing as any)[0]?.metadata?.contentHash !== hash) {
            throw adapterError('同一幂等键对应不同日报/周报内容。', 'work_product_drift');
        }
        return Object.freeze({
            workProductId: (existing as any)[0].id,
            duplicate: true,
            contentHash: hash,
            relativePath: (existing as any)[0]?.metadata?.relativePath || access.relativePath,
        });
    }
    const local: any = await writeWorkspaceText({
        access,
        input: { contents: `${markdown}\n` },
        workspaceRoot,
    });
    const product: any = await governance.createIssueWorkProduct(issueId, {
        type: 'document',
        provider: 'agent-army.office-assistant',
        externalId,
        title: String(input?.title || (reportKind === 'daily' ? 'Agent军团日报' : 'Agent军团周报')).slice(0, 300),
        status: 'active',
        reviewState: 'none',
        isPrimary: false,
        healthStatus: 'healthy',
        summary: String(input?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
            || `${reportKind === 'daily' ? '日报' : '周报'}已写入受控 execution workspace。`,
        metadata: {
            schemaVersion: 'agent.army/office-report-work-product/v1',
            kind: reportKind === 'daily' ? 'DailyReport' : 'WeeklyReport',
            contentHash: hash,
            relativePath: access.relativePath,
            pipelineCaseId: pipelineCaseId || null,
            sourceTaskIds: requestedTaskIds,
            generatedAt: new Date().toISOString(),
            validation: {
                exists: true,
                readable: true,
                nonEmpty: true,
                bytes: local.bytes,
            },
        },
        createdByRunId: runId,
    }, { runId });
    if (!product?.id) {
        throw adapterError('Paperclip 未返回 Work Product ID。', 'role_tool_output_invalid');
    }
    return Object.freeze({
        workProductId: product.id,
        duplicate: false,
        contentHash: hash,
        relativePath: access.relativePath,
        bytes: local.bytes,
    });
}
async function writeWorkspaceText({ access, input, workspaceRoot }: any): Promise<any> {
    const contents: any = String(input.contents || '');
    if (!contents)
        throw adapterError('办公产物内容为空，拒绝写入。', 'role_tool_input_invalid');
    const { target } = await prepareWorkspaceFile(workspaceRoot, access.relativePath);
    try {
        const existing: any = await fs.lstat(target);
        if (existing.isSymbolicLink()) {
            throw adapterError('办公产物目标不能是符号链接。', 'workspace_path_denied');
        }
    }
    catch (error: any) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const handle: any = await fs.open(target, fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_TRUNC
        | (fsConstants.O_NOFOLLOW || 0), 0o600);
    try {
        await handle.writeFile(contents, 'utf8');
    }
    finally {
        await handle.close();
    }
    const stat: any = await fs.stat(target);
    if (!stat.isFile() || stat.size < 1) {
        throw adapterError('办公产物写入后为空。', 'role_tool_output_invalid');
    }
    return Object.freeze({
        filePath: target,
        relativePath: access.relativePath,
        bytes: stat.size,
    });
}
function withContentHash(value: any): any {
    if (!value || typeof value !== 'object')
        return value;
    const digest: any = String(value.contentHash || '').replace(/^sha256:/i, '') || crypto
        .createHash('sha256')
        .update(String(value.text || ''))
        .digest('hex');
    return Object.freeze({
        ...value,
        contentHash: `sha256:${digest}`,
    });
}
function adapterError(message: any, code: any): any {
    const error: any = new Error(message);
    error.code = code;
    return error;
}
function workProductItems(value: any): any {
    return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
function stringList(value: any): any {
    return Array.isArray(value)
        ? value.map((item: any): any => String(item || '').trim()).filter(Boolean).slice(0, 100)
        : [];
}
