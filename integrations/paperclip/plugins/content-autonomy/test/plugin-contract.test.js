import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pluginManifestV1Schema } from '@paperclipai/shared';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.js';
import plugin from '../src/worker.js';
import { paidActionStateKey } from '../src/stepfun-tools.js';

const agentId = '11111111-1111-4111-8111-111111111111';
const run = {
  agentId,
  runId:'22222222-2222-4222-8222-222222222222',
  companyId:'33333333-3333-4333-8333-333333333333',
  projectId:'44444444-4444-4444-8444-444444444444'
};
const costRatesCents = {
  visionInputPerMillionTokens:100,
  visionOutputPerMillionTokens:200,
  imagePerGeneration:3,
  ttsPerThousandCharacters:4
};
const stepfunSecretRef = {
  type:'secret_ref',
  secretId:'55555555-5555-4555-8555-555555555555',
  version:'latest'
};
const budgetTicketKeys = crypto.generateKeyPairSync('ed25519');
const budgetTicketPublicKey = budgetTicketKeys.publicKey.export({ type:'spki', format:'pem' });
const roleBindings = {
  ajun:agentId,
  'intel-researcher':'66666666-6666-4666-8666-666666666666',
  xiaod:'77777777-7777-4777-8777-777777777777',
  'video-content-analyst':'88888888-8888-4888-8888-888888888888',
  'content-creator':'99999999-9999-4999-8999-999999999999',
  reviewer:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operator:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'office-assistant':'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const exactGrants = {
  [roleBindings.ajun]:['campaign-preflight'],
  [roleBindings['intel-researcher']]:[],
  [roleBindings.xiaod]:['stepfun-vision', 'media-probe', 'media-validate'],
  [roleBindings['video-content-analyst']]:['stepfun-vision', 'media-probe', 'media-validate'],
  [roleBindings['content-creator']]:[
    'stepfun-image-generate',
    'stepfun-image-edit',
    'stepfun-tts',
    'media-probe',
    'media-validate',
    'media-finalize',
    'remotion-props-write',
    'remotion-render',
    'subtitle-layout-validate',
    'artifact-lineage-validate',
  ],
  [roleBindings.reviewer]:[
    'campaign-preflight',
    'media-probe',
    'media-validate',
    'subtitle-layout-validate',
    'artifact-package-write',
    'artifact-lineage-validate',
    'publish-preflight',
  ],
  [roleBindings.operator]:[],
  [roleBindings['office-assistant']]:[],
};

function validConfig(overrides = {}) {
  return {
    stepfunSecretRef,
    stepfunBaseUrl:'https://api.stepfun.com/v1',
    stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
    budgetTicketPublicKey,
    officialTtsVoices:['official-test-voice'],
    costRatesCents,
    agentRoleBindings:structuredClone(roleBindings),
    agentToolGrants:structuredClone(exactGrants),
    ...overrides,
  };
}

function campaign() {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    themeScope:'AI Agent 实战',
    platforms:['douyin', 'xiaohongshu'],
    dailyPublishLimitPerPlatform:1,
    totalPublishLimit:14,
    budgetCents:500,
    startsAt:new Date().toISOString(),
    expiresAt:new Date(Date.now() + 7 * 86400000).toISOString(),
    accountRefs:{ douyin:'account:douyin:test', xiaohongshu:'account:xhs:test' },
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:['direct_message', 'comment', 'follow', 'paid_promotion', 'payment', 'account_settings', 'delete_history'],
    receipts:[]
  };
}

