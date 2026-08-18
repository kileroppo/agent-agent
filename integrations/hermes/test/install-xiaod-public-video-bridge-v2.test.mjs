import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ADAPTER_RELATIVE_PATH,
  SEAM_MARKER,
  SIDECAR_FILENAME,
  SIDECAR_RELATIVE_PATH,
  SUPPORTED_HERMES_GIT_COMMIT,
  SUPPORTED_HERMES_VERSION,
  installXiaodPublicVideoBridgeV2,
  rollbackXiaodPublicVideoBridgeV2,
} from '../scripts/install-xiaod-public-video-bridge-v2.mjs';

// This is the Hermes 0.20.1 Feishu adapter topology the installer supports:
// FeishuAdapter owns Feishu send/disconnect/_run_blocking, while the real
// generic handle_message implementation is inherited from BasePlatformAdapter.
// The exact production tree additionally has substantial SDK code, which is
// intentionally absent from this deterministic, importable fixture.
const CURRENT_HERMES_0201_ADAPTER_FIXTURE = `
import asyncio

class MessageEvent:
    pass

class BasePlatformAdapter:
    async def handle_message(self, event: MessageEvent) -> None:
        self.fallback_calls += 1

class FeishuAdapter(BasePlatformAdapter):
    def __init__(self):
        self.fallback_calls = 0
        self.sent = []

    async def _run_blocking(self, func, *args):
        return func(*args)

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict | None = None,
    ):
        self.sent.append((chat_id, content, reply_to))
        return True

    async def _handle_message_with_guards(self, event: MessageEvent) -> None:
        chat_lock = asyncio.Lock()
        async with chat_lock:
            await self.handle_message(event)
`;

const currentCommit = async () => SUPPORTED_HERMES_GIT_COMMIT;

