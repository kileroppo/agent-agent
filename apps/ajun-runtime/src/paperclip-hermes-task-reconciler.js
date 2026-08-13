import { validateTaskCompletion } from './task-completion-contract.ts';
import {
  PaperclipAssignmentCompletion,
  pendingPaperclipCompletion,
} from './paperclip-assignment-completion.js';

const FAILURE_STATUSES = new Set(['blocked', 'failed']);

export class PaperclipHermesTaskReconciler {
  constructor({ store, governance, fallback = null, now = () => Date.now(), intervalMs = 10_000 } = {}) {
    this.store = store;
    this.governance = governance;
    this.fallback = fallback;
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
    await Promise.all(tasks.filter((task) => pendingPaperclipCompletion(task)).map((task) => this.reconcilePendingCompletion(task)));
    await Promise.all(tasks.filter(isDelegatedHermesTask).map((task) => this.reconcileTask(task)));
  }

  async reconcilePendingCompletion(task) {
    if (!pendingPaperclipCompletion(task)) return;
    await this.assignmentCompletion().reconcilePending(task);
  }

  async reconcileTask(task) {
    let issue;
    try {
      issue = await this.governance.getPaperclipIssue(task.governance.paperclipIssueId);
    } catch {
      // Paperclip 短时不可用不应改写业务真相，也不刷新任务时间戳。
      return;
    }

    if (issue?.status === 'cancelled') {
      await this.settle(task, {
        status:'cancelled',
        currentStage:'paperclip_hermes_cancelled',
        outcome:'cancelled_in_paperclip',
        error:null
      });
      return;
    }

    if (FAILURE_STATUSES.has(issue?.status)) {
      const hasArtifact = hasReadableArtifact(task);
      if (await this.tryLocalEvidenceFallback(task, issue)) return;
      await this.settle(task, hasArtifact ? {
        status:'waiting_test',
        currentStage:'paperclip_hermes_waiting_test',
        outcome:'artifact_requires_review',
        error:task.error || taskFailure(
          'paperclip_hermes_requires_review',
          'Paperclip 已结束本次运行，但本机保留了可读产物；需要人工核对后再决定是否采用。',
          this.now()
        )
      } : {
        status:'failed',
        currentStage:'paperclip_hermes_failed',
        outcome:'paperclip_hermes_failed',
        error:task.error || taskFailure(
          'paperclip_hermes_failed',
          'Paperclip 已结束本次运行，且没有可验证产物；任务已如实记为失败。',
          this.now()
        )
      });
      return;
    }

    if (issue?.status === 'done') {
      const completion = validateTaskCompletion(task);
      const hasArtifact = completion.valid;
      await this.settle(task, hasArtifact ? {
        status:'succeeded',
        currentStage:'paperclip_hermes_completed',
        outcome:'verified_artifact_ready',
        error:null
      } : {
        status:'waiting_test',
        currentStage:'paperclip_hermes_evidence_missing',
        outcome:'paperclip_done_without_local_evidence',
        error:taskFailure(
          'paperclip_hermes_evidence_missing',
          'Paperclip 已标记完成，但 A君没有找到可验证的本地产物；已转为待测试，不冒充完整成功。',
          this.now()
        )
      });
    }
  }

