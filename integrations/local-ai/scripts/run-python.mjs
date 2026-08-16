import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const integrationRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(integrationRoot, '../..');

function resolvePython() {
  const candidates = [
    process.env.AGENT_ARMY_LOCAL_AI_PYTHON,
    path.join(
      process.env.AGENT_ARMY_LOCAL_AI_HOME
        || path.join(os.homedir(), 'Library', 'Application Support', 'AgentArmy', 'local-ai'),
      'venvs/gateway/bin/python',
    ),
    process.env.VIRTUAL_ENV && path.join(process.env.VIRTUAL_ENV, 'bin/python'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }

  const fallback = spawnSync('python3', ['--version'], { stdio:'ignore' });
  if (fallback.status === 0) return 'python3';
  throw new Error('找不到本地 AI 插件 Python。请先运行 ops/local-ai/install-plugin.sh --bootstrap，或设置 AGENT_ARMY_LOCAL_AI_PYTHON。');
}

const command = process.argv[2];
const commands = {
  test:['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'],
  check:[
    '-m', 'py_compile',
    'local_ai_gateway.py',
    'desktop_enhancement_node.py',
    'desktop_comfyui_adapter.py',
    'retrieval_engine.py',
    'knowledge_index.py',
    path.join(repositoryRoot, 'ops/local-ai/desktop/desktop_node_launcher.py'),
    path.join(repositoryRoot, 'ops/local-ai/desktop/download-desktop-models.py'),
    path.join(repositoryRoot, 'ops/local-ai/desktop/smoke-simulated-node.py'),
  ],
  'smoke:desktop-simulated':[
    path.join(repositoryRoot, 'ops/local-ai/desktop/smoke-simulated-node.py'),
  ],
};

if (!Object.hasOwn(commands, command)) {
  throw new Error(`未知本地 AI Python 命令：${command || '(empty)'}`);
}

const testWorkRoot = command === 'test'
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-army-local-ai-test-'))
  : null;
let result;
try {
  result = spawnSync(resolvePython(), commands[command], {
    cwd:integrationRoot,
    env:testWorkRoot ? { ...process.env, LOCAL_AI_WORK_ROOT:testWorkRoot } : process.env,
    stdio:'inherit',
  });
} finally {
  if (testWorkRoot) fs.rmSync(testWorkRoot, { recursive:true, force:true });
}

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