async function makeHermesFixture({ version = SUPPORTED_HERMES_VERSION, adapter = CURRENT_HERMES_0201_ADAPTER_FIXTURE } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hermes-0201-v2-'));
  const feishuDirectory = path.join(root, 'plugins', 'platforms', 'feishu');
  await fs.mkdir(feishuDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nversion = "${version}"\n`, { mode: 0o600 }),
    fs.writeFile(path.join(feishuDirectory, '__init__.py'), '', { mode: 0o600 }),
    fs.writeFile(path.join(root, 'plugins', '__init__.py'), '', { mode: 0o600 }),
    fs.writeFile(path.join(root, 'plugins', 'platforms', '__init__.py'), '', { mode: 0o600 }),
    fs.writeFile(path.join(feishuDirectory, 'adapter.py'), adapter, { mode: 0o600 }),
  ]);
  return {
    root,
    adapter: path.join(root, ADAPTER_RELATIVE_PATH),
    sidecar: path.join(root, SIDECAR_RELATIVE_PATH),
  };
}

async function read(filePath) {
  return fs.readFile(filePath, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('V2 installer 在版本或 commit 不精确命中时拒绝改动', async () => {
  const wrongVersion = await makeHermesFixture({ version: '0.20.0' });
  const versionBefore = await read(wrongVersion.adapter);
  await assert.rejects(
    installXiaodPublicVideoBridgeV2({ target: wrongVersion.root, getGitCommit: currentCommit }),
    /V2 锁定校验/,
  );
  assert.equal(await read(wrongVersion.adapter), versionBefore);
  await assert.rejects(fs.access(wrongVersion.sidecar));

  const wrongCommit = await makeHermesFixture();
  const commitBefore = await read(wrongCommit.adapter);
  await assert.rejects(
    installXiaodPublicVideoBridgeV2({ target: wrongCommit.root, getGitCommit: async () => 'not-the-pinned-commit' }),
    /V2 锁定校验/,
  );
  assert.equal(await read(wrongCommit.adapter), commitBefore);
  await assert.rejects(fs.access(wrongCommit.sidecar));
  await Promise.all([fs.rm(wrongVersion.root, { recursive: true, force: true }), fs.rm(wrongCommit.root, { recursive: true, force: true })]);
});

test('V2 installer 在真实入口锚点漂移时 fail closed', async () => {
  const fixture = await makeHermesFixture({
    adapter: CURRENT_HERMES_0201_ADAPTER_FIXTURE.replace('            await self.handle_message(event)', '            await self.dispatch_message(event)'),
  });
  const before = await read(fixture.adapter);
  await assert.rejects(
    installXiaodPublicVideoBridgeV2({ target: fixture.root, getGitCommit: currentCommit }),
    /核心 Host 锚点/,
  );
  assert.equal(await read(fixture.adapter), before);
  await assert.rejects(fs.access(fixture.sidecar));
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test('V2 dry-run 完整转换并编译，但不写 sidecar、adapter 或备份', async () => {
  const fixture = await makeHermesFixture();
  const before = await read(fixture.adapter);
  const result = await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    dryRun: true,
    getGitCommit: currentCommit,
    pythonCommand: 'python3',
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, false);
  assert.equal(result.wouldChange, true);
  assert.equal(await read(fixture.adapter), before);
  await assert.rejects(fs.access(fixture.sidecar));
  await assert.rejects(fs.access(path.join(fixture.root, '.agent-army-backups')));
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test('活动 Hermes 源码树默认拒绝安装和回滚，不能因 dry-run 绕过门禁', async () => {
  const activeRoot = path.join(homedir(), '.hermes', 'hermes-agent');
  await assert.rejects(
    installXiaodPublicVideoBridgeV2({
      target: activeRoot,
      dryRun: true,
      getGitCommit: currentCommit,
      pythonCommand: 'python3',
    }),
    /默认拒绝活动 Hermes 源码树/,
  );
  await assert.rejects(
    rollbackXiaodPublicVideoBridgeV2({
      target: activeRoot,
      backupDirectory: path.join(tmpdir(), 'not-a-v2-backup'),
      getGitCommit: currentCommit,
    }),
    /默认拒绝活动 Hermes 源码树/,
  );
});

test('plugins 路径段是符号链接时拒绝越界，外部 adapter 与 sidecar 均不写入', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hermes-0201-symlink-root-'));
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'hermes-0201-symlink-outside-'));
  const outsideFeishu = path.join(outside, 'platforms', 'feishu');
  const outsideAdapter = path.join(outsideFeishu, 'adapter.py');
  const outsideSidecar = path.join(outsideFeishu, SIDECAR_FILENAME);
  await fs.mkdir(outsideFeishu, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nversion = "${SUPPORTED_HERMES_VERSION}"\n`, { mode: 0o600 }),
    fs.writeFile(outsideAdapter, CURRENT_HERMES_0201_ADAPTER_FIXTURE, { mode: 0o600 }),
    fs.symlink(outside, path.join(root, 'plugins')),
  ]);
  const before = await read(outsideAdapter);
  await assert.rejects(
    installXiaodPublicVideoBridgeV2({
      target: root,
      getGitCommit: currentCommit,
      pythonCommand: 'python3',
    }),
    /符号链接|根目录外/,
  );
  await assert.rejects(
    rollbackXiaodPublicVideoBridgeV2({
      target: root,
      backupDirectory: path.join(root, '.agent-army-backups', 'xiaod-public-video-bridge-v2', 'missing'),
      getGitCommit: currentCommit,
    }),
    /符号链接|根目录外/,
  );
  assert.equal(await read(outsideAdapter), before);
  await assert.rejects(fs.access(outsideSidecar));
  await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
});