  async tryLocalEvidenceFallback(task, issue) {
    if (task.taskType !== 'content.video-benchmark-analysis') return false;
    const expectedIntent = expectedAnalysisIntent(task.input);
    let result = {
      artifactRefs:task.artifactRefs || [],
      usage:task.usage,
      execution:task.execution,
    };
    let artifact = result.artifactRefs.find((candidate) => (
      validLocalEvidenceReport(candidate, expectedIntent, task.input?.evidenceMode)
    ));
    if (!artifact && typeof this.fallback !== 'function') return false;
    try {
      if (!artifact) result = await this.fallback(task, { issue });
    } catch {
      return false;
    }
    artifact = artifact || (result?.artifactRefs || []).find((candidate) => (
      validLocalEvidenceReport(candidate, expectedIntent, task.input?.evidenceMode)
    ));
    if (!artifact) return false;
    const requiresReview = expectedIntent === 'deep';
    const currentStage = requiresReview
      ? 'local_evidence_fallback_waiting_test'
      : 'local_evidence_fallback_ready';
    const finishedAt = new Date(this.now()).toISOString();
    await this.store.updateTask(task.taskId, {
      status:requiresReview ? 'waiting_test' : 'succeeded',
      currentStage,
      execution:{
        ...(task.execution || {}),
        ...(result.execution || {}),
        owner:'local-evidence-fallback',
        finishedAt,
        outcome:currentStage
      },
      usage:result.usage || task.usage,
      artifactRefs:mergeArtifactRefs(task.artifactRefs, result.artifactRefs),
      error:requiresReview ? taskFailure(
        'local_evidence_fallback_requires_review',
        'Hermes 未能完成深度分析；本机已生成证据化 13 模块报告，需人工核对后采用。',
        this.now()
      ) : null
    });
    return true;
  }

  async settle(task, { status, currentStage, outcome, error }) {
    const finishedAt = new Date(this.now()).toISOString();
    await this.store.updateTask(task.taskId, {
      status,
      currentStage,
      execution:{ ...(task.execution || {}), finishedAt, outcome },
      error
    });
  }

  assignmentCompletion() {
    return new PaperclipAssignmentCompletion({
      store:this.store,
      governance:this.governance,
      now:() => new Date(this.now()).toISOString(),
    });
  }
}

function mergeArtifactRefs(existing = [], added = []) {
  const merged = new Map();
  for (const artifact of [...existing, ...added]) {
    const key = artifact?.artifactId
      || `${artifact?.type || 'unknown'}:${artifact?.checksum || artifact?.location || merged.size}`;
    merged.set(key, artifact);
  }
  return [...merged.values()];
}

function isDelegatedHermesTask(task) {
  return task?.status === 'running'
    && task.taskType !== 'operations.technical-repair'
    && task.execution?.owner === 'paperclip-hermes'
    && Boolean(task.governance?.paperclipIssueId);
}

function hasReadableArtifact(task) {
  return (task.artifactRefs || []).some((artifact) =>
    artifact?.validation?.exists === true
    && artifact.validation.readable === true
    && artifact.validation.nonEmpty === true
  );
}

function expectedAnalysisIntent(input = {}) {
  const structured = String(input?.analysisIntent || '').trim().toLowerCase();
  if (['digest', 'deep', 'template', 'style'].includes(structured)) return structured;
  return input?.depth === 'full' ? 'deep' : 'digest';
}

function validLocalEvidenceReport(artifact, expectedIntent, evidenceMode) {
  const validation = artifact?.validation || {};
  const data = artifact?.data || {};
  return artifact?.type === 'video_content_analysis_report'
    && validation.exists === true
    && validation.readable === true
    && validation.nonEmpty === true
    && validation.modeStructurePassed === true
    && validation.claimsEvidenceLinked === true
    && (evidenceMode !== 'formal' || validation.formalSourceConfirmed === true)
    && validation.analysisIntent === expectedIntent
    && validation.reportVersion === 'video-analysis/v2'
    && data.analysisIntent === expectedIntent
    && data.reportVersion === 'video-analysis/v2'
    && data.generationMode === 'deterministic_fallback'
    && Boolean(data.sourceTranscriptArtifactId)
    && Array.isArray(artifact.sourceRefs)
    && artifact.sourceRefs.includes(data.sourceTranscriptArtifactId);
}

function taskFailure(code, userMessage, now) {
  return {
    code,
    message:userMessage,
    userMessage,
    category:'manual',
    stage:'paperclip_hermes',
    retryable:false,
    occurredAt:new Date(now).toISOString()
  };
}
