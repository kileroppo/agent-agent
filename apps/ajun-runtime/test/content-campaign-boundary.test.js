import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { ContentCampaignService } from '../src/content-campaign-service.js';

test('ContentCampaignService 不引入本地状态库，活动视图始终读取 Paperclip Case 真相', async () => {
  const source = await fs.readFile(new URL('../src/content-campaign-service.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:fs|sqlite|level)/);
  assert.doesNotMatch(source, /\b(?:TaskStore|localStorage|sessionStorage|writeFile|appendFile)\b/);
  assert.doesNotMatch(source, /this\.adapter\.request/);
  assert.doesNotMatch(source, /['"`]\/api\//);

  const parentCase = {
    id:'12345678-1234-1234-1234-123456789012',
    pipelineId:'pipeline-m5',
    parentCaseId:null,
    caseKey:'m5-paperclip-truth',
    title:'M5 内容活动',
    stageKey:'topic',
    fields:{
      campaignGrant:{
        schemaVersion:'agent.army/campaign-grant/v1',
        status:'draft',
        platforms:['douyin', 'xiaohongshu'],
        accountRefs:{ douyin:'connection:dy-owner', xiaohongshu:'connection:xhs-owner' },
        startsAt:'2026-08-02T16:00:00.000Z',
        expiresAt:'2026-08-09T15:59:59.999Z',
        dailyPublishLimitPerPlatform:1,
        totalPublishLimit:14,
        allowedActions:['upload'],
        prohibitedActions:['direct_message'],
        budgetCents:625,
      },
    },
  };
  const adapter = {
    async findByMarker(type) {
      return type === 'pipeline'
        ? { id:'pipeline-m5', key:'m5-content-pipeline', projectId:'project-m5' }
        : null;
    },
    async request(method, path) {
      const stage = { key:'topic', name:'选题', kind:'work' };
      const pipeline = { id:'pipeline-m5', key:'m5-content-pipeline', projectId:'project-m5' };
      if (method === 'GET' && path === '/api/pipelines/pipeline-m5/cases') {
        return [{ case:parentCase, stage, pipeline, parentCase:null, activeWork:null, descendantActiveWorkCount:0 }];
      }
      if (method === 'GET' && path === `/api/cases/${parentCase.id}`) {
        return { case:parentCase, stage, pipeline, parentCase:null };
      }
      if (method === 'GET' && path.includes('/children/tree')) {
        return {
          case:{
            id:parentCase.id,
            caseKey:parentCase.caseKey,
            title:parentCase.title,
            terminalKind:null,
            pipeline,
            stage,
            rollup:{ total:0 },
            childGroups:[],
          },
          rollup:{ total:0 },
          childGroups:[],
          truncated:false,
          totalNodes:1,
        };
      }
      if (method === 'GET' && path.includes('/events?')) return { items:[], pagination:{} };
      if (method === 'GET' && path.endsWith('/outputs')) return [];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({ adapter, definition:{ key:'m5-content-pipeline' } });

  assert.equal((await service.list())[0].status, 'draft');
  parentCase.fields.campaignGrant.status = 'active';
  assert.equal((await service.list())[0].status, 'active');
  assert.equal((await service.get(parentCase.id)).status, 'active');
  assert.equal(Object.hasOwn(service, 'campaigns'), false);
  assert.equal(Object.hasOwn(service, 'state'), false);
});
