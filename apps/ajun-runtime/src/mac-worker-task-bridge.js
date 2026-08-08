import crypto from 'node:crypto';

const SUPPORTED_TASK_TYPES = new Set(['media.transcribe-and-refine']);

export class MacWorkerTaskBridge {
  constructor({ store, governance = null, token = process.env.AGENT_ARMY_WORKER_TOKEN || '', now = () => Date.now(), leaseMs = 120_000, onFailure = null } = {}) {
    this.store = store;
    this.governance = governance;
    this.token = String(token || '').trim();
    this.now = now;
    this.leaseMs = leaseMs;
    this.onFailure = onFailure;
    this.lastSeenAt = null;
    this.lastWorkerId = null;
  }

  enabled() { return this.token.length >= 32; }

  authorize(header) {
    const supplied = String(header || '').replace(/^Bearer\s+/i, '');
    if (!this.enabled() || supplied.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token));
  }

  async lease({ workerId, capabilities } = {}) {
    const id = clean(workerId, 120);
    if (!id) throw new MacWorkerBridgeError('Mac 工作间缺少稳定设备标识。', 'worker_id_required');
    const taskTypes = [...new Set((Array.isArray(capabilities) ? capabilities : [])
      .map((item) => clean(item, 120))
      .filter((item) => SUPPORTED_TASK_TYPES.has(item)))];
    if (!taskTypes.length) throw new MacWorkerBridgeError('Mac 工作间没有声明受支持的任务能力。', 'worker_capability_required');
    this.recordSeen(id);
    const task = await this.store.claimWorkerTask({ workerId:id, taskTypes, leaseMs:this.leaseMs, now:this.now() });
    return { job:task ? jobFor(task) : null, nextPollAfterMs:5_000 };
  }

  async heartbeat(taskId, { workerId, leaseId, stage, progress } = {}) {
    const id = clean(workerId, 120);
    const lease = clean(leaseId, 120);
    if (!id || !lease) throw new MacWorkerBridgeError('Mac 工作间心跳缺少租约信息。', 'worker_lease_required');
    this.recordSeen(id);
    const normalizedProgress = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Math.round(Number(progress)))) : null;
    const normalizedStage = clean(stage, 120) || 'working';
    return this.store.updateWorkerTask(String(taskId), {
      workerId:id,
      leaseId:lease,
      leaseMs:this.leaseMs,
      now:this.now(),
      extendLease:true,
      patch:{
        status:'running',
        currentStage:`mac_worker_${normalizedStage}`,
        execution:{ worker:{ stage:normalizedStage, ...(normalizedProgress === null ? {} : { progress:normalizedProgress }) } }
      }
    });
  }

  async complete(taskId, { workerId, leaseId, result } = {}) {
    const id = clean(workerId, 120);
    const lease = clean(leaseId, 120);
    if (!id || !lease) throw new MacWorkerBridgeError('Mac 工作间回报缺少租约信息。', 'worker_lease_required');
    this.recordSeen(id);
    const normalized = normalizeResult(String(taskId), id, result, this.now());
    let task = await this.store.updateWorkerTask(String(taskId), {
      workerId:id,
      leaseId:lease,
      now:this.now(),
      patch:normalized.patch
    });
    if (this.governance && task.governance?.paperclipIssueId) {
      task = await this.store.updateTask(task.taskId, { governance:await this.governance.update(task) });
    }
    if (task.status === 'failed' && typeof this.onFailure === 'function') {
      try { await this.onFailure(task); }
      catch { /* 任务失败事实已经保存；恢复协调器会在后续巡检继续处理。 */ }
    }
    return task;
  }

  snapshot(tasks = []) {
    const waiting = (tasks || []).filter((task) => task.status === 'waiting_worker').length;
    const active = (tasks || []).filter((task) => task.status === 'running' && task.execution?.mode === 'mac_worker').length;
    if (!this.enabled()) return { status:'blocked', detail:'云端尚未配置 Mac 工作间令牌；本机任务只会安全等待，不会外发凭据。', waiting, active };
    const recent = this.lastSeenAt && this.now() - Date.parse(this.lastSeenAt) <= Math.max(this.leaseMs, 120_000);
    if (recent) return { status:'ready', detail:`Mac工作间已连接${this.lastWorkerId ? `（${this.lastWorkerId}）` : ''}；${active} 项处理中，${waiting} 项等待。`, waiting, active, lastSeenAt:this.lastSeenAt };
    return { status:'waiting', detail:`云端接力已就绪，等待 Mac工作间连接；${waiting} 项任务正在安全排队。`, waiting, active };
  }

  recordSeen(workerId) {
    this.lastSeenAt = new Date(this.now()).toISOString();
    this.lastWorkerId = workerId;
  }
}