test('回滚拒绝符号链接备份根，即使外部伪造 manifest 与哈希完全匹配', async () => {
  const fixture = await makeHermesFixture();
  const installed = await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    getGitCommit: currentCommit,
    pythonCommand: 'python3',
  });
  assert.ok(installed.backupDirectory);
  const [adapterAfter, sidecarAfter] = await Promise.all([read(fixture.adapter), read(fixture.sidecar)]);
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'hermes-0201-rollback-outside-'));
  const externalBackups = path.join(outside, 'backups');
  const externalBackup = path.join(externalBackups, 'xiaod-public-video-bridge-v2', 'backup-forged');
  const forgedAdapterBefore = 'THIS EXTERNAL ADAPTER MUST NEVER BE WRITTEN\n';
  await fs.mkdir(externalBackup, { recursive: true, mode: 0o700 });
  const manifest = {
    schemaVersion: 'agent-army/hermes-xiaod-public-video-bridge-v2-backup/v1',
    hermesVersion: SUPPORTED_HERMES_VERSION,
    hermesGitCommit: SUPPORTED_HERMES_GIT_COMMIT,
    root: fixture.root,
    adapter: {
      relativePath: ADAPTER_RELATIVE_PATH,
      beforeFile: 'adapter.py.before',
      beforeSha256: sha256(forgedAdapterBefore),
      afterSha256: sha256(adapterAfter),
      mode: 0o600,
    },
    sidecar: {
      relativePath: SIDECAR_RELATIVE_PATH,
      beforeFile: null,
      beforeSha256: null,
      afterSha256: sha256(sidecarAfter),
      mode: 0o600,
    },
  };
  await Promise.all([
    fs.writeFile(path.join(externalBackup, 'adapter.py.before'), forgedAdapterBefore, { mode: 0o600 }),
    fs.writeFile(path.join(externalBackup, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 }),
  ]);
  const targetBackupRoot = path.join(fixture.root, '.agent-army-backups');
  await fs.rm(targetBackupRoot, { recursive: true, force: true });
  await fs.symlink(externalBackups, targetBackupRoot);
  const targetBefore = await read(fixture.adapter);
  await assert.rejects(
    rollbackXiaodPublicVideoBridgeV2({
      target: fixture.root,
      backupDirectory: path.join(targetBackupRoot, 'xiaod-public-video-bridge-v2', 'backup-forged'),
      getGitCommit: currentCommit,
    }),
    /符号链接|根目录外|回滚路径段/,
  );
  assert.equal(await read(fixture.adapter), targetBefore);
  assert.equal(await read(fixture.sidecar), sidecarAfter);
  await Promise.all([fs.rm(fixture.root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
});

test('V2 真安装后 Python 能导入，并通过真实入口形态消费 B站纯链接', async () => {
  const fixture = await makeHermesFixture();
  const installed = await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    getGitCommit: currentCommit,
    pythonCommand: 'python3',
  });
  assert.equal(installed.changed, true);
  assert.ok(installed.backupDirectory);
  const adapter = await read(fixture.adapter);
  assert.equal((adapter.match(new RegExp(SEAM_MARKER, 'g')) || []).length, 1);
  assert.match(adapter, /install_xiaod_public_video_bridge_v2/);
  await fs.access(fixture.sidecar);

  const second = await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    getGitCommit: currentCommit,
    pythonCommand: 'python3',
  });
  assert.equal(second.changed, false);
  assert.equal(second.wouldChange, false);
  assert.equal(second.backupDirectory, null);

  const python = [
    'import asyncio, importlib, json, os, sys',
    'from types import SimpleNamespace',
    'root = sys.argv[1]',
    'sys.path.insert(0, root)',
    'adapter_module = importlib.import_module("plugins.platforms.feishu.adapter")',
    'bridge = importlib.import_module("plugins.platforms.feishu.agent_army_xiaod_public_video_bridge_v2")',
    'requests = []',
    'class Response:',
    '  status = 202',
    '  def read(self):',
    '    return json.dumps({"task":{"taskId":"task-video-1","taskType":"media.transcribe-and-refine","assigneeAgentId":"xiaod","source":{"channel":"feishu","eventRef":"feishu:om_video_1","chatRef":"chat-1","targetAgentId":"xiaod","profileId":"xiaod"},"requester":{"kind":"feishu-user","ref":"open-1"}},"taskCard":{"schemaVersion":"agent.army/task-card/v1","taskId":"task-video-1","agentId":"xiaod","profileId":"xiaod","chatId":"chat-1","taskKind":"media.transcribe-and-refine"},"reply":"任务已创建"}).encode()',
    '  def __enter__(self): return self',
    '  def __exit__(self, *args): return False',
    'def fake_urlopen(request, timeout=0):',
    '  requests.append((request, timeout)); return Response()',
    'bridge.urlopen = fake_urlopen',
    'os.environ.update({"AGENT_ARMY_FEISHU_AGENT_ID":"xiaod","AGENT_ARMY_PROFILE_ID":"xiaod","AJUN_FEISHU_COMMANDER_INGRESS_URL":"http://127.0.0.1:4321/api/feishu/commander"})',
    'event = SimpleNamespace(text="https://www.bilibili.com/video/BV1ymux6BEFU/?spm_id_from=333.337.search-card.all.click",message_id="om_video_1",message_type="text",media_urls=[],media_types=[],source=SimpleNamespace(chat_id="chat-1",user_id="open-1",user_id_alt=""),is_command=lambda: False)',
    'async def main():',
    '  host = adapter_module.FeishuAdapter()',
    '  await host._handle_message_with_guards(event)',
    '  await host._handle_message_with_guards(event)',
    '  await asyncio.sleep(0.03)',
    '  assert host.fallback_calls == 0',
    '  assert len(requests) == 1',
    '  request, timeout = requests[0]',
    '  body = json.loads(request.data.decode())',
    '  assert timeout == 25 and request.full_url == "http://127.0.0.1:4321/api/feishu/commander"',
    '  assert body["sourceEventRef"] == "feishu:om_video_1"',
    '  assert body["requesterRef"] == "open-1" and body["targetAgentId"] == body["profileId"] == "xiaod"',
    '  assert host.sent[-1][1].startswith("任务已创建") and "没有自动完成回告监听" in host.sent[-1][1]',
    'asyncio.run(main())',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python, fixture.root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  await rollbackXiaodPublicVideoBridgeV2({
    target: fixture.root,
    backupDirectory: installed.backupDirectory,
    getGitCommit: currentCommit,
  });
  assert.equal(await read(fixture.adapter), CURRENT_HERMES_0201_ADAPTER_FIXTURE);
  await assert.rejects(fs.access(fixture.sidecar));
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test('V2 receipt 只接受当前小D来源契约，允许无 watch 同步成功，并防止 URL/SSRF 混淆', async () => {
  const fixture = await makeHermesFixture();
  await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    getGitCommit: currentCommit,
    pythonCommand: 'python3',
  });
  const python = [
    'import asyncio, importlib, json, os, sys',
    'from types import SimpleNamespace',
    'root = sys.argv[1]; sys.path.insert(0, root)',
    'adapter_module = importlib.import_module("plugins.platforms.feishu.adapter")',
    'bridge = importlib.import_module("plugins.platforms.feishu.agent_army_xiaod_public_video_bridge_v2")',
    'requests = []',
    'def receipt(event_ref, *, task_type="media.transcribe-and-refine", assignee="xiaod", source_chat="chat-1", requester="actual-user", card_agent="xiaod", card_chat="chat-1"):',
    '  return {"task":{"taskId":"task-video-1","taskType":task_type,"assigneeAgentId":assignee,"source":{"channel":"feishu","eventRef":event_ref,"chatRef":source_chat,"targetAgentId":"xiaod","profileId":"xiaod"},"requester":{"kind":"feishu-user","ref":requester}},"taskCard":{"schemaVersion":"agent.army/task-card/v1","taskId":"task-video-1","agentId":card_agent,"profileId":"xiaod","chatId":card_chat,"taskKind":"media.transcribe-and-refine"},"reply":"任务已创建"}',
    'bad_watch = receipt("feishu:om-watch"); bad_watch["completionWatch"] = {"kind":"ajun_task","taskId":"task-video-1","baseUrl":"http://user@127.0.0.1:4321"}',
    'responses = [receipt("feishu:om-1"), receipt("feishu:om-1"), receipt("feishu:om-type", task_type="research"), receipt("feishu:om-session", source_chat="other-chat"), receipt("feishu:om-requester", requester="other-user"), receipt("feishu:om-card", card_agent="other-agent"), bad_watch, {"handled": False, "clarification": "请选择处理方式"}]',
    'class Response:',
    '  status = 202',
    '  def __init__(self, body): self.body = body',
    '  def read(self): return json.dumps(self.body).encode()',
    '  def __enter__(self): return self',
    '  def __exit__(self, *args): return False',
    'def fake_urlopen(request, timeout=0):',
    '  requests.append((request, timeout)); return Response(responses[len(requests) - 1])',
    'bridge.urlopen = fake_urlopen',
    'os.environ.update({"AGENT_ARMY_FEISHU_AGENT_ID":"xiaod","AGENT_ARMY_PROFILE_ID":"xiaod","AJUN_FEISHU_COMMANDER_INGRESS_URL":"http://127.0.0.1:4321/api/feishu/commander"})',
    'def event(message_id, text):',
    '  return SimpleNamespace(text=text,message_id=message_id,message_type="text",media_urls=[],media_types=[],source=SimpleNamespace(chat_id="chat-1",user_id="actual-user",user_id_alt="untrusted-alt"),is_command=lambda: False)',
    'async def submit(host, message_id, text):',
    '  await host._handle_message_with_guards(event(message_id, text)); await asyncio.sleep(0.03)',
    'async def main():',
    '  host = adapter_module.FeishuAdapter()',
    '  one = "https://www.bilibili.com/video/BV1ymux6BEFU/?source=one"',
    '  two = "https://www.bilibili.com/video/BV1ymux6BEFU/?source=two"',
    '  await submit(host, "om-1", one)',
    '  assert len(requests) == 1 and "没有自动完成回告监听" in host.sent[-1][1]',
    '  await submit(host, "om-1", one)',
    '  assert len(requests) == 1',
    '  await submit(host, "om-1", two)',
    '  assert len(requests) == 2',
    '  await submit(host, "om-type", one)',
    '  await submit(host, "om-session", one)',
    '  await submit(host, "om-requester", one)',
    '  await submit(host, "om-card", one)',
    '  await submit(host, "om-watch", one)',
    '  await submit(host, "om-clarify", one)',
    '  assert len(requests) == 8',
    '  assert all(json.loads(item[0].data.decode())["requesterRef"] == "actual-user" for item in requests)',
    '  assert all(item[1] == 25 for item in requests)',
    '  assert sum("不能确认任务已建立" in sent[1] for sent in host.sent) == 6',
    '  os.environ["AJUN_FEISHU_COMMANDER_INGRESS_URL"] = "http://user@127.0.0.1:4321/api/feishu/commander"',
    '  await submit(host, "om-ssrf", one)',
    '  assert len(requests) == 8 and "安全规则" in host.sent[-1][1]',
    '  assert host.fallback_calls == 0',
    'asyncio.run(main())',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python, fixture.root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test('V2 URL 资格与 A君 planner 对齐：YouTube watch 必须有非空 v，并支持 shorts/live', async () => {
  const fixture = await makeHermesFixture();
  await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    getGitCommit: currentCommit,
    pythonCommand: 'python3',
  });
  const python = [
    'import asyncio, importlib, json, os, sys',
    'from types import SimpleNamespace',
    'root = sys.argv[1]; sys.path.insert(0, root)',
    'adapter_module = importlib.import_module("plugins.platforms.feishu.adapter")',
    'bridge = importlib.import_module("plugins.platforms.feishu.agent_army_xiaod_public_video_bridge_v2")',
    'requests = []',
    'def receipt(payload):',
    '  event_ref = payload["sourceEventRef"]; chat = payload["chatRef"]; requester = payload["requesterRef"]',
    '  return {"task":{"taskId":"task-" + event_ref,"taskType":"media.transcribe-and-refine","assigneeAgentId":"xiaod","source":{"channel":"feishu","eventRef":event_ref,"chatRef":chat,"targetAgentId":"xiaod","profileId":"xiaod"},"requester":{"kind":"feishu-user","ref":requester}},"taskCard":{"schemaVersion":"agent.army/task-card/v1","taskId":"task-" + event_ref,"agentId":"xiaod","profileId":"xiaod","chatId":chat,"taskKind":"media.transcribe-and-refine"}}',
    'class Response:',
    '  status = 202',
    '  def __init__(self, body): self.body = body',
    '  def read(self): return json.dumps(self.body).encode()',
    '  def __enter__(self): return self',
    '  def __exit__(self, *args): return False',
    'def fake_urlopen(request, timeout=0):',
    '  payload = json.loads(request.data.decode()); requests.append(payload); return Response(receipt(payload))',
    'bridge.urlopen = fake_urlopen',
    'os.environ.update({"AGENT_ARMY_FEISHU_AGENT_ID":"xiaod","AGENT_ARMY_PROFILE_ID":"xiaod","AJUN_FEISHU_COMMANDER_INGRESS_URL":"http://127.0.0.1:4321/api/feishu/commander"})',
    'def event(index, text): return SimpleNamespace(text=text,message_id="om-url-" + str(index),message_type="text",media_urls=[],media_types=[],source=SimpleNamespace(chat_id="chat-yt",user_id="user-yt"),is_command=lambda: False)',
    'async def main():',
    '  host = adapter_module.FeishuAdapter()',
    '  supported = ["https://www.youtube.com/watch?v=abc", "https://youtube.com/watch?feature=share&v=abc", "https://youtube.com/shorts/abc", "https://youtube.com/live/abc"]',
    '  unsupported = ["https://www.youtube.com/watch", "https://www.youtube.com/watch?v=", "https://www.youtube.com/watch?feature=share", "https://www.youtube.com/watch?feature=share&v="]',
    '  for index, url in enumerate(supported):',
    '    await host._handle_message_with_guards(event(index, url)); await asyncio.sleep(0.02)',
    '  assert len(requests) == len(supported) and host.fallback_calls == 0',
    '  for index, url in enumerate(unsupported, start=len(supported)):',
    '    await host._handle_message_with_guards(event(index, url)); await asyncio.sleep(0)',
    '  assert len(requests) == len(supported)',
    '  assert host.fallback_calls == len(unsupported)',
    'asyncio.run(main())',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python, fixture.root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test('同一 event 的不同 URL 发生 A君冲突时不标记 delivered、不回成功，仍可安全重试', async () => {
  const fixture = await makeHermesFixture();
  await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    getGitCommit: currentCommit,
    pythonCommand: 'python3',
  });
  const python = [
    'import asyncio, importlib, json, os, sys',
    'from types import SimpleNamespace',
    'from urllib.error import HTTPError',
    'root = sys.argv[1]; sys.path.insert(0, root)',
    'adapter_module = importlib.import_module("plugins.platforms.feishu.adapter")',
    'bridge = importlib.import_module("plugins.platforms.feishu.agent_army_xiaod_public_video_bridge_v2")',
    'attempts = []',
    'def receipt(payload):',
    '  event_ref = payload["sourceEventRef"]; chat = payload["chatRef"]; requester = payload["requesterRef"]',
    '  return {"task":{"taskId":"task-first","taskType":"media.transcribe-and-refine","assigneeAgentId":"xiaod","source":{"channel":"feishu","eventRef":event_ref,"chatRef":chat,"targetAgentId":"xiaod","profileId":"xiaod"},"requester":{"kind":"feishu-user","ref":requester}},"taskCard":{"schemaVersion":"agent.army/task-card/v1","taskId":"task-first","agentId":"xiaod","profileId":"xiaod","chatId":chat,"taskKind":"media.transcribe-and-refine"},"reply":"任务已创建"}',
    'class Response:',
    '  status = 202',
    '  def __init__(self, body): self.body = body',
    '  def read(self): return json.dumps(self.body).encode()',
    '  def __enter__(self): return self',
    '  def __exit__(self, *args): return False',
    'def fake_urlopen(request, timeout=0):',
    '  payload = json.loads(request.data.decode()); attempts.append(payload)',
    '  if payload["text"].endswith("two"): raise HTTPError(request.full_url, 409, "conflict", {}, None)',
    '  return Response(receipt(payload))',
    'bridge.urlopen = fake_urlopen',
    'os.environ.update({"AGENT_ARMY_FEISHU_AGENT_ID":"xiaod","AGENT_ARMY_PROFILE_ID":"xiaod","AJUN_FEISHU_COMMANDER_INGRESS_URL":"http://127.0.0.1:4321/api/feishu/commander"})',
    'def event(text): return SimpleNamespace(text=text,message_id="om-conflict",message_type="text",media_urls=[],media_types=[],source=SimpleNamespace(chat_id="chat-conflict",user_id="user-conflict"),is_command=lambda: False)',
    'async def main():',
    '  host = adapter_module.FeishuAdapter()',
    '  first = "https://www.bilibili.com/video/BV1ymux6BEFU/?source=one"; second = "https://www.bilibili.com/video/BV1ymux6BEFU/?source=two"',
    '  await host._handle_message_with_guards(event(first)); await asyncio.sleep(0.03)',
    '  assert len(attempts) == 1 and host.sent[-1][1].startswith("任务已创建")',
    '  await host._handle_message_with_guards(event(second)); await asyncio.sleep(0.03)',
    '  await host._handle_message_with_guards(event(second)); await asyncio.sleep(0.03)',
    '  assert len(attempts) == 3',
    '  bridge_state = host._agent_army_xiaod_public_video_bridge_v2',
    '  assert len(bridge_state._delivered_refs) == 1',
    '  assert sum(message[1].startswith("任务已创建") for message in host.sent) == 1',
    '  assert "未标记为成功" in host.sent[-1][1] and host.fallback_calls == 0',
    'asyncio.run(main())',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python, fixture.root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test('V2 用当前本机 Hermes 0.20.1 adapter 源码副本完成只读 dry-run', async (t) => {
  const liveRoot = path.join(homedir(), '.hermes', 'hermes-agent');
  const liveAdapter = path.join(liveRoot, ADAPTER_RELATIVE_PATH);
  try {
    await fs.access(liveAdapter);
  } catch {
    t.skip('本机没有 Hermes 0.20.1 源码，CI 不读取用户目录');
    return;
  }
  const [adapterSource, pyprojectSource] = await Promise.all([
    read(liveAdapter),
    read(path.join(liveRoot, 'pyproject.toml')),
  ]);
  const git = spawnSync('git', ['-C', liveRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  assert.match(pyprojectSource, new RegExp(`^version\\s*=\\s*["']${SUPPORTED_HERMES_VERSION}["']`, 'm'));
  assert.equal(git.stdout.trim(), SUPPORTED_HERMES_GIT_COMMIT);
  const fixture = await makeHermesFixture({ adapter: adapterSource });
  const before = await read(fixture.adapter);
  const result = await installXiaodPublicVideoBridgeV2({
    target: fixture.root,
    dryRun: true,
    getGitCommit: async () => git.stdout.trim(),
    pythonCommand: 'python3',
  });
  assert.equal(result.wouldChange, true);
  assert.equal(await read(fixture.adapter), before);
  await assert.rejects(fs.access(fixture.sidecar));
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test('已存在但不完整的 V2 seam 或未知 sidecar 都不会被覆盖', async () => {
  const malformed = await makeHermesFixture({
    adapter: `${CURRENT_HERMES_0201_ADAPTER_FIXTURE}\n# ${SEAM_MARKER}: half installed\n`,
  });
  await assert.rejects(
    installXiaodPublicVideoBridgeV2({ target: malformed.root, getGitCommit: currentCommit }),
    /Seam 不完整/,
  );

  const orphan = await makeHermesFixture();
  await fs.writeFile(orphan.sidecar, '# unknown sidecar\n', { mode: 0o600 });
  await assert.rejects(
    installXiaodPublicVideoBridgeV2({ target: orphan.root, getGitCommit: currentCommit }),
    /拒绝覆盖未知文件/,
  );
  await Promise.all([fs.rm(malformed.root, { recursive: true, force: true }), fs.rm(orphan.root, { recursive: true, force: true })]);
});
