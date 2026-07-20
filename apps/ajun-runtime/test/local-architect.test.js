import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalArchitect } from '../src/local-architect.js';

test('架构师基于真实岗位清单给出能力与缺口，不改变边界', async () => {
  const registry = { async list() { return [
    { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] },
    { agentId:'future', name:'未来岗位', status:'draft', acceptedTaskTypes:['future.task'] }
  ]; } };
  const architect = new LocalArchitect({ registry, now: () => new Date('2026-07-20T08:00:00.000Z') });
  const result = await architect.execute({ taskId:'task-1', createdAt:'2026-07-20T07:00:00.000Z', input:{ title:'评估现有军团', description:'只评估本地岗位' }, execution:{} });
  const report = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded'); assert.equal(result.artifactRefs[0].type, 'architecture_review');
  assert.equal(report.currentCapabilities[0].agentId, 'operator'); assert.equal(report.capabilityGaps[0].agentId, 'future');
  assert.equal(report.externalActionStarted, false); assert.equal(report.architectureChanged, false);
});
