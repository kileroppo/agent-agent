import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import { prepareWorkspaceFile } from './workspace-path-guard.js';

export function createM5RoleToolAdapters({
  publicWebSearch,
  publicWebFetch,
  publicDynamicWebReader,
  publicPdfReader,
  githubSearch,
  officeDocuments,
  officePresentations,
  governance,
  store,
  knowledgeArchive,
} = {}) {
  return Object.freeze({
    ...(typeof publicWebSearch?.search === 'function'
      ? {
          'ajun-public-search':async ({ input }) =>
            publicWebSearch.search({
              query:input.query,
              limit:input.limit,
            }),
        }
      : {}),
    ...(typeof publicWebFetch?.acquire === 'function'
      ? {
          'ajun-public-fetch':async ({ access }) =>
            withContentHash(await publicWebFetch.acquire({ sourceUrl:access.url })),
        }
      : {}),
    ...(typeof publicDynamicWebReader?.read === 'function'
      ? {
          'hermes-public-browser':async ({ access }) =>
            publicDynamicWebReader.read({ sourceUrl:access.url }),
        }
      : {}),
    ...(typeof publicPdfReader?.read === 'function'
      ? {
          'hermes-pdf':async ({ access }) =>
            publicPdfReader.read({ sourceUrl:access.url }),
        }
      : {}),
    ...(typeof githubSearch?.search === 'function' && typeof githubSearch?.readRepo === 'function'
      ? {
          'github-public':async ({ input }) => {
            if (input.operation === 'search') {
              return githubSearch.search({ query:input.query, limit:input.limit });
            }
            if (input.operation === 'read') {
              return githubSearch.readRepo({ repo:input.repo, path:input.path });
            }
            throw adapterError('GitHub 受控适配器不支持该操作。', 'role_tool_input_invalid');
          },
        }
      : {}),
    ...(typeof store?.list === 'function'
      ? {
          'ajun-task-store':async ({ trustedScope }) => {
            const allowedTaskIds = new Set(stringList(trustedScope?.allowedTaskIds));
            if (!allowedTaskIds.size) return [];
            return (await store.list()).filter((task) =>
              allowedTaskIds.has(String(task?.taskId || '')),
            );
          },
        }
      : {}),
    'ajun-office-markdown':writeWorkspaceText,
    ...(typeof officeDocuments?.writeDocx === 'function'
      ? {
          'hermes-docx':(context) => officeDocuments.writeDocx(context),
        }
      : {}),
    ...(typeof officeDocuments?.writeXlsx === 'function'
      ? {
          'hermes-xlsx':(context) => officeDocuments.writeXlsx(context),
        }
      : {}),
    ...(typeof officeDocuments?.writePdf === 'function'
      ? {
          'hermes-office-pdf':(context) => officeDocuments.writePdf(context),
        }
      : {}),
    ...(typeof officePresentations?.writePptd === 'function'
      ? {
          'open-kimi-pptd':(context) => officePresentations.writePptd(context),
        }
      : {}),
    ...(typeof officePresentations?.exportPptx === 'function'
      ? {
          'local-pptx':(context) => officePresentations.exportPptx(context),
        }
      : {}),
    ...(typeof governance?.createIssueWorkProduct === 'function'
      && typeof governance?.getIssueWorkProducts === 'function'
      ? {
          'paperclip-work-product':(context) =>
            writePaperclipReportWorkProduct(context, governance),
        }
      : {}),
    ...(typeof knowledgeArchive?.write === 'function'
      ? {
          'content-library':async ({ access, input }) => {
            if (
              access.scope !== 'agent-army-knowledge-archive'
              || access.relativePath !== 'Agent军团'
            ) {
              throw adapterError('知识归档目标不属于已授权的 Agent军团 逻辑目录。', 'workspace_scope_denied');
            }
            return knowledgeArchive.write({
              taskId:input.taskId,
              idempotencyKey:input.idempotencyKey,
              title:input.title,
              markdown:input.markdown,
            });
          },
        }
      : {}),
  });
}

