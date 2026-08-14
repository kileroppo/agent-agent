#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { StepFunContentTools } from '../src/stepfun-tools.ts';
import { assertM5BudgetCoverage } from '../../../../../apps/ajun-runtime/src/m5-budget-cost-contract.ts';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONFIRMATION = 'I_ACCEPT_REAL_STEPFUN_CHARGES';
const DEFAULT_RATES = Object.freeze({
  visionInputPerMillionTokens:35,
  visionOutputPerMillionTokens:112,
  imagePerGeneration:1,
  ttsPerThousandCharacters:9,
});

class JsonState {
  constructor(file, records) {
    this.file = file;
    this.records = records;
  }

  static async open(file) {
    let records = {};
    try {
      records = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
      fail('付费状态文件格式无效。');
    }
    return new JsonState(file, records);
  }

  async get(key) {
    return this.records[stateKey(key)] || null;
  }

  async set(key, value) {
    this.records[stateKey(key)] = value;
    await atomicJson(this.file, this.records);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options['confirm-paid'] !== CONFIRMATION) {
  fail(`真实调用未执行：必须显式传入 --confirm-paid ${CONFIRMATION}`);
}

const apiBase = loopbackBase(options['api-base'] || 'http://127.0.0.1:3100');
const companyId = uuid(options['company-id'], '--company-id 必须是 UUID。');
const agentId = uuid(options['agent-id'], '--agent-id 必须是 UUID。');
const projectId = uuid(options['project-id'], '--project-id 必须是 UUID。');
const goalId = uuid(options['goal-id'], '--goal-id 必须是 UUID。');
const issueId = uuid(options['issue-id'], '--issue-id 必须是 UUID。');
const runId = uuid(options['run-id'], '--run-id 必须是 UUID。');
const envFile = path.resolve(required(options['env-file'], '--env-file 缺失。'));
const sourceImage = path.resolve(required(options['source-image'], '--source-image 缺失。'));
const workspace = path.resolve(required(options.workspace, '--workspace 缺失。'));
const probeVersion = actionVersion(options['probe-version'] || 'v1');

await assertPrivateRegularFile(envFile);
await assertRegularFile(sourceImage);
await fs.mkdir(workspace, { recursive:true, mode:0o700 });
const workspaceReal = await fs.realpath(workspace);
const sourceBytes = await fs.readFile(sourceImage);
const sourceName = imageName(sourceImage);
await fs.writeFile(path.join(workspaceReal, sourceName), sourceBytes, { mode:0o600 });

const paperclipContext = await verifyPaperclipContext({
  apiBase,
  companyId,
  agentId,
  projectId,
  goalId,
  issueId,
  runId,
});
const apiKey = await readEnvValue(envFile, 'STEPFUN_API_KEY');
if (!apiKey) fail('指定环境文件没有可用的 STEPFUN_API_KEY。');

const stateFile = path.join(workspaceReal, '.paid-actions-state.json');
const state = await JsonState.open(stateFile);
let providerCalls = 0;
const config = {
  stepfunSecretRef:{ type:'secret_ref', secretId:crypto.randomUUID(), version:'latest' },
  stepfunBaseUrl:'https://api.stepfun.com/v1',
  stepfunMediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
  officialTtsVoices:['vibrant-youth'],
  costRatesCents:DEFAULT_RATES,
};
const run = { companyId, agentId, projectId, runId };
const ctx = {
  config:{ get:async () => config },
  secrets:{ resolve:async () => apiKey },
  http:{
    fetch:async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.stepfun.com') {
        throw new Error('Provider URL 不在 StepFun 官方域名白名单。');
      }
      providerCalls += 1;
      return fetch(parsed, init);
    },
  },
  localFolders:{
    status:async (requestedCompanyId, folderKey) => ({
      healthy:requestedCompanyId === companyId && folderKey === 'content-workspace',
      writable:true,
      realPath:workspaceReal,
    }),
  },
  state,
  metrics:{ write:async () => undefined },
  logger:{ warn:() => undefined },
};
const paidBudgetChecker = async ({ maximumCostCents, ...requested }) => {
  const overview = await readJson(
    `${apiBase}/api/companies/${encodeURIComponent(companyId)}/budgets/overview`,
  );
  const scopes = assertM5BudgetCoverage({
    overview,
    companyId,
    agentId,
    projectId,
    maximumCostCents,
  });
  return {
    ...requested,
    maximumCostCents,
    companyId,
    agentId,
    projectId,
    runId,
    allowed:true,
    reservationId:crypto.randomUUID(),
    reservedCents:maximumCostCents,
    scopes:Object.fromEntries(scopes.map((item) => [
      item.scopeType,
      {
        scopeId:item.scopeId,
        allowed:true,
        remainingCents:item.remainingAmount,
      },
    ])),
  };
};
const tools = new StepFunContentTools({ ctx, paidBudgetChecker });

