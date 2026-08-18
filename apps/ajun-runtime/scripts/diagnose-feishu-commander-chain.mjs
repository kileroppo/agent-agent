#!/usr/bin/env node
// 飞书军团总管链路本机诊断入口（唯一诊断入口，进程外运行）
//
//   npm run diagnose:feishu-chain                          # 中文逐项表格
//   npm run diagnose:feishu-chain -- --json                # 机器可读 diagnosis/v1
//   npm run diagnose:feishu-chain -- --requester <open_id> # 额外判定飞书准入白名单是否命中
//
// 关键属性：**不依赖 4321，也不依赖 npm install。**
// 只 import Node 内建模块与仓库内零第三方依赖文件，因此在依赖未安装、4321 未监听、
// Hermes Gateway 未起的最坏情况下仍能跑完并给出结论。
//
// 只读、零外部副作用、输出零凭据：不读 .env，不回显环境变量原值 / token / Cookie / 授权链接。
// **不新增任何 HTTP 端点，不新建平行控制面。**
//
// 退出码：0 = no_local_gap_found；1 = blocking_gap；2 = diagnosis_incomplete。

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DeterministicLocalHealthProbe } from '../src/deterministic-local-health-probe.ts';
import {
  CHAIN_CHECK_IDS,
  GATEWAY_LAUNCHD_LABEL,
  diagnoseFeishuCommanderChain,
} from '../src/feishu-commander-chain-diagnosis.ts';
import { digestRef, observeFeishuCommanderChain, resolveHermesAgentRoot } from '../src/feishu-commander-chain-observations.ts';
import {
  EVIDENCE_DIRECTORY_NAME,
  createFeishuCommanderChainEvidenceLedger,
  readCommanderChainEvidenceFiles,
} from '../src/feishu-commander-chain-evidence.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, '..');
const repositoryRoot = path.resolve(runtimeRoot, '../..');

const EXIT_CODE_BY_VERDICT = Object.freeze({
  no_local_gap_found:0,
  blocking_gap:1,
  diagnosis_incomplete:2,
});

const TRUTH_LAYER_LABELS = Object.freeze({
  declared:'已声明',
  configured:'已配置',
  reachable:'运行可达',
});

const STATUS_LABELS = Object.freeze({ pass:'通过', gap:'缺口', unknown:'判定不出' });

export function parseArguments(argv) {
  const options = { json:false, requesterRef:null, help:false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') { options.json = true; continue; }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (argument === '--requester') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--requester 需要一个飞书 open_id 参数。');
      options.requesterRef = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--requester=')) {
      options.requesterRef = argument.slice('--requester='.length);
      continue;
    }
    throw new Error(`无法识别的参数：${argument}`);
  }
  return options;
}

export function renderUsage() {
  return [
    '用法：npm run diagnose:feishu-chain [-- --json] [-- --requester <open_id>]',
    '',
    '  --json                 输出 agent.army/feishu-commander-chain-diagnosis/v1',
    '  --requester <open_id>  额外判定该发送者是否命中飞书准入白名单（只以摘要呈现）',
    '',
    '退出码：0 未发现本机缺口；1 存在阻断缺口；2 诊断自身无法完成。',
  ].join('\n');
}

// 命令执行机制沿用 ops/ajun-release-helper/system-adapter.mjs 的 defaultRunCommand。
// 它在非零退出时 reject 且不带 stdout/stderr，而只读诊断必须能区分
// 「launchctl 服务未加载 / PlistBuddy 缺键」与「命令不可用」，
// 因此失败路径再以同样的 spawn 机制重放一次只读命令以取回输出。
async function createCommandRunner() {
  let defaultRunCommand = null;
  try {
    ({ defaultRunCommand } = await import('../../../ops/ajun-release-helper/system-adapter.mjs'));
  } catch {
    defaultRunCommand = null;
  }
  return async function runCommand(file, args) {
    if (defaultRunCommand) {
      try {
        const result = await defaultRunCommand(file, [...args]);
        return { code:result.code ?? 0, stdout:result.stdout ?? '', stderr:result.stderr ?? '' };
      } catch (error) {
        if (isCommandMissing(error)) throw error;
      }
    }
    return captureReadOnlyCommand(file, args);
  };
}

function isCommandMissing(error) {
  return error?.code === 'ENOENT' || /ENOENT/.test(String(error?.message || ''));
}

