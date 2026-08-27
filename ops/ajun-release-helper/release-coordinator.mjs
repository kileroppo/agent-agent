import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIVE_STATES = new Set([
  'checking',
  'preparing_source',
  'verifying',
  'freezing',
  'activating',
  'verifying_live',
  'rolling_back',
]);

const CONFIRMATIONS = Object.freeze({
  publish:'publish_current_commit',
  rollback:'rollback_previous_release',
});

const STAGE_TIMEOUTS_MS = Object.freeze({
  checking:60_000,
  preparing_source:180_000,
  verifying:360_000,
  freezing:240_000,
  activating:120_000,
  verifying_live:120_000,
  rolling_back:120_000,
});

export class ReleaseCoordinator {
  constructor({ stateDir, adapter, clock = () => new Date(), randomUUID = crypto.randomUUID } = {}) {
    if (!stateDir) throw new Error('缺少发布状态目录');
    if (!adapter?.inspect) throw new Error('缺少发布检查适配器');
    this.stateDir = path.resolve(stateDir);
    this.statePath = path.join(this.stateDir, 'status.json');
    this.adapter = adapter;
    this.clock = clock;
    this.randomUUID = randomUUID;
    this.state = idleState(this.clock());
    this.running = null;
    this.stageTimer = null;
  }

  async initialize() {
    await fs.mkdir(this.stateDir, { recursive:true, mode:0o700 });
    try {
      const stored = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      this.state = ACTIVE_STATES.has(stored.state)
        ? { ...stored, state:'failed', message:'上次发布助手意外退出，请重新检查。', finishedAt:this.clock().toISOString() }
        : stored;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.persist();
    return this.status();
  }

  status() {
    if (!this.running && ACTIVE_STATES.has(this.state.state)) {
      const updatedTime = new Date(this.state.updatedAt).getTime();
      const nowTime = this.clock().getTime();
      if (nowTime - updatedTime > 600_000) {
        this.state = {
          ...this.state,
          state:'failed',
          message:'执行状态已超时脱轨，已自动复位。请重新检查。',
          finishedAt:this.clock().toISOString(),
        };
        this.persist().catch(() => {});
      }
    }
    return structuredClone(this.state);
  }

  armStageWatchdog(stage) {
    if (this.stageTimer) clearTimeout(this.stageTimer);
    const timeoutMs = STAGE_TIMEOUTS_MS[stage] || 300_000;
    this.stageTimer = setTimeout(() => {
      const error = new Error(`阶段【${stage}】执行超时（${Math.round(timeoutMs / 1000)}秒），已自动熔断。请重新检查。`);
      this.running = null;
      this.update({
        state:'failed',
        candidate:candidateValidation(this.state.candidate, 'not_completed'),
        message:publicError(error),
        finishedAt:this.clock().toISOString(),
      }).catch(() => {});
    }, timeoutMs);
    this.stageTimer.unref?.();
  }

  clearStageWatchdog() {
    if (this.stageTimer) {
      clearTimeout(this.stageTimer);
      this.stageTimer = null;
    }
  }

  async start(action, input = {}) {
    if (!['check', 'publish', 'rollback'].includes(action)) throw new ReleaseRequestError(404, '未知发布动作。');
    if (this.running || ACTIVE_STATES.has(this.state.state)) {
      return { accepted:false, duplicate:true, status:this.status() };
    }
    if (CONFIRMATIONS[action] && input.confirm !== CONFIRMATIONS[action]) {
      throw new ReleaseRequestError(400, action === 'publish' ? '请确认发布当前正式版本。' : '请确认退回上一版。');
    }
    const now = this.clock().toISOString();
    const initialStage = action === 'check' ? 'checking' : action === 'publish' ? 'preparing_source' : 'rolling_back';
    this.state = {
      schemaVersion:'agent.army/self-service-release-status/v1',
      runId:this.randomUUID(),
      action,
      state:initialStage,
      message:action === 'check' ? '正在检查正式仓库与线上版本。' : action === 'publish' ? '正在重新核对候选版本。' : '正在核对可回滚版本。',
      startedAt:now,
      updatedAt:now,
      finishedAt:null,
      current:null,
      candidate:null,
      rollback:null,
    };
    await this.persist();
    this.armStageWatchdog(initialStage);
    this.running = this.execute(action).finally(() => {
      this.clearStageWatchdog();
      this.running = null;
    });
    return { accepted:true, duplicate:false, status:this.status() };
  }

  async wait() {
    await this.running;
    return this.status();
  }

  async execute(action) {
    try {
      this.armStageWatchdog(action === 'check' ? 'checking' : 'preparing_source');
      const inspection = await this.adapter.inspect();
      await this.update({ current:inspection.current, candidate:inspection.candidate, rollback:inspection.rollback || null });
      if (action === 'check') {
        await this.update({
          state:inspection.canPublish ? 'ready' : inspection.updateAvailable ? 'blocked' : 'up_to_date',
          message:inspection.message,
          finishedAt:this.clock().toISOString(),
        });
        return;
      }
      if (action === 'publish') {
        if (!inspection.canPublish) throw new Error(inspection.message || '当前版本不能发布。');
        const result = await this.adapter.publish({ inspection, onStage:(stage, message) => {
          this.armStageWatchdog(stage);
          return this.update({
            state:stage,
            message,
            candidate:stage === 'verifying' || stage === 'freezing'
              ? candidateValidation(this.state.candidate, 'running')
              : this.state.candidate,
          });
        } });
        await this.update({
          ...result,
          candidate:candidateForLiveRelease(this.state.candidate, result.current, {
            validationStatus:'passed',
            verifiedAt:this.clock().toISOString(),
          }),
          state:'succeeded',
          message:'新版已发布，并已核对运行身份和恢复入口。',
          finishedAt:this.clock().toISOString(),
        });
        return;
      }
      const result = await this.adapter.rollback({ inspection, onStage:(stage, message) => {
        this.armStageWatchdog(stage);
        return this.update({ state:stage, message });
      } });
      await this.update({
        ...result,
        candidate:candidateForLiveRelease(this.state.candidate, result.current),
        state:'succeeded',
        message:'已退回上一版并通过运行检查。',
        finishedAt:this.clock().toISOString(),
      });
    } catch (error) {
      if (error?.releaseActive === true) {
        await this.update({
          current:error.current || this.state.current,
          rollback:error.rollback || this.state.rollback,
          candidate:candidateForLiveRelease(this.state.candidate, error.current, {
            validationStatus:'passed',
            verifiedAt:this.clock().toISOString(),
          }),
          state:'succeeded',
          message:'新版已上线并核对运行身份；正式历史写入失败，临时恢复记录仍可用于回滚，请重新检查以重建历史。',
          finishedAt:this.clock().toISOString(),
        });
        return;
      }
      const rolledBack = error?.rolledBack === true;
      await this.update({
        state:rolledBack ? 'rolled_back' : 'failed',
        candidate:candidateValidation(this.state.candidate, ACTIVE_STATES.has(this.state.state) ? 'not_completed' : undefined),
        message:rolledBack ? '新版未通过检查，已自动恢复旧版。' : publicError(error),
        finishedAt:this.clock().toISOString(),
      });
    }
  }

  async update(patch) {
    if (this.state.finishedAt && !patch.finishedAt && !ACTIVE_STATES.has(this.state.state)) {
      return;
    }
    this.state = { ...this.state, ...patch, updatedAt:this.clock().toISOString() };
    await this.persist();
  }

  async persist() {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode:0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.statePath);
  }
}