async function writePaperclipReportWorkProduct({
  access,
  input,
  workspaceRoot,
  trustedScope,
}, governance) {
  const reportKind = ({
    'office.report.daily.write':'daily',
    'office.report.weekly.write':'weekly',
  })[access?.toolId];
  if (!reportKind) {
    throw adapterError('Work Product 适配器只接受日报或周报工具。', 'role_tool_input_invalid');
  }
  const issueId = String(trustedScope?.paperclipIssueId || '').trim();
  const runId = String(trustedScope?.paperclipRunId || '').trim();
  const pipelineCaseId = String(trustedScope?.pipelineCaseId || '').trim();
  if (!issueId || !runId) {
    throw adapterError('Work Product 缺少当前 Paperclip Issue/Run 身份。', 'paperclip_scope_invalid');
  }
  const markdown = String(input?.markdown || input?.contents || '').replace(/\u0000/g, '').trim();
  const idempotencyKey = String(input?.idempotencyKey || '').trim();
  if (!markdown || markdown.length > 500_000 || !/^[a-zA-Z0-9:_-]{8,200}$/.test(idempotencyKey)) {
    throw adapterError('日报/周报需要非空 Markdown 和受控幂等键。', 'role_tool_input_invalid');
  }
  const trustedTaskIds = new Set(stringList(trustedScope?.allowedTaskIds));
  const requestedTaskIds = stringList(input?.sourceTaskIds);
  if (requestedTaskIds.some((taskId) => !trustedTaskIds.has(taskId))) {
    throw adapterError('日报/周报引用了当前任务信封未授权的来源任务。', 'paperclip_scope_invalid');
  }
  const hash = crypto.createHash('sha256').update(markdown).digest('hex');
  const externalId = `agent-army-office-${reportKind}-${idempotencyKey}`.slice(0, 240);
  const existing = workProductItems(await governance.getIssueWorkProducts(issueId))
    .filter((item) => item?.externalId === externalId);
  if (existing.length > 1) {
    throw adapterError('同一日报/周报存在多个 Work Product，拒绝自动选择。', 'work_product_drift');
  }
  if (existing.length === 1) {
    if (existing[0]?.metadata?.contentHash !== hash) {
      throw adapterError('同一幂等键对应不同日报/周报内容。', 'work_product_drift');
    }
    return Object.freeze({
      workProductId:existing[0].id,
      duplicate:true,
      contentHash:hash,
      relativePath:existing[0]?.metadata?.relativePath || access.relativePath,
    });
  }
  const local = await writeWorkspaceText({
    access,
    input:{ contents:`${markdown}\n` },
    workspaceRoot,
  });
  const product = await governance.createIssueWorkProduct(issueId, {
    type:'document',
    provider:'agent-army.office-assistant',
    externalId,
    title:String(input?.title || (reportKind === 'daily' ? 'Agent军团日报' : 'Agent军团周报')).slice(0, 300),
    status:'active',
    reviewState:'none',
    isPrimary:false,
    healthStatus:'healthy',
    summary:String(input?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
      || `${reportKind === 'daily' ? '日报' : '周报'}已写入受控 execution workspace。`,
    metadata:{
      schemaVersion:'agent.army/office-report-work-product/v1',
      kind:reportKind === 'daily' ? 'DailyReport' : 'WeeklyReport',
      contentHash:hash,
      relativePath:access.relativePath,
      pipelineCaseId:pipelineCaseId || null,
      sourceTaskIds:requestedTaskIds,
      generatedAt:new Date().toISOString(),
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        bytes:local.bytes,
      },
    },
    createdByRunId:runId,
  }, { runId });
  if (!product?.id) {
    throw adapterError('Paperclip 未返回 Work Product ID。', 'role_tool_output_invalid');
  }
  return Object.freeze({
    workProductId:product.id,
    duplicate:false,
    contentHash:hash,
    relativePath:access.relativePath,
    bytes:local.bytes,
  });
}

async function writeWorkspaceText({ access, input, workspaceRoot }) {
  const contents = String(input.contents || '');
  if (!contents) throw adapterError('办公产物内容为空，拒绝写入。', 'role_tool_input_invalid');
  const { target } = await prepareWorkspaceFile(workspaceRoot, access.relativePath);
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) {
      throw adapterError('办公产物目标不能是符号链接。', 'workspace_path_denied');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const handle = await fs.open(
    target,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_TRUNC
      | (fsConstants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size < 1) {
    throw adapterError('办公产物写入后为空。', 'role_tool_output_invalid');
  }
  return Object.freeze({
    filePath:target,
    relativePath:access.relativePath,
    bytes:stat.size,
  });
}

function withContentHash(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.freeze({
    ...value,
    contentHash:String(value.contentHash || '') || crypto
      .createHash('sha256')
      .update(String(value.text || ''))
      .digest('hex'),
  });
}

function adapterError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function workProductItems(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function stringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100)
    : [];
}
