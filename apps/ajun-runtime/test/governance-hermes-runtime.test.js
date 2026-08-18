import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GOVERNANCE_HERMES_AGENT_IDS,
  assertM5HermesExecutionManifest,
  assertM5HermesExecutionPrompt,
  discoverGovernanceHermesAgentIds,
  hermesRuntimePolicyForManifest,
  paperclipHermesAdapterConfig
} from '../src/governance-hermes-runtime.ts';

test('Paperclip Hermes 员工清单从 Manifest 自动发现，不维护第二份岗位名单', () => {
  assert.deepEqual(GOVERNANCE_HERMES_AGENT_IDS, [
    'ajun',
    'architect',
    'content-creator',
    'creator',
    'intel-researcher',
    'office-assistant',
    'operator',
    'reviewer',
    'technical-expert',
    'video-content-analyst',
    'xiaod'
  ]);
});

test('Manifest 预算生成有界 Hermes 运行、压缩、记忆和会话策略', () => {
  const policy = hermesRuntimePolicyForManifest({
    autonomyBudgetPolicy:{
      maxModelCalls:8,
      maxTurns:8,
      reasoningEffort:'none',
      apiMaxRetries:1,
      toolLoopHardStop:true,
    },
  });
  assert.deepEqual(policy.model, { maxTokens:8192 });
  assert.deepEqual(policy.agent, { maxTurns:8, reasoningEffort:'none', apiMaxRetries:1 });
  assert.equal(policy.toolLoopGuardrails.hardStopEnabled, true);
  assert.deepEqual(policy.tools, { toolSearch:{ enabled:'off' } });
  assert.equal(policy.compression.protectLastN, 8);
  assert.deepEqual(policy.memory, { writeApproval:true, nudgeInterval:0 });
  assert.deepEqual(policy.sessions, { autoPrune:true, retentionDays:30 });
  assert.deepEqual(policy.sessionReset, { mode:'idle', idleMinutes:1440, notify:true });
  assert.throws(() => hermesRuntimePolicyForManifest({ autonomyBudgetPolicy:{
    maxModelCalls:8, maxTurns:9, reasoningEffort:'high', apiMaxRetries:5, toolLoopHardStop:false,
  } }), /最大轮次|推理强度|重试次数|硬停止|模型调用预算/);
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
    acceptedTaskTypes:[
      'content.video-benchmark-analysis',
      'content.campaign-visual-analysis',
    ],
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
  assert.equal(config.env.AGENT_ARMY_PROFILE_ID, 'video-content-analyst');
  assert.equal(config.env.AGENT_ARMY_TASK_CARD_POLICY, 'disabled');
});

test('Paperclip Hermes 适配器从 Manifest 传播任务卡策略且未配置默认关闭', () => {
  const ajun = readJson(new URL('../../../agents/ajun/manifest.json', import.meta.url));
  const contentCreator = readJson(new URL('../../../agents/content-creator/manifest.json', import.meta.url));
  assert.equal(
    paperclipHermesAdapterConfig(ajun).env.AGENT_ARMY_TASK_CARD_POLICY,
    'routed-task',
  );
  assert.equal(
    paperclipHermesAdapterConfig(contentCreator).env.AGENT_ARMY_TASK_CARD_POLICY,
    'disabled',
  );
  assert.throws(
    () => paperclipHermesAdapterConfig({
      ...contentCreator,
      interaction:{ ...contentCreator.interaction, taskCardPolicy:'all-tasks' },
    }),
    /任务卡策略不在受控白名单/,
  );
});

test('Paperclip Hermes 员工统一选择 StepFun 固定模型且不配置文本回退', () => {
  const config = paperclipHermesAdapterConfig({
    agentId:'architect',
    status:'active',
    promptRef:'agents/architect/prompts/system.md',
    acceptedTaskTypes:['governance.architecture-review'],
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes',
    runtimeCapabilities:{
      modelSelection:{ provider:'stepfun', model:'step-3.7-flash' },
      fallbackModels:[],
      paperclipToolsets:['agent-army'],
      mcpTools:['approval_list']
    }
  });
  assert.equal(config.provider, 'stepfun');
  assert.equal(config.model, 'step-3.7-flash');
  assert.deepEqual(config.extraArgs, []);
  assert.deepEqual(config.fallbackModels, []);
});

