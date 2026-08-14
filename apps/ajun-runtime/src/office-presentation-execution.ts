import fs from 'node:fs/promises';
import path from 'node:path';
import { M5RoleToolGrantError } from './m5-role-tool-grant.ts';
import { outputItems, ValidationError, verifiedAssignmentArtifact, } from './task-service-execution-support.ts';
import { recordTaskUsage } from './task-usage.ts';
export class OfficePresentationExecution {
    capabilityCatalog: any;
    executorResolver: any;
    governance: any;
    prepareCompletion: any;
    roleToolAdapters: any;
    runs: any;
    store: any;
    workspaceRoot: any;
    constructor({ workspaceRoot = null, store, governance = null, capabilityCatalog, executorResolver, roleToolAdapters = {}, prepareCompletion = (_task: any, result: any): any => result, }: any) {
        this.workspaceRoot = safeWorkspaceRoot(workspaceRoot);
        this.store = store;
        this.governance = governance;
        this.capabilityCatalog = capabilityCatalog;
        this.executorResolver = executorResolver;
        this.roleToolAdapters = roleToolAdapters;
        this.prepareCompletion = prepareCompletion;
        this.runs = new Map();
    }
    supports(task: any, agent: any): any {
        return task?.taskType === 'office.presentation-package'
            && agent?.status === 'active'
            && Boolean(this.workspaceRoot);
    }
    async execute(task: any, agent: any): Promise<any> {
        const running: any = this.runs.get(task.taskId);
        if (running)
            return running;
        const execution: any = this.executeOnce(task, agent).finally((): any => this.runs.get(task.taskId) === execution && this.runs.delete(task.taskId));
        this.runs.set(task.taskId, execution);
        return execution;
    }
    async executeOnce(task: any, agent: any): Promise<any> {
        const executor: any = this.executorResolver(agent.agentId)
            || this.capabilityCatalog.executor(agent.agentId);
        if (!executor?.execute)
            throw new ValidationError('小办本地演示文稿执行器不可用。');
        const workspaceRoot: any = path.join(this.workspaceRoot, safeWorkspaceSegment(task.taskId));
        await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const stat: any = await fs.lstat(workspaceRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new ValidationError('小办演示文稿工作区无效。');
        }
        const startedAt: any = new Date();
        let updated: any = await this.store.updateTask(task.taskId, {
            status: 'running',
            currentStage: 'office_presentation_local_starting',
            execution: {
                ...(task.execution || {}),
                owner: 'ajun-controlled-local',
                executor: 'office-assistant',
                workspaceRoot,
                startedAt: startedAt.toISOString(),
            },
        });
        try {
            const roleToolContext: any = localPresentationToolContext({
                task: updated,
                adapters: this.roleToolAdapters,
                workspaceRoot,
            });
            const result: any = await this.prepareCompletion(updated, await executor.execute(updated, { roleToolContext }));
            updated = await this.store.updateTask(updated.taskId, {
                ...result,
                execution: {
                    ...(updated.execution || {}),
                    ...(result.execution || {}),
                    owner: 'ajun-controlled-local',
                    executor: 'office-assistant',
                    workspaceRoot,
                    toolAccesses: roleToolContext.snapshot(),
                },
                usage: recordTaskUsage({ task: updated, result, startedAt }),
            });
            if (['succeeded', 'running'].includes(updated.status))
                await this.syncWorkProducts(updated);
        }
        catch (error: any) {
            updated = await this.store.updateTask(updated.taskId, {
                status: 'waiting_test',
                currentStage: 'office_presentation_local_failed',
                execution: {
                    ...(updated.execution || {}),
                    finishedAt: new Date().toISOString(),
                    outcome: 'waiting_test',
                },
                error: {
                    code: String(error?.code || 'office_presentation_local_failed').slice(0, 120),
                    message: String(error?.message || '本地演示文稿执行失败。').slice(0, 500),
                    userMessage: '本地演示文稿未通过真实导出或产物登记门禁，已保留当前工作区供检查。',
                    category: String(error?.category || 'manual').slice(0, 80),
                    stage: 'office_presentation_local',
                    retryable: false,
                    occurredAt: new Date().toISOString(),
                },
            });
        }
        if (this.governance && updated.governance?.paperclipIssueId) {
            updated = await this.store.updateTask(updated.taskId, {
                governance: await this.governance.update(updated),
            });
        }
        return updated;
    }
    async syncWorkProducts(task: any): Promise<any> {
        if (!this.governance?.createIssueWorkProduct || !this.governance?.getIssueWorkProducts) {
            throw new ValidationError('Paperclip Work Product 写回能力不可用。');
        }
        const issueId: any = String(task.governance?.paperclipIssueId || '').trim();
        if (!issueId)
            throw new ValidationError('小办演示文稿缺少 Paperclip Issue 绑定。');
        const expectedTypes: any = new Set([
            'office_presentation_source',
            'office_presentation_qa',
            'office_pptx_document',
        ]);
        const artifacts: any = (task.artifactRefs || []).filter((artifact: any): any => expectedTypes.has(artifact?.type) && verifiedAssignmentArtifact(artifact));
        if (artifacts.length !== expectedTypes.size) {
            throw new ValidationError('小办演示文稿缺少 PPTD、QA 或 PPTX 验证产物。');
        }
        const current: any = outputItems(await this.governance.getIssueWorkProducts(issueId));
        for (const artifact of artifacts) {
            const existing: any = current.filter((item: any): any => item?.metadata?.sourceTaskId === task.taskId
                && item?.metadata?.sourceArtifactId === artifact.artifactId);
            if (existing.length > 1)
                throw new ValidationError('Paperclip 演示文稿 Work Product 存在重复记录。');
            if (existing.length === 1)
                continue;
            await this.governance.createIssueWorkProduct(issueId, {
                type: 'artifact',
                provider: 'agent-army.office-presentation',
                externalId: artifact.checksum || artifact.artifactId,
                title: artifact.title,
                status: 'active',
                reviewState: 'none',
                isPrimary: artifact.type === 'office_pptx_document',
                healthStatus: 'healthy',
                summary: '只登记本地产物引用、校验和与验收状态；未复制演示文稿正文。',
                metadata: {
                    sourceTaskId: task.taskId,
                    sourceArtifactId: artifact.artifactId,
                    artifactType: artifact.type,
                    location: artifact.location,
                    checksum: artifact.checksum || null,
                    validation: artifact.validation,
                },
            });
        }
        const persistedTypes: any = new Set(outputItems(await this.governance.getIssueWorkProducts(issueId))
            .filter((item: any): any => item?.metadata?.sourceTaskId === task.taskId)
            .map((item: any): any => item?.metadata?.artifactType));
        if ([...expectedTypes].some((type: any): any => !persistedTypes.has(type))) {
            throw new ValidationError('Paperclip 演示文稿 Work Product 写后回读不完整。');
        }
    }
}
function safeWorkspaceRoot(value: any): any {
    const normalized: any = String(value || '').trim();
    if (!normalized)
        return null;
    const resolved: any = path.resolve(normalized);
    if (!path.isAbsolute(normalized) || resolved === path.parse(resolved).root) {
        throw new Error('小办演示文稿工作区必须是明确的非根绝对目录。');
    }
    return resolved;
}
function safeWorkspaceSegment(value: any): any {
    const normalized: any = String(value || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(normalized)) {
        throw new ValidationError('小办演示文稿任务编号不能映射到安全工作区。');
    }
    return normalized;
}
function localPresentationToolContext({ task, adapters, workspaceRoot }: any): any {
    const declarations: any = Object.freeze({
        'army.task.read': Object.freeze({ adapter: 'ajun-task-store', access: 'read' }),
        'office.pptd.write': Object.freeze({ adapter: 'open-kimi-pptd', access: 'write' }),
        'office.pptx.export': Object.freeze({ adapter: 'local-pptx', access: 'write' }),
    });
    const allowedTaskIds: any = [
        ...(Array.isArray(task.input?.sourceTaskIds) ? task.input.sourceTaskIds : []),
        ...(Array.isArray(task.input?.context?.sourceTaskIds) ? task.input.context.sourceTaskIds : []),
    ].map((item: any): any => String(item || '').trim()).filter(Boolean);
    const accesses: any[] = [];
    return Object.freeze({
        workspaceRoot,
        async execute(request: any = {}): Promise<any> {
            const toolId: any = String(request.toolId || '').trim();
            const declaration: any = declarations[toolId];
            if (!declaration)
                throw new M5RoleToolGrantError('小办本地演示文稿只允许读取任务及写入 PPTD/PPTX。', 'role_tool_denied');
            const relativePath: any = request.relativePath == null ? null : String(request.relativePath);
            if (declaration.access === 'write' && !safePresentationRelativePath(relativePath)) {
                throw new M5RoleToolGrantError('小办演示文稿写入路径必须是安全相对路径。', 'workspace_path_denied');
            }
            const adapter: any = adapters?.[declaration.adapter];
            if (typeof adapter !== 'function') {
                throw new M5RoleToolGrantError(`小办演示文稿适配器 ${declaration.adapter} 不可用。`, 'role_tool_adapter_unavailable');
            }
            const access: any = Object.freeze({
                toolId,
                adapter: declaration.adapter,
                access: declaration.access,
                scope: 'ajun-controlled-task-workspace',
                externalSideEffect: 'none',
                relativePath,
            });
            const output: any = await adapter({
                access,
                input: request.input && typeof request.input === 'object' && !Array.isArray(request.input)
                    ? request.input
                    : {},
                workspaceRoot,
                trustedScope: Object.freeze({ allowedTaskIds: Object.freeze([...new Set(allowedTaskIds)]) }),
            });
            accesses.push(Object.freeze({ ...access, executed: true }));
            return output;
        },
        snapshot(): any {
            return Object.freeze(accesses.map((item: any): any => Object.freeze({ ...item })));
        },
    });
}
function safePresentationRelativePath(value: any): any {
    const normalized: any = String(value || '').trim().replaceAll('\\', '/');
    return Boolean(normalized)
        && normalized.length <= 1024
        && !normalized.includes('\0')
        && !normalized.startsWith('/')
        && !/^[a-z]:\//i.test(normalized)
        && !normalized.split('/').some((part: any): any => !part || part === '.' || part === '..');
}
