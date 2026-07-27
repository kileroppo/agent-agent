import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ARMY_REPOSITORY_ROOT = path.resolve(sourceDirectory, '../../..');
const agentsDirectory = path.join(AGENT_ARMY_REPOSITORY_ROOT, 'agents');

// Keep the historical export name for callers, but derive the fleet from the
// same manifest contract Paperclip uses. Adding an active Hermes employee no
// longer requires editing a second hard-coded roster.
export const GOVERNANCE_HERMES_AGENT_IDS = Object.freeze(discoverGovernanceHermesAgentIds());
const GOVERNANCE_HERMES_AGENT_ID_SET = new Set(GOVERNANCE_HERMES_AGENT_IDS);

export function discoverGovernanceHermesAgentIds({
  directory = agentsDirectory,
  readdir = fs.readdirSync,
  readFile = fs.readFileSync
} = {}) {
  const ids = [];
  for (const entry of readdir(directory, { withFileTypes:true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(directory, entry.name, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (usesPaperclipHermesExecution(manifest)) ids.push(String(manifest.agentId || '').trim());
  }
  return [...new Set(ids.filter(Boolean))].sort();
}

export function isGovernanceHermesAgent(agentOrId) {
  const agentId = typeof agentOrId === 'string' ? agentOrId : agentOrId?.agentId;
  return GOVERNANCE_HERMES_AGENT_ID_SET.has(String(agentId || '').trim());
}

export function usesPaperclipHermesExecution(manifest) {
  return manifest?.status === 'active'
    && manifest?.interaction?.runtime === 'hermes-profile'
    && manifest?.executionOwner === 'paperclip-hermes';
}

export function hermesProfileHome(agentId) {
  const home = String(process.env.HOME || '').trim();
  if (!home || home === path.parse(home).root) throw new Error('无法确定安全的 Hermes Profile 根目录。');
  const profileRoot = path.resolve(home, '.hermes/profiles');
  const profileHome = path.resolve(profileRoot, String(agentId || ''));
  if (!profileHome.startsWith(`${profileRoot}${path.sep}`)) throw new Error('Hermes Profile 路径越界。');
  return profileHome;
}

export function paperclipHermesAdapterConfig(manifest) {
  if (!usesPaperclipHermesExecution(manifest)) return {};
  const promptPath = path.resolve(AGENT_ARMY_REPOSITORY_ROOT, String(manifest.promptRef || ''));
  if (!promptPath.startsWith(`${AGENT_ARMY_REPOSITORY_ROOT}${path.sep}`)) throw new Error('员工 Prompt 路径越界。');
  const paperclipToolsets = safeStringList(manifest.runtimeCapabilities?.paperclipToolsets);
  return {
    cwd:AGENT_ARMY_REPOSITORY_ROOT,
    instructionsFilePath:promptPath,
    hermesCommand:path.resolve(String(process.env.HOME || ''), '.local/bin/hermes'),
    env:{
      HERMES_HOME:hermesProfileHome(manifest.agentId),
      AGENT_ARMY_AGENT_ID:manifest.agentId,
      AGENT_ARMY_ALLOWED_AGENT_IDS:manifest.agentId,
      AGENT_ARMY_ALLOWED_TASK_TYPES:safeStringList(manifest.acceptedTaskTypes).join(','),
      AGENT_ARMY_ALLOWED_MCP_TOOLS:safeStringList(manifest.runtimeCapabilities?.mcpTools).join(','),
      AGENT_ARMY_ALLOW_MISSIONS:manifest.runtimeCapabilities?.mcpTools?.includes('mission_create') ? 'true' : 'false'
    },
    toolsets:paperclipToolsets.join(','),
    persistSession:true,
    quiet:true,
    timeoutSec:1800,
    graceSec:15
  };
}

function safeStringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}
