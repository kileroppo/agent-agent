import crypto from 'node:crypto';
import { CapabilityExecutionEngine } from '../workflow/capability-execution.ts';
import { createCapabilityEventRecorder } from '../workflow/capability-event-recorder.ts';
import { createPublicWebReadRoutes } from './public-content-capability-adapters.ts';

type Reader = Readonly<{ acquire(input: Readonly<Record<string, unknown>>): Promise<any> }>;
type DynamicReader = Readonly<{ read(input: Readonly<Record<string, unknown>>): Promise<any> }>;

export class RoutedPublicWebReader {
  readonly primary: Reader;
  readonly engine: CapabilityExecutionEngine;

  constructor({ primary, fallback, eventStore }: {
    primary: Reader;
    fallback: DynamicReader;
    eventStore?: any;
  }) {
    this.primary = primary;
    this.engine = new CapabilityExecutionEngine({
      routes:createPublicWebReadRoutes({ publicWebFetch:primary, publicDynamicWebReader:fallback }),
      onReceipt:eventStore ? createCapabilityEventRecorder(eventStore) : undefined,
    });
  }

  async acquire(input: Readonly<{ sourceUrl?: string; task?: any }>) {
    const task = input?.task;
    if (!task?.taskId) return this.primary.acquire({ sourceUrl:input?.sourceUrl });
    const capabilityId = 'public-web.read';
    const result = await this.engine.invoke({
      request:{
        requestId:crypto.randomUUID(),
        workflowId:String(task.workflow?.workflowId || `workflow:${task.taskId}`),
        stepId:String(task.workflow?.step?.stepId || task.currentStage || 'public-web-read'),
        taskId:String(task.taskId),
        agentId:String(task.assigneeAgentId || 'intel-researcher'),
        capabilityId,
        dataClass:'public',
        sideEffect:'read',
        maxCostUsd:0,
        costKnown:true,
        crossDevice:false,
        requiresCredentials:false,
      },
      policy:{ manifestCapabilities:[capabilityId], taskBudgetUsd:0 },
      payload:{ sourceUrl:input?.sourceUrl },
    });
    return result.output;
  }
}
