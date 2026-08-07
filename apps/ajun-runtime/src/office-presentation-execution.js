import fs from 'node:fs/promises';
import path from 'node:path';

import { M5RoleToolGrantError } from './m5-role-tool-grant.js';
import {
  outputItems,
  ValidationError,
  verifiedAssignmentArtifact,
} from './task-service-execution-support.js';
import { recordTaskUsage } from './task-usage.js';

export class OfficePresentationExecution {
  constructor({
    workspaceRoot = null,
    store,
    governance = null,
    capabilityCatalog,
    executorResolver,
    roleToolAdapters = {},
  }) {
    this.workspaceRoot = safeWorkspaceRoot(workspaceRoot);
    this.store = store;
    this.governance = governance;
    this.capabilityCatalog = capabilityCatalog;
    this.executorResolver = executorResolver;
    this.roleToolAdapters = roleToolAdapters;
  }

  supports(task, agent) {
    return task?.taskType === 'office.presentation-package'
      && agent?.status === 'active'
      && Boolean(this.workspaceRoot);
  }

  async execute(task, agent) {
    const executor = this.executorResolver(agent.agentId)
      || this.capabilityCatalog.executor(agent.agentId);
    if (!executor?.execute) throw new ValidationError('小办本地演示文稿执行器不可用。');

    const workspaceRoot = path.join(this.workspaceRoot, safeWorkspaceSegment(task.taskId));
    await fs.mkdir(workspaceRoot, { recursive:true, mode:0o700 });
    const stat = await fs.lstat(workspaceRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ValidationError('小办演示文稿工作区无效。');
    }

    const startedAt = new Date();
    let updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:'office_presentation_local_starting',
      execution:{
        ...(task.execution || {}),
        owner:'ajun-controlled-local',
        executor:'office-assistant',
        workspaceRoot,
        startedAt:startedAt.toISOString(),
      },
    });

    try {
      const roleToolContext = localPresentationToolContext({
        task:updated,
        adapters:this.roleToolAdapters,
        workspaceRoot,
      });
      const result = await executor.execute(updated, { roleToolContext });
      updated = await this.store.updateTask(updated.taskId, {
        ...result,
        execution:{
          ...(updated.execution || {}),
          ...(result.execution || {}),
          owner:'ajun-controlled-local',
          executor:'office-assistant',
          workspaceRoot,
          toolAccesses:roleToolContext.snapshot(),
        },
        usage:recordTaskUsage({ task:updated, result, startedAt }),
      });
      if (updated.status === 'succeeded') await this.syncWorkProducts(updated);
    } catch (error) {
      updated = await this.store.updateTask(updated.taskId, {
        status:'waiting_test',
        currentStage:'office_presentation_local_failed',
        execution:{
          ...(updated.execution || {}),
          finishedAt:new Date().toISOString(),
          outcome:'waiting_test',
        },
        error:{
          code:String(error?.code || 'office_presentation_local_failed').slice(0, 120),
          message:String(error?.message || '本地演示文稿执行失败。').slice(0, 500),
          userMessage:'本地演示文稿未通过真实导出或产物登记门禁，已保留当前工作区供检查。',
          category:String(error?.category || 'manual').slice(0, 80),
          stage:'office_presentation_local',
          retryable:false,
          occurredAt:new Date().toISOString(),
        },
      });
    }

    if (this.governance && updated.governance?.paperclipIssueId) {
      updated = await this.store.updateTask(updated.taskId, {
        governance:await this.governance.update(updated),
      });
    }
    return updated;
  }

  async syncWorkProducts(task) {
    if (!this.governance?.createIssueWorkProduct || !this.governance?.getIssueWorkProducts) {
      throw new ValidationError('Paperclip Work Product 写回能力不可用。');
    }
    const issueId = String(task.governance?.paperclipIssueId || '').trim();
    if (!issueId) throw new ValidationError('小办演示文稿缺少 Paperclip Issue 绑定。');

    const expectedTypes = new Set([
      'office_presentation_source',
      'office_presentation_qa',
      'office_pptx_document',
    ]);
    const artifacts = (task.artifactRefs || []).filter((artifact) =>
      expectedTypes.has(artifact?.type) && verifiedAssignmentArtifact(artifact));
    if (artifacts.length !== expectedTypes.size) {
      throw new ValidationError('小办演示文稿缺少 PPTD、QA 或 PPTX 验证产物。');
    }

    const current = outputItems(await this.governance.getIssueWorkProducts(issueId));
    for (const artifact of artifacts) {
      const existing = current.filter((item) =>
        item?.metadata?.sourceTaskId === task.taskId
        && item?.metadata?.sourceArtifactId === artifact.artifactId);
      if (existing.length > 1) throw new ValidationError('Paperclip 演示文稿 Work Product 存在重复记录。');
      if (existing.length === 1) continue;
      await this.governance.createIssueWorkProduct(issueId, {
        type:'artifact',
        provider:'agent-army.office-presentation',
        externalId:artifact.checksum || artifact.artifactId,
        title:artifact.title,
        status:'active',
        reviewState:'none',
        isPrimary:artifact.type === 'office_pptx_document',
        healthStatus:'healthy',
        summary:'只登记本地产物引用、校验和与验收状态；未复制演示文稿正文。',
        metadata:{
          sourceTaskId:task.taskId,
          sourceArtifactId:artifact.artifactId,
          artifactType:artifact.type,
          location:artifact.location,
          checksum:artifact.checksum || null,
          validation:artifact.validation,
        },
      });
    }

    const persistedTypes = new Set(outputItems(await this.governance.getIssueWorkProducts(issueId))
      .filter((item) => item?.metadata?.sourceTaskId === task.taskId)
      .map((item) => item?.metadata?.artifactType));
    if ([...expectedTypes].some((type) => !persistedTypes.has(type))) {
      throw new ValidationError('Paperclip 演示文稿 Work Product 写后回读不完整。');
    }
  }
}

