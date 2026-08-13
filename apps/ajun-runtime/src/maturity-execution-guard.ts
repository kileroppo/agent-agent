import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFile = promisify(execFileCallback);
const FIXTURE_FILE = 'docs/acceptance-fixtures/technical-repair-sandbox/calculator.js';
const FIXTURE_TEST = 'docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js';

export class MaturityExecutionGuardError extends Error {
  code = 'maturity_execution_guard_rejected';
  blockedTask: any;

  constructor(message: string, blockedTask: any = null) {
    super(message);
    this.name = 'MaturityExecutionGuardError';
    this.blockedTask = blockedTask;
  }
}

export class MaturityExecutionGuard {
  store: any;
  policy: any;
  now: () => Date;

  constructor({ store, policy, now = () => new Date() }: any = {}) {
    this.store = store;
    this.policy = policy;
    this.now = now;
  }

  async verify(task: any) {
    const mission = await this.#maturityMission(task);
    if (!mission) return null;
    if (mission === task) {
      try {
        return this.policy.verifyMissionAuthorization(task);
      } catch (error: any) {
        throw new MaturityExecutionGuardError(error?.message || '产品成熟度总任务验签失败，已停止执行。');
      }
    }
    if (!this.policy?.verifyTaskAuthorization) {
      throw new MaturityExecutionGuardError('产品成熟度执行策略不可用，已停止执行。');
    }
    try {
      return this.policy.verifyTaskAuthorization({ mission, task });
    } catch (error: any) {
      throw new MaturityExecutionGuardError(error?.message || '产品成熟度任务验签失败，已停止执行。');
    }
  }

  async verifyOrBlock(task: any) {
    try {
      return await this.verify(task);
    } catch (error: any) {
      const blocked = await this.store.updateTask(task.taskId, {
        status:'waiting_test',
        currentStage:'maturity_execution_blocked',
        execution:{
          ...(task.execution || {}),
          outcome:'maturity_execution_blocked',
          finishedAt:this.now().toISOString(),
        },
        error:{
          code:'maturity_execution_guard_rejected',
          message:String(error?.message || '产品成熟度执行验签失败。').slice(0, 500),
          userMessage:'产品成熟度任务没有通过固定权限、来源或零费用门禁，已停止且没有调用岗位执行器。',
          category:'governance',
          stage:'maturity_execution_guard',
          retryable:false,
          occurredAt:this.now().toISOString(),
        },
      });
      throw new MaturityExecutionGuardError(error?.message || '产品成熟度执行验签失败。', blocked);
    }
  }

  async execute(task: any, executor: any, options: any = {}) {
    const authorization = await this.verifyOrBlock(task);
    if (!authorization) return executor.execute(task, options);
    let result;
    try {
      if (authorization.executionMode === 'draft_only') {
        result = await executeCreatorDraftOnly(executor, task, options);
      } else if (authorization.executionMode === 'deterministic_fixture') {
        result = await executeDeterministicTechnicalFixture(executor, task);
      } else if (authorization.executionMode === 'local_draft_only') {
        result = await executeLocalDraftOnly(executor, task, options);
      } else if (authorization.executionMode === 'mission_plan') {
        result = await executor.execute(task, options);
      } else {
        throw new Error('产品成熟度任务没有已登记的确定性执行模式。');
      }
      assertZeroModelResult(task, result, authorization);
    } catch (error: any) {
      if (error?.blockedTask) throw error;
      throw await this.#blockedError(task, error?.message || '产品成熟度执行用量或副作用无法确认。');
    }
    return withKnownZeroUsage(result, authorization.executionMode);
  }

  async block(task: any, message: string) {
    throw await this.#blockedError(task, message || '产品成熟度任务未通过恢复门禁。');
  }

