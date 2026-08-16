import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchBoomSignal, normalizeBoomSignal } from '../../../integrations/boom-monitor/ajun-intake.ts';
import { CrossAgentMissionService } from '../src/cross-agent-mission-service.ts';

const signal = {
  workId:'work-1',
  title:'测试视频',
  platform:'douyin',
  sourceUrl:'https://example.com/video/1',
  sourceRef:'https://example.com/video/1',
  grade:'T3',
  tier:'mid',
  rValue:8.6,
  mValue:0.12,
  observedAt:'2026-08-01T00:00:00Z',
  observedMetrics:{ likes:12_000, favorites:300, plays:500_000, followers:100_000 },
  baseline:{ metricMedian:1_395, sampleCount:20, followerSnapshot:100_000, frozenAt:'2026-08-01T00:00:00Z' },
};

test('T3 爆款信号映射为小D到小拆的同一军团任务', async () => {
  let received;
  const result = await dispatchBoomSignal(signal, {
    missions:{
      async createBusinessMission(input) {
        received = input;
        return { mission:{ taskId:'mission-123' }, children:[] };
      }
    }
  });
  assert.equal(result.mission.taskId, 'mission-123');
  assert.equal(received.idempotencyKey, 'boom-monitor:douyin:work-1');
  assert.equal(received.items.length, 2);
  assert.equal(received.items[0].agentId, 'xiaod');
  assert.equal(received.items[1].agentId, 'video-content-analyst');
  assert.deepEqual(received.items[1].dependsOn, ['acquire-transcript']);
  assert.equal(received.items[1].depth, 'full');
  assert.equal(received.items[1].context.boomSignal.rValue, 8.6);
  assert.doesNotMatch(received.items.map((item) => item.description).join('\n'), /外发|发布|删除|付款|付费|扩权|敏感/);
});

test('没有来源链接时停止派发', () => {
  assert.throws(() => normalizeBoomSignal({ ...signal, sourceUrl:'' }), /缺少可供小D读取/);
});

test('军团分派保留爆款信号到小拆子任务上下文', async () => {
  const created = [];
  const tasks = {
    async create(input) {
      created.push(input);
      if (input.taskType === 'army.cross-agent-mission') {
        return {
          taskId:'mission-context',
          taskType:input.taskType,
          idempotencyKey:input.idempotencyKey,
          status:'running',
          source:input.source,
          requester:input.requester,
          artifactRefs:[{
            type:'cross_agent_mission_plan',
            data:{ kind:'business', safeOnly:true, summary:input.title, subtasks:input.context.businessMissionItems }
          }]
        };
      }
      return { taskId:`child-${created.length}`, taskType:input.taskType, assigneeAgentId:input.agentId, idempotencyKey:input.idempotencyKey, status:'succeeded', artifactRefs:[] };
    }
  };
  const store = {
    async list() { return []; },
    async updateTask(_id, patch) { return { ...created[0], ...patch }; }
  };
  const missions = new CrossAgentMissionService({ tasks, store, governance:{} });
  await dispatchBoomSignal(signal, { missions });
  assert.equal(created[0].context.missionSafeOnly, true);
  const analysis = created.find((item) => item.taskType === 'content.video-benchmark-analysis');
  assert.equal(analysis.input, undefined);
  assert.equal(analysis.context.boomSignal.workId, 'work-1');
  assert.equal(analysis.context.boomSignal.grade, 'T3');
});

test('多人任务安全边界理解并列否定但仍识别真实高风险动作', async () => {
  const created = [];
  const tasks = {
    async create(input) {
      created.push(input);
      return { taskId:`mission-${created.length}`, status:'running', artifactRefs:[] };
    },
  };
  const missions = new CrossAgentMissionService({ tasks, store:{ async list(){ return []; } }, governance:{} });
  await missions.createBusinessMission({
    title:'只读内容拆解',
    items:[{ key:'read', title:'读取公开素材', description:'只取证和分析，不外发或发布。', taskType:'media.transcribe-and-refine', agentId:'xiaod' }],
  });
  await missions.createBusinessMission({
    title:'对外发布内容',
    items:[{ key:'publish', title:'公开发布', description:'把内容发布到平台。', taskType:'content.platform-publish', agentId:'publisher' }],
  });
  assert.equal(created[0].context.missionSafeOnly, true);
  assert.equal(created[1].context.missionSafeOnly, false);
});
