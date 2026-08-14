import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DOUYIN_OFFICIAL_ENDPOINTS,
  DouyinOfficialApiConnector,
  createPublisherRuntime,
  publishIdempotencyKey,
} from '../src/index.ts';
import {
  actualCost,
  deterministicCostReporter,
  recordingCostRecorder,
} from '../test-support/cost-reporter.js';
import {
  recordingAccountIdentityVerifier,
} from '../test-support/account-identity-verifier.js';

const ACCESS_TOKEN = 'act.secret-token-must-not-persist';
const OPEN_ID = 'open-id-must-not-persist';
const ACCOUNT_REF = 'account:douyin:owner';
const ITEM_ID = '@encrypted-item-id';
const VIDEO_ID = '7227815678634470001';

function publishRequest(overrides = {}) {
  return {
    campaignId:'campaign-1',
    platform:'douyin',
    accountRef:ACCOUNT_REF,
    idempotencyKey:'campaign-1:douyin:content-v1:2026-07-30',
    title:'Agent实战',
    body:'一次真实执行闭环',
    tags:['AI Agent'],
    verifiedMedia:{
      relativePath:'douyin.mp4',
      checksum:`sha256:${'a'.repeat(64)}`,
      bytes:1024,
      immutableLease:true,
    },
    mediaLease:{
      createReadStream:() => ({ kind:'test-readable' }),
    },
    ...overrides,
  };
}

function successfulHttp(calls) {
  return async (request) => {
    calls.push(request);
    if (request.operation === 'upload_video') {
      return {
        status:200,
        actualCost:actualCost(request.operation),
        body:{
          data:{ error_code:0, video:{ video_id:VIDEO_ID } },
          extra:{ error_code:0 },
        },
      };
    }
    if (request.operation === 'create_video') {
      return {
        status:200,
        actualCost:actualCost(request.operation),
        body:{
          data:{ error_code:0, item_id:ITEM_ID, video_id:VIDEO_ID },
          extra:{ error_code:0 },
        },
      };
    }
    if (request.operation === 'query_video_basic_info') {
      return {
        status:200,
        actualCost:actualCost(request.operation),
        body:{
          data:{
            error_code:0,
            list:[{
              item_id:ITEM_ID,
              video_id:VIDEO_ID,
              video_status:5,
              create_time:1785379200,
            }],
          },
          extra:{ error_code:0 },
        },
      };
    }
    if (request.operation === 'read_video_metrics') {
      return {
        status:200,
        actualCost:actualCost(request.operation),
        body:{
          data:{
            error_code:0,
            list:[{
              item_id:ITEM_ID,
              statistics:{
                play_count:321,
                digg_count:27,
                comment_count:4,
                share_count:3,
                download_count:2,
                forward_count:1,
              },
            }],
          },
          extra:{ error_code:0 },
        },
      };
    }
    throw new Error(`unexpected operation: ${request.operation}`);
  };
}

function officialConnector(options = {}) {
  return new DouyinOfficialApiConnector({
    costRecorder:recordingCostRecorder(),
    accountIdentityVerifier:recordingAccountIdentityVerifier(),
    ...options,
  });
}

function credentialResolver(calls = []) {
  return async (request) => {
    calls.push(structuredClone(request));
    return { accessToken:ACCESS_TOKEN, openId:OPEN_ID };
  };
}

test('抖音官方连接器默认关闭且关闭时不读取凭据、不调用HTTP', async () => {
  let credentialCalls = 0;
  let httpCalls = 0;
  const connector = officialConnector({
    credentialResolver:async () => {
      credentialCalls += 1;
      return { accessToken:ACCESS_TOKEN, openId:OPEN_ID };
    },
    httpRequest:async () => {
      httpCalls += 1;
      return { status:500, body:{} };
    },
  });

  await assert.rejects(connector.publish(publishRequest()), { code:'real_connector_disabled' });
  assert.equal(credentialCalls, 0);
  assert.equal(httpCalls, 0);
});