export class ReleaseRequestError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.name = 'ReleaseRequestError';
    this.httpStatus = httpStatus;
  }
}

function idleState(now) {
  const at = now.toISOString();
  return {
    schemaVersion:'agent.army/self-service-release-status/v1',
    runId:null,
    action:null,
    state:'idle',
    message:'尚未检查新版。',
    startedAt:null,
    updatedAt:at,
    finishedAt:null,
    current:null,
    candidate:null,
    rollback:null,
  };
}

function publicError(error) {
  const message = String(error?.message || '发布助手执行失败。').replace(/[\r\n]+/g, ' ').trim();
  return message.slice(0, 240) || '发布助手执行失败。';
}

function candidateValidation(candidate, status, verifiedAt = null) {
  if (!candidate || !status) return candidate || null;
  return {
    ...candidate,
    validation:{
      status,
      verifiedAt:status === 'passed' ? verifiedAt : null,
    },
  };
}

function candidateForLiveRelease(candidate, current, { validationStatus, verifiedAt = null } = {}) {
  if (!candidate) return null;
  const gitHead = String(candidate.gitHead || '');
  const liveGitHead = String(current?.gitHead || '');
  const comparisonAvailable = Boolean(gitHead && liveGitHead);
  const onLiveRelease = comparisonAvailable && gitHead === liveGitHead;
  const publishable = comparisonAvailable && candidate.clean === true && candidate.branch === 'main' && !onLiveRelease;
  return {
    ...candidate,
    committed:candidate.committed === true || /^[0-9a-f]{40}$/i.test(gitHead),
    publishable,
    undeployed:comparisonAvailable && !onLiveRelease,
    validation:validationStatus
      ? { status:validationStatus, verifiedAt:validationStatus === 'passed' ? verifiedAt : null }
      : candidate.validation || { status:'not_checked', verifiedAt:null },
  };
}
