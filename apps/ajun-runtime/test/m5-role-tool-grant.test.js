import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertM5RoleToolAccess,
  compileM5RoleToolGrant,
  createM5RoleToolExecutionContext,
  M5RoleToolGrantError,
} from '../src/m5-role-tool-grant.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ids = Object.freeze({
  paperclipAgent:'11111111-1111-4111-8111-111111111111',
  project:'22222222-2222-4222-8222-222222222222',
  workspace:'33333333-3333-4333-8333-333333333333',
});

for (const agentId of ['intel-researcher', 'office-assistant']) {
  test(`${agentId} 直接从Manifest和Hermes Profile编译精确岗位grant`, async () => {
    const manifest = await json(`agents/${agentId}/manifest.json`);
    const profile = await json(manifest.runtimeProfileRef);
    const grant = compileM5RoleToolGrant({
      manifest,
      profile,
      paperclipAgentId:ids.paperclipAgent,
      projectId:ids.project,
      executionWorkspaceId:ids.workspace,
      availableAdapters:manifestAdapters(manifest),
    });

    assert.deepEqual(Object.keys(grant.grants), manifest.toolAllowlist);
    assert.equal(grant.unknownToolDecision, 'deny');
    assert.equal(grant.workspace.scope, 'paperclip-execution-workspace');
    assert.equal(grant.workspace.pathMode, 'relative-only');
  });
}

test('小R只读公开搜索、动态网页、PDF和GitHub', async () => {
  const grant = await roleGrant('intel-researcher');
  assert.equal(assertM5RoleToolAccess(grant, {
    toolId:'content.public.search',
    executionWorkspaceId:ids.workspace,
    externalSideEffect:'network-read',
    url:'https://html.duckduckgo.com/html/',
  }).adapter, 'ajun-public-search');
  assert.equal(assertM5RoleToolAccess(grant, {
    toolId:'content.public.dynamic.read',
    executionWorkspaceId:ids.workspace,
    externalSideEffect:'network-read',
    url:'https://example.com/dynamic',
  }).adapter, 'hermes-public-browser');
  assert.equal(assertM5RoleToolAccess(grant, {
    toolId:'content.public.pdf.read',
    executionWorkspaceId:ids.workspace,
    externalSideEffect:'network-read',
    url:'https://example.com/report.pdf',
  }).adapter, 'hermes-pdf');
});

test('小办声明的办公输出逐项绑定适配器，知识库使用独立逻辑目录scope', async () => {
  const grant = await roleGrant('office-assistant');
  const expected = {
    'office.docx.write':'hermes-docx',
    'office.xlsx.write':'hermes-xlsx',
    'office.pdf.write':'hermes-office-pdf',
    'office.pptd.write':'open-kimi-pptd',
    'office.pptx.export':'local-pptx',
    'office.report.daily.write':'paperclip-work-product',
    'office.report.weekly.write':'paperclip-work-product',
    'knowledge.archive.write':'content-library',
  };
  for (const [toolId, adapter] of Object.entries(expected)) {
    const access = assertM5RoleToolAccess(grant, {
      toolId,
      executionWorkspaceId:ids.workspace,
      relativePath:`deliverables/${toolId.replaceAll('.', '-')}`,
    });
    assert.equal(access.adapter, adapter);
    assert.equal(access.externalSideEffect, 'none');
    if (toolId === 'knowledge.archive.write') {
      assert.equal(access.scope, 'agent-army-knowledge-archive');
    }
  }
});

test('PPTX 使用本地适配器且不申请外部数据处理', async () => {
  const grant = await roleGrant('office-assistant');
  const access = assertM5RoleToolAccess(grant, {
    toolId:'office.pptx.export',
    executionWorkspaceId:ids.workspace,
    externalSideEffect:'none',
    relativePath:'deliverables/deck.pptx',
    dataClassification:'sensitive',
    externalProcessingApproved:false,
  });
  assert.equal(access.adapter, 'local-pptx');
  assert.equal(access.externalSideEffect, 'none');
  assert.equal(access.allowedHosts, null);
  assert.throws(() => assertM5RoleToolAccess(grant, {
    toolId:'office.pptx.export',
    executionWorkspaceId:ids.workspace,
    externalSideEffect:'external-data-processing',
    relativePath:'deliverables/deck.pptx',
    dataClassification:'public',
    externalProcessingApproved:true,
  }), { code:'external_side_effect_denied' });
});

test('未知工具、越权外部副作用、跨工作区和路径逃逸全部拒绝', async () => {
  const grant = await roleGrant('office-assistant');
  for (const input of [
    {
      toolId:'office.email.send',
      executionWorkspaceId:ids.workspace,
      externalSideEffect:'message-send',
    },
    {
      toolId:'office.docx.write',
      executionWorkspaceId:ids.workspace,
      externalSideEffect:'external-write',
    },
    {
      toolId:'office.docx.write',
      executionWorkspaceId:'44444444-4444-4444-8444-444444444444',
    },
    {
      toolId:'office.docx.write',
      executionWorkspaceId:ids.workspace,
      relativePath:'../outside.docx',
    },
  ]) {
    assert.throws(
      () => assertM5RoleToolAccess(grant, input),
      (error) => error instanceof M5RoleToolGrantError,
    );
  }
});

