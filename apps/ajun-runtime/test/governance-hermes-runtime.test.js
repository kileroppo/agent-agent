import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOVERNANCE_HERMES_AGENT_IDS,
  discoverGovernanceHermesAgentIds
} from '../src/governance-hermes-runtime.js';

test('Paperclip Hermes 员工清单从 Manifest 自动发现，不维护第二份岗位名单', () => {
  assert.deepEqual(GOVERNANCE_HERMES_AGENT_IDS, [
    'architect',
    'creator',
    'operator',
    'reviewer',
    'task-coordinator',
    'technical-expert'
  ]);
});

test('自动发现只纳入 active + hermes-profile + paperclip-hermes 员工', () => {
  const manifests = new Map([
    ['active', { agentId:'active', status:'active', interaction:{ runtime:'hermes-profile' }, executionOwner:'paperclip-hermes' }],
    ['draft', { agentId:'draft', status:'draft', interaction:{ runtime:'hermes-profile' }, executionOwner:'paperclip-hermes' }],
    ['local', { agentId:'local', status:'active', interaction:{ runtime:'local' }, executionOwner:'paperclip-hermes' }]
  ]);
  const result = discoverGovernanceHermesAgentIds({
    directory:'/virtual/agents',
    readdir:() => [...manifests.keys()].map((name) => ({ name, isDirectory:() => true })),
    readFile:(manifestPath) => JSON.stringify(manifests.get(pathName(manifestPath)))
  });
  assert.deepEqual(result, ['active']);
});

function pathName(value) {
  return String(value).split('/').at(-2);
}
