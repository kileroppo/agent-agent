#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPatch,
  upgradeFeishuReactionReliabilityPatch,
  upgradeFeishuSenderIdentityPatch,
} from './feishu-agent-proposal-router-patch-pack.mjs';
import {
  atomicWriteFile,
  defaultHermesTarget,
  resolveAndVerifyHermesTarget,
} from './patch-support.mjs';

export {
  assertSupportedHermesCompatibility,
  atomicWriteFile,
  SUPPORTED_HERMES_GIT_COMMIT,
  SUPPORTED_HERMES_VERSION,
  verifyHermesTarget,
} from './patch-support.mjs';
export {
  applyPatch,
  upgradeFeishuReactionReliabilityPatch,
  upgradeFeishuSenderIdentityPatch,
};

const adapterRelativePath = path.join('plugins', 'platforms', 'feishu', 'adapter.py');
const defaultAdapter = defaultHermesTarget(adapterRelativePath);
const semanticLayoutSource = fileURLToPath(new URL('../runtime/agent_army_feishu_layout.py', import.meta.url));
const taskCardRuntimeSource = fileURLToPath(new URL('../runtime/agent_army_feishu_task_card.py', import.meta.url));
const commanderEvidenceSource = fileURLToPath(new URL('../runtime/agent_army_feishu_commander_evidence.py', import.meta.url));

export async function installFeishuAgentProposalRouterPatch(input = defaultAdapter) {
  const { filePath } = await resolveAndVerifyHermesTarget(input, adapterRelativePath);
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  const semanticLayoutTarget = path.join(path.dirname(filePath), 'agent_army_layout.py');
  const taskCardRuntimeTarget = path.join(path.dirname(filePath), 'agent_army_task_card.py');
  const commanderEvidenceTarget = path.join(path.dirname(filePath), 'agent_army_commander_evidence.py');
  const [semanticLayout, taskCardRuntime, commanderEvidence] = await Promise.all([
    fs.readFile(semanticLayoutSource),
    fs.readFile(taskCardRuntimeSource),
    fs.readFile(commanderEvidenceSource),
  ]);
  const semanticLayoutChanged = await atomicWriteFile(semanticLayoutTarget, semanticLayout);
  const taskCardRuntimeChanged = await atomicWriteFile(taskCardRuntimeTarget, taskCardRuntime);
  const commanderEvidenceChanged = await atomicWriteFile(commanderEvidenceTarget, commanderEvidence);
  const adapterChanged = await atomicWriteFile(filePath, patched);
  const changed = semanticLayoutChanged || taskCardRuntimeChanged || commanderEvidenceChanged || adapterChanged;
  return {
    filePath,
    changed,
    message: changed
      ? `已安装 Hermes 飞书智能布局、动态任务卡、链路证据与军团总管路由：${filePath}`
      : `Hermes 飞书智能布局、动态任务卡与链路证据已存在：${filePath}`,
  };
}

async function main() {
  const result = await installFeishuAgentProposalRouterPatch(process.argv[2]);
  console.log(result.message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
