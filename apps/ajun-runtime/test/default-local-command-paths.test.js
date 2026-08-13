import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HermesContentGrowthAdvisor } from '../src/hermes-content-growth-advisor.js';
import { HermesConversationAdvisor } from '../src/hermes-conversation-advisor.js';
import { HermesIntelResearchAdvisor } from '../src/hermes-intel-research-advisor.js';
import { HermesIntentPlanner } from '../src/hermes-intent-planner.js';
import { HermesModelSetupService } from '../src/hermes-model-setup-service.js';
import { HermesPublicComparisonAdvisor } from '../src/hermes-public-comparison-advisor.js';
import { HermesPublicSummaryAdvisor } from '../src/hermes-public-summary-advisor.js';
import { HermesTaskAdvisor } from '../src/hermes-task-advisor.js';
import { TechnicalExpertRunner } from '../src/technical-expert-runner.ts';
import { TechnicalRepairDiagnoser } from '../src/technical-repair-diagnoser.ts';

test('Hermes 与 Codex 默认命令由当前 home 组合，不固化开发机用户名', () => {
  const previousHermes = process.env.AJUN_HERMES_COMMAND;
  const previousCodex = process.env.AJUN_CODEX_COMMAND;
  delete process.env.AJUN_HERMES_COMMAND;
  delete process.env.AJUN_CODEX_COMMAND;
  try {
    const hermes = path.join(os.homedir(), '.local', 'bin', 'hermes');
    const codex = path.join(os.homedir(), '.local', 'bin', 'codex');
    for (const Runtime of [
      HermesContentGrowthAdvisor,
      HermesConversationAdvisor,
      HermesIntelResearchAdvisor,
      HermesIntentPlanner,
      HermesModelSetupService,
      HermesPublicComparisonAdvisor,
      HermesPublicSummaryAdvisor,
      HermesTaskAdvisor,
    ]) {
      assert.equal(new Runtime().command, hermes);
    }
    assert.equal(new TechnicalExpertRunner().command, codex);
    assert.equal(new TechnicalRepairDiagnoser().command, codex);
  } finally {
    if (previousHermes === undefined) delete process.env.AJUN_HERMES_COMMAND;
    else process.env.AJUN_HERMES_COMMAND = previousHermes;
    if (previousCodex === undefined) delete process.env.AJUN_CODEX_COMMAND;
    else process.env.AJUN_CODEX_COMMAND = previousCodex;
  }
});