async function providerVerificationFixture() {
  const harness = createTestHarness({
    manifest,
    config:validConfig(),
  });
  await plugin.definition.setup(harness.ctx);
  const actionId = 'action:tts:verified';
  const costEventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const costEvent = {
    provider:'stepfun',
    biller:'stepfun',
    billingType:'metered_api',
    billingCode:'m5:tts',
    model:'stepaudio-2.5-tts',
    agentId:run.agentId,
    projectId:run.projectId,
    heartbeatRunId:run.runId,
    costCents:4,
  };
  const state = {
    actionId,
    operation:'tts',
    state:'confirmed',
    agentId:run.agentId,
    companyId:run.companyId,
    projectId:run.projectId,
    runId:run.runId,
    costEventId,
    resultData:{
      actionId,
      operation:'tts',
      model:'stepaudio-2.5-tts',
      callRecord:{
        actionId,
        operation:'tts',
        provider:'stepfun',
        model:'stepaudio-2.5-tts',
        promptChecksum:`sha256:${'a'.repeat(64)}`,
        costEvent,
      },
      costCommit:{
        status:'confirmed',
        costEventId,
        costEvent:{ ...costEvent },
      },
    },
  };
  await harness.ctx.state.set(paidActionStateKey(run.projectId, actionId), state);
  const params = {
    actionId,
    costEventId,
    operation:'tts',
    runContext:{ ...run },
  };
  return {
    actionId,
    costEventId,
    state,
    params,
    verify:() => harness.performAction(
      'provider-action-verify',
      params,
      {
        companyId:run.companyId,
        actor:{
          type:'user',
          userId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          companyId:run.companyId,
        },
      },
    ),
  };
}

test('插件 manifest 通过当前 Paperclip 官方 schema', () => {
  const result = pluginManifestV1Schema.safeParse(manifest);
  assert.equal(result.success, true, result.error?.message);
  assert.equal(manifest.instanceConfigSchema.properties.stepfunSecretRef.type, 'object');
  assert.equal(manifest.instanceConfigSchema.properties.stepfunSecretRef.format, 'secret-ref');
  assert.deepEqual(
    manifest.instanceConfigSchema.properties.stepfunSecretRef.required,
    ['type', 'secretId']
  );
  assert.ok(manifest.tools.some((item) => item.name === 'stepfun-image-edit'));
  assert.ok(manifest.tools.some((item) => item.name === 'remotion-render'));
  assert.ok(manifest.tools.some((item) => item.name === 'subtitle-layout-validate'));
  assert.ok(manifest.tools.some((item) => item.name === 'artifact-package-write'));
  for (const boardOnlyAction of [
    'provider-action-verify',
    'cost-event-claim',
    'cost-event-confirm',
  ]) {
    assert.equal(manifest.tools.some((item) => item.name === boardOnlyAction), false);
    assert.equal(
      Object.values(exactGrants).some((tools) => tools.includes(boardOnlyAction)),
      false,
    );
  }
});

test('Paperclip官方测试宿主可加载插件并执行被授权工具', async () => {
  const harness = createTestHarness({
    manifest,
    config:{
      ...validConfig(),
    }
  });
  await plugin.definition.setup(harness.ctx);
  const result = await harness.executeTool('campaign-preflight', { campaign:campaign() }, run);
  assert.equal(result.data.passed, true);
  assert.equal(harness.activity.length, 1);
  assert.equal(harness.activity[0].metadata.toolName, 'campaign-preflight');
});

test('Paperclip工具已注册也不能绕过岗位白名单', async () => {
  const harness = createTestHarness({
    manifest,
    config:{
      ...validConfig(),
      agentToolGrants:{ ...structuredClone(exactGrants), [agentId]:[] },
    }
  });
  await plugin.definition.setup(harness.ctx);
  const result = await harness.executeTool('campaign-preflight', { campaign:campaign() }, run);
  assert.match(result.error, /agent_tool_(?:denied|policy_invalid)/);
});

test('worker内付费工具缺少可信签名预算票据时失败关闭', async () => {
  const harness = createTestHarness({
    manifest,
    config:validConfig(),
  });
  await plugin.definition.setup(harness.ctx);
  const result = await harness.executeTool('stepfun-image-generate', {
    actionId:'action:worker:budget:missing',
    prompt:'不应外发',
    outputPath:'generated.png',
  }, {
    ...run,
    agentId:roleBindings['content-creator'],
  });
  assert.match(result.error, /paid_budget_(?:check_failed|ticket_invalid)/);
});