  async #maturityMission(task: any) {
    const taskSignalsMaturity = task?.input?.context?.productMaturityAuthorization?.kind === 'product-maturity-validation'
      || /^maturity-[0-9a-f-]{36}$/i.test(String(task?.source?.eventRef || ''));
    if (typeof this.store?.list !== 'function') {
      if (taskSignalsMaturity) throw new MaturityExecutionGuardError('产品成熟度任务无法解析父任务，已停止执行。');
      return null;
    }
    const tasks = await this.store.list();
    const rootMission = task?.taskType === 'army.cross-agent-mission'
      && task?.assigneeAgentId === 'ajun'
      && /^maturity-[0-9a-f-]{36}$/i.test(String(task?.input?.context?.productMaturityBatchId || ''));
    if (rootMission) {
      if (task.parentTaskId) throw new MaturityExecutionGuardError('产品成熟度总任务不能带父任务。');
      return task;
    }
    const mission = task?.parentTaskId
      ? tasks.find((item: any) => item.taskId === task.parentTaskId) || null
      : null;
    const parentSignalsMaturity = Boolean(mission?.input?.context?.productMaturityBatchId);
    if (!taskSignalsMaturity && !parentSignalsMaturity) return null;
    if (!mission || !parentSignalsMaturity) {
      throw new MaturityExecutionGuardError('产品成熟度任务父级缺失、错配或批次标记已丢失，已停止执行。');
    }
    return mission;
  }

  async #blockedError(task: any, message: string) {
    const blocked = await this.store.updateTask(task.taskId, {
      status:'waiting_test',
      currentStage:'maturity_execution_blocked',
      execution:{
        ...(task.execution || {}),
        outcome:'maturity_execution_blocked',
        finishedAt:this.now().toISOString(),
      },
      error:{
        code:'maturity_execution_guard_rejected',
        message:String(message).slice(0, 500),
        userMessage:'产品成熟度任务的用量、费用或副作用无法按零模型调用契约确认，已停止。',
        category:'governance',
        stage:'maturity_execution_guard',
        retryable:false,
        occurredAt:this.now().toISOString(),
      },
    });
    return new MaturityExecutionGuardError(message, blocked);
  }
}

async function executeCreatorDraftOnly(executor: any, task: any, { proposalInput = null }: any = {}) {
  if (!executor?.proposals?.create || !executor?.execute) {
    throw new Error('创建官缺少只创建草案所需的本机执行能力。');
  }
  const proposals = {
    create:executor.proposals.create.bind(executor.proposals),
    async submit() { throw new Error('产品成熟度验证只允许 draft_only，不提交审核。'); },
  };
  return executor.execute.call({ ...executor, proposals }, task, { proposalInput });
}

async function executeDeterministicTechnicalFixture(executor: any, task: any) {
  if (!executor?.workspace?.prepare || !executor?.execute) {
    throw new Error('技术专家缺少隔离工作区，确定性夹具验证已停止。');
  }
  const runner = {
    async run(_task: any, workspace: string) {
      const root = path.resolve(workspace);
      const target = safeWorkspacePath(root, FIXTURE_FILE);
      const testFile = safeWorkspacePath(root, FIXTURE_TEST);
      const source = await fs.readFile(target, 'utf8');
      const fixed = source.includes('return left + right;')
        ? source
        : source.replace('return left - right;', 'return left + right;');
      if (fixed === source && !source.includes('return left + right;')) {
        throw new Error('受控 calculator 夹具不是已登记的单行加法故障，已停止。');
      }
      if (fixed !== source) await fs.writeFile(target, fixed);
      const testRun = await execFile(process.execPath, ['--test', testFile], {
        cwd:root,
        timeout:30_000,
        maxBuffer:500_000,
      });
      const diff = await execFile('git', ['diff', '--name-only'], {
        cwd:root,
        timeout:10_000,
        maxBuffer:100_000,
      });
      const changedFiles = diff.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (changedFiles.length !== 1 || changedFiles[0] !== FIXTURE_FILE) {
        throw new Error('确定性夹具修复没有留下唯一允许文件的变更，已停止。');
      }
      return {
        status:'evidence_ready',
        evidence:{
          metadata:{
            agentArmyRepairEvidence:{
              changedFiles,
              testsPassed:true,
              testSummary:String(testRun.stdout || 'node --test passed').trim().slice(0, 2000),
              recoveryVerified:true,
              recoverySummary:'修复只存在于 acceptance-runs 隔离工作区；正式源码与 live release 未改动。',
              remainingTests:[],
            },
          },
        },
      };
    },
  };
  return executor.execute.call({ ...executor, runner, promotion:null }, task);
}