test('显式启用后按上传、创建、查询顺序执行官方最小发布契约', async () => {
  const httpCalls = [];
  const credentialCalls = [];
  const accountIdentityVerifier = recordingAccountIdentityVerifier();
  const connector = officialConnector({
    enabled:true,
    credentialResolver:credentialResolver(credentialCalls),
    accountIdentityVerifier,
    httpRequest:successfulHttp(httpCalls),
    clock:() => new Date('2026-07-30T08:00:00.000Z'),
  });

  const result = await connector.publish(publishRequest());

  assert.deepEqual(httpCalls.map((call) => call.operation), [
    'upload_video',
    'create_video',
    'query_video_basic_info',
  ]);
  assert.equal(
    httpCalls[0].url,
    `${DOUYIN_OFFICIAL_ENDPOINTS.upload}?open_id=${encodeURIComponent(OPEN_ID)}`,
  );
  assert.equal(httpCalls[0].method, 'POST');
  assert.equal(httpCalls[0].headers['access-token'], ACCESS_TOKEN);
  assert.equal(httpCalls[0].body.kind, 'multipart');
  assert.equal(httpCalls[0].body.files[0].fieldName, 'video');
  assert.equal(httpCalls[0].body.files[0].filename, 'douyin.mp4');
  assert.equal(httpCalls[0].body.files[0].bytes, 1024);
  assert.deepEqual(httpCalls[0].body.files[0].createReadStream(), { kind:'test-readable' });
  assert.equal(httpCalls[0].idempotencyKey, publishRequest().idempotencyKey);

  assert.equal(
    httpCalls[1].url,
    `${DOUYIN_OFFICIAL_ENDPOINTS.create}?open_id=${encodeURIComponent(OPEN_ID)}`,
  );
  assert.equal(httpCalls[1].body.video_id, VIDEO_ID);
  assert.match(httpCalls[1].body.text, /Agent实战/);
  assert.match(httpCalls[1].body.text, /#AI Agent/);
  assert.deepEqual(httpCalls[2].body, { video_ids:[VIDEO_ID] });

  assert.deepEqual(credentialCalls, [{
    accountRef:ACCOUNT_REF,
    platform:'douyin',
    purpose:'publish',
  }]);
  assert.deepEqual(accountIdentityVerifier.calls, [{
    platform:'douyin',
    accountRef:ACCOUNT_REF,
    providerIdentity:{
      kind:'open_id_sha256',
      value:`sha256:${crypto.createHash('sha256').update(OPEN_ID).digest('hex')}`,
    },
  }]);
  assert.equal(JSON.stringify(accountIdentityVerifier.calls).includes(OPEN_ID), false);
  assert.equal(result.state, 'published');
  assert.equal(result.externalContentId, ITEM_ID);
  assert.equal(result.accountRef, ACCOUNT_REF);
  assert.equal(result.evidence, `https://www.douyin.com/video/${VIDEO_ID}`);
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(result).includes(OPEN_ID), false);
});

test('创建请求发出后遇到传输错误不重试并标记结果不确定', async () => {
  const httpCalls = [];
  const connector = officialConnector({
    enabled:true,
    credentialResolver:credentialResolver(),
    httpRequest:async (request) => {
      httpCalls.push(request.operation);
      if (request.operation === 'upload_video') {
        return {
          status:200,
          actualCost:actualCost(request.operation),
          body:{ data:{ error_code:0, video:{ video_id:VIDEO_ID } } },
        };
      }
      const error = new Error('socket closed');
      error.code = 'ECONNRESET';
      throw error;
    },
  });

  await assert.rejects(
    connector.publish(publishRequest()),
    { code:'douyin_create_result_ambiguous' },
  );
  assert.deepEqual(httpCalls, ['upload_video', 'create_video']);
});

test('请求中的accountRef不能自证；身份错配或核验不可用时0 HTTP且不暴露open_id', async () => {
  for (const verifier of [
    recordingAccountIdentityVerifier({ verified:false }),
    recordingAccountIdentityVerifier({ error:new Error('paperclip unavailable') }),
  ]) {
    let httpCalls = 0;
    const connector = officialConnector({
      enabled:true,
      accountIdentityVerifier:verifier,
      credentialResolver:credentialResolver(),
      httpRequest:async () => {
        httpCalls += 1;
        throw new Error('身份核验前不应调用HTTP');
      },
    });
    await assert.rejects(
      connector.publish(publishRequest({ accountRef:'account:douyin:caller-claimed' })),
      { code:'account_mismatch' },
    );
    assert.equal(httpCalls, 0);
    assert.equal(verifier.calls.length, 1);
    assert.equal(verifier.calls[0].accountRef, 'account:douyin:caller-claimed');
    assert.equal(verifier.calls[0].providerIdentity.kind, 'open_id_sha256');
    assert.equal(JSON.stringify(verifier.calls).includes(OPEN_ID), false);
  }
});