function safeWorkspaceRoot(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const resolved = path.resolve(normalized);
  if (!path.isAbsolute(normalized) || resolved === path.parse(resolved).root) {
    throw new Error('小办演示文稿工作区必须是明确的非根绝对目录。');
  }
  return resolved;
}

function safeWorkspaceSegment(value) {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(normalized)) {
    throw new ValidationError('小办演示文稿任务编号不能映射到安全工作区。');
  }
  return normalized;
}

function localPresentationToolContext({ task, adapters, workspaceRoot }) {
  const declarations = Object.freeze({
    'army.task.read':Object.freeze({ adapter:'ajun-task-store', access:'read' }),
    'office.pptd.write':Object.freeze({ adapter:'open-kimi-pptd', access:'write' }),
    'office.pptx.export':Object.freeze({ adapter:'local-pptx', access:'write' }),
  });
  const allowedTaskIds = [
    ...(Array.isArray(task.input?.sourceTaskIds) ? task.input.sourceTaskIds : []),
    ...(Array.isArray(task.input?.context?.sourceTaskIds) ? task.input.context.sourceTaskIds : []),
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const accesses = [];
  return Object.freeze({
    workspaceRoot,
    async execute(request = {}) {
      const toolId = String(request.toolId || '').trim();
      const declaration = declarations[toolId];
      if (!declaration) throw new M5RoleToolGrantError('小办本地演示文稿只允许读取任务及写入 PPTD/PPTX。', 'role_tool_denied');
      const relativePath = request.relativePath == null ? null : String(request.relativePath);
      if (declaration.access === 'write' && !safePresentationRelativePath(relativePath)) {
        throw new M5RoleToolGrantError('小办演示文稿写入路径必须是安全相对路径。', 'workspace_path_denied');
      }
      const adapter = adapters?.[declaration.adapter];
      if (typeof adapter !== 'function') {
        throw new M5RoleToolGrantError(`小办演示文稿适配器 ${declaration.adapter} 不可用。`, 'role_tool_adapter_unavailable');
      }
      const access = Object.freeze({
        toolId,
        adapter:declaration.adapter,
        access:declaration.access,
        scope:'ajun-controlled-task-workspace',
        externalSideEffect:'none',
        relativePath,
      });
      const output = await adapter({
        access,
        input:request.input && typeof request.input === 'object' && !Array.isArray(request.input)
          ? request.input
          : {},
        workspaceRoot,
        trustedScope:Object.freeze({ allowedTaskIds:Object.freeze([...new Set(allowedTaskIds)]) }),
      });
      accesses.push(Object.freeze({ ...access, executed:true }));
      return output;
    },
    snapshot() {
      return Object.freeze(accesses.map((item) => Object.freeze({ ...item })));
    },
  });
}

function safePresentationRelativePath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(normalized)
    && normalized.length <= 1024
    && !normalized.includes('\0')
    && !normalized.startsWith('/')
    && !/^[a-z]:\//i.test(normalized)
    && !normalized.split('/').some((part) => !part || part === '.' || part === '..');
}