export class MacWorkerBridgeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function jobFor(task) {
  return {
    taskId:task.taskId,
    leaseId:task.execution.worker.leaseId,
    taskType:task.taskType,
    idempotencyKey:`agent-army:${task.taskId}`,
    input:{
      title:clean(task.input?.title, 500),
      sourceUrl:safePublicUrl(task.input?.sourceUrl)
    },
    leaseExpiresAt:task.execution.worker.leaseExpiresAt
  };
}

function normalizeResult(taskId, workerId, result, now) {
  const status = clean(result?.status, 40);
  const finishedAt = new Date(now).toISOString();
  if (status === 'succeeded') {
    const xiaodJobId = clean(result?.xiaodJobId, 160);
    const validation = result?.validation || {};
    const larkUrl = safeHttpsUrl(result?.larkUrl);
    if (!xiaodJobId
      || validation.exists !== true
      || validation.readable !== true
      || validation.nonEmpty !== true
      || !larkUrl
      || result?.larkPermissionGranted !== true) {
      throw new MacWorkerBridgeError('Mac 工作间成功回报缺少可验证产物。', 'worker_artifact_invalid');
    }
    const artifact = {
      artifactId:`xiaod-job:${xiaodJobId}`,
      taskId,
      type:'xiaod_media_delivery',
      title:clean(result?.title, 500) || '小D素材整理交付',
      location:`mac-worker://${encodeURIComponent(workerId)}/xiaod/${encodeURIComponent(xiaodJobId)}`,
      mimeType:'application/json',
      accessScope:'local-owner',
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        qualityPassed:validation.qualityPassed === true
      },
      createdAt:finishedAt,
      data:{
        larkUrl,
        larkPermissionGranted:true
      }
    };
    return {
      patch:{
        status:'succeeded',
        currentStage:'xiaod_completed',
        artifactRefs:[artifact],
        error:undefined,
        execution:{
          finishedAt,
          outcome:'succeeded',
          xiaodJobId,
          worker:{ state:'completed', finishedAt }
        }
      }
    };
  }
  if (status !== 'failed') throw new MacWorkerBridgeError('Mac 工作间回报状态无效。', 'worker_result_invalid');
  const code = clean(result?.error?.code, 120) || 'mac_worker_failed';
  const retryable = result?.error?.retryable === true;
  return {
    patch:{
      status:'failed',
      currentStage:'mac_worker_failed',
      artifactRefs:[],
      execution:{ finishedAt, outcome:'failed', worker:{ state:'failed', finishedAt } },
      error:{
        code,
        message:clean(result?.error?.message, 500) || 'Mac 工作间未能完成任务。',
        userMessage:clean(result?.error?.userMessage, 500) || 'Mac 工作间未能完成这项本机任务，已保留失败原因。',
        category:retryable ? 'retryable' : 'manual',
        retryable,
        stage:'mac_worker',
        occurredAt:finishedAt
      }
    }
  };
}

function safePublicUrl(value) {
  const parsed = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(parsed.protocol) || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new MacWorkerBridgeError('Mac 工作间任务只允许公开 HTTP(S) 素材链接。', 'worker_source_invalid');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function safeHttpsUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch { return null; }
}

function clean(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