test('创建成功但查询不到相同视频时结果不确定且不再次创建', async () => {
  const httpCalls = [];
  const connector = officialConnector({
    enabled:true,
    credentialResolver:credentialResolver(),
    httpRequest:async (request) => {
      httpCalls.push(request.operation);
      if (request.operation === 'upload_video') {
        return {
          status:200,
          actualCost:actualCost(request.operation),
          body:{ data:{ error_code:0, video:{ video_id:VIDEO_ID } } },
        };
      }
      if (request.operation === 'create_video') {
        return {
          status:200,
          actualCost:actualCost(request.operation),
          body:{ data:{ error_code:0, item_id:ITEM_ID, video_id:VIDEO_ID } },
        };
      }
      return {
        status:200,
        actualCost:actualCost(request.operation),
        body:{ data:{ error_code:0, list:[] } },
      };
    },
  });

  await assert.rejects(
    connector.publish(publishRequest()),
    { code:'douyin_publish_reconciliation_required' },
  );
  assert.deepEqual(httpCalls, [
    'upload_video',
    'create_video',
    'query_video_basic_info',
  ]);
});

test('失效凭据映射为身份验证停止，不回显Token', async () => {
  const connector = officialConnector({
    enabled:true,
    credentialResolver:credentialResolver(),
    httpRequest:async () => ({
      status:200,
      actualCost:actualCost('upload_video'),
      body:{
        data:{ error_code:28001003, description:`bad ${ACCESS_TOKEN}` },
        extra:{ error_code:28001003, description:`bad ${ACCESS_TOKEN}` },
      },
    }),
  });

  const result = await connector.publish(publishRequest());

  assert.deepEqual(result, {
    state:'stopped',
    stopReason:'identity_verification',
    evidence:'https://open.douyin.com/platform/resource/docs/openapi',
  });
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
});

test('指标查询只读取本人回执并归一化官方统计字段', async () => {
  const httpCalls = [];
  const credentialCalls = [];
  const connector = officialConnector({
    enabled:true,
    credentialResolver:credentialResolver(credentialCalls),
    httpRequest:successfulHttp(httpCalls),
  });
  const receipt = {
    campaignId:'campaign-1',
    platform:'douyin',
    accountRef:ACCOUNT_REF,
    externalContentId:ITEM_ID,
    receiptId:'receipt-1',
  };

  const metrics = await connector.readOwnMetrics(receipt, '2026-07-30T10:00:00.000Z');

  assert.deepEqual(credentialCalls, [{
    accountRef:ACCOUNT_REF,
    platform:'douyin',
    purpose:'read_own_metrics',
  }]);
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].operation, 'read_video_metrics');
  assert.equal(httpCalls[0].url, DOUYIN_OFFICIAL_ENDPOINTS.metrics);
  assert.deepEqual(httpCalls[0].body, { item_ids:[ITEM_ID] });
  assert.deepEqual(metrics, {
    views:321,
    likes:27,
    comments:4,
    shares:3,
    downloads:2,
    forwards:1,
  });
  assert.equal(JSON.stringify(metrics).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(metrics).includes(OPEN_ID), false);
});

test('指标官方响应的身份验证和风控停止传播规范 hard-stop 语义', async () => {
  for (const scenario of [
    { errorCode:28001003, stopReason:'identity_verification' },
    { errorCode:28001014, stopReason:'risk_control' },
  ]) {
    let httpCalls = 0;
    const connector = officialConnector({
      enabled:true,
      credentialResolver:credentialResolver(),
      httpRequest:async (request) => {
        httpCalls += 1;
        return {
          status:200,
          actualCost:actualCost(request.operation),
          body:{
            data:{ error_code:scenario.errorCode },
            extra:{ error_code:scenario.errorCode },
          },
        };
      },
    });
    const receipt = {
      campaignId:'campaign-1',
      platform:'douyin',
      accountRef:ACCOUNT_REF,
      externalContentId:ITEM_ID,
      receiptId:'receipt-1',
    };

    await assert.rejects(
      connector.readOwnMetrics(receipt),
      (error) => (
        error.code === `douyin_metric_${scenario.stopReason}`
        && error.hardStop === true
        && error.stopReason === scenario.stopReason
      ),
      scenario.stopReason,
    );
    assert.equal(httpCalls, 1, scenario.stopReason);
  }
});