test('Paperclip Hermes 无人值守运行不开放交互追问工具集', () => {
  const manifest = readJson(new URL('../../../agents/ajun/manifest.json', import.meta.url));
  const config = paperclipHermesAdapterConfig(manifest);
  assert.equal(config.toolsets, 'agent-army');
  assert.doesNotMatch(config.toolsets, /clarify/);
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

test('Paperclip Hermes 适配器接受受控 StepFun 推理目录并拒绝能力专用模型与非固定 DeepSeek 主模型', () => {
  const manifest = {
    agentId:'architect',
    status:'active',
    promptRef:'agents/architect/prompts/system.md',
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes'
  };
  const runtimeCapabilities = { paperclipToolsets:['agent-army'], mcpTools:[] };
  const router = paperclipHermesAdapterConfig({
    ...manifest,
    runtimeCapabilities:{
      ...runtimeCapabilities,
      modelSelection:{ provider:'stepfun', model:'step-router-v1' }
    }
  });
  assert.equal(router.model, 'step-router-v1');
  assert.throws(() => paperclipHermesAdapterConfig({
    ...manifest,
    runtimeCapabilities:{
      ...runtimeCapabilities,
      modelSelection:{ provider:'stepfun', model:'stepaudio-2.5-tts' }
    }
  }), /受控推理模型目录/);
  assert.throws(() => paperclipHermesAdapterConfig({
    ...manifest,
    runtimeCapabilities:{
      ...runtimeCapabilities,
      modelSelection:{ provider:'deepseek', model:'deepseek-chat' }
    }
  }), /DeepSeek 主模型必须使用受控固定版本/);
});

test('Paperclip Hermes 适配器拒绝非 DeepSeek 或非连接故障触发的 fallback', () => {
  const baseManifest = {
    agentId:'architect',
    status:'active',
    promptRef:'agents/architect/prompts/system.md',
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes',
    runtimeCapabilities:{
      modelSelection:{ provider:'stepfun', model:'step-3.7-flash' },
      paperclipToolsets:['agent-army'],
      mcpTools:[]
    }
  };
  assert.throws(() => paperclipHermesAdapterConfig({
    ...baseManifest,
    runtimeCapabilities:{
      ...baseManifest.runtimeCapabilities,
      fallbackModels:[{ provider:'openrouter', model:'other-model', trigger:'transport_unavailable' }]
    }
  }), /fallback Provider 不在受控白名单/);
  assert.throws(() => paperclipHermesAdapterConfig({
    ...baseManifest,
    runtimeCapabilities:{
      ...baseManifest.runtimeCapabilities,
      fallbackModels:[{ provider:'deepseek', model:'deepseek-chat', trigger:'transport_unavailable' }]
    }
  }), /fallback 模型不在受控白名单/);
  assert.throws(() => paperclipHermesAdapterConfig({
    ...baseManifest,
    runtimeCapabilities:{
      ...baseManifest.runtimeCapabilities,
      fallbackModels:[{ provider:'deepseek', model:'deepseek-v4-flash', trigger:'quality_failure' }]
    }
  }), /fallback 仅允许连接不可用/);
  assert.throws(() => paperclipHermesAdapterConfig({
    ...baseManifest,
    runtimeCapabilities:{
      fallbackModels:[{ provider:'deepseek', model:'deepseek-v4-flash', trigger:'transport_unavailable' }],
      paperclipToolsets:['agent-army'],
      mcpTools:[]
    }
  }), /fallback 必须绑定主模型/);
});

test('小创与审核官的 Profile、Manifest 和 Paperclip adapter 同时开放现有 M5 专用入口', () => {
  const expected = {
    'content-creator':[
      'content.campaign-image-generation',
      'content.campaign-voice',
      'content.campaign-render',
    ],
    reviewer:[
      'content.campaign-machine-review',
      'content.campaign-publish-approval',
      'content.campaign-verify',
    ],
  };
  for (const [agentId, taskTypes] of Object.entries(expected)) {
    const manifest = readJson(
      new URL(`../../../agents/${agentId}/manifest.json`, import.meta.url),
    );
    const profile = readJson(
      new URL(`../../../integrations/hermes/profiles/${agentId}.profile.json`, import.meta.url),
    );
    const prompt = readFileSync(
      new URL(`../../../agents/${agentId}/prompts/system.md`, import.meta.url),
      'utf8',
    );
    assert.equal(assertM5HermesExecutionManifest(manifest), true);
    assert.equal(assertM5HermesExecutionPrompt(manifest, prompt), true);
    assert.ok(manifest.runtimeCapabilities.mcpTools.includes('m5_stage_execute'));
    assert.ok(profile.mcp.tools.includes('m5_stage_execute'));
    for (const taskType of taskTypes) {
      assert.ok(manifest.acceptedTaskTypes.includes(taskType));
      assert.ok(profile.mcp.scope.taskTypes.includes(taskType));
    }
    const adapter = paperclipHermesAdapterConfig(manifest);
    assert.ok(
      adapter.env.AGENT_ARMY_ALLOWED_MCP_TOOLS.split(',').includes('m5_stage_execute'),
    );
    for (const taskType of taskTypes) {
      assert.ok(
        adapter.env.AGENT_ARMY_ALLOWED_TASK_TYPES.split(',').includes(taskType),
      );
    }
  }
});

test('审核官交付复核只判断已声明标准，不把审批条件或等待复核状态当失败', () => {
  const prompt = readFileSync(
    new URL('../../../agents/reviewer/prompts/system.md', import.meta.url),
    'utf8',
  );
  assert.match(prompt, /只逐项核对指派 `context\.criteria` 和 `context\.deliveryBrief\.acceptanceCriteria`/);
  assert.match(prompt, /不得把审批审核里的预算、有效期、失败去向等额外条件新增为交付失败项/);
  assert.match(prompt, /不能作为产物不完整的证据/);
  assert.match(prompt, /不能增加指派未声明的通过条件/);
});

test('Paperclip Hermes 配置在 M5 任务类型或专用工具缺失时失败关闭', () => {
  const manifest = readJson(
    new URL('../../../agents/content-creator/manifest.json', import.meta.url),
  );
  assert.throws(
    () => paperclipHermesAdapterConfig({
      ...manifest,
      acceptedTaskTypes:manifest.acceptedTaskTypes.filter(
        (item) => item !== 'content.campaign-voice',
      ),
    }),
    /content-creator Manifest 缺少 M5 任务类型 content\.campaign-voice/,
  );
  assert.throws(
    () => paperclipHermesAdapterConfig({
      ...manifest,
      runtimeCapabilities:{
        ...manifest.runtimeCapabilities,
        mcpTools:manifest.runtimeCapabilities.mcpTools.filter(
          (item) => item !== 'm5_stage_execute',
        ),
      },
    }),
    /content-creator Manifest 缺少 M5 MCP 工具 m5_stage_execute/,
  );
  const prompt = readFileSync(
    new URL('../../../agents/content-creator/prompts/system.md', import.meta.url),
    'utf8',
  );
  assert.throws(
    () => assertM5HermesExecutionPrompt(
      manifest,
      prompt.replace('content.campaign-image-generation', 'content.campaign-image'),
    ),
    /content-creator SOUL 缺少 M5 任务说明 content\.campaign-image-generation/,
  );
});

function pathName(value) {
  return String(value).split('/').at(-2);
}

function readJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}