test('所有写工具强制安全相对路径，网络只读强制公开HTTP(S) URL', async () => {
  const office = await roleGrant('office-assistant');
  assert.throws(
    () => assertM5RoleToolAccess(office, {
      toolId:'office.docx.write',
      executionWorkspaceId:ids.workspace,
    }),
    { code:'workspace_path_required' },
  );
  const intel = await roleGrant('intel-researcher');
  for (const url of [
    null,
    'ftp://example.com/a',
    'http://user:pass@example.com/a',
    'http://127.0.0.1/a',
    'http://10.0.0.1/a',
    'http://[::1]/a',
    'http://[::ffff:a00:1]/a',
    'http://service.internal/a',
  ]) {
    assert.throws(
      () => assertM5RoleToolAccess(intel, {
        toolId:'content.public.fetch',
        executionWorkspaceId:ids.workspace,
        externalSideEffect:'network-read',
        url,
      }),
      (error) => ['network_url_required', 'network_url_denied'].includes(error?.code),
    );
  }
});

test('声明存在但运行时没有实际适配器时失败关闭', async () => {
  const manifest = await json('agents/office-assistant/manifest.json');
  const grant = compileM5RoleToolGrant({
    manifest,
    profile:await json(manifest.runtimeProfileRef),
      paperclipAgentId:ids.paperclipAgent,
      projectId:ids.project,
      executionWorkspaceId:ids.workspace,
      availableAdapters:['ajun-office-markdown'],
  });
  assert.throws(
    () => assertM5RoleToolAccess(grant, {
      toolId:'office.docx.write',
      executionWorkspaceId:ids.workspace,
      relativePath:'deliverables/report.docx',
    }),
    { code:'role_tool_adapter_unavailable' },
  );
});

test('非M5普通岗位任务可没有Project，但伪造Project仍失败关闭', async () => {
  const manifest = await json('agents/intel-researcher/manifest.json');
  const input = {
    manifest,
    profile:await json(manifest.runtimeProfileRef),
    paperclipAgentId:ids.paperclipAgent,
    projectId:null,
    executionWorkspaceId:ids.workspace,
    requireProjectId:false,
    availableAdapters:manifestAdapters(manifest),
  };
  const grant = compileM5RoleToolGrant(input);
  assert.equal(grant.projectId, null);
  assert.throws(
    () => compileM5RoleToolGrant({ ...input, projectId:'forged-project' }),
    { code:'paperclip_scope_invalid' },
  );
});

test('非M5纯只读岗位可没有Workspace，但伪造Workspace仍失败关闭', async () => {
  const manifest = await json('agents/intel-researcher/manifest.json');
  const input = {
    manifest,
    profile:await json(manifest.runtimeProfileRef),
    paperclipAgentId:ids.paperclipAgent,
    projectId:null,
    executionWorkspaceId:null,
    requireProjectId:false,
    requireExecutionWorkspaceId:false,
    availableAdapters:manifestAdapters(manifest),
  };
  const grant = compileM5RoleToolGrant(input);
  assert.equal(grant.executionWorkspaceId, null);
  assert.throws(
    () => compileM5RoleToolGrant({ ...input, executionWorkspaceId:'forged-workspace' }),
    { code:'paperclip_scope_invalid' },
  );
});

test('受信执行上下文只通过精确适配器执行并在成功后生成访问回执', async () => {
  const manifest = await json('agents/intel-researcher/manifest.json');
  const calls = [];
  const adapters = {
    'ajun-public-fetch':async ({ access, input }) => {
      calls.push({ access, input });
      return { sourceRef:access.url };
    },
  };
  const grant = compileM5RoleToolGrant({
    manifest,
    profile:await json(manifest.runtimeProfileRef),
    paperclipAgentId:ids.paperclipAgent,
    projectId:ids.project,
    executionWorkspaceId:ids.workspace,
    availableAdapters:adapters,
  });
  const context = createM5RoleToolExecutionContext(grant, { adapters });
  const output = await context.execute({
    toolId:'content.public.fetch',
    externalSideEffect:'network-read',
    url:'https://example.com/source',
    input:{ sourceUrl:'https://example.com/source' },
  });
  assert.equal(output.sourceRef, 'https://example.com/source');
  assert.equal(calls.length, 1);
  assert.equal(context.snapshot().length, 1);
  assert.equal(context.snapshot()[0].executed, true);
  assert.equal('authorize' in context, false);
});

test('Profile额外放行工具或Manifest策略缺项时失败关闭', async () => {
  const manifest = await json('agents/intel-researcher/manifest.json');
  const profile = await json(manifest.runtimeProfileRef);
  profile.toolAllowlist.push('content.private.read');
  assert.throws(
    () => compileM5RoleToolGrant({
      manifest,
      profile,
      paperclipAgentId:ids.paperclipAgent,
      projectId:ids.project,
      executionWorkspaceId:ids.workspace,
      availableAdapters:manifestAdapters(manifest),
    }),
    { code:'role_tool_policy_invalid' },
  );
});

async function roleGrant(agentId) {
  const manifest = await json(`agents/${agentId}/manifest.json`);
  return compileM5RoleToolGrant({
    manifest,
    profile:await json(manifest.runtimeProfileRef),
    paperclipAgentId:ids.paperclipAgent,
    projectId:ids.project,
    executionWorkspaceId:ids.workspace,
    availableAdapters:manifestAdapters(manifest),
  });
}

function manifestAdapters(manifest) {
  return Object.fromEntries(
    [...new Set(Object.values(manifest.toolExecutionPolicy.grants).map((item) => item.adapter))]
      .map((name) => [name, async () => ({})]),
  );
}

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}