test('指标风控与费用上报双故障时仍传播 hard-stop 并保留费用错误代码', async () => {
  const connector = officialConnector({
    enabled:true,
    credentialResolver:credentialResolver(),
    costRecorder:{
      async recordOfficialTransportAttempt() {
        throw Object.assign(new Error('cost reporter unavailable'), {
          code:'cost_reporting_failed',
        });
      },
    },
    httpRequest:async (request) => ({
      status:200,
      actualCost:actualCost(request.operation),
      body:{
        data:{ error_code:28001014 },
        extra:{ error_code:28001014 },
      },
    }),
  });

  await assert.rejects(
    connector.readOwnMetrics({
      campaignId:'campaign-1',
      platform:'douyin',
      accountRef:ACCOUNT_REF,
      externalContentId:ITEM_ID,
      receiptId:'receipt-1',
    }),
    (error) => (
      error.code === 'douyin_metric_risk_control'
      && error.hardStop === true
      && error.stopReason === 'risk_control'
      && error.costReportingErrorCode === 'cost_reporting_failed'
    ),
  );
});

test('拒绝可变媒体、超限文件和非抖音请求，均不接触凭据或HTTP', async () => {
  let calls = 0;
  const connector = officialConnector({
    enabled:true,
    maxUploadBytes:2048,
    credentialResolver:async () => {
      calls += 1;
      return { accessToken:ACCESS_TOKEN, openId:OPEN_ID };
    },
    httpRequest:async () => {
      calls += 1;
      return { status:500, body:{} };
    },
  });

  await assert.rejects(
    connector.publish(publishRequest({
      verifiedMedia:{ ...publishRequest().verifiedMedia, immutableLease:false },
    })),
    { code:'immutable_media_lease_required' },
  );
  await assert.rejects(
    connector.publish(publishRequest({
      verifiedMedia:{ ...publishRequest().verifiedMedia, bytes:2049 },
    })),
    { code:'douyin_upload_too_large' },
  );
  await assert.rejects(
    connector.publish(publishRequest({ platform:'xiaohongshu' })),
    { code:'douyin_platform_mismatch' },
  );
  assert.equal(calls, 0);
});

test('官方文案1000字边界可通过，1001字在凭据和HTTP前拒绝', async () => {
  const acceptedHttpCalls = [];
  const accepted = officialConnector({
    enabled:true,
    credentialResolver:credentialResolver(),
    httpRequest:successfulHttp(acceptedHttpCalls),
  });
  await accepted.publish(publishRequest({
    title:'甲'.repeat(1000),
    body:'',
    tags:[],
  }));
  assert.equal(acceptedHttpCalls[1].body.text.length, 1000);

  let rejectedCalls = 0;
  const rejected = officialConnector({
    enabled:true,
    credentialResolver:async () => {
      rejectedCalls += 1;
      return { accessToken:ACCESS_TOKEN, openId:OPEN_ID };
    },
    httpRequest:async () => {
      rejectedCalls += 1;
      return { status:500, body:{} };
    },
  });
  await assert.rejects(rejected.publish(publishRequest({
    title:'甲'.repeat(1001),
    body:'',
    tags:[],
  })), { code:'douyin_caption_too_long' });
  assert.equal(rejectedCalls, 0);
});

