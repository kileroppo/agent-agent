import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const integrationRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(integrationRoot, '../..');

function gitCheckoutRoot() {
  try {
    const commonDirectory = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return path.dirname(commonDirectory);
  } catch {
    return null;
  }
}

function resolvePython() {
  const checkoutRoot = gitCheckoutRoot();
  const candidates = [
    process.env.AGENT_ARMY_LOCAL_AI_PYTHON,
    path.join(repositoryRoot, 'work/local-ai/venvs/retrieval/bin/python'),
    checkoutRoot && path.join(checkoutRoot, 'work/local-ai/venvs/retrieval/bin/python'),
    process.env.VIRTUAL_ENV && path.join(process.env.VIRTUAL_ENV, 'bin/python'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }

  const fallback = spawnSync('python3', ['--version'], { stdio:'ignore' });
  if (fallback.status === 0) return 'python3';
  throw new Error('找不到本地 AI Python。请先安装本地环境，或设置 AGENT_ARMY_LOCAL_AI_PYTHON。');
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

const result = spawnSync(resolvePython(), commands[command], {
  cwd:integrationRoot,
  env:process.env,
  stdio:'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
