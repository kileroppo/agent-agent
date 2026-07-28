import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { HermesContentGrowthAdvisor } from '../src/hermes-content-growth-advisor.js';

test('Hermes 内容执行器使用隔离 Profile、写入用量并在读取后清理临时文件', async () => {
  let usagePath;
  const advisor = new HermesContentGrowthAdvisor({
    command:'/opt/hermes',
    hermesHome:'/tmp/hermes/profiles/video-content-analyst',
    run:async (command, args, options) => {
      assert.equal(command, '/opt/hermes');
      assert.equal(options.env.HERMES_HOME, '/tmp/hermes/profiles/video-content-analyst');
      usagePath = args[args.indexOf('--usage-file') + 1];
      await fs.writeFile(usagePath, JSON.stringify({
        model:'gpt-5.6-terra',
        provider:'openai-codex',
        api_calls:1,
        input_tokens:123,
        output_tokens:45,
        estimated_cost_usd:0
      }));
      return JSON.stringify({ summary:'已分析', modules:[] });
    }
  });

  const result = await advisor.analyze({
    title:'受限测试',
    transcript:'[00:00] 仅用于受限测试。',
    depth:'fast',
    evidenceMode:'formal'
  });

  assert.deepEqual(result.data, { summary:'已分析', modules:[] });
  assert.deepEqual(result.usage, {
    model:{
      provider:'openai-codex',
      model:'gpt-5.6-terra',
      inputTokens:123,
      outputTokens:45,
      apiCalls:1,
      cost:{ amount:0, currency:'USD' }
    }
  });
  await assert.rejects(() => fs.access(usagePath));
});

test('快速拆解在五分钟总预算内最多尝试两次并合并失败调用用量', async () => {
  let now = 0;
  const timeouts = [];
  let calls = 0;
  const advisor = new HermesContentGrowthAdvisor({
    hermesHome:'/tmp/hermes/profiles/video-content-analyst',
    timeoutMs:720_000,
    nowMs:() => now,
    run:async (_command, args, options) => {
      calls += 1;
      timeouts.push(options.timeoutMs);
      const usagePath = args[args.indexOf('--usage-file') + 1];
      await fs.writeFile(usagePath, JSON.stringify({
        model:'gpt-5.6-terra',
        provider:'openai-codex',
        api_calls:1,
        input_tokens:10,
        output_tokens:5,
        estimated_cost_usd:0.01
      }));
      now += 120_000;
      if (calls === 1) throw new Error('temporary failure');
      return JSON.stringify({ summary:'第二次成功', modules:[] });
    }
  });

  const result = await advisor.analyze({
    title:'受限重试测试',
    transcript:'[00:00] 只用于测试总预算。',
    depth:'fast',
    evidenceMode:'formal'
  });

  assert.equal(calls, 2);
  assert.deepEqual(timeouts, [120_000, 120_000]);
  assert.equal(result.executionBudget.attempts, 2);
  assert.equal(result.executionBudget.maxRuntimeMs, 300_000);
  assert.equal(result.usage.model.apiCalls, 2);
  assert.equal(result.usage.model.inputTokens, 20);
  assert.equal(result.usage.model.outputTokens, 10);
  assert.equal(result.usage.model.cost.amount, 0.02);
});