function captureReadOnlyCommand(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio:['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) target.push(chunk);
      });
    }
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code:Number.isInteger(code) ? code : 1,
      stdout:Buffer.concat(stdout).toString('utf8'),
      stderr:Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function resolveHermesPaths() {
  const home = os.homedir();
  const hermesHome = String(process.env.HERMES_HOME || '').trim() || path.join(home, '.hermes');
  // 复用 integrations/hermes/scripts/patch-support.mjs 的既有解析与版本基线；
  // 该文件零第三方依赖，导入失败时退回本地推导，绝不因此让诊断跑不完。
  let expectedHermesVersion = null;
  let hermesAgentRoot = resolveHermesAgentRoot(hermesHome);
  try {
    const support = await import('../../../integrations/hermes/scripts/patch-support.mjs');
    expectedHermesVersion = support.SUPPORTED_HERMES_VERSION ?? null;
    hermesAgentRoot = resolveHermesAgentRoot(support.defaultHermesRoot());
  } catch {
    // 保留本地推导结果。
  }
  return {
    hermesHome,
    hermesAgentRoot,
    expectedHermesVersion,
    gatewayPlistPath:path.join(home, 'Library', 'LaunchAgents', `${GATEWAY_LAUNCHD_LABEL}.plist`),
  };
}

async function createFingerprintReader() {
  try {
    const { collectRuntimeFingerprint } = await import('../../../scripts/runtime-fingerprint.mjs');
    return async () => collectRuntimeFingerprint({
      root:repositoryRoot,
      // 只读探测，缩短超时；git 不可用时返回空串而不是抛异常。
      command:(file, args, options = {}) => runFingerprintCommand(file, args, options),
      request:(url) => requestJsonOnce(url),
    });
  } catch {
    return async () => null;
  }
}

