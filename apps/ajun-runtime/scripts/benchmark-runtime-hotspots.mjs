import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from '../src/agent-registry.ts';
import { DEFAULT_TASK_DEFINITION_REGISTRY } from '../src/task-definition-registry.ts';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(runtimeRoot, '../..');
const baseline = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'performance-baseline.json'), 'utf8'));

const registry = new AgentRegistry({ agentsDir:path.join(repositoryRoot, 'agents') });
await registry.list({ includeManagers:true, includeInactive:true });
const measurements = {
  agentRegistry100Lists:await measure(async () => {
    for (let index = 0; index < 100; index += 1) {
      await registry.list({ includeManagers:true, includeInactive:true });
    }
  }),
  directTaskType500k:await measure(() => {
    const agentIds = ['xiaod', 'operator', 'architect', 'office-assistant', 'intel-researcher', 'content-creator'];
    for (let index = 0; index < 500_000; index += 1) {
      DEFAULT_TASK_DEFINITION_REGISTRY.directTaskType(agentIds[index % agentIds.length]);
    }
  }),
};

let failed = false;
for (const [name, result] of Object.entries(measurements)) {
  const baselineMs = baseline.workloads[name].medianMs;
  const changePercent = ((result.medianMs - baselineMs) / baselineMs) * 100;
  const limitMs = baselineMs * (1 + baseline.maxRegressionPercent / 100);
  console.log(`${name}: ${baselineMs.toFixed(3)}ms -> ${result.medianMs.toFixed(3)}ms (${formatPercent(changePercent)})`);
  if (result.medianMs > limitMs) failed = true;
}
if (failed) throw new Error(`运行热路径超过 ${baseline.maxRegressionPercent}% 回退门禁。`);

async function measure(operation, rounds = 7) {
  const samples = [];
  for (let round = 0; round < rounds; round += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return { medianMs:samples[Math.floor(samples.length / 2)] };
}

function formatPercent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
