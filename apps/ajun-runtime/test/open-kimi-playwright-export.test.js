import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const BRIDGE = fileURLToPath(new URL('../scripts/open-kimi-playwright-export.py', import.meta.url));
const DRIVER = fileURLToPath(new URL('../scripts/open-kimi-playwright-driver.mjs', import.meta.url));
const TOOLCHAIN = path.join(os.homedir(), '.agent-army/toolchains/open-kimi-ppt/1.1.0');
const NODE = '/opt/homebrew/bin/node';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('Playwright Python 桥接只写固定枚举的脱敏阶段记录', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-stage-progress-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const code = [
    'import importlib.util, os',
    'spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.EXPORT_MODE = "images"',
    'module.write_progress("deck.ready", "started")',
  ].join('; ');
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
    },
  });
  const raw = await fs.readFile(progressRecord, 'utf8');
  const document = JSON.parse(raw);
  assert.deepEqual(Object.keys(document).sort(), [
    'errorCode', 'mode', 'schemaVersion', 'stage', 'status', 'updatedAt',
  ]);
  assert.equal(document.schemaVersion, 'agent.army/open-kimi-ppt-stage-progress/v1');
  assert.equal(document.mode, 'images');
  assert.equal(document.stage, 'deck.ready');
  assert.equal(document.status, 'started');
  assert.equal(document.errorCode, null);
  assert.match(document.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(raw.includes('http'), false);
  assert.equal((await fs.stat(progressRecord)).mode & 0o777, 0o600);
});

test('Python 桥接在 localhost 真浏览器操作中推进阶段 checkpoint', async (t) => {
  const playwrightRoot = path.join(TOOLCHAIN, 'node_modules/playwright-core');
  if (!(await allExist([NODE, CHROME, path.join(playwrightRoot, 'index.mjs')]))) {
    t.skip('本机未安装锁定的 OpenKimi Playwright 隔离工具链');
    return;
  }
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-bridge-progress-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    response.end('<!doctype html><html data-ready="yes"><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const code = [
    'import importlib.util, os',
    'from pathlib import Path',
    'spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.EXPORT_MODE = "images"',
    'browser = module.PlaywrightBrowserSession("", "fixture", Path(os.environ["OPEN_KIMI_WORK_ROOT"]), Path(os.environ["OPEN_KIMI_WORK_ROOT"]))',
    'browser.open(os.environ["OPEN_KIMI_FIXTURE_URL"])',
    'browser.run(["wait", "--fn", "document.documentElement.dataset.ready === \\"yes\\""])',
    'browser.run(["set", "viewport", "1366", "768"])',
    'browser.close()',
  ].join('; ');
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:`${path.dirname(NODE)}:/usr/bin:/bin`,
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      OPEN_KIMI_WORK_ROOT:runtimeRoot,
      OPEN_KIMI_FIXTURE_URL:`http://127.0.0.1:${address.port}/`,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
      AGENT_ARMY_OPEN_KIMI_NODE_REAL:NODE,
      AGENT_ARMY_OPEN_KIMI_PLAYWRIGHT_DRIVER:DRIVER,
      AGENT_ARMY_OPEN_KIMI_PLAYWRIGHT_ROOT:playwrightRoot,
      AGENT_ARMY_OPEN_KIMI_CHROME_REAL:CHROME,
    },
    timeout:30_000,
  });
  const document = JSON.parse(await fs.readFile(progressRecord, 'utf8'));
  assert.equal(document.mode, 'images');
  assert.equal(document.stage, 'browser.viewport');
  assert.equal(document.status, 'completed');
  assert.equal(document.errorCode, null);
});

test('下载 RPC 已失败时，上游兜底轮询不得覆盖最初的脱敏错误码', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-download-progress-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const code = `
import importlib.util
import os

spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.EXPORT_MODE = "images"
module.LAST_DOWNLOAD_ERROR_CODE = "playwright_download_event_timeout"
module.write_progress(
    "visualQa.download",
    "failed",
    error_code="playwright_download_event_timeout",
)

def fail(*_args, **_kwargs):
    raise RuntimeError("timed out waiting for download")

try:
    module.download_wait_wrapper(fail, "visualQa.download_wait")([], timeout=240)
except RuntimeError:
    pass
`;
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
    },
  });
  const document = JSON.parse(await fs.readFile(progressRecord, 'utf8'));
  assert.equal(document.mode, 'images');
  assert.equal(document.stage, 'visualQa.download');
  assert.equal(document.status, 'failed');
  assert.equal(document.errorCode, 'playwright_download_event_timeout');
});