async function executeLocalDraftOnly(executor: any, task: any, options: any) {
  if (!executor?.execute || !executor?.scriptPackage?.execute) {
    throw new Error('小创缺少已登记的本地脚本包执行器，费用边界未知，已停止。');
  }
  const original = executor.scriptPackage;
  const scriptPackage = {
    execute:(inputTask: any, inputOptions: any) => original.execute(
      inputTask,
      { ...inputOptions, allowAdvisor:false, allowResearch:false },
    ),
  };
  const deterministicExecutor = Object.assign(
    Object.create(Object.getPrototypeOf(executor)),
    executor,
    { advisor:null, scriptPackage },
  );
  return executor.execute.call(deterministicExecutor, task, {
    ...options,
    allowAdvisor:false,
    allowResearch:false,
  });
}

function safeWorkspacePath(root: string, relative: string) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('受控夹具路径越出隔离工作区。');
  return target;
}

function assertZeroModelResult(task: any, result: any, authorization: any) {
  if (authorization.maxModelCalls !== 0 || authorization.maxCostUsd !== 0 || authorization.costKnown !== true) {
    throw new Error('产品成熟度执行没有锁定为 0 次模型调用和已知 0 USD。');
  }
  const reportedCalls = result?.usage?.model?.apiCalls;
  const reportedCost = result?.usage?.cost || result?.usage?.model?.cost;
  if (reportedCalls != null && Number(reportedCalls) !== 0) throw new Error('产品成熟度执行产生了未授权模型调用。');
  if (reportedCost != null && (Number(reportedCost.amount) !== 0 || String(reportedCost.currency || '').toUpperCase() !== 'USD')) {
    throw new Error('产品成熟度执行费用不是已知 0 USD。');
  }
  if (task.taskType === 'governance.agent-proposal') {
    const proposal = result?.artifactRefs?.find((item: any) => item.type === 'agent_proposal')?.data;
    if (proposal?.status !== 'draft' || proposal?.reviewSubmission?.status !== 'pending') {
      throw new Error('创建官成熟度验证没有保持 draft_only。');
    }
  }
  if (task.taskType === 'operations.technical-repair') {
    const verification = result?.execution?.verification;
    if (verification?.testsPassed !== true || verification?.recoveryVerified !== true || verification?.acceptanceOnly !== true) {
      throw new Error('技术专家成熟度验证缺少确定性测试、恢复或 acceptance-only 证据。');
    }
  }
  if (task.taskType === 'content.video-script-package') {
    const artifact = result?.artifactRefs?.find((item: any) => item.type === 'video_script_package');
    if (!artifact || artifact.validation?.externalSideEffects !== 0
      || artifact.data?.generationMode !== 'deterministic_fallback'
      || !['not_required', 'disabled'].includes(String(artifact.data?.researchStatus || ''))
      || artifact.data?.templateLifecycle?.approvedForUse !== false) {
      throw new Error('小创成熟度验证没有证明本地待审、无 Advisor 且零外部副作用。');
    }
  }
}

function withKnownZeroUsage(result: any, mode: string) {
  return {
    ...result,
    artifactRefs:Array.isArray(result?.artifactRefs)
      ? result.artifactRefs.map(withContentDigest)
      : result?.artifactRefs,
    usage:{
      ...(result?.usage || {}),
      model:{ provider:'deterministic-local', model:mode, inputTokens:0, outputTokens:0, apiCalls:0 },
      cost:{ amount:0, currency:'USD', basis:'included', source:'maturity_zero_model_contract' },
    },
  };
}

function withContentDigest(artifact: any) {
  const checksum = typeof artifact?.checksum === 'string'
    && /^[0-9a-f]{64}$/i.test(artifact.checksum)
    ? artifact.checksum.toLowerCase()
    : crypto.createHash('sha256').update(stableJson({
      type:artifact?.type || null,
      data:artifact?.data ?? null,
      validation:artifact?.validation ?? null,
    })).digest('hex');
  return { ...artifact, checksum };
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