const actions = [
  {
    name:'vision',
    actionId:`m5_probe_${issueId.slice(0, 8)}_vision_${probeVersion}`,
    invoke:() => tools.vision({
      actionId:`m5_probe_${issueId.slice(0, 8)}_vision_${probeVersion}`,
      relativePath:sourceName,
      prompt:'只描述画面中可直接看见的主体、文字、颜色和布局。不要猜测背景信息，最多120字。',
    }, run),
  },
  {
    name:'image_generate',
    actionId:`m5_probe_${issueId.slice(0, 8)}_image_${probeVersion}`,
    invoke:() => tools.image({
      actionId:`m5_probe_${issueId.slice(0, 8)}_image_${probeVersion}`,
      prompt:'竖屏科技信息图，无人物无品牌无水印。深蓝背景，中央是一条清晰的AI Agent执行闭环：目标、计划、执行、观察、纠错、审核。简洁高对比，适合短视频封面。',
      outputPath:'provider/generated-cover.png',
      seed:8301,
      textMode:false,
    }, run),
  },
  {
    name:'image_edit',
    actionId:`m5_probe_${issueId.slice(0, 8)}_edit_${probeVersion}`,
    invoke:() => tools.imageEdit({
      actionId:`m5_probe_${issueId.slice(0, 8)}_edit_${probeVersion}`,
      inputPath:'provider/generated-cover.png',
      prompt:'保持竖屏构图和科技感，把流程节点强化为六个发光卡片，减少装饰元素，不添加品牌、人物或水印。',
      outputPath:'provider/edited-cover.png',
      seed:8302,
      textMode:false,
    }, run),
  },
  {
    name:'tts',
    actionId:`m5_probe_${issueId.slice(0, 8)}_tts_${probeVersion}`,
    invoke:() => tools.tts({
      actionId:`m5_probe_${issueId.slice(0, 8)}_tts_${probeVersion}`,
      text:'真正的智能体，不是只会回答问题。它要能根据真实结果调整计划，失败后换路线，并把每一次成本和产物都记清楚。',
      voice:'vibrant-youth',
      speed:1.05,
      outputPath:'provider/narration.mp3',
    }, run),
  },
];

const results = [];
for (const action of actions) {
  const before = providerCalls;
  const raw = await action.invoke();
  const committed = await commitCost({
    apiBase,
    companyId,
    issueId,
    goalId,
    run,
    tools,
    actionId:action.actionId,
    result:raw,
  });
  results.push(safeResult(action.name, committed, providerCalls - before));
}

const replayStart = providerCalls;
const replays = [];
for (const action of actions) {
  const replay = await action.invoke();
  if (replay?.data?.replayed !== true || replay?.data?.costCommit?.status !== 'confirmed') {
    fail(`幂等回放失败：${action.name} 没有复用已确认结果。`);
  }
  replays.push({ name:action.name, replayed:true });
}
if (providerCalls !== replayStart) fail('幂等回放触发了额外 Provider 调用。');