test('worker只接受注入检查器对当前公司、岗位、Project和Run的预算裁决', async () => {
  const harness = createTestHarness({
    manifest,
    config:validConfig(),
  });
  let checked = null;
  harness.ctx.paperclipBudgets = {
    reservePaidToolBudget:async (request) => {
      checked = request;
      return { ...request, allowed:false };
    },
  };
  await plugin.definition.setup(harness.ctx);
  const trustedRun = {
    ...run,
    agentId:roleBindings['content-creator'],
  };
  const result = await harness.executeTool('stepfun-image-generate', {
    actionId:'action:worker:budget:denied',
    prompt:'不应外发',
    outputPath:'generated.png',
  }, trustedRun);
  assert.match(result.error, /paid_budget_insufficient/);
  assert.deepEqual({
    companyId:checked.companyId,
    agentId:checked.agentId,
    projectId:checked.projectId,
    runId:checked.runId,
  }, trustedRun);
  assert.ok(checked.maximumCostCents > 0);
});

test('图片编辑、Remotion和字幕门禁已注册且仍默认拒绝', async () => {
  const harness = createTestHarness({
    manifest,
    config:{
      ...validConfig(),
      agentToolGrants:{ ...structuredClone(exactGrants), [agentId]:[] },
    }
  });
  await plugin.definition.setup(harness.ctx);
  for (const [toolName, params] of [
    ['stepfun-image-edit', {
      actionId:'action:image-edit:contract',
      inputPath:'input.png',
      prompt:'编辑',
      outputPath:'output.png'
    }],
    ['remotion-render', {
      composition:'M5Master',
      propsPath:'master.props.json',
      outputPath:'master.mp4'
    }],
    ['remotion-props-write', {
      composition:'M5Master',
      outputPath:'master.props.json',
      props:{}
    }],
    ['subtitle-layout-validate', { propsPath:'master.props.json' }]
  ]) {
    const result = await harness.executeTool(toolName, params, run);
    assert.match(result.error, /agent_tool_(?:denied|policy_invalid)/);
  }
});

test('费用状态动作拒绝Agent身份，只接受Paperclip已认证负责人执行面', async () => {
  const harness = createTestHarness({
    manifest,
    config:{
      ...validConfig(),
      agentToolGrants:{
        ...structuredClone(exactGrants),
        [agentId]:['stepfun-image-generate'],
      },
    }
  });
  await plugin.definition.setup(harness.ctx);
  await assert.rejects(
    harness.performAction('cost-event-claim', {
      actionId:'action:image:cover:1',
      runContext:run
    }, {
      companyId:run.companyId,
      actor:{ type:'agent', agentId:run.agentId, runId:run.runId, companyId:run.companyId }
    }),
    /费用状态只能由 Paperclip 已认证的负责人执行面变更/
  );
  await assert.rejects(
    harness.performAction('provider-action-verify', {
      actionId:'action:image:cover:1',
      costEventId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      operation:'image_generate',
      runContext:run,
    }, {
      companyId:run.companyId,
      actor:{ type:'agent', agentId:run.agentId, runId:run.runId, companyId:run.companyId }
    }),
    /费用状态只能由 Paperclip 已认证的负责人执行面变更/
  );
  await assert.rejects(
    harness.performAction('provider-action-verify', {
      actionId:'action:image:cover:1',
      costEventId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      operation:'image_generate',
      runContext:run,
    }, {
      companyId:run.companyId,
      actor:{ type:'system', companyId:run.companyId }
    }),
    /费用状态只能由 Paperclip 已认证的负责人执行面变更/
  );
});

test('Provider action 只读核验只接受原Run的confirmed插件状态并返回脱敏字段', async () => {
  const fixture = await providerVerificationFixture();
  const result = await fixture.verify();
  assert.deepEqual(result.data, {
    confirmed:true,
    actionId:fixture.actionId,
    costEventId:fixture.costEventId,
    operation:'tts',
    provider:'stepfun',
    model:'stepaudio-2.5-tts',
    projectId:run.projectId,
    heartbeatRunId:run.runId,
    costCents:4,
  });
  assert.deepEqual(Object.keys(result.data).sort(), [
    'actionId',
    'confirmed',
    'costCents',
    'costEventId',
    'heartbeatRunId',
    'model',
    'operation',
    'projectId',
    'provider',
  ]);
});

