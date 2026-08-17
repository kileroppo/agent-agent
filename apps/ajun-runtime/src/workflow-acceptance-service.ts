import crypto from 'node:crypto';
import { ValidationError } from './task-validation-error.ts';
import { evaluateWorkflow } from './workflow/evaluation.ts';
import type { WorkflowAcceptanceDecision, WorkflowAcceptanceSource } from './workflow-acceptance-record.ts';

export class WorkflowAcceptanceService {
  store: any;

  constructor({ store }: any = {}) {
    this.store = store;
  }

  async record(workflowId: unknown, input: any = {}): Promise<any> {
    const id = validIdentifier(workflowId, 160);
    if (!id) throw validationError('工作流编号无效。', 'workflow_acceptance_workflow_id_invalid');
    const decision = normalizeDecision(input.decision);
    if (!decision) throw validationError('验收结论必须是 accepted 或 revision_required。', 'workflow_acceptance_decision_invalid');
    const source = normalizeSource(input.source);
    if (!source) throw validationError('验收来源无效。', 'workflow_acceptance_source_invalid');
    const note = clean(input.note, 300);
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion ?? input.expectedRevision);
    const idempotencyKey = validIdentifier(input.idempotencyKey, 200);

    if (!idempotencyKey) throw validationError('缺少本次操作编号，请刷新后重试。', 'workflow_acceptance_idempotency_key_invalid');
    if (typeof this.store?.recordWorkflowAcceptance !== 'function') {
      throw validationError('当前存储尚未支持工作流验收，请升级后重试。', 'workflow_acceptance_store_unsupported');
    }
    const [tasks, current] = await Promise.all([
      workflowTasks(this.store, id),
      this.store.getWorkflowAcceptance?.(id) || null,
    ]);
    if (!tasks.length) throw validationError('找不到要验收的工作流。', 'workflow_acceptance_workflow_not_found');
    const normalized = { workflowId:id, decision, note, source, expectedVersion, idempotencyKey };
    const replay = current?.idempotencyReceipts?.find((receipt: any) => receipt.key === idempotencyKey);
    if (!replay) {
      const evaluation = evaluateWorkflow(id, tasks, current);
      if (evaluation.workKind !== 'business') {
        throw validationError('测试或系统任务不需要你验收。', 'workflow_acceptance_not_business_work');
      }
      if (evaluation.status !== 'waiting_acceptance') {
        throw validationError('这件工作当前不在等待验收，已保留现有状态。', 'workflow_acceptance_not_eligible');
      }
    }
    return this.store.recordWorkflowAcceptance(normalized);
  }
}

export function workflowAcceptanceIdempotencyKey(prefix: string, input: unknown): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
  return `${prefix}:${digest}`.slice(0, 200);
}

async function workflowTasks(store: any, workflowId: string): Promise<any[]> {
  if (typeof store?.listWorkflowTasks === 'function') return store.listWorkflowTasks(workflowId);
  return (await store.list()).filter((task: any) => task?.workflow?.workflowId === workflowId);
}

function normalizeDecision(value: unknown): WorkflowAcceptanceDecision | null {
  return value === 'accepted' || value === 'revision_required' ? value : null;
}

function normalizeSource(value: unknown): WorkflowAcceptanceSource | null {
  return value === 'feishu_feedback' || value === 'local_console' ? value : null;
}

function normalizeExpectedVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw validationError('验收版本号无效，请刷新后重试。', 'workflow_acceptance_version_invalid');
  }
  return number;
}

function validIdentifier(value: unknown, limit: number): string {
  const text = clean(value, limit);
  return /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(text) ? text : '';
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function validationError(message: string, code: string): ValidationError {
  const error = new ValidationError(message) as ValidationError & { code: string };
  error.code = code;
  return error;
}
