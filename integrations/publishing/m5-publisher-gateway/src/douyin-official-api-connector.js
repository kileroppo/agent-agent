import path from 'node:path';
import { M5_PLATFORM_IDS } from '@agent-army/m5-contracts';
import { coded } from './policy.js';
import { parseOfficialTransportCost } from './cost-reporting.js';
import {
  validateAccountIdentityVerifier,
  verifyDouyinAccountIdentity,
} from './account-identity.js';

const OFFICIAL_ORIGIN = 'https://open.douyin.com';
const OFFICIAL_EVIDENCE = `${OFFICIAL_ORIGIN}/platform/resource/docs/openapi`;
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CAPTION_CODE_POINTS = 1000;
const AUTH_ERROR_CODES = new Set([28001003, 28001008]);
const RISK_ERROR_CODES = new Set([
  28001014,
  28001016,
  28001018,
  28001019,
  28001028,
  28003017,
]);

export const DOUYIN_OFFICIAL_ENDPOINTS = Object.freeze({
  upload:`${OFFICIAL_ORIGIN}/api/douyin/v1/video/upload_video/`,
  create:`${OFFICIAL_ORIGIN}/api/douyin/v1/video/create_video/`,
  basicInfo:`${OFFICIAL_ORIGIN}/api/douyin/v1/video/video_basic_info/`,
  metrics:`${OFFICIAL_ORIGIN}/video/data/`,
});

export class DouyinOfficialApiConnector {
  constructor({
    enabled = false,
    httpRequest,
    credentialResolver,
    accountIdentityVerifier,
    costRecorder,
    maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
    clock = () => new Date(),
  } = {}) {
    this.connectorMode = 'real:douyin_official_api';
    this.enabled = enabled === true;
    this.httpRequest = httpRequest;
    this.credentialResolver = credentialResolver;
    this.accountIdentityVerifier = accountIdentityVerifier;
    this.costRecorder = costRecorder;
    this.costReportingMode = 'transport_actual';
    this.maxUploadBytes = maxUploadBytes;
    this.clock = clock;
  }

  async publish(request = {}) {
    this.assertEnabled();
    validatePublishInput(request, this.maxUploadBytes);
    const caption = buildCaption(request);
    const costContext = {
      campaignId:request.campaignId,
      idempotencyKey:request.idempotencyKey,
    };
    const credentials = await this.resolveCredentials(request.accountRef, 'publish');
    const query = `?open_id=${encodeURIComponent(credentials.openId)}`;
    const common = {
      method:'POST',
      headers:{ 'access-token':credentials.accessToken },
      idempotencyKey:request.idempotencyKey,
      accountRef:request.accountRef,
    };

    const upload = await this.callOfficial({
      ...common,
      operation:'upload_video',
      url:`${DOUYIN_OFFICIAL_ENDPOINTS.upload}${query}`,
      body:{
        kind:'multipart',
        fields:{},
        files:[{
          fieldName:'video',
          filename:path.basename(request.verifiedMedia.relativePath),
          contentType:'video/mp4',
          bytes:request.verifiedMedia.bytes,
          checksum:request.verifiedMedia.checksum,
          createReadStream:request.mediaLease.createReadStream,
        }],
      },
    }, {
      transportCode:'douyin_upload_failed',
      platformCode:'douyin_upload_rejected',
    }, costContext);
    if (upload.stopped) return upload.stopped;
    const uploadedVideoId = stringValue(upload.body?.data?.video?.video_id);
    if (!uploadedVideoId) {
      throw coded('douyin_upload_result_unverified', '抖音上传响应缺少 video_id，停止发布并等待核对。');
    }

    const created = await this.callOfficial({
      ...common,
      operation:'create_video',
      url:`${DOUYIN_OFFICIAL_ENDPOINTS.create}${query}`,
      headers:{
        ...common.headers,
        'content-type':'application/json',
      },
      body:{
        video_id:uploadedVideoId,
        text:caption,
      },
    }, {
      transportCode:'douyin_create_result_ambiguous',
      platformCode:'douyin_create_result_ambiguous',
    }, costContext);
    if (created.stopped) return created.stopped;
    const itemId = stringValue(created.body?.data?.item_id);
    const createdVideoId = stringValue(created.body?.data?.video_id) || uploadedVideoId;
    if (!itemId || !createdVideoId) {
      throw coded(
        'douyin_create_result_ambiguous',
        '抖音创建响应缺少内容 ID，结果不确定；必须暂停并人工核对，禁止自动重发。',
      );
    }

    const queried = await this.callOfficial({
      ...common,
      operation:'query_video_basic_info',
      url:`${DOUYIN_OFFICIAL_ENDPOINTS.basicInfo}${query}`,
      headers:{
        ...common.headers,
        'content-type':'application/json',
      },
      body:{ video_ids:[createdVideoId] },
    }, {
      transportCode:'douyin_publish_reconciliation_required',
      platformCode:'douyin_publish_reconciliation_required',
    }, costContext);
    if (queried.stopped) return queried.stopped;
    const record = listFrom(queried.body).find((entry) => (
      stringValue(entry?.video_id) === createdVideoId
      && stringValue(entry?.item_id) === itemId
    ));
    if (!record) {
      throw coded(
        'douyin_publish_reconciliation_required',
        '抖音创建后无法核对相同 item_id 和 video_id；必须暂停并人工核对，禁止自动重发。',
      );
    }

    return {
      state:'published',
      externalContentId:itemId,
      evidence:evidenceFor(record, createdVideoId),
      accountRef:request.accountRef,
      publishedAt:publishedAt(record, this.clock),
    };
  }