test('接入生产 Runtime 后创建结果不确定会暂停Paperclip且重放不再次外发', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-douyin-runtime-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const media = Buffer.from('douyin-runtime-controlled-media');
  await fs.writeFile(path.join(root, 'douyin.mp4'), media);
  const checksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  const httpCalls = [];
  const pauseCalls = [];
  const canonicalGrant = {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{ douyin:ACCOUNT_REF, xiaohongshu:'account:xhs:owner' },
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:['direct_message', 'comment', 'follow', 'paid_promotion', 'payment', 'account_settings', 'delete_history'],
    budgetCents:625,
  };
  const runtime = createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:{
      assertPublishAllowed:async ({ campaignId }) => ({
        campaignId,
        grantStatus:'active',
        currentStage:'campaign_active',
        canonicalGrant,
      }),
      pauseCampaignAndDisableCron:async (input) => {
        pauseCalls.push(structuredClone(input));
        return {
          campaignId:input.campaignId,
          grantStatus:'paused',
          cronStatus:'disabled',
          controlEventId:`pause-${pauseCalls.length}`,
        };
      },
    },
    costReporter:deterministicCostReporter(),
    accountIdentityVerifier:recordingAccountIdentityVerifier(),
    clock:() => new Date('2026-07-30T08:00:00.000Z'),
    approvedConnectorMap:{
      douyin:{
        kind:'douyin_official_api',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:douyin-test',
          platform:'douyin',
          connectorKind:'douyin_official_api',
          expiresAt:'2026-08-06T00:00:00.000Z',
        },
        options:{
          credentialResolver:credentialResolver(),
          httpRequest:async (request) => {
            httpCalls.push(request.operation);
            if (request.operation === 'upload_video') {
              return {
                status:200,
                actualCost:actualCost(request.operation),
                body:{ data:{ error_code:0, video:{ video_id:VIDEO_ID } } },
              };
            }
            throw new Error('result lost');
          },
        },
      },
    },
  });
  const request = {
    campaignId:'campaign-real-contract',
    grant:canonicalGrant,
    platform:'douyin',
    contentVersionId:'content-v1',
    contentChecksum:checksum,
    scheduledDate:'2026-07-30',
    mediaPath:'douyin.mp4',
    title:'Agent实战',
    body:'一次真实执行闭环',
    tags:['AI Agent'],
    reviewReport:{
      status:'passed',
      checks:{
        facts:true,
        privacy:true,
        rights:true,
        media:true,
        claims:true,
        grantScope:true,
        duplicate:true,
      },
    },
  };
  request.idempotencyKey = publishIdempotencyKey(request);

  await assert.rejects(runtime.publish(request), { code:'publish_attempt_ambiguous' });
  assert.deepEqual(httpCalls, ['upload_video', 'create_video']);
  assert.equal(pauseCalls.length, 1);
  assert.equal(pauseCalls[0].reason, 'publish_attempt_requires_reconciliation');

  await assert.rejects(runtime.publish(request), { code:'publish_attempt_ambiguous' });
  assert.deepEqual(httpCalls, ['upload_video', 'create_video']);
  assert.equal(pauseCalls.length, 2);

  const ledger = await runtime.repository.read();
  assert.equal(JSON.stringify(ledger).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(ledger).includes(OPEN_ID), false);
});