const report = {
  schemaVersion:'agent.army/real-stepfun-probe/v1',
  generatedAt:new Date().toISOString(),
  paperclip:paperclipContext,
  provider:'stepfun',
  reasoningBaseUrl:'https://api.stepfun.com/v1',
  mediaBaseUrl:'https://api.stepfun.com/step_plan/v1',
  probeVersion,
  results,
  replay:{ providerCalls:0, actions:replays },
  totalProviderCalls:providerCalls,
};
await atomicJson(path.join(workspaceReal, 'probe-report.json'), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function commitCost({
  apiBase:base,
  companyId:company,
  issueId:issue,
  goalId:goal,
  run:runContext,
  tools:stepfun,
  actionId,
  result,
}) {
  if (result?.data?.costCommit?.status === 'confirmed') return result;
  if (result?.data?.costCommit?.status !== 'pending_core_cost_event') {
    fail(`付费 action ${actionId} 缺少待提交费用事件。`);
  }
  const claimed = await stepfun.claimCostEvent({ actionId }, runContext);
  const commit = claimed?.data?.costCommit;
  if (commit?.status !== 'submitting_core_cost_event' || !UUID.test(String(commit.submissionId))) {
    fail(`付费 action ${actionId} 没有返回有效费用提交租约。`);
  }
  const draft = {
    ...commit.costEvent,
    issueId:issue,
    goalId:goal,
  };
  let created;
  try {
    created = await writeJson(
      `${base}/api/companies/${encodeURIComponent(company)}/cost-events`,
      draft,
    );
  } catch (error) {
    error.message = `Paperclip 费用提交结果不确定；禁止重放 Provider：${error.message}`;
    throw error;
  }
  const costEventId = uuid(created?.id, 'Paperclip 没有返回有效费用事件 ID。');
  return stepfun.confirmCostEvent({
    actionId,
    submissionId:commit.submissionId,
    costEventId,
  }, runContext);
}

function safeResult(name, result, calls) {
  const data = result?.data || {};
  return {
    name,
    model:data.model,
    providerCalls:calls,
    replayed:data.replayed === true,
    costCents:data.callRecord?.costEvent?.costCents,
    costEventId:data.costCommit?.costEventId,
    outputPath:data.relativePath || null,
    outputChecksum:data.checksum || null,
    sourceChecksum:data.sourceChecksum || null,
    observationCharacters:[...String(data.observation || '')].length,
    nextStageAllowed:data.nextStageAllowed === true,
  };
}

async function verifyPaperclipContext(input) {
  const [run, issue] = await Promise.all([
    readJson(`${input.apiBase}/api/heartbeat-runs/${encodeURIComponent(input.runId)}`),
    readJson(`${input.apiBase}/api/issues/${encodeURIComponent(input.issueId)}`),
  ]);
  if (
    run?.id !== input.runId
    || run?.companyId !== input.companyId
    || run?.agentId !== input.agentId
    || run?.status !== 'running'
  ) fail('Paperclip Run 与指定公司、岗位或允许状态不一致。');
  if (
    issue?.id !== input.issueId
    || issue?.companyId !== input.companyId
    || issue?.projectId !== input.projectId
    || issue?.goalId !== input.goalId
    || issue?.assigneeAgentId !== input.agentId
  ) fail('Paperclip Issue 与指定公司、项目、目标或岗位不一致。');
  const linked = await readJson(
    `${input.apiBase}/api/heartbeat-runs/${encodeURIComponent(input.runId)}/issues`,
  );
  if (!list(linked).some((item) => item?.issueId === input.issueId)) {
    fail('Paperclip Run 没有关联指定 Issue。');
  }
  const overview = await readJson(
    `${input.apiBase}/api/companies/${encodeURIComponent(input.companyId)}/budgets/overview`,
  );
  assertM5BudgetCoverage({
    overview,
    companyId:input.companyId,
    agentId:input.agentId,
    projectId:input.projectId,
    maximumCostCents:25,
  });
  return {
    companyId:input.companyId,
    agentId:input.agentId,
    projectId:input.projectId,
    goalId:input.goalId,
    issueId:input.issueId,
    runId:input.runId,
    runStatus:run.status,
  };
}

function stateKey(value) {
  return JSON.stringify([
    value?.scopeKind,
    value?.scopeId,
    value?.namespace,
    value?.stateKey,
  ]);
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode:0o600 });
  await fs.rename(temporary, file);
}

async function readEnvValue(file, key) {
  const content = await fs.readFile(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) return value.slice(1, -1);
    return value;
  }
  return null;
}

async function assertPrivateRegularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('环境文件必须是普通文件，不能是符号链接。');
  if ((stat.mode & 0o077) !== 0) fail('环境文件权限过宽；必须至少收紧为 0600。');
}

async function assertRegularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('输入素材必须是普通文件，不能是符号链接。');
}

function imageName(file) {
  const extension = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    fail('输入素材只允许 PNG、JPEG 或 WebP。');
  }
  return `source${extension === '.jpeg' ? '.jpg' : extension}`;
}

async function readJson(url) {
  const response = await fetch(url, { headers:{ accept:'application/json' } });
  if (!response.ok) throw new Error(`Paperclip GET ${new URL(url).pathname} 返回 HTTP ${response.status}。`);
  return response.json();
}

async function writeJson(url, body) {
  const response = await fetch(url, {
    method:'POST',
    headers:{ accept:'application/json', 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    throw new Error(`Paperclip POST ${new URL(url).pathname} 返回 HTTP ${response.status}：${text}`);
  }
  return response.json();
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) {
      fail(`参数无效：${item || '(empty)'}`);
    }
    result[item.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

function loopbackBase(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    fail('--api-base 只允许本机 Paperclip HTTP 地址。');
  }
  return url.toString().replace(/\/$/, '');
}

function required(value, message) {
  if (!String(value || '').trim()) fail(message);
  return String(value);
}

function actionVersion(value) {
  const version = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{2,24}$/.test(version)) fail('--probe-version 格式无效。');
  return version;
}

function uuid(value, message) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) fail(message);
  return id;
}

function list(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