function runFingerprintCommand(file, args, { cwd } = {}) {
  try {
    return execFileSync(file, args, { cwd, encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

async function requestJsonOnce(url) {
  try {
    const response = await fetch(url, { signal:AbortSignal.timeout(1_200) });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    return { httpStatus:response.status, body };
  } catch {
    return { httpStatus:null, body:{} };
  }
}

// 与 src/runtime/runtime-configuration.ts 同一解析：AGENT_ARMY_DATA_DIR || <repoRoot>/apps/ajun-runtime/data。
// CLI 必须在依赖未安装时也能跑完，因此这里直接推导而不 import 运行时装配层。
export function resolveDataDir(environment = process.env) {
  return path.resolve(String(environment.AGENT_ARMY_DATA_DIR || '').trim()
    || path.join(repositoryRoot, 'apps/ajun-runtime/data'));
}

// Hermes 侧账本只读解析（agent_army_commander_evidence-<YYYY-MM-DD>.jsonl，见
// integrations/hermes/runtime/agent_army_feishu_commander_evidence.py）。读不到就返回空数组。
async function readHermesSideEvidence(hermesHome) {
  return readCommanderChainEvidenceFiles(hermesHome, { filePrefix:'agent_army_commander_evidence-' });
}

async function collectRecentEvidence({ dataDir, hermesHome }) {
  const [runtimeSide, hermesSide] = await Promise.all([
    createFeishuCommanderChainEvidenceLedger({ dataDir }).readRecent(),
    readHermesSideEvidence(hermesHome),
  ]);
  // 两侧同一 sourceEventRef 的记录按时间排在一起，使一条飞书消息可被关联。
  return [...runtimeSide, ...hermesSide]
    .sort((left, right) => String(left?.recordedAt || '').localeCompare(String(right?.recordedAt || '')));
}

export async function runDiagnosis({ requesterRef = null } = {}) {
  const [runCommand, paths, fingerprint] = await Promise.all([
    createCommandRunner(),
    resolveHermesPaths(),
    createFingerprintReader(),
  ]);
  const observations = await observeFeishuCommanderChain({
    runCommand,
    readTextFile:(filePath) => fs.readFile(filePath, 'utf8'),
    statFile:async (filePath) => {
      try {
        const stats = await fs.stat(filePath);
        return { mode:stats.mode };
      } catch {
        return null;
      }
    },
    probe:new DeterministicLocalHealthProbe({ timeoutMs:1_500 }),
    fingerprint,
    uid:typeof process.getuid === 'function' ? process.getuid() : 0,
    hermesHome:paths.hermesHome,
    hermesAgentRoot:paths.hermesAgentRoot,
    gatewayLabel:GATEWAY_LAUNCHD_LABEL,
    gatewayPlistPath:paths.gatewayPlistPath,
    expectedHermesVersion:paths.expectedHermesVersion,
    requesterRef,
    devPort:4322,
  });
  // 合并读取两侧账本：运行时侧在 dataDir，Hermes 侧在 HERMES_HOME；缺任一侧都不影响诊断跑完。
  const dataDir = resolveDataDir();
  const recentEvidence = await collectRecentEvidence({ dataDir, hermesHome:paths.hermesHome });
  return diagnoseFeishuCommanderChain(observations, { recentEvidence });
}

// 诊断结束后**尽力**留痕：只写运行时侧 dataDir，绝不写 HERMES_HOME 或其他 Profile 的账本（需求 3.8）。
// 失败只提示，不改变输出与退出码。
async function noteDiagnosisCompleted(diagnosis) {
  const dataDir = resolveDataDir();
  const record = await createFeishuCommanderChainEvidenceLedger({ dataDir }).record({
    kind:'diagnosis_completed',
    reason:diagnosis.verdict,
    outcome:`本机链路诊断已跑完：${diagnosis.verdict}；只读判定，未启动任何外部动作。`,
    truthLayer:'configured',
    nextStep:diagnosis.uniqueNextStep,
  });
  return record
    ? `诊断留痕：已写入 ${path.join(dataDir, EVIDENCE_DIRECTORY_NAME)}。`
    : `诊断留痕未写入（${path.join(dataDir, EVIDENCE_DIRECTORY_NAME)} 不可写）；诊断结论本身不受影响。`;
}

export function renderHumanReadable(diagnosis, { requesterRef = null } = {}) {
  const lines = [
    '飞书军团总管链路本机诊断',
    `生成时间：${diagnosis.generatedAt}`,
    '范围：只读本机，不启动服务、不修改配置、不产生任何外部副作用。',
    `发送者：${requesterRef ? digestRef(requesterRef) : '未指定（用 --requester <open_id> 判定白名单命中）'}`,
    '',
  ];
  for (const [index, check] of diagnosis.checks.entries()) {
    const verification = check.requiresRealMachineVerification ? '需真机验证' : '无需真机验证';
    lines.push(`${index + 1}. ${check.title}【${STATUS_LABELS[check.status] || check.status}】`);
    lines.push(`   结论：${check.conclusion}`);
    lines.push(`   能力真相层级：${TRUTH_LAYER_LABELS[check.truthLayer]}（本机上限：${TRUTH_LAYER_LABELS[check.truthLayerCeiling]}，${verification}）`);
    lines.push(`   已脱敏证据：${JSON.stringify(check.evidence)}`);
    lines.push(`   唯一下一步：${check.nextStep ?? '无需动作'}`);
    lines.push('');
  }
  lines.push(`总判定：${diagnosis.verdict}`);
  lines.push(`唯一下一步：${diagnosis.uniqueNextStep ?? '无需动作'}`);
  lines.push(diagnosis.verdictCaveat);
  lines.push(diagnosis.recentEvidence.length
    ? `最近证据：${diagnosis.recentEvidence.length} 条（已脱敏，两侧账本按时间合并）`
    : '最近证据：本机暂无链路证据记录。');
  // 只打印最近 5 条摘要：记录本身已脱敏，这里不做任何反向还原。
  for (const record of diagnosis.recentEvidence.slice(-5)) {
    lines.push(`   ${record.recordedAt} ${record.side} ${record.kind}`
      + ` 事件=${record.sourceEventRef ?? '未记录'} 结论=${record.outcome ?? ''}`);
  }
  return lines.join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${renderUsage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${renderUsage()}\n`);
    return 0;
  }
  let diagnosis;
  try {
    diagnosis = await runDiagnosis({ requesterRef:options.requesterRef });
  } catch (error) {
    // 诊断自身无法完成时也必须给出可读结论，绝不以未捕获异常收场。
    process.stderr.write(`诊断自身无法完成：${String(error?.message || error)}\n`
      + `唯一下一步：确认仓库路径与 HERMES_HOME 可读后重跑 npm run diagnose:feishu-chain。\n`);
    return 2;
  }
  const noticeLine = await noteDiagnosisCompleted(diagnosis);
  process.stdout.write(options.json
    ? `${JSON.stringify(diagnosis, null, 2)}\n`
    : `${renderHumanReadable(diagnosis, { requesterRef:options.requesterRef })}\n${noticeLine}\n`);
  if (!options.json && diagnosis.checks.length !== CHAIN_CHECK_IDS.length) {
    process.stderr.write('诊断输出的检查项数量异常。\n');
    return 2;
  }
  return EXIT_CODE_BY_VERDICT[diagnosis.verdict] ?? 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