test('Provider action 只读核验拒绝伪造状态、身份、费用、模型和额外输入', async (t) => {
  for (const variant of [
    'state',
    'state-agent',
    'state-company',
    'model',
    'cost',
    'cost-event',
    'run',
    'call-agent',
    'commit-agent',
    'project',
    'company',
    'action',
    'extra',
  ]) {
    await t.test(variant, async () => {
      const fixture = await providerVerificationFixture();
      if (variant === 'state') {
        fixture.state.state = 'cost_event_pending';
      } else if (variant === 'state-agent') {
        fixture.state.agentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'state-company') {
        fixture.state.companyId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'model') {
        fixture.state.resultData.model = 'forged-model';
      } else if (variant === 'cost') {
        fixture.state.resultData.costCommit.costEvent.costCents = 999;
      } else if (variant === 'cost-event') {
        fixture.params.costEventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'run') {
        fixture.params.runContext.runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'call-agent') {
        fixture.state.resultData.callRecord.costEvent.agentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'commit-agent') {
        fixture.state.resultData.costCommit.costEvent.agentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'project') {
        fixture.params.runContext.projectId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'company') {
        fixture.params.runContext.companyId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      } else if (variant === 'action') {
        fixture.params.actionId = 'action:tts:forged';
      } else {
        fixture.params.unexpected = 'denied';
      }
      await assert.rejects(
        fixture.verify,
        /Provider action|StepFun tts action|费用状态/,
      );
    });
  }
});

test('配置只接受Paperclip对象Secret引用并拒绝旧字符串UUID', async () => {
  const base = {
    ...validConfig(),
  };
  const accepted = await plugin.definition.onValidateConfig({
    ...base,
    stepfunSecretRef
  });
  assert.deepEqual(accepted, { ok:true, errors:[] });

  for (const rejectedRef of [
    stepfunSecretRef.secretId,
    'STEPFUN_API_KEY_REF',
    { type:'secret_ref', secretId:'not-a-uuid' }
  ]) {
    const rejected = await plugin.definition.onValidateConfig({
      ...base,
      stepfunSecretRef:rejectedRef
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /secret_ref 对象/);
    assert.doesNotMatch(rejected.errors.join('\n'), /55555555|STEPFUN_API_KEY_REF|not-a-uuid/);
  }
});

test('全部零费率配置在任何付费调用前被拒绝', async () => {
  const validation = await plugin.definition.onValidateConfig({
    ...validConfig(),
    costRatesCents:{
      visionInputPerMillionTokens:0,
      visionOutputPerMillionTokens:0,
      imagePerGeneration:0,
      ttsPerThousandCharacters:0
    },
  });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /不能全部为零/);
});

test('StepFun地址白名单拒绝凭据、查询、非官方路径和端口', async () => {
  for (const overrides of [
    { stepfunBaseUrl:'https://user:pass@api.stepfun.com/v1' },
    { stepfunBaseUrl:'https://api.stepfun.com/v1?redirect=1' },
    { stepfunBaseUrl:'https://api.stepfun.com/other' },
    { stepfunMediaBaseUrl:'https://api.stepfun.com:444/step_plan/v1' },
    { stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1#fragment' },
  ]) {
    const validation = await plugin.definition.onValidateConfig(validConfig(overrides));
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join('\n'), /Base URL/);
  }
});

test('worker配置校验拒绝额外工具、未知工具和额外Agent UUID', async (t) => {
  for (const [label, mutate] of [
    ['A君额外工具', (config) => config.agentToolGrants[agentId].push('publish-preflight')],
    ['未知工具', (config) => config.agentToolGrants[roleBindings['content-creator']].push('shell-exec')],
    ['额外Agent UUID', (config) => {
      config.agentToolGrants['dddddddd-dddd-4ddd-8ddd-dddddddddddd'] = [];
    }],
  ]) {
    await t.test(label, async () => {
      const config = validConfig();
      mutate(config);
      const validation = await plugin.definition.onValidateConfig(config);
      assert.equal(validation.ok, false);
      assert.match(validation.errors.join('\n'), /最小岗位bundle|精确/);
    });
  }
});