test('图片下载在 RPC 前规范化 macOS 临时目录路径别名', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-path-alias-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const realRoot = path.join(runtimeRoot, 'real');
  const aliasRoot = path.join(runtimeRoot, 'alias');
  await fs.mkdir(realRoot);
  await fs.symlink(realRoot, aliasRoot);
  const code = `
import importlib.util
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.EXPORT_MODE = "images"
session = object.__new__(module.PlaywrightBrowserSession)
captured = {}
session.rpc = lambda action, **values: captured.update({"action": action, **values})
session.download_dir = Path(os.environ["OPEN_KIMI_REAL_OUTPUT"]).resolve().parent
module.normalize_image_download = lambda output, _download_dir: output
session.run(["download", "@e1", os.environ["OPEN_KIMI_ALIAS_OUTPUT"]], timeout=300)
expected = str(Path(os.environ["OPEN_KIMI_REAL_OUTPUT"]).resolve())
raise SystemExit(0 if captured.get("output") == expected and captured.get("timeout") == 120 else 1)
`;
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      OPEN_KIMI_ALIAS_OUTPUT:path.join(aliasRoot, 'browser-output.pptx'),
      OPEN_KIMI_REAL_OUTPUT:path.join(realRoot, 'browser-output.pptx'),
    },
  });
});

test('PPTX 下载只触发按钮并由受控目录轮询发现文件', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptx-trigger-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const code = `
import importlib.util
import os

spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.EXPORT_MODE = "pptx"
session = object.__new__(module.PlaywrightBrowserSession)
captured = {}
session.rpc = lambda action, **values: captured.update({"action": action, **values})
session.run(["download", "@e1", os.path.join(os.environ["OPEN_KIMI_WORK_ROOT"], "browser-output.pptx")], timeout=300)

observed = {}
def find_fixture(*_args, **kwargs):
    observed.update(kwargs)
    return "fixture.pptx"

result = module.download_wait_wrapper(find_fixture, "pptx.download_wait")([], timeout=90)
valid = (
    captured.get("action") == "triggerDownloadRef"
    and captured.get("ref") == "@e1"
    and captured.get("timeout") == 180
    and "output" not in captured
    and observed.get("timeout") == 180.0
    and result == "fixture.pptx"
)
raise SystemExit(0 if valid else 1)
`;
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      OPEN_KIMI_WORK_ROOT:runtimeRoot,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
    },
  });
  const document = JSON.parse(await fs.readFile(progressRecord, 'utf8'));
  assert.equal(document.stage, 'pptx.download_wait');
  assert.equal(document.status, 'completed');
});

test('PPTX 目录轮询超时写入稳定脱敏 checkpoint', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptx-wait-timeout-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const code = `
import importlib.util
import os

spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.EXPORT_MODE = "pptx"
def fail(*_args, **_kwargs):
    raise RuntimeError("details are not persisted")
try:
    module.download_wait_wrapper(fail, "pptx.download_wait")([], timeout=90)
except RuntimeError:
    pass
`;
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
    },
  });
  const document = JSON.parse(await fs.readFile(progressRecord, 'utf8'));
  assert.equal(document.stage, 'pptx.download_wait');
  assert.equal(document.status, 'failed');
  assert.equal(document.errorCode, 'playwright_download_file_timeout');
});

test('上游非零返回不得把详细下载失败 checkpoint 覆盖成整体完成', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-overall-progress-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const code = [
    'import importlib.util, os',
    'spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.EXPORT_MODE = "images"',
    'module.write_progress("visualQa.download", "failed", error_code="playwright_download_invalid_image_archive")',
    'module.record_overall_result("visualQa.images", 1)',
  ].join('; ');
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
    },
  });
  const document = JSON.parse(await fs.readFile(progressRecord, 'utf8'));
  assert.equal(document.stage, 'visualQa.download');
  assert.equal(document.status, 'failed');
  assert.equal(document.errorCode, 'playwright_download_invalid_image_archive');
});

test('上游非零返回且没有细粒度失败时写入稳定整体失败 checkpoint', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-overall-nonzero-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const code = [
    'import importlib.util, os',
    'spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.EXPORT_MODE = "images"',
    'module.write_progress("visualQa.download_wait", "completed")',
    'module.record_overall_result("visualQa.images", 1)',
  ].join('; ');
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
    },
  });
  const document = JSON.parse(await fs.readFile(progressRecord, 'utf8'));
  assert.equal(document.stage, 'visualQa.images');
  assert.equal(document.status, 'failed');
  assert.equal(document.errorCode, 'upstream_nonzero');
});

