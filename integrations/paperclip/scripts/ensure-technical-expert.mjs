#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = 'http://127.0.0.1:3100';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const projectName = 'Agent军团工程修复';
const worktreeParentDir = '/Users/pengaro/.paperclip/agent-army-worktrees';
const metadata = { agentArmyId:'technical-expert', managedBy:'ajun-runtime', safetyMode:'isolated-worktree' };
const adapterConfig = {
  command:'/Users/pengaro/.local/bin/codex',
  cwd:root,
  instructionsFilePath:path.join(root, 'agents/technical-expert/prompts/system.md'),
  model:'gpt-5.4', modelReasoningEffort:'high', search:false, fastMode:false,
  dangerouslyBypassApprovalsAndSandbox:false,
  extraArgs:['--sandbox', 'workspace-write', '-c', 'approval_policy="never"'],
  workspaceStrategy:{ type:'git_worktree', branchTemplate:'paperclip/technical-expert-manual-hold', worktreeParentDir },
  timeoutSec:1800, graceSec:15, outputInactivityTimeoutMs:420000
};

export async function ensureTechnicalExpert({ fetchImpl = fetch } = {}) {
  const request = async (pathname, options = {}) => {
    const response = await fetchImpl(`${baseUrl}${pathname}`, { method:options.method || 'GET', headers:options.body ? {'content-type':'application/json'} : undefined, body:options.body ? JSON.stringify(options.body) : undefined });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Paperclip 返回 ${response.status}`);
    return payload;
  };
  const companies = await request('/api/companies');
  const company = companies.find((item) => item.name === 'Agent军团');
  if (!company) throw new Error('Paperclip 中未找到 Agent军团。');
  const project = await ensureRepairProject(request, company.id);
  const agents = await request(`/api/companies/${company.id}/agents`);
  const existing = agents.find((agent) => agent.metadata?.agentArmyId === 'technical-expert' && agent.status !== 'terminated');
  if (existing) {
    const agent = await request(`/api/agents/${existing.id}`, { method:'PATCH', body:{ adapterConfig, metadata:{ ...existing.metadata, paperclipProjectId:project.id }, status:'paused' } });
    return { created:false, agent, environment:null, project };
  }
  const environment = await request(`/api/companies/${company.id}/adapters/codex_local/test-environment`, { method:'POST', body:{ adapterConfig } });
  if (environment.status !== 'pass' && environment.status !== 'warn') throw new Error('Codex 技术专家运行环境未通过检查，未创建员工。');
  const createdAgent = await request(`/api/companies/${company.id}/agents`, { method:'POST', body:{
    name:'技术专家', role:'engineer', title:'受控项目修复与验证', icon:'wrench',
    capabilities:'接收已脱敏的项目故障，在隔离工作区复现、修改、测试并提交可复核结果。禁止登录、读取凭据、外发、付费、扩权或公开发布。',
    adapterType:'codex_local', adapterConfig, budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false }, metadata:{ ...metadata, paperclipProjectId:project.id }
  } });
  const agent = await request(`/api/agents/${createdAgent.id}`, { method:'PATCH', body:{ status:'paused' } });
  return { created:true, agent, environment, project };
}

async function ensureRepairProject(request, companyId) {
  const projects = await request(`/api/companies/${companyId}/projects`);
  let project = projects.find((item) => item.name === projectName);
  if (!project) {
    project = await request(`/api/companies/${companyId}/projects`, { method:'POST', body:{
      name:projectName, description:'仅供技术专家在独立副本中修复 Agent军团工程问题；主运行目录不直接改动。', status:'in_progress', icon:'wrench',
      workspace:{ name:'Agent军团工程主路径', sourceType:'local_path', cwd:root, isPrimary:true },
      executionWorkspacePolicy:{ enabled:true, defaultMode:'isolated_workspace', workspaceStrategy:{ type:'git_worktree', baseRef:'HEAD', branchTemplate:'paperclip/technical-expert-manual-hold', worktreeParentDir } }
    } });
  }
  const workspaces = await request(`/api/projects/${project.id}/workspaces`);
  const workspace = workspaces.find((item) => item.isPrimary) || workspaces[0];
  if (!workspace) throw new Error('技术专家工程工作区未创建。');
  return request(`/api/projects/${project.id}`, { method:'PATCH', body:{
    executionWorkspacePolicy:{ enabled:true, defaultMode:'isolated_workspace', defaultProjectWorkspaceId:workspace.id, workspaceStrategy:{ type:'git_worktree', baseRef:'HEAD', branchTemplate:'paperclip/technical-expert-manual-hold', worktreeParentDir } }
  } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureTechnicalExpert().then((result) => console.log(JSON.stringify({ created:result.created, name:result.agent.name, adapterType:result.agent.adapterType, status:result.agent.status, project:result.project.name, environmentStatus:result.environment?.status || 'already_exists' }))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
