const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_UNAVAILABLE_POLLS = 5;
import { validateTaskCompletion } from './task-completion-contract.js';
import { prepareDeliveryQualityResult } from './workflow/delivery-quality-runtime.ts';

export class XiaodReconciler {
  constructor({
    store,
    xiaod,
    governance = null,
    deliveryQuality = null,
    lifecycleEvents = null,
    onFailure = null,
    contentWorkspaceDir = null,
    now = () => Date.now(),
    intervalMs = 3_000,
  } = {}) {
    this.store = store;
    this.xiaod = xiaod;
    this.governance = governance;
    this.deliveryQuality = deliveryQuality;
    this.lifecycleEvents = lifecycleEvents;
    this.onFailure = onFailure;
    this.contentWorkspaceDir = contentWorkspaceDir ? path.resolve(contentWorkspaceDir) : null;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile() {
    if (this.running) return this.running;
    this.running = this.reconcileOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async reconcileOnce() {
    const tasks = await this.store.list();
    const now = this.now();
    await Promise.all(tasks
      .filter((task) => isRunningXiaodTask(task) && isPollDue(task, now))
      .map((task) => this.reconcileTask(task)));
  }

  async reconcileTask(task) {
    try {
      const job = await this.xiaod.getJob(task.execution.xiaodJobId);
      let status = job.status === 'completed'
        ? 'succeeded'
        : job.status === 'awaiting_review'
          ? 'waiting_approval'
          : job.status === 'awaiting_delivery'
            ? 'needs_input'
          : job.status === 'failed' && job.failure?.category === 'needs_input'
            ? 'needs_input'
            : job.status === 'failed'
              ? 'failed'
              : job.status === 'paused'
                ? 'paused'
                : job.status === 'pausing'
                  ? 'pausing'
                  : 'running';
      const execution = {
        ...task.execution,
        xiaodStatus: job.status,
        xiaodProgress: job.progress,
        connectionBinding:job.connectionBinding || task.execution?.connectionBinding || null,
        updatedAt: new Date(this.now()).toISOString(),
        polling: { state: ['running', 'pausing'].includes(status) ? 'watching' : 'settled', consecutiveFailures: 0, nextPollAt: ['running', 'pausing'].includes(status) ? new Date(this.now() + this.intervalMs).toISOString() : null }
      };
      let patch = { status, currentStage: `xiaod_${job.status}`, execution };
      if (job.status === 'awaiting_review') {
        const approvals = await this.store.listApprovals();
        let approval = approvals.find((item) => item.taskId === task.taskId && item.action === 'confirm-transcript-after-complete-listen' && item.status === 'pending');
        if (!approval) approval = await this.store.createApproval({
          taskId:task.taskId,
          governanceMode:'local',
          decisionChannel:'feishu_card',
          action:'confirm-transcript-after-complete-listen',
          riskLevel:'medium',
          reason:job.reviewPolicy === 'required'
            ? '本次任务明确要求人工确认。请完整听审后决定是否生成正式确认稿。'
            : `系统自动确认没有通过，需人工复核后再生成正式确认稿。${job.output?.automaticConfirmation?.reasons?.length ? ` 原因：${job.output.automaticConfirmation.reasons.join(', ')}。` : ''}`,
          requestedBy:'xiaod',
          approverScope:'A君',
          requestedScope:{ taskType:task.taskType, title:task.input?.title || '', assigneeAgentId:'xiaod' },
          validUntil:new Date(this.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
        patch.approvalRefs = [...new Set([...(task.approvalRefs || []), approval.approvalId])];
      }
      if (status === 'succeeded') {
        patch.artifactRefs = xiaodArtifactsFor(task, job, this.xiaod.baseUrl);
        if (task.taskType === 'content.campaign-assets') {
          patch.artifactRefs.push(await m5AssetPackageFor(task, job, {
            contentWorkspaceDir:this.contentWorkspaceDir,
          }));
        }
        const completion = validateTaskCompletion(task, patch.artifactRefs);
        if (!completion.valid) {
          status = 'waiting_test';
          patch.status = 'waiting_test';
          patch.currentStage = 'completion_evidence_invalid';
          patch.execution = {
            ...execution,
            outcome:'completion_evidence_invalid',
            completionValidation:{
              reportedStatus:'succeeded',
              valid:false,
              expectedArtifactTypes:completion.expectedArtifactTypes,
            },
          };
          patch.error = {
            code:'completion_evidence_invalid',
            message:completion.reason,
            userMessage:'小D已经停止处理，但最终交付没有通过权限或可读性门禁；已转为待测试。',
            category:'manual',
            stage:'completion_validation',
            retryable:false,
            occurredAt:new Date(this.now()).toISOString(),
          };
        }
        if (patch.status === 'succeeded' && this.deliveryQuality) {
          patch = prepareDeliveryQualityResult(task, patch);
          status = patch.status;
        }
      }
      if (job.status === 'awaiting_delivery') patch.error = deliveryWaitFor(job);
      else if (status === 'failed' || status === 'needs_input') patch.error = failureFor(job);
      let updated = await this.persist(task.taskId, patch);
      if (this.deliveryQuality) {
        const beforeQuality = structuredClone(updated);
        updated = await this.deliveryQuality.continue(updated);
        this.lifecycleEvents?.recordPersisted(updated, { previousTask:beforeQuality });
      }
      if (status === 'failed') await this.coordinateFailure(updated);
    } catch (error) {
      if (String(error?.code || '').startsWith('m5_asset_')) {
        await this.persist(task.taskId, {
          status:'needs_input',
          currentStage:String(error.code),
          execution:{
            ...task.execution,
            updatedAt:new Date(this.now()).toISOString(),
            polling:{ state:'settled', consecutiveFailures:0, nextPollAt:null },
          },
          error:{
            code:String(error.code),
            message:String(error.message || 'M5 素材包证据不足。'),
            userMessage:String(error.message || 'M5 素材包证据不足。'),
            category:'needs_input',
            stage:'m5_asset_package',
            retryable:false,
            occurredAt:new Date(this.now()).toISOString(),
          },
        });
        return;
      }
      await this.deferUnavailableTask(task, error);
    }
  }

  async deferUnavailableTask(task, error) {
    const priorFailures = Number(task.execution?.polling?.consecutiveFailures || 0);
    const consecutiveFailures = priorFailures + 1;
    const message = String(error?.message || '小D状态不可用。');
    if (consecutiveFailures >= MAX_UNAVAILABLE_POLLS) {
      const updated = await this.persist(task.taskId, {
        status: 'failed', currentStage: 'xiaod_status_unavailable',
        execution: { ...task.execution, updatedAt: new Date(this.now()).toISOString(), polling: { state: 'exhausted', consecutiveFailures, nextPollAt: null } },
        error: { code: 'xiaod_status_unavailable', message, userMessage: '多次无法确认小D任务状态，已停止自动查询；请稍后检查小D服务后重试。', category: 'retryable', stage: 'delegated_to_xiaod', occurredAt: new Date(this.now()).toISOString() }
      });
      await this.coordinateFailure(updated);
      return;
    }
    const delay = Math.min(BASE_BACKOFF_MS * (2 ** (consecutiveFailures - 1)), MAX_BACKOFF_MS);
    await this.persist(task.taskId, {
      status: 'running', currentStage: 'xiaod_status_retrying',
      execution: { ...task.execution, updatedAt: new Date(this.now()).toISOString(), polling: { state: 'backoff', consecutiveFailures, nextPollAt: new Date(this.now() + delay).toISOString() } },
      error: { code: 'xiaod_status_unavailable', message, userMessage: `暂时无法连接小D，${Math.ceil(delay / 1000)} 秒后会自动重试。`, category: 'retryable', stage: 'delegated_to_xiaod', occurredAt: new Date(this.now()).toISOString() }
    });
  }

  async persist(taskId, patch) {
    const previous = await this.getPersistedTask(taskId);
    let updated = await this.store.updateTask(taskId, patch);
    if (this.governance && updated.governance?.paperclipIssueId) {
      updated = await this.store.updateTask(taskId, { governance: await this.governance.update(updated) });
    }
    this.lifecycleEvents?.recordPersisted(updated, { previousTask:previous });
    return updated;
  }

  async getPersistedTask(taskId) {
    const task = typeof this.store.getTask === 'function'
      ? await this.store.getTask(taskId)
      : (await this.store.list()).find((item) => item.taskId === taskId) || null;
    return task ? structuredClone(task) : null;
  }

  async coordinateFailure(task) {
    if (typeof this.onFailure !== 'function') return;
    try { await this.onFailure(task); }
    catch (error) {
      await this.persist(task.taskId, {
        recovery: {
          ...(task.recovery || {}),
          coordination: { status: 'pending', reason: String(error?.message || '恢复协调暂时失败。'), updatedAt: new Date(this.now()).toISOString() }
        }
      });
    }
  }
}

function isRunningXiaodTask(task) {
  return ['running', 'pausing'].includes(task.status) && task.execution?.executor === 'xiaod' && Boolean(task.execution.xiaodJobId);
}

function deliveryWaitFor(job) {
  const delivery = job.output?.larkDelivery || {};
  const uncertain = delivery.state === 'uncertain' || job.failure?.retryable === false;
  if (uncertain) return {
    code:'xiaod_delivery_uncertain',
    message:String(job.error || delivery.lastError || '飞书交付结果不确定。'),
    userMessage:'小D已生成本地确认稿，但飞书可能已经收到交付。请先在本机运行台按任务编号核对并仲裁；确认前不要重试。',
    category:'needs_input',
    retryable:false,
    stage:'awaiting_delivery',
    occurredAt:new Date().toISOString(),
  };
  const documentReady = delivery.state === 'document_ready';
  return {
    code:'xiaod_delivery_pending',
    message:String(delivery.lastError || (documentReady ? '飞书文档权限尚未确认。' : '飞书文档尚未创建。')),
    userMessage:documentReady
      ? '视频处理结果已保存，飞书文档也已生成，但目标用户权限尚未确认。这不是重复提交能解决的问题；请联系系统管理员检查小D的飞书权限，修复后在本会话回复“继续飞书交付”。'
      : '视频处理结果已保存，但报告发送到飞书失败。这不是你的操作问题；请联系系统管理员检查小D的飞书应用连接，修复后在本会话回复“继续飞书交付”。',
    category:'needs_input',
    retryable:true,
    stage:'awaiting_delivery',
    occurredAt:new Date().toISOString(),
  };
}

function isPollDue(task, now) {
  const nextPollAt = task.execution?.polling?.nextPollAt;
  return !nextPollAt || Date.parse(nextPollAt) <= now;
}

export function xiaodArtifactsFor(task, job, baseUrl) {
  const createdAt = new Date().toISOString();
  const common = { taskId:task.taskId, accessScope:'local-owner', createdAt };
  const larkRevisionStatus = String(job.output?.larkRevisionStatus || (job.output?.larkUrl ? 'current' : 'not_delivered'));
  const artifacts = [
    { ...common, artifactId:`source-evidence:${job.id}`, type:'source_evidence_record', title:`${job.title}｜来源证据`, location:`file://${job.output?.sourceEvidencePath}`, mimeType:'application/json', validation:{ exists:Boolean(job.output?.sourceEvidencePath), readable:true, nonEmpty:true } },
    { ...common, artifactId:`raw-transcript:${job.id}`, type:'raw_asr_transcript', title:`${job.title}｜机器原始转录`, location:`file://${job.output?.rawTranscriptPath}`, mimeType:'text/plain', checksum:job.output?.transcriptChecksum || null, validation:{ exists:Boolean(job.output?.rawTranscriptPath), readable:true, nonEmpty:true, immutable:true } },
    { ...common, artifactId:`transcript-quality:${job.id}`, type:'transcript_quality_report', title:`${job.title}｜转录质量报告`, location:`file://${job.output?.qualityReportPath}`, mimeType:'application/json', validation:{ exists:Boolean(job.output?.qualityReportPath), readable:true, nonEmpty:true } },
    { ...common, artifactId:`xiaod-job:${job.id}`, type:'xiaod_media_delivery', title:job.title, location:`${baseUrl}/api/jobs/${job.id}`, mimeType:'application/json', validation:{ exists:true, readable:true, nonEmpty:Boolean(job.output?.markdownPath), qualityPassed:Boolean(job.quality?.passed), currentTranscriptDelivered:larkRevisionStatus !== 'stale' }, data:{ larkUrl:typeof job.output?.larkUrl === 'string' ? job.output.larkUrl : null, larkPermissionGranted:job.output?.larkPermissionGranted === true, larkRevisionStatus, currentTranscriptDelivered:larkRevisionStatus !== 'stale', transcriptVersion:Number(job.output?.confirmedTranscriptVersion) || null } }
  ];
  if (job.output?.visualEvidencePath) {
    artifacts.push({
      ...common,
      artifactId:`visual-evidence:${job.id}`,
      type:'visual_evidence_package',
      title:`${job.title}｜关键帧画面证据`,
      location:`file://${job.output.visualEvidencePath}`,
      mimeType:'application/json',
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        visualCoverage:job.output.visualCoverage,
        sourceControlled:true
      }
    });
  }
  if (job.output?.confirmedTranscriptPath) {
    const confirmationMode = job.output.confirmationMode === 'automatic' ? 'automatic' : 'human';
    const correction = job.output?.transcriptCorrection?.applied === true ? job.output.transcriptCorrection : null;
    const attestationType = confirmationMode === 'automatic' ? 'automatic_transcript_attestation' : 'human_review_attestation';
    const attestationRef = `${confirmationMode === 'automatic' ? 'automatic-confirmation' : 'human-review'}:${job.id}:v${job.output.confirmedTranscriptVersion}`;
    const attestationPath = job.output.confirmationAttestationPath || job.output.humanReviewAttestationPath;
    artifacts.push(
      {
        ...common,
        artifactId:attestationRef,
        type:attestationType,
        title:`${job.title}｜${confirmationMode === 'automatic' ? correction ? '系统质量确认与人工补正记录' : '系统质量确认记录' : '人工听审记录'}`,
        location:`file://${attestationPath}`,
        mimeType:'application/json',
        checksum:job.output.confirmedTranscriptChecksum,
        validation:{
          exists:Boolean(attestationPath),
          readable:true,
          nonEmpty:true,
          confirmationMode,
          completeListen:confirmationMode === 'human',
          correctionApplied:Boolean(correction),
          transcriptVersion:Number(job.output.confirmedTranscriptVersion) || 1,
          qualityGatePassed:true
        }
      },
      {
        ...common,
        artifactId:`confirmed-transcript:${job.id}:v${job.output.confirmedTranscriptVersion}`,
        type:'confirmed_transcript',
        title:`${job.title}｜${confirmationMode === 'automatic' ? correction ? 'AI 初稿人工补正版' : '系统确认稿' : '人工确认稿'}`,
        location:`file://${job.output.confirmedTranscriptPath}`,
        mimeType:'text/markdown',
        checksum:job.output.confirmedTranscriptChecksum,
        sourceRefs:[`raw-transcript:${job.id}`, attestationRef],
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          confirmationMode,
          humanConfirmed:confirmationMode === 'human',
          automaticConfirmed:confirmationMode === 'automatic',
          correctionApplied:Boolean(correction),
          transcriptVersion:Number(job.output.confirmedTranscriptVersion) || 1,
          basedOnVersion:correction ? Number(correction.basedOnVersion) || null : null,
          qualityGatePassed:true,
          evidenceLevel:job.output.evidenceLevel
        },
        data:{
          confirmationMode,
          correctionApplied:Boolean(correction),
          transcriptVersion:Number(job.output.confirmedTranscriptVersion) || 1,
          basedOnVersion:correction ? Number(correction.basedOnVersion) || null : null,
        },
      }
    );
  }
  return artifacts;
}

async function m5AssetPackageFor(task, job, { contentWorkspaceDir } = {}) {
  const candidates = [
    ['source_evidence', job.output?.sourceEvidencePath],
    ['visual_evidence', job.output?.visualEvidencePath],
    ['confirmed_transcript', job.output?.confirmedTranscriptPath],
  ].filter(([, filePath]) => Boolean(String(filePath || '').trim()));
  if (candidates.length < 2) {
    throw m5AssetError(
      'm5_asset_evidence_incomplete',
      'M5 素材阶段缺少至少两类真实本机证据文件，不能生成 AssetPackage。',
    );
  }
  const files = [];
  for (const [kind, filePath] of candidates) {
    let bytes;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      throw m5AssetError(
        'm5_asset_file_unreadable',
        `M5 素材阶段的 ${kind} 文件无法回读，不能生成 AssetPackage。`,
      );
    }
    if (!bytes.length) {
      throw m5AssetError(
        'm5_asset_file_empty',
        `M5 素材阶段的 ${kind} 文件为空，不能生成 AssetPackage。`,
      );
    }
    files.push({
      kind,
      checksum:`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      bytes:bytes.length,
    });
  }
  const rightsBasis = String(
    task.input?.context?.assetRightsBasis
    || task.input?.context?.pipelineCase?.fields?.assetRightsBasis
    || task.input?.assetRightsBasis
    || '',
  ).trim();
  if (!rightsBasis) {
    throw m5AssetError(
      'm5_asset_rights_basis_required',
      'M5 素材阶段缺少明确版权依据，不能把来源画面带入成片。',
    );
  }
  const assets = await stageM5VisualAssets({
    task,
    job,
    contentWorkspaceDir,
  });
  const createdAt = new Date().toISOString();
  return {
    artifactId:`asset-package:${job.id}`,
    taskId:task.taskId,
    type:'asset_package',
    title:`${job.title || 'M5 内容'}｜已核验素材包`,
    mimeType:'application/json',
    accessScope:'local-owner',
    sourceRefs:files.map((item) => `${item.kind}:${item.checksum}`),
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      sourceFilesReadBack:true,
      checksumCount:files.length,
      externalSideEffects:0,
    },
    createdAt,
    data:{
      xiaodJobId:String(job.id || '').trim(),
      sourceUrl:String(task.execution?.sourceUrl || task.input?.sourceUrl || '').trim(),
      files,
      assets,
      coverSourcePath:assets[0].relativePath,
      rightsBasis:rightsBasis.slice(0, 200),
      visualCoverage:job.output?.visualCoverage || null,
      generatedAt:createdAt,
    },
  };
}

async function stageM5VisualAssets({ task, job, contentWorkspaceDir }) {
  if (!contentWorkspaceDir) {
    throw m5AssetError(
      'm5_content_workspace_required',
      'M5 内容工作区未绑定到 A君运行时，不能安全转存真实画面素材。',
    );
  }
  const pipelineCaseId = String(task.input?.context?.pipelineCaseId || '').trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(pipelineCaseId)) {
    throw m5AssetError('m5_asset_case_required', 'M5 素材阶段缺少可信 Pipeline Case。');
  }
  const manifestPath = path.resolve(String(job.output?.visualEvidencePath || ''));
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    throw m5AssetError('m5_visual_manifest_invalid', 'M5 视觉证据清单不可读或不是有效 JSON。');
  }
  const frames = Array.isArray(manifest?.frames) ? manifest.frames.slice(0, 12) : [];
  if (manifest?.schemaVersion !== 'agent.army/visual-evidence/v1' || !frames.length) {
    throw m5AssetError('m5_visual_frames_required', 'M5 视觉证据没有可用关键帧，不能冒充旁白混剪。');
  }
  await fs.mkdir(contentWorkspaceDir, { recursive:true, mode:0o700 });
  const workspaceRoot = await fs.realpath(contentWorkspaceDir);
  const sourceRoot = await fs.realpath(path.dirname(manifestPath));
  const targetDirectory = path.resolve(workspaceRoot, 'campaigns', pipelineCaseId, 'assets');
  await fs.mkdir(targetDirectory, { recursive:true, mode:0o700 });
  const realTargetDirectory = await fs.realpath(targetDirectory);
  if (!realTargetDirectory.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw m5AssetError('m5_asset_workspace_escape', 'M5 素材目标目录逃逸内容工作区。');
  }
  const assets = [];
  for (const [index, frame] of frames.entries()) {
    const localRef = String(frame?.localRef || '').trim().replaceAll('\\', '/');
    if (
      !localRef
      || localRef.startsWith('/')
      || localRef.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw m5AssetError('m5_asset_source_escape', 'M5 关键帧引用不是安全相对路径。');
    }
    const sourcePath = await fs.realpath(path.resolve(sourceRoot, localRef)).catch(() => null);
    if (!sourcePath || !sourcePath.startsWith(`${sourceRoot}${path.sep}`)) {
      throw m5AssetError('m5_asset_source_escape', 'M5 关键帧通过路径或符号链接逃逸来源目录。');
    }
    const extension = normalizedImageExtension(path.extname(sourcePath));
    if (!extension) throw m5AssetError('m5_asset_image_type_invalid', 'M5 关键帧不是允许的 JPG、PNG 或 WebP。');
    const bytes = await fs.readFile(sourcePath);
    if (!bytes.length) throw m5AssetError('m5_asset_file_empty', 'M5 关键帧为空。');
    const checksum = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (
      frame?.checksum
      && String(frame.checksum).toLowerCase() !== checksum
    ) {
      throw m5AssetError('m5_asset_checksum_mismatch', 'M5 关键帧哈希与视觉证据清单不一致。');
    }
    const frameId = /^frame-\d{3}$/i.test(String(frame?.frameId || ''))
      ? String(frame.frameId).toLowerCase()
      : `frame-${String(index + 1).padStart(3, '0')}`;
    const fileName = `${frameId}${extension}`;
    const targetPath = path.join(realTargetDirectory, fileName);
    await fs.writeFile(targetPath, bytes, { mode:0o600 });
    const readBack = await fs.readFile(targetPath);
    const stagedChecksum = `sha256:${crypto.createHash('sha256').update(readBack).digest('hex')}`;
    if (stagedChecksum !== checksum) {
      throw m5AssetError('m5_asset_stage_mismatch', 'M5 关键帧转存回读哈希不一致。');
    }
    assets.push({
      frameId,
      timestamp:String(frame?.timestamp || '').slice(0, 20) || null,
      relativePath:path.posix.join('campaigns', pipelineCaseId, 'assets', fileName),
      checksum,
      bytes:readBack.length,
      origin:'xiaod_verified_visual_evidence',
    });
  }
  return assets;
}

function normalizedImageExtension(value) {
  const extension = String(value || '').toLowerCase();
  if (extension === '.jpeg') return '.jpg';
  return ['.jpg', '.png', '.webp'].includes(extension) ? extension : null;
}

function m5AssetError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.category = 'needs_input';
  error.retryable = false;
  return error;
}

function failureFor(job) {
  const failure = job.failure || {};
  return { code: 'xiaod_job_failed', message: typeof job.error === 'string' ? job.error : '小D任务失败。', userMessage: failure.recovery || '小D未能完成素材处理，请根据任务提示补充素材或稍后重试。', category: failure.category || 'manual', retryable: failure.retryable === true, stage: job.status, occurredAt: new Date().toISOString() };
}
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