test('图片兜底轮询优先返回桥接器已验证并重封装的归档', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-normalized-wait-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const progressRecord = path.join(runtimeRoot, 'stage-progress.json');
  const normalized = path.join(runtimeRoot, 'normalized-image-output.zip');
  await fs.writeFile(normalized, Buffer.from('fixture'));
  const code = `
import importlib.util
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.EXPORT_MODE = "images"
module.LAST_NORMALIZED_IMAGE_DOWNLOAD = Path(os.environ["OPEN_KIMI_NORMALIZED"])
def denied(*_args, **_kwargs):
    raise RuntimeError("raw search must not run")
result = module.download_wait_wrapper(denied, "visualQa.download_wait")([], timeout=240)
raise SystemExit(0 if result == module.LAST_NORMALIZED_IMAGE_DOWNLOAD or result == Path(os.environ["OPEN_KIMI_NORMALIZED"]) else 1)
`;
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      OPEN_KIMI_NORMALIZED:normalized,
      AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD:progressRecord,
    },
  });
  const document = JSON.parse(await fs.readFile(progressRecord, 'utf8'));
  assert.equal(document.stage, 'visualQa.download_wait');
  assert.equal(document.status, 'completed');
});

test('Kimi 返回单张图片文件时，桥接器在受控临时目录重新封装为上游可接受 ZIP', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-image-normalize-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const downloadRoot = path.join(runtimeRoot, 'downloads');
  await fs.mkdir(downloadRoot);
  const output = path.join(runtimeRoot, 'browser-output.zip');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  await Promise.all([
    fs.writeFile(output, png),
    fs.writeFile(path.join(downloadRoot, 'first-download'), png),
    fs.writeFile(path.join(downloadRoot, 'second-download'), jpeg),
  ]);
  const code = [
    'import importlib.util, os, sys',
    'from pathlib import Path',
    'spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'normalized = module.normalize_image_download(Path(sys.argv[1]), Path(sys.argv[2]))',
    'raise SystemExit(0 if module.is_image_zip(normalized) else 1)',
  ].join('; ');
  await execute('/usr/bin/python3', ['-c', code, output, downloadRoot], {
    env:{ PATH:'/usr/bin:/bin', OPEN_KIMI_BRIDGE_PATH:BRIDGE },
    timeout:15_000,
  });
  const normalized = path.join(runtimeRoot, 'normalized-image-output.zip');
  assert.equal((await fs.stat(normalized)).isFile(), true);
  const listing = await execute('/usr/bin/unzip', ['-Z1', normalized]);
  assert.deepEqual(listing.stdout.trim().split('\n').map((name) => path.extname(name)).sort(), ['.jpeg', '.png']);
});

test('Kimi 返回图片 ZIP 时，桥接器解压校验后写入确定命名的新归档', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-zip-normalize-'));
  t.after(() => fs.rm(runtimeRoot, { recursive:true, force:true }));
  const downloadRoot = path.join(runtimeRoot, 'downloads');
  await fs.mkdir(downloadRoot);
  const source = path.join(runtimeRoot, 'browser-output.zip');
  const code = `
import importlib.util
import os
import zipfile
from pathlib import Path

source = Path(os.environ["OPEN_KIMI_SOURCE"])
with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("nested/original-name.bin", b"\\x89PNG\\r\\n\\x1a\\nfixture")
    archive.writestr("ignored.txt", b"not an image")
spec = importlib.util.spec_from_file_location("open_kimi_bridge", os.environ["OPEN_KIMI_BRIDGE_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
normalized = module.normalize_image_download(source, Path(os.environ["OPEN_KIMI_DOWNLOADS"]))
with zipfile.ZipFile(normalized) as archive:
    names = archive.namelist()
raise SystemExit(0 if names == ["01.png"] else 1)
`;
  await execute('/usr/bin/python3', ['-c', code], {
    env:{
      PATH:'/usr/bin:/bin',
      OPEN_KIMI_BRIDGE_PATH:BRIDGE,
      OPEN_KIMI_SOURCE:source,
      OPEN_KIMI_DOWNLOADS:downloadRoot,
    },
  });
});

async function allExist(paths) {
  const states = await Promise.all(paths.map((target) => fs.access(target).then(() => true).catch(() => false)));
  return states.every(Boolean);
}
