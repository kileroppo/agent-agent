import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOVERNANCE_HERMES_AGENT_IDS,
  discoverGovernanceHermesAgentIds,
  paperclipHermesAdapterConfig
} from '../src/governance-hermes-runtime.js';

test('Paperclip Hermes 员工清单从 Manifest 自动发现，不维护第二份岗位名单', () => {
  assert.deepEqual(GOVERNANCE_HERMES_AGENT_IDS, [
    'architect',
    'content-creator',
    'creator',
    'operator',
    'reviewer',
    'technical-expert',
    'video-content-analyst'
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

test('Paperclip Hermes 适配器显式携带受控模型，避免 ChatGPT 授权被 auto 模型拒绝', () => {
  const config = paperclipHermesAdapterConfig({
    agentId:'video-content-analyst',
    status:'active',
    promptRef:'agents/video-content-analyst/prompts/system.md',
    acceptedTaskTypes:['content.video-benchmark-analysis'],
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes',
    runtimeCapabilities:{
      modelSelection:{ provider:'openai-codex', model:'gpt-5.6-terra' },
      paperclipToolsets:['agent-army'],
      mcpTools:['video_content_analyze_execute']
    }
  });
  assert.equal(config.provider, 'openai-codex');
  assert.equal(config.model, 'gpt-5.6-terra');
});

test('Paperclip Hermes 适配器拒绝 Manifest 中未授权的 Provider', () => {
  assert.throws(() => paperclipHermesAdapterConfig({
    agentId:'unsafe',
    status:'active',
    promptRef:'agents/video-content-analyst/prompts/system.md',
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes',
    runtimeCapabilities:{ modelSelection:{ provider:'shell-provider', model:'gpt-5.6-terra' } }
  }), /Provider 不在受控白名单/);
});

function pathName(value) {
  return String(value).split('/').at(-2);
}
