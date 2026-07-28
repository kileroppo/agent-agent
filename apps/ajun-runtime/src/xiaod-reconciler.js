const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_UNAVAILABLE_POLLS = 5;

export class XiaodReconciler {
  constructor({ store, xiaod, governance = null, onFailure = null, now = () => Date.now(), intervalMs = 3_000 } = {}) {
    this.store = store;
    this.xiaod = xiaod;
    this.governance = governance;
    this.onFailure = onFailure;
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
      const status = job.status === 'completed'
        ? 'succeeded'
        : job.status === 'awaiting_review'
          ? 'waiting_approval'
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
        updatedAt: new Date(this.now()).toISOString(),
        polling: { state: ['running', 'pausing'].includes(status) ? 'watching' : 'settled', consecutiveFailures: 0, nextPollAt: ['running', 'pausing'].includes(status) ? new Date(this.now() + this.intervalMs).toISOString() : null }
      };
      const patch = { status, currentStage: `xiaod_${job.status}`, execution };
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
      if (status === 'succeeded') patch.artifactRefs = artifactFor(task, job, this.xiaod.baseUrl);
      if (status === 'failed' || status === 'needs_input') patch.error = failureFor(job);
      const updated = await this.persist(task.taskId, patch);
      if (status === 'failed') await this.coordinateFailure(updated);
    } catch (error) {
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
    let updated = await this.store.updateTask(taskId, patch);
    if (this.governance && updated.governance?.paperclipIssueId) {
      updated = await this.store.updateTask(taskId, { governance: await this.governance.update(updated) });
    }
    return updated;
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

function isPollDue(task, now) {
  const nextPollAt = task.execution?.polling?.nextPollAt;
  return !nextPollAt || Date.parse(nextPollAt) <= now;
}

function artifactFor(task, job, baseUrl) {
  const createdAt = new Date().toISOString();
  const common = { taskId:task.taskId, accessScope:'local-owner', createdAt };
  const artifacts = [
    { ...common, artifactId:`source-evidence:${job.id}`, type:'source_evidence_record', title:`${job.title}｜来源证据`, location:`file://${job.output?.sourceEvidencePath}`, mimeType:'application/json', validation:{ exists:Boolean(job.output?.sourceEvidencePath), readable:true, nonEmpty:true } },
    { ...common, artifactId:`raw-transcript:${job.id}`, type:'raw_asr_transcript', title:`${job.title}｜机器原始转录`, location:`file://${job.output?.rawTranscriptPath}`, mimeType:'text/plain', checksum:job.output?.transcriptChecksum || null, validation:{ exists:Boolean(job.output?.rawTranscriptPath), readable:true, nonEmpty:true, immutable:true } },
    { ...common, artifactId:`transcript-quality:${job.id}`, type:'transcript_quality_report', title:`${job.title}｜转录质量报告`, location:`file://${job.output?.qualityReportPath}`, mimeType:'application/json', validation:{ exists:Boolean(job.output?.qualityReportPath), readable:true, nonEmpty:true } },
    { ...common, artifactId:`xiaod-job:${job.id}`, type:'xiaod_media_delivery', title:job.title, location:`${baseUrl}/api/jobs/${job.id}`, mimeType:'application/json', validation:{ exists:true, readable:true, nonEmpty:Boolean(job.output?.markdownPath), qualityPassed:Boolean(job.quality?.passed) }, data:{ larkUrl:typeof job.output?.larkUrl === 'string' ? job.output.larkUrl : null, larkPermissionGranted:job.output?.larkPermissionGranted === true } }
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
    const attestationType = confirmationMode === 'automatic' ? 'automatic_transcript_attestation' : 'human_review_attestation';
    const attestationRef = `${confirmationMode === 'automatic' ? 'automatic-confirmation' : 'human-review'}:${job.id}:v${job.output.confirmedTranscriptVersion}`;
    const attestationPath = job.output.confirmationAttestationPath || job.output.humanReviewAttestationPath;
    artifacts.push(
      {
        ...common,
        artifactId:attestationRef,
        type:attestationType,
        title:`${job.title}｜${confirmationMode === 'automatic' ? '系统质量确认记录' : '人工听审记录'}`,
        location:`file://${attestationPath}`,
        mimeType:'application/json',
        checksum:job.output.confirmedTranscriptChecksum,
        validation:{
          exists:Boolean(attestationPath),
          readable:true,
          nonEmpty:true,
          confirmationMode,
          completeListen:confirmationMode === 'human',
          qualityGatePassed:true
        }
      },
      {
        ...common,
        artifactId:`confirmed-transcript:${job.id}:v${job.output.confirmedTranscriptVersion}`,
        type:'confirmed_transcript',
        title:`${job.title}｜${confirmationMode === 'automatic' ? '系统确认稿' : '人工确认稿'}`,
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
          qualityGatePassed:true,
          evidenceLevel:job.output.evidenceLevel
        }
      }
    );
  }
  return artifacts;
}

function failureFor(job) {
  const failure = job.failure || {};
  return { code: 'xiaod_job_failed', message: typeof job.error === 'string' ? job.error : '小D任务失败。', userMessage: failure.recovery || '小D未能完成素材处理，请根据任务提示补充素材或稍后重试。', category: failure.category || 'manual', retryable: failure.retryable === true, stage: job.status, occurredAt: new Date().toISOString() };
}