test('完整拆解和平台草稿都不会越过各自总预算或尝试上限', async () => {
  for (const scenario of [
    { kind:'analysis', expectedTimeout:360_000, expectedBudget:720_000 },
    { kind:'draft', expectedTimeout:150_000, expectedBudget:300_000 }
  ]) {
    let calls = 0;
    const advisor = new HermesContentGrowthAdvisor({
      hermesHome:'/tmp/hermes/profiles/content-growth',
      timeoutMs:720_000,
      run:async () => {
        calls += 1;
        throw new Error('persistent failure');
      }
    });
    const action = scenario.kind === 'analysis'
      ? advisor.analyze({ transcript:'[00:00] 测试。', depth:'full', evidenceMode:'formal' })
      : advisor.draft({ transcript:'[00:00] 测试。', platforms:['douyin'], analysis:{} });
    await assert.rejects(action, (error) => {
      assert.equal(error.executionBudget.attempts, 2);
      assert.equal(error.executionBudget.maxRuntimeMs, scenario.expectedBudget);
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(
      scenario.kind === 'analysis'
        ? Math.min(advisor.timeoutMs, 360_000)
        : Math.min(advisor.timeoutMs, 150_000),
      scenario.expectedTimeout
    );
  }
});

test('完整拆解第一次语义结构不合格时在同一预算内安全重试并聚合用量', async () => {
  let calls = 0;
  const advisor = new HermesContentGrowthAdvisor({
    hermesHome:'/tmp/hermes/profiles/video-content-analyst',
    run:async (_command, args) => {
      calls += 1;
      const usagePath = args[args.indexOf('--usage-file') + 1];
      await fs.writeFile(usagePath, JSON.stringify({
        model:'gpt-5.6-terra',
        provider:'openai-codex',
        api_calls:1,
        input_tokens:20,
        output_tokens:10,
        estimated_cost_usd:0
      }));
      return JSON.stringify(calls === 1
        ? { summary:'结构不完整', modules:[] }
        : { summary:'结构通过', modules:[{ name:'定位与受众' }] });
    }
  });

  const result = await advisor.analyze({
    title:'语义重试',
    transcript:'[00:00] 仅用于语义重试测试。',
    depth:'fast',
    evidenceMode:'formal',
    validate:(value) => value.modules?.length === 1
  });

  assert.equal(calls, 2);
  assert.equal(result.executionBudget.attempts, 2);
  assert.equal(result.usage.model.apiCalls, 2);
  assert.equal(result.usage.model.inputTokens, 40);
  assert.equal(result.usage.model.outputTokens, 20);
});

test('两次语义校验都失败时保留最后一次模型数据供受控证据修复', async () => {
  let calls = 0;
  const advisor = new HermesContentGrowthAdvisor({
    hermesHome:'/tmp/hermes/profiles/video-content-analyst',
    run:async () => JSON.stringify({ summary:`第${++calls}次结构不完整`, modules:[] })
  });

  await assert.rejects(
    () => advisor.analyze({
      title:'保留最后一次模型数据',
      transcript:'[00:00] 仅用于受控修复测试。',
      depth:'full',
      evidenceMode:'formal',
      validate:() => false
    }),
    (error) => {
      assert.equal(error.code, 'content_analysis_semantic_validation_failed');
      assert.equal(error.data.summary, '第2次结构不完整');
      assert.equal(error.executionBudget.attempts, 2);
      return true;
    }
  );
});

test('有故事板时 Hermes 只增加 vision 工具集并把真实来源与帧目录写入同一次分析', async () => {
  const advisor = new HermesContentGrowthAdvisor({
    hermesHome:'/tmp/hermes/profiles/video-content-analyst',
    run:async (_command, args) => {
      assert.equal(args[args.indexOf('--toolsets') + 1], 'vision');
      const prompt = args[args.indexOf('--oneshot') + 1];
      assert.match(prompt, /平台真实原标题/);
      assert.match(prompt, /frame-001/);
      assert.match(prompt, /storyboard-01\.jpg/);
      assert.match(prompt, /只允许调用 vision_analyze/);
      return JSON.stringify({ summary:'图文分析', modules:[], visualFindings:[] });
    }
  });
  await advisor.analyze({
    title:'平台真实原标题',
    transcript:'[00:00] 测试内容。',
    depth:'fast',
    evidenceMode:'formal',
    sourceMetadata:{ title:'平台真实原标题', platform:'bili' },
    visualEvidence:{
      frames:[{ frameId:'frame-001', timestamp:'00:00', reason:'opening_anchor' }],
      storyboards:[{ filePath:'/tmp/visual/storyboard-01.jpg' }]
    }
  });
});

test('关键帧处理时间会从同一拆解总预算中扣除', async () => {
  const timeouts = [];
  const advisor = new HermesContentGrowthAdvisor({
    hermesHome:'/tmp/hermes/profiles/video-content-analyst',
    timeoutMs:720_000,
    run:async (_command, _args, options) => {
      timeouts.push(options.timeoutMs);
      return JSON.stringify({ summary:'共享预算', modules:[] });
    }
  });
  const result = await advisor.analyze({
    title:'共享预算',
    transcript:'[00:00] 测试。',
    depth:'fast',
    evidenceMode:'formal',
    priorRuntimeMs:250_000
  });
  assert.equal(result.executionBudget.maxRuntimeMs, 50_000);
  assert.deepEqual(timeouts, [50_000]);
});
