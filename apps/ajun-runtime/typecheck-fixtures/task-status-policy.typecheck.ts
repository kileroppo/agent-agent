import { TASK_STATUS_POLICIES, taskStatusPolicy } from '@task-status-policy';
import type { TaskStatus } from '../src/task-lifecycle.ts';

const known = taskStatusPolicy('running');
const knownStatus: TaskStatus = known.status;
void knownStatus;
void TASK_STATUS_POLICIES.running;

// @ts-expect-error 策略表只能按完整生命周期状态索引。
void TASK_STATUS_POLICIES.planned;

declare const persistedStatus: string;
const unknown = taskStatusPolicy(persistedStatus);
const unknownLabel: string = unknown.label;
void unknownLabel;

// @ts-expect-error 未知持久化状态不能伪装为当前生命周期状态。
const mustBeKnown: TaskStatus = unknown.status;
void mustBeKnown;