test('真实抖音指标 connector 的身份或风控停止会经 Gateway 暂停活动且禁止重试', async () => {
  const scenarios = [
    {
      errorCode:28001003,
      stopReason:'identity_verification',
      suffix:'identity-verification',
    },
    {
      errorCode:28001014,
      stopReason:'risk_control',
      suffix:'risk-control',
    },
    {
      errorCode:28001014,
      stopReason:'risk_control',
      suffix:'risk-control-cost-failure',
      reportError:Object.assign(new Error('cost reporter unavailable'), {
        code:'paperclip_cost_unavailable',
      }),
      expectedCostReportingErrorCode:'publisher_cost_reporting_ambiguous',
    },
  ];
  for (const scenario of scenarios) {
    const root = await fs.mkdtemp(path.join(
      os.tmpdir(),
      `m5-douyin-metric-stop-${scenario.suffix}-`,
    ));
    try {
      const pauseCalls = [];
      let metricHttpCalls = 0;
      const metricTime = new Date('2026-07-30T10:00:00.000Z');
      const receiptId = scenario.stopReason === 'identity_verification'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222';
      const campaignId = `campaign-metric-stop-${scenario.stopReason}`;
      const runtime = createPublisherRuntime({
        mode:'real',
        productionEnabled:true,
        workspaceRoot:root,
        ledgerPath:path.join(root, 'ledger.json'),
        paperclipControl:{
          assertPublishAllowed:async ({ campaignId:requestedCampaignId }) => ({
            campaignId:requestedCampaignId,
            grantStatus:'active',
            currentStage:'campaign_active',
            canonicalGrant:{},
          }),
          pauseCampaignAndDisableCron:async (input) => {
            pauseCalls.push(structuredClone(input));
            return {
              campaignId:input.campaignId,
              grantStatus:'paused',
              cronStatus:'disabled',
              controlEventId:`pause-${scenario.stopReason}`,
            };
          },
        },
        costReporter:deterministicCostReporter({
          reportError:scenario.reportError || null,
        }),
        accountIdentityVerifier:recordingAccountIdentityVerifier(),
        clock:() => new Date(metricTime),
        approvedConnectorMap:{
          douyin:{
            kind:'douyin_official_api',
            approval:{
              status:'approved',
              approvalRef:`paperclip:publish-${scenario.stopReason}`,
              platform:'douyin',
              connectorKind:'douyin_official_api',
              expiresAt:'2026-08-06T00:00:00.000Z',
            },
            options:{
              credentialResolver:credentialResolver(),
              httpRequest:successfulHttp([]),
            },
          },
        },
        approvedMetricConnectorMap:{
          douyin:{
            kind:'douyin_official_api',
            approval:{
              status:'approved',
              approvalRef:`paperclip:metrics-${scenario.stopReason}`,
              platform:'douyin',
              capability:'read_own_metrics',
              connectorKind:'douyin_official_api',
              expiresAt:'2026-08-06T00:00:00.000Z',
            },
            options:{
              credentialResolver:credentialResolver(),
              httpRequest:async (request) => {
                metricHttpCalls += 1;
                return {
                  status:200,
                  actualCost:actualCost(request.operation),
                  body:{
                    data:{ error_code:scenario.errorCode },
                    extra:{ error_code:scenario.errorCode },
                  },
                };
              },
            },
          },
        },
      });
      await runtime.repository.update((state) => {
        state.receipts.seed = {
          receiptId,
          idempotencyKey:`seed:${scenario.stopReason}`,
          campaignId,
          platform:'douyin',
          contentVersionId:`content-${scenario.stopReason}`,
          contentChecksum:`sha256:${'a'.repeat(64)}`,
          scheduledDate:'2026-07-30',
          externalContentId:ITEM_ID,
          evidence:`https://www.douyin.com/video/${VIDEO_ID}`,
          accountRef:ACCOUNT_REF,
          publishedAt:'2026-07-30T08:00:00.000Z',
          connectorMode:'real:douyin_official_api',
        };
      });
      const input = {
        campaignId,
        receiptId,
        collectionKey:`${receiptId}:2h`,
        collectedAt:metricTime.toISOString(),
      };

      await assert.rejects(
        runtime.collectMetricSnapshot(input),
        { code:`metric_collection_stopped_${scenario.stopReason}` },
      );
      assert.equal(pauseCalls.length, 1, scenario.stopReason);
      assert.equal(pauseCalls[0].reason, scenario.stopReason);
      await assert.rejects(
        runtime.collectMetricSnapshot(input),
        { code:'metric_collection_hard_stopped' },
      );
      assert.equal(metricHttpCalls, 1, scenario.stopReason);
      assert.equal(pauseCalls.length, 1, scenario.stopReason);
      const attempt = (await runtime.repository.read())
        .attempts[`metric:${input.collectionKey}`];
      assert.equal(attempt.state, 'blocked');
      assert.equal(attempt.hardStop, true);
      assert.equal(attempt.stopReason, scenario.stopReason);
      assert.equal(attempt.pauseControl.grantStatus, 'paused');
      assert.equal(attempt.pauseControl.cronStatus, 'disabled');
      if (scenario.expectedCostReportingErrorCode) {
        assert.equal(
          attempt.costReportingErrorCode,
          scenario.expectedCostReportingErrorCode,
        );
        const costRecords = Object.values(
          (await runtime.repository.read()).costRecords,
        );
        assert.equal(costRecords.length, 1);
        assert.equal(costRecords[0].state, 'submitting');
      }
    } finally {
      await fs.rm(root, { recursive:true, force:true });
    }
  }
});