  async readOwnMetrics(receipt = {}) {
    this.assertEnabled();
    if (
      receipt.platform !== M5_PLATFORM_IDS.DOUYIN
      || !receipt.accountRef
      || !receipt.externalContentId
    ) {
      throw coded('invalid_douyin_metric_receipt', '抖音指标查询必须使用本人内容的完整发布回执。');
    }
    const credentials = await this.resolveCredentials(receipt.accountRef, 'read_own_metrics');
    const response = await this.callOfficial({
      operation:'read_video_metrics',
      method:'POST',
      url:DOUYIN_OFFICIAL_ENDPOINTS.metrics,
      headers:{
        'access-token':credentials.accessToken,
        'content-type':'application/json',
      },
      accountRef:receipt.accountRef,
      body:{ item_ids:[receipt.externalContentId] },
    }, {
      transportCode:'douyin_metric_transport_failed',
      platformCode:'douyin_metric_query_rejected',
    }, {
      campaignId:receipt.campaignId,
      idempotencyKey:`metric:${receipt.receiptId}`,
    });
    if (response.stopped) {
      const stopReason = normalizedMetricStopReason(
        response.stopped.stopReason,
      );
      const error = coded(
        `douyin_metric_${stopReason}`,
        '抖音指标查询被安全门禁停止，等待 Paperclip 决定恢复动作。',
      );
      error.hardStop = true;
      error.stopReason = stopReason;
      if (response.stopped.costReportingErrorCode) {
        error.costReportingErrorCode =
          response.stopped.costReportingErrorCode;
      }
      throw error;
    }
    const record = listFrom(response.body).find((entry) => (
      stringValue(entry?.item_id) === receipt.externalContentId
    ));
    if (!record?.statistics || typeof record.statistics !== 'object') {
      throw coded('douyin_metric_result_unverified', '抖音指标响应没有匹配本人内容，拒绝记录快照。');
    }
    return {
      views:nonNegativeInteger(record.statistics.play_count),
      likes:nonNegativeInteger(record.statistics.digg_count),
      comments:nonNegativeInteger(record.statistics.comment_count),
      shares:nonNegativeInteger(record.statistics.share_count),
      downloads:nonNegativeInteger(record.statistics.download_count),
      forwards:nonNegativeInteger(record.statistics.forward_count),
    };
  }

  assertEnabled() {
    if (!this.enabled) {
      throw coded('real_connector_disabled', '抖音官方 API 连接器默认关闭，尚未接入真实 Publisher Runtime。');
    }
    if (
      typeof this.httpRequest !== 'function'
      || typeof this.credentialResolver !== 'function'
      || typeof this.costRecorder?.recordOfficialTransportAttempt !== 'function'
    ) {
      throw coded(
        'douyin_connector_dependencies_missing',
        '抖音官方 API 连接器必须注入 HTTP 传输、临时凭据解析器、Paperclip 账号核验器和确定性费用记录器。',
      );
    }
    validateAccountIdentityVerifier(this.accountIdentityVerifier);
  }

  async resolveCredentials(accountRef, purpose) {
    let resolved;
    try {
      resolved = await this.credentialResolver({
        accountRef,
        platform:M5_PLATFORM_IDS.DOUYIN,
        purpose,
      });
    } catch {
      throw coded('douyin_credential_unavailable', '无法取得抖音账号临时授权，未调用平台接口。');
    }
    const accessToken = stringValue(resolved?.accessToken);
    const openId = stringValue(resolved?.openId);
    if (!accessToken || !openId) {
      throw coded('douyin_credential_unavailable', '抖音账号临时授权不完整，未调用平台接口。');
    }
    await verifyDouyinAccountIdentity({
      verifier:this.accountIdentityVerifier,
      accountRef,
      openId,
    });
    return { accessToken, openId };
  }

  async callOfficial(request, { transportCode, platformCode }, costContext) {
    let response;
    try {
      response = await this.httpRequest(request);
    } catch {
      throw coded(transportCode, '抖音官方接口传输失败；不自动重试，等待安全恢复或人工核对。');
    }
    const safetyStopReason = officialSafetyStopReason(response);
    let costReportingErrorCode = null;
    try {
      const transportCost = parseOfficialTransportCost(response?.actualCost, {
        operation:request.operation,
        connectorMode:this.connectorMode,
      });
      await this.costRecorder.recordOfficialTransportAttempt({
        campaignId:costContext?.campaignId,
        idempotencyKey:costContext?.idempotencyKey,
        connectorMode:this.connectorMode,
        operation:request.operation,
        providerRequestId:transportCost.providerRequestId,
        receiptRef:transportCost.receiptRef,
        amountUsd:transportCost.amountUsd,
        occurredAt:transportCost.occurredAt,
      });
    } catch (error) {
      if (!safetyStopReason) throw error;
      costReportingErrorCode = safeErrorCode(
        error,
        'cost_reporting_failed',
      );
    }
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw coded(transportCode, '抖音官方接口未返回确定的成功状态；不自动重试。');
    }
    const body = response.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw coded(transportCode, '抖音官方接口响应无法验证；不自动重试。');
    }
    const errorCode = officialErrorCode(body);
    if (errorCode === 0) return { body };
    if (safetyStopReason) {
      return {
        stopped:{
          state:'stopped',
          stopReason:safetyStopReason,
          evidence:OFFICIAL_EVIDENCE,
          ...(costReportingErrorCode ? { costReportingErrorCode } : {}),
        },
      };
    }
    throw coded(platformCode, `抖音官方接口拒绝请求（错误码 ${errorCode}）；不自动重试。`);
  }
}

function validatePublishInput(request, maxUploadBytes) {
  if (request.platform !== M5_PLATFORM_IDS.DOUYIN) {
    throw coded('douyin_platform_mismatch', '抖音官方连接器只接受 douyin 平台请求。');
  }
  if (!request.campaignId || !request.accountRef || !request.idempotencyKey) {
    throw coded('invalid_douyin_publish_request', '抖音发布请求缺少活动、账号引用或幂等键。');
  }
  if (
    request.verifiedMedia?.immutableLease !== true
    || typeof request.mediaLease?.createReadStream !== 'function'
  ) {
    throw coded('immutable_media_lease_required', '抖音发布只接受网关创建的不可变媒体租约。');
  }
  if (!Number.isInteger(request.verifiedMedia.bytes) || request.verifiedMedia.bytes <= 0) {
    throw coded('invalid_douyin_media_size', '抖音发布媒体大小无效。');
  }
  if (
    !Number.isInteger(maxUploadBytes)
    || maxUploadBytes <= 0
    || request.verifiedMedia.bytes > maxUploadBytes
  ) {
    throw coded(
      'douyin_upload_too_large',
      '视频超过当前抖音单次上传安全上限；分片上传尚未实现，拒绝调用平台。',
    );
  }
}

function buildCaption(request) {
  const lines = [
    stringValue(request.title),
    stringValue(request.body),
    ...(Array.isArray(request.tags)
      ? request.tags.map((tag) => stringValue(tag)).filter(Boolean).map((tag) => `#${tag}`)
      : []),
  ].filter(Boolean);
  const caption = lines.join('\n');
  if (!caption) throw coded('invalid_douyin_caption', '抖音发布文案不能为空。');
  if ([...caption].length > MAX_CAPTION_CODE_POINTS) {
    throw coded(
      'douyin_caption_too_long',
      `抖音发布文案超过 ${MAX_CAPTION_CODE_POINTS} 个字符，拒绝静默截断。`,
    );
  }
  return caption;
}

function officialErrorCode(body) {
  const candidates = [
    body?.data?.error_code,
    body?.extra?.error_code,
    body?.err_no,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value !== 0) return value;
  }
  return 0;
}

function officialSafetyStopReason(response) {
  if (
    !response
    || !Number.isInteger(response.status)
    || response.status < 200
    || response.status >= 300
    || !response.body
    || typeof response.body !== 'object'
    || Array.isArray(response.body)
  ) {
    return null;
  }
  const errorCode = officialErrorCode(response.body);
  if (AUTH_ERROR_CODES.has(errorCode)) return 'identity_verification';
  if (RISK_ERROR_CODES.has(errorCode)) return 'risk_control';
  return null;
}

function safeErrorCode(error, fallback) {
  const value = String(error?.code || '');
  return /^[a-z][a-z0-9_]{1,127}$/.test(value) ? value : fallback;
}

function normalizedMetricStopReason(value) {
  if (value === 'identity_verification' || value === 'risk_control') {
    return value;
  }
  return 'unknown_page';
}

function listFrom(body) {
  const list = body?.data?.list ?? body?.data?.data?.list;
  return Array.isArray(list) ? list : [];
}

function evidenceFor(record, videoId) {
  const shareUrl = stringValue(record?.share_url);
  if (shareUrl?.startsWith('https://')) return shareUrl;
  return `https://www.douyin.com/video/${encodeURIComponent(videoId)}`;
}

function publishedAt(record, clock) {
  const seconds = Number(record?.create_time);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();
  return clock().toISOString();
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
