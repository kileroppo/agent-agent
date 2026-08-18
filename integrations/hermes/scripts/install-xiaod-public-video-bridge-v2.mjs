#!/usr/bin/env node
/**
 * Install the narrowly-scoped 小D public-video bridge for one pinned Hermes
 * source tree.  This intentionally does not reuse patch-support.mjs: the V1
 * patch family is locked to Hermes 0.19 and must remain independently
 * verifiable.
 */
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const SUPPORTED_HERMES_VERSION = '0.20.1';
export const SUPPORTED_HERMES_GIT_COMMIT = '2be183142c6dd9ac309b6db5b783af5e25c3be18';
export const ADAPTER_RELATIVE_PATH = path.join('plugins', 'platforms', 'feishu', 'adapter.py');
export const SIDECAR_FILENAME = 'agent_army_xiaod_public_video_bridge_v2.py';
export const SIDECAR_RELATIVE_PATH = path.join('plugins', 'platforms', 'feishu', SIDECAR_FILENAME);
export const SEAM_MARKER = 'AGENT_ARMY_XIAOD_PUBLIC_VIDEO_BRIDGE_V2';
export const BACKUP_MANIFEST_FILENAME = 'manifest.json';

const REQUIRED_ADAPTER_ANCHORS = Object.freeze([
  'class FeishuAdapter(BasePlatformAdapter):',
  '    async def _run_blocking(self, func, *args):',
  '    async def disconnect(self) -> None:',
  '    async def send(',
  '    async def _handle_message_with_guards(self, event: MessageEvent) -> None:',
  '            await self.handle_message(event)',
]);

// This is the complete production sidecar.  Keeping it in the installer makes
// the copied byte sequence, its hash and its version lock one reviewable unit.
// It is deliberately standard-library only and owns no credential/config file.
export const SIDECAR_SOURCE = String.raw`"""Hermes 0.20.1 小D公开视频 deterministic ingress bridge.

This sidecar is installed only by Agent Army's V2 installer.  It consumes a
plain, supported public-video URL in the dedicated 小D profile before Hermes'
generic model session sees it, then posts a bounded registration request to the
local A君 ingress.  It never downloads media, invokes a shell, or sends a
request to a non-loopback destination.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import threading
from typing import Any, Dict, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen


BRIDGE_SEAM = "agent.army/hermes-xiaod-public-video-bridge/v2"
SUPPORTED_HERMES_VERSION = "0.20.1"
SUPPORTED_HERMES_GIT_COMMIT = "2be183142c6dd9ac309b6db5b783af5e25c3be18"
_INGRESS_PATH = "/api/feishu/commander"
_INGRESS_TIMEOUT_SECONDS = 25
class XiaodPublicVideoBridgeCompatibilityError(RuntimeError):
    """The pinned Hermes host seam is unavailable or inconsistent."""


def _strict_loopback_http_url(value: Any, *, expected_path: str) -> str:
    raw = str(value or "")
    if (
        not raw
        or raw != raw.strip()
        or len(raw) > 500
        or any(character.isspace() for character in raw)
        or "?" in raw
        or "#" in raw
    ):
        return ""
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.netloc != f"127.0.0.1:{port}"
        or parsed.path != expected_path
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return f"http://127.0.0.1:{port}{expected_path}"


def _xiaod_profile_enabled() -> bool:
    agent_id = (
        os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "")
        or os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "")
    ).strip()
    profile_id = (
        os.getenv("AGENT_ARMY_PROFILE_ID", "")
        or os.getenv("AGENT_ARMY_FEISHU_PROFILE_ID", "")
    ).strip()
    return agent_id == "xiaod" and profile_id == "xiaod"


def _is_plain_text_event(event: Any) -> bool:
    if getattr(event, "media_urls", None) or getattr(event, "media_types", None):
        return False
    is_command = getattr(event, "is_command", None)
    if callable(is_command) and is_command():
        return False
    message_type = str(getattr(event, "message_type", "") or "").lower()
    return not message_type or message_type.endswith("text")


def _is_supported_public_video_url(value: Any) -> bool:
    """Mirror A君's planner eligibility before consuming the chat turn.

    Hermes must not route a URL that A君 will decline: otherwise a normal
    conversation is swallowed and then reported as a mysterious task failure.
    Keep YouTube's watch form especially strict: the query must have a
    non-empty v value; shorts and live are their own supported
    path forms.
    """
    text = str(value or "").strip()
    if not text or any(character.isspace() for character in text):
        return False
    try:
        parsed = urlsplit(text)
    except (TypeError, ValueError):
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    hostname = (parsed.hostname or "").lower()
    if hostname.startswith("www."):
        hostname = hostname[4:]
    pathname = parsed.path or ""
    if hostname == "bilibili.com":
        return bool(re.match(r"^/video/(?:BV|av)[a-z0-9]+", pathname, re.IGNORECASE))
    if hostname == "b23.tv":
        return len(pathname) > 1
    if hostname == "youtube.com":
        if pathname == "/watch":
            try:
                return bool(parse_qs(parsed.query, keep_blank_values=True).get("v", [""])[0])
            except (TypeError, ValueError):
                return False
        return bool(re.match(r"^/(?:shorts|live)/[^/]+", pathname, re.IGNORECASE))
    if hostname == "youtu.be":
        return len(pathname) > 1
    if hostname == "douyin.com":
        return bool(re.match(r"^/(?:video|note)/[^/]+", pathname, re.IGNORECASE))
    if hostname == "v.douyin.com":
        return len(pathname) > 1
    return False


def _verified_task_receipt(
    body: Any,
    *,
    source_event_ref: str,
    chat_id: str,
    requester_ref: str,
) -> Optional[str]:
    if not isinstance(body, Mapping):
        return None
    task = body.get("task")
    card = body.get("taskCard")
    watch = body.get("completionWatch")
    if not isinstance(task, Mapping) or not isinstance(card, Mapping):
        return None
    if card.get("schemaVersion") != "agent.army/task-card/v1":
        return None
    task_id = str(task.get("taskId") or "").strip()
    if not task_id or str(card.get("taskId") or "").strip() != task_id:
        return None
    response_task_id = str(body.get("taskId") or "").strip()
    if response_task_id and response_task_id != task_id:
        return None
    if (
        str(task.get("taskType") or "").strip() != "media.transcribe-and-refine"
        or str(task.get("assigneeAgentId") or "").strip() != "xiaod"
    ):
        return None
    source = task.get("source")
    requester = task.get("requester")
    if not isinstance(source, Mapping) or not isinstance(requester, Mapping):
        return None
    if (
        str(source.get("channel") or "").strip() != "feishu"
        or str(source.get("eventRef") or "").strip() != source_event_ref
        or str(source.get("chatRef") or "").strip() != chat_id
        or str(source.get("targetAgentId") or "").strip() != "xiaod"
        or str(source.get("profileId") or "").strip() != "xiaod"
        or str(requester.get("kind") or "").strip() != "feishu-user"
        or str(requester.get("ref") or "").strip() != requester_ref
    ):
        return None
    if (
        str(card.get("agentId") or "").strip() != "xiaod"
        or str(card.get("profileId") or "").strip() != "xiaod"
        or str(card.get("chatId") or "").strip() != chat_id
        or str(card.get("taskKind") or "").strip() != "media.transcribe-and-refine"
    ):
        return None
    if watch is not None:
        if not isinstance(watch, Mapping):
            return None
        status_url = _strict_loopback_http_url(
            f"{str(watch.get('baseUrl') or '').rstrip('/')}/api/feishu/task-status",
            expected_path="/api/feishu/task-status",
        )
        if (
            str(watch.get("kind") or "").strip() != "ajun_task"
            or str(watch.get("taskId") or "").strip() != task_id
            or not status_url
        ):
            return None
    if not task_id:
        return None
    return task_id


class XiaodPublicVideoBridge:
    def __init__(self, host: Any):
        self._host = host
        self._lock = threading.Lock()
        self._delivered_refs: set[str] = set()
        self._inflight_refs: set[str] = set()
        self._tasks: Dict[str, asyncio.Task[Any]] = {}

    async def _reply(self, chat_id: str, message_id: str, message: str) -> None:
        if chat_id:
            await self._host.send(chat_id, message, reply_to=message_id or None)

    def _finish(self, source_event_ref: str, task: asyncio.Task[Any]) -> None:
        with self._lock:
            if self._tasks.get(source_event_ref) is task:
                self._tasks.pop(source_event_ref, None)
            self._inflight_refs.discard(source_event_ref)
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except Exception:
            # Do not include chat/user/link data in logs.  The user already
            # receives a bounded recovery message from the route itself.
            return

    async def close(self) -> None:
        with self._lock:
            tasks = list(self._tasks.values())
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        with self._lock:
            self._tasks.clear()
            self._inflight_refs.clear()

    async def route(self, event: Any) -> bool:
        if not _xiaod_profile_enabled() or not _is_plain_text_event(event):
            return False
        text = str(getattr(event, "text", "") or "").strip()
        if not _is_supported_public_video_url(text):
            return False

        source = getattr(event, "source", None)
        chat_id = str(getattr(source, "chat_id", "") or "").strip()
        requester_ref = str(
            getattr(source, "user_id", "") or getattr(source, "user_id_alt", "") or ""
        ).strip()
        message_id = str(getattr(event, "message_id", "") or "").strip()
        if not message_id:
            await self._reply(chat_id, message_id, "小D无法登记这条公开视频链接：缺少稳定消息编号；没有启动下载、转录或外部动作。")
            return True
        if not requester_ref:
            await self._reply(chat_id, message_id, "小D无法登记这条公开视频链接：缺少可验证的飞书用户身份；没有启动下载、转录或外部动作。")
            return True
        ingress_url = _strict_loopback_http_url(
            os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", ""),
            expected_path=_INGRESS_PATH,
        )
        if not ingress_url:
            await self._reply(chat_id, message_id, "小D的公开视频任务入口未配置或不符合本机回环安全规则；没有启动下载、转录或外部动作。")
            return True

        source_event_ref = f"feishu:{message_id}"
        route_key = f"{source_event_ref}\x1f{hashlib.sha256(text.encode('utf-8')).hexdigest()}"
        with self._lock:
            if route_key in self._delivered_refs or route_key in self._inflight_refs:
                return True
            self._inflight_refs.add(route_key)

        async def register() -> None:
            payload = json.dumps(
                {
                    "sourceEventRef": source_event_ref,
                    "text": text,
                    "chatRef": chat_id,
                    "requesterRef": requester_ref,
                    "targetAgentId": "xiaod",
                    "profileId": "xiaod",
                    "taskCardPolicy": (
                        os.getenv("AGENT_ARMY_TASK_CARD_POLICY", "")
                        or os.getenv("AGENT_ARMY_FEISHU_TASK_CARD_POLICY", "")
                    ).strip(),
                },
                ensure_ascii=False,
            ).encode("utf-8")

            def post() -> tuple[int, Any]:
                request = Request(
                    ingress_url,
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request, timeout=_INGRESS_TIMEOUT_SECONDS) as response:
                    return int(response.status), json.loads(response.read().decode("utf-8"))

            try:
                status, body = await asyncio.wait_for(
                    self._host._run_blocking(post),
                    timeout=_INGRESS_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                await self._reply(chat_id, message_id, "小D等待本机任务登记超时，不能确认任务是否建立；这条消息未标记为成功，可按原链接稍后重试。")
                return
            except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError):
                await self._reply(chat_id, message_id, "小D暂时没有收到可验证的任务登记回执，不能确认任务是否建立；这条消息未标记为成功，可按原链接稍后重试。")
                return
            task_id = _verified_task_receipt(
                body,
                source_event_ref=source_event_ref,
                chat_id=chat_id,
                requester_ref=requester_ref,
            ) if status in {200, 201, 202} else None
            if not task_id:
                await self._reply(chat_id, message_id, "小D收到的登记回执与本条飞书来源不一致或不完整，不能确认任务已建立；这条消息未标记为成功，可按原链接稍后重试。")
                return
            with self._lock:
                if len(self._delivered_refs) >= 2048:
                    self._delivered_refs.clear()
                self._delivered_refs.add(route_key)
            acknowledgement = body.get("reply") if isinstance(body, Mapping) else None
            response = (
                acknowledgement
                if isinstance(acknowledgement, str) and acknowledgement.strip()
                else "小D已登记这条公开视频链接，正在按任务链处理。"
            )
            if body.get("completionWatch") is None:
                response += "\n\n说明：本次回执没有自动完成回告监听；请以任务状态为准。"
            await self._reply(chat_id, message_id, response)

        try:
            task = asyncio.create_task(register())
        except RuntimeError:
            with self._lock:
                self._inflight_refs.discard(route_key)
            await self._reply(chat_id, message_id, "小D暂时无法开始本机任务登记；没有启动下载、转录或外部动作，请稍后重试。")
            return True
        with self._lock:
            self._tasks[route_key] = task
        task.add_done_callback(lambda completed: self._finish(route_key, completed))
        return True


def install_xiaod_public_video_bridge_v2(
    host_class: Any,
    *,
    hermes_version: str,
    hermes_git_commit: str,
) -> Any:
    """Attach the V2 bridge through Hermes 0.20.1's inherited handle_message seam."""
    if hermes_version != SUPPORTED_HERMES_VERSION:
        raise XiaodPublicVideoBridgeCompatibilityError("unsupported Hermes version for 小D V2 bridge")
    if hermes_git_commit != SUPPORTED_HERMES_GIT_COMMIT:
        raise XiaodPublicVideoBridgeCompatibilityError("unsupported Hermes Git identity for 小D V2 bridge")
    if getattr(host_class, "__agent_army_xiaod_public_video_bridge_v2__", None) == BRIDGE_SEAM:
        return host_class
    required_methods = ("handle_message", "send", "_run_blocking", "disconnect")
    missing = [name for name in required_methods if not callable(getattr(host_class, name, None))]
    if missing:
        raise XiaodPublicVideoBridgeCompatibilityError(
            "Hermes Feishu Adapter interface changed; missing: " + ", ".join(sorted(missing))
        )

    original_handle_message = host_class.handle_message
    original_disconnect = host_class.disconnect

    def bridge_for(instance: Any) -> XiaodPublicVideoBridge:
        bridge = getattr(instance, "_agent_army_xiaod_public_video_bridge_v2", None)
        if not isinstance(bridge, XiaodPublicVideoBridge):
            bridge = XiaodPublicVideoBridge(instance)
            instance._agent_army_xiaod_public_video_bridge_v2 = bridge
        return bridge

    async def patched_handle_message(instance: Any, event: Any, *args: Any, **kwargs: Any) -> Any:
        if await bridge_for(instance).route(event):
            return None
        return await original_handle_message(instance, event, *args, **kwargs)

    async def patched_disconnect(instance: Any, *args: Any, **kwargs: Any) -> Any:
        await bridge_for(instance).close()
        return await original_disconnect(instance, *args, **kwargs)

    host_class.handle_message = patched_handle_message
    host_class.disconnect = patched_disconnect
    host_class.__agent_army_xiaod_public_video_bridge_v2__ = BRIDGE_SEAM
    host_class.__agent_army_xiaod_public_video_bridge_v2_version__ = hermes_version
    host_class.__agent_army_xiaod_public_video_bridge_v2_commit__ = hermes_git_commit
    return host_class
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function assertExactOnce(source, value, description) {
  if (countOccurrences(source, value) !== 1) {
    throw new Error(`Hermes 0.20.1 Feishu 适配器${description}不匹配；拒绝猜测补丁。`);
  }
}

function isSubpath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSafeHermesRoot(root, { allowLiveTarget = false } = {}) {
  if (!path.isAbsolute(root)) {
    throw new Error('Hermes V2 installer 要求显式绝对 --target 路径。');
  }
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    throw new Error('拒绝把 Hermes 根目录设为文件系统根目录。');
  }
  const forbiddenLiveRoot = path.resolve(homedir(), '.hermes', 'live');
  if (resolved === forbiddenLiveRoot || isSubpath(forbiddenLiveRoot, resolved)) {
    throw new Error('V2 installer 拒绝修改 ~/.hermes/live；请先创建独立、可回滚的 Hermes 副本。');
  }
  const activeHermesRoot = path.resolve(homedir(), '.hermes', 'hermes-agent');
  if (
    (resolved === activeHermesRoot || isSubpath(activeHermesRoot, resolved))
    && !allowLiveTarget
  ) {
    throw new Error('V2 installer 默认拒绝活动 Hermes 源码树 ~/.hermes/hermes-agent；外部二次确认后才可显式传 --allow-live-target。');
  }
  return resolved;
}

async function assertRegularSafeFile(filePath, description) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description}必须是普通文件，拒绝跟随符号链接。`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${description}权限过宽（组或其他用户可写），拒绝修改。`);
  }
  return stat;
}

async function assertSafeDirectory(directory, description) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description}必须是实际目录，拒绝跟随符号链接。`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${description}权限过宽（组或其他用户可写），拒绝修改。`);
  }
  return stat;
}

async function assertSafeFeishuDirectoryChain(root) {
  const canonicalRoot = await fs.realpath(root);
  let current = root;
  for (const segment of ['plugins', 'platforms', 'feishu']) {
    current = path.join(current, segment);
    await assertSafeDirectory(current, `Hermes 路径段 ${segment}`);
    const canonicalCurrent = await fs.realpath(current);
    if (!isSubpath(canonicalRoot, canonicalCurrent)) {
      throw new Error(`Hermes 路径段 ${segment}解析到根目录外；拒绝越界写入。`);
    }
  }
  return { feishuDirectory: current, canonicalRoot };
}

async function assertCanonicalFileWithinRoot(filePath, canonicalRoot, description) {
  const canonicalFile = await fs.realpath(filePath);
  if (!isSubpath(canonicalRoot, canonicalFile)) {
    throw new Error(`${description}解析到 Hermes 根目录外；拒绝越界写入。`);
  }
  return canonicalFile;
}

async function readGitCommit(root) {
  try {
    const { stdout } = await execFile('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new Error('Hermes 安装缺少可验证 Git 身份；拒绝修改。');
  }
}

function parsePyprojectVersion(source) {
  return source.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1] || '';
}

export function adapterSeam() {
  return `# ${SEAM_MARKER}: pinned public-video ingress only; no commander, approval, or mobile patch migration.\nfrom .${SIDECAR_FILENAME.slice(0, -3)} import install_xiaod_public_video_bridge_v2\n\ninstall_xiaod_public_video_bridge_v2(\n    FeishuAdapter,\n    hermes_version="${SUPPORTED_HERMES_VERSION}",\n    hermes_git_commit="${SUPPORTED_HERMES_GIT_COMMIT}",\n)`;
}

export function transformAdapter(source) {
  const markerCount = countOccurrences(source, SEAM_MARKER);
  if (markerCount > 0) {
    if (markerCount !== 1) {
      throw new Error('小D公开视频 V2 Seam 出现多次；拒绝继续。');
    }
    const markerIndex = source.indexOf(`# ${SEAM_MARKER}`);
    const before = source.slice(0, markerIndex).trimEnd();
    const canonical = `${before}\n\n${adapterSeam()}\n`;
    if (source !== canonical) {
      throw new Error('小D公开视频 V2 Seam 不完整或被夹带其他补丁；拒绝继续。');
    }
    return { patched: source, changed: false };
  }
  for (const anchor of REQUIRED_ADAPTER_ANCHORS) {
    assertExactOnce(source, anchor, `核心 Host 锚点 ${JSON.stringify(anchor)}`);
  }
  return {
    patched: `${source.trimEnd()}\n\n${adapterSeam()}\n`,
    changed: true,
  };
}

async function resolvePython(root, requestedPython) {
  if (requestedPython) return requestedPython;
  const venvPython = path.join(root, 'venv', 'bin', 'python3');
  try {
    await fs.access(venvPython);
    return venvPython;
  } catch {
    return 'python3';
  }
}

async function compileStagedPython({ root, adapterSource, sidecarSource, pythonCommand }) {
  const stageParent = path.join(root, 'plugins', 'platforms', 'feishu');
  const stageDirectory = await fs.mkdtemp(path.join(stageParent, '.agent-army-xiaod-public-video-v2-stage-'));
  try {
    const stagedAdapter = path.join(stageDirectory, 'adapter.py');
    const stagedSidecar = path.join(stageDirectory, SIDECAR_FILENAME);
    await Promise.all([
      fs.writeFile(stagedAdapter, adapterSource, { mode: 0o600 }),
      fs.writeFile(stagedSidecar, sidecarSource, { mode: 0o600 }),
    ]);
    const python = await resolvePython(root, pythonCommand);
    try {
      await execFile(python, ['-m', 'py_compile', stagedAdapter, stagedSidecar], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || '').trim().slice(0, 240);
      throw new Error(`V2 sidecar 或适配器临时 Python 编译失败${detail ? `：${detail}` : ''}`);
    }
  } finally {
    await fs.rm(stageDirectory, { recursive: true, force: true });
  }
}

async function atomicWriteFile(filePath, content, mode) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.agent-army-v2-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function backupRootFor(root) {
  return path.join(root, '.agent-army-backups', 'xiaod-public-video-bridge-v2');
}

async function assertSafeBackupDirectoryChain(root, backupDirectory) {
  const canonicalRoot = await fs.realpath(root);
  const expectedBackupRoot = backupRootFor(root);
  const backup = path.resolve(backupDirectory);
  if (
    path.dirname(backup) !== expectedBackupRoot
    || !path.basename(backup).startsWith('backup-')
  ) {
    throw new Error('回滚备份必须是该 Hermes 根目录 V2 专用目录下的直接 backup-* 子目录。');
  }
  let current = root;
  let canonicalCurrent = canonicalRoot;
  for (const segment of ['.agent-army-backups', 'xiaod-public-video-bridge-v2', path.basename(backup)]) {
    current = path.join(current, segment);
    await assertSafeDirectory(current, `V2 回滚路径段 ${segment}`);
    canonicalCurrent = await fs.realpath(current);
    if (!isSubpath(canonicalRoot, canonicalCurrent)) {
      throw new Error(`V2 回滚路径段 ${segment}解析到 Hermes 根目录外；拒绝越界回滚。`);
    }
  }
  if (path.dirname(canonicalCurrent) !== await fs.realpath(expectedBackupRoot)) {
    throw new Error('V2 回滚备份不在受控 backup 根目录的直接子目录内。');
  }
  return { backup, canonicalBackup: canonicalCurrent, canonicalRoot };
}

async function assertCanonicalBackupFile(filePath, canonicalBackup, description) {
  const canonicalFile = await fs.realpath(filePath);
  if (path.dirname(canonicalFile) !== canonicalBackup) {
    throw new Error(`${description}解析到 V2 回滚目录外；拒绝读取。`);
  }
  return canonicalFile;
}

async function createBackup({ root, adapter, sidecar, adapterOriginal, sidecarOriginal, adapterMode, sidecarMode, adapterPatched, sidecarPatched }) {
  const backupsDirectory = path.join(root, '.agent-army-backups');
  await fs.mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(backupsDirectory, 'V2 备份根目录');
  const parent = backupRootFor(root);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(parent, 'V2 备份目录');
  const backupDirectory = await fs.mkdtemp(path.join(parent, 'backup-'));
  await fs.chmod(backupDirectory, 0o700);
  const adapterBackup = path.join(backupDirectory, 'adapter.py.before');
  await fs.writeFile(adapterBackup, adapterOriginal, { mode: 0o600 });
  let sidecarBackup = null;
  if (sidecarOriginal !== null) {
    sidecarBackup = path.join(backupDirectory, `${SIDECAR_FILENAME}.before`);
    await fs.writeFile(sidecarBackup, sidecarOriginal, { mode: 0o600 });
  }
  const manifest = {
    schemaVersion: 'agent-army/hermes-xiaod-public-video-bridge-v2-backup/v1',
    hermesVersion: SUPPORTED_HERMES_VERSION,
    hermesGitCommit: SUPPORTED_HERMES_GIT_COMMIT,
    root,
    adapter: {
      relativePath: ADAPTER_RELATIVE_PATH,
      beforeFile: path.basename(adapterBackup),
      beforeSha256: sha256(adapterOriginal),
      afterSha256: sha256(adapterPatched),
      mode: adapterMode,
    },
    sidecar: {
      relativePath: SIDECAR_RELATIVE_PATH,
      beforeFile: sidecarBackup ? path.basename(sidecarBackup) : null,
      beforeSha256: sidecarOriginal === null ? null : sha256(sidecarOriginal),
      afterSha256: sha256(sidecarPatched),
      mode: sidecarMode,
    },
  };
  await fs.writeFile(
    path.join(backupDirectory, BACKUP_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { backupDirectory, manifest };
}

async function readOptionalRegularFile(filePath, description) {
  try {
    const stat = await assertRegularSafeFile(filePath, description);
    return { content: await fs.readFile(filePath), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function inspectXiaodPublicVideoBridgeV2Target({
  target,
  getGitCommit = readGitCommit,
  allowLiveTarget = false,
} = {}) {
  const root = assertSafeHermesRoot(target || '', { allowLiveTarget });
  await assertSafeDirectory(root, 'Hermes 根目录');
  const adapter = path.join(root, ADAPTER_RELATIVE_PATH);
  const sidecar = path.join(root, SIDECAR_RELATIVE_PATH);
  const pyproject = path.join(root, 'pyproject.toml');
  const { canonicalRoot } = await assertSafeFeishuDirectoryChain(root);
  const [pyprojectStat, adapterStat] = await Promise.all([
    assertRegularSafeFile(pyproject, 'Hermes pyproject.toml'),
    assertRegularSafeFile(adapter, 'Hermes Feishu 适配器'),
  ]);
  await Promise.all([
    assertCanonicalFileWithinRoot(pyproject, canonicalRoot, 'Hermes pyproject.toml'),
    assertCanonicalFileWithinRoot(adapter, canonicalRoot, 'Hermes Feishu 适配器'),
  ]);
  const [pyprojectSource, adapterOriginal, sidecarExisting, gitCommit] = await Promise.all([
    fs.readFile(pyproject, 'utf8'),
    fs.readFile(adapter),
    readOptionalRegularFile(sidecar, 'Hermes 小D V2 sidecar'),
    getGitCommit(root),
  ]);
  const version = parsePyprojectVersion(pyprojectSource);
  if (version !== SUPPORTED_HERMES_VERSION || gitCommit !== SUPPORTED_HERMES_GIT_COMMIT) {
    throw new Error(
      `Hermes 版本未通过 V2 锁定校验：需要 ${SUPPORTED_HERMES_VERSION}@${SUPPORTED_HERMES_GIT_COMMIT.slice(0, 12)}，`
      + `实际为 ${version || 'unknown'}@${String(gitCommit || 'unknown').slice(0, 12)}；拒绝猜测补丁。`,
    );
  }
  const adapterText = adapterOriginal.toString('utf8');
  const transformed = transformAdapter(adapterText);
  const sidecarOriginal = sidecarExisting?.content ?? null;
  const sidecarPatched = Buffer.from(SIDECAR_SOURCE, 'utf8');
  if (transformed.changed && sidecarOriginal && !sidecarOriginal.equals(sidecarPatched)) {
    throw new Error('发现未接线或非本安装器生成的小D V2 sidecar；拒绝覆盖未知文件。');
  }
  if (!transformed.changed && (!sidecarOriginal || !sidecarOriginal.equals(sidecarPatched))) {
    throw new Error('小D公开视频 V2 Seam 已存在，但 sidecar 哈希不完整；拒绝继续。');
  }
  return {
    root,
    version,
    gitCommit,
    pyproject,
    pyprojectMode: pyprojectStat.mode & 0o777,
    adapter,
    adapterMode: adapterStat.mode & 0o777,
    adapterOriginal,
    adapterPatched: Buffer.from(transformed.patched, 'utf8'),
    adapterChanged: transformed.changed,
    sidecar,
    sidecarOriginal,
    sidecarPatched,
    sidecarMode: sidecarExisting?.mode ?? (adapterStat.mode & 0o777),
    sidecarChanged: !sidecarOriginal || !sidecarOriginal.equals(sidecarPatched),
  };
}

export async function installXiaodPublicVideoBridgeV2({
  target,
  dryRun = false,
  getGitCommit = readGitCommit,
  pythonCommand,
  allowLiveTarget = false,
} = {}) {
  const plan = await inspectXiaodPublicVideoBridgeV2Target({
    target,
    getGitCommit,
    allowLiveTarget,
  });
  await compileStagedPython({
    root: plan.root,
    adapterSource: plan.adapterPatched,
    sidecarSource: plan.sidecarPatched,
    pythonCommand,
  });
  const changed = plan.adapterChanged || plan.sidecarChanged;
  if (dryRun || !changed) {
    return {
      ...plan,
      changed: false,
      wouldChange: changed,
      dryRun: Boolean(dryRun),
      backupDirectory: null,
    };
  }

  const { backupDirectory } = await createBackup(plan);
  try {
    if (plan.sidecarChanged) {
      await atomicWriteFile(plan.sidecar, plan.sidecarPatched, plan.sidecarMode);
    }
    if (plan.adapterChanged) {
      await atomicWriteFile(plan.adapter, plan.adapterPatched, plan.adapterMode);
    }
  } catch (error) {
    // A partial copy must not leave the bridge ambiguous.  We only restore the
    // two exact, pre-read targets; never recurse or infer any other path.
    await atomicWriteFile(plan.adapter, plan.adapterOriginal, plan.adapterMode).catch(() => {});
    if (plan.sidecarOriginal !== null) {
      await atomicWriteFile(plan.sidecar, plan.sidecarOriginal, plan.sidecarMode).catch(() => {});
    } else {
      await fs.rm(plan.sidecar, { force: true }).catch(() => {});
    }
    throw new Error(`V2 安装写入失败，已尝试恢复备份 ${backupDirectory}：${error.message}`);
  }
  return {
    ...plan,
    changed: true,
    wouldChange: true,
    dryRun: false,
    backupDirectory,
  };
}

export async function rollbackXiaodPublicVideoBridgeV2({
  target,
  backupDirectory,
  getGitCommit = readGitCommit,
  allowLiveTarget = false,
} = {}) {
  const root = assertSafeHermesRoot(target || '', { allowLiveTarget });
  await assertSafeDirectory(root, 'Hermes 根目录');
  const { canonicalRoot } = await assertSafeFeishuDirectoryChain(root);
  if (!backupDirectory || !path.isAbsolute(backupDirectory)) {
    throw new Error('回滚要求显式绝对 --backup 路径。');
  }
  const { backup, canonicalBackup } = await assertSafeBackupDirectoryChain(root, backupDirectory);
  const manifestPath = path.join(backup, BACKUP_MANIFEST_FILENAME);
  const pyprojectPath = path.join(root, 'pyproject.toml');
  await Promise.all([
    assertRegularSafeFile(manifestPath, 'V2 回滚 manifest'),
    assertRegularSafeFile(pyprojectPath, 'Hermes pyproject.toml'),
  ]);
  await Promise.all([
    assertCanonicalFileWithinRoot(pyprojectPath, canonicalRoot, 'Hermes pyproject.toml'),
    assertCanonicalBackupFile(manifestPath, canonicalBackup, 'V2 回滚 manifest'),
  ]);
  const [pyprojectSource, gitCommit] = await Promise.all([
    fs.readFile(pyprojectPath, 'utf8'),
    getGitCommit(root),
  ]);
  if (
    parsePyprojectVersion(pyprojectSource) !== SUPPORTED_HERMES_VERSION
    || gitCommit !== SUPPORTED_HERMES_GIT_COMMIT
  ) {
    throw new Error('当前 Hermes 身份已漂移；拒绝把 V2 备份回滚到未知版本。');
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('V2 回滚 manifest 无法解析。');
  }
  if (
    manifest?.schemaVersion !== 'agent-army/hermes-xiaod-public-video-bridge-v2-backup/v1'
    || manifest.root !== root
    || manifest.hermesVersion !== SUPPORTED_HERMES_VERSION
    || manifest.hermesGitCommit !== SUPPORTED_HERMES_GIT_COMMIT
    || manifest.adapter?.relativePath !== ADAPTER_RELATIVE_PATH
    || manifest.sidecar?.relativePath !== SIDECAR_RELATIVE_PATH
    || manifest.adapter?.beforeFile !== 'adapter.py.before'
    || ![null, `${SIDECAR_FILENAME}.before`].includes(manifest.sidecar?.beforeFile)
  ) {
    throw new Error('V2 回滚 manifest 与目标 Hermes 不匹配。');
  }
  const adapter = path.join(root, ADAPTER_RELATIVE_PATH);
  const sidecar = path.join(root, SIDECAR_RELATIVE_PATH);
  const adapterBeforePath = path.join(backup, manifest.adapter.beforeFile);
  await assertRegularSafeFile(adapter, 'Hermes Feishu 适配器');
  await Promise.all([
    assertCanonicalFileWithinRoot(adapter, canonicalRoot, 'Hermes Feishu 适配器'),
    assertRegularSafeFile(adapterBeforePath, 'V2 adapter 回滚备份'),
    assertCanonicalBackupFile(adapterBeforePath, canonicalBackup, 'V2 adapter 回滚备份'),
  ]);
  const [currentAdapter, currentSidecar, adapterBefore] = await Promise.all([
    fs.readFile(adapter),
    readOptionalRegularFile(sidecar, 'Hermes 小D V2 sidecar'),
    fs.readFile(adapterBeforePath),
  ]);
  if (
    sha256(currentAdapter) !== manifest.adapter.afterSha256
    || !currentSidecar
    || sha256(currentSidecar.content) !== manifest.sidecar.afterSha256
    || sha256(adapterBefore) !== manifest.adapter.beforeSha256
  ) {
    throw new Error('当前 V2 文件或备份已漂移；拒绝覆盖未知状态。');
  }
  let sidecarBefore = null;
  if (manifest.sidecar.beforeFile) {
    const sidecarBeforePath = path.join(backup, manifest.sidecar.beforeFile);
    await Promise.all([
      assertRegularSafeFile(sidecarBeforePath, 'V2 sidecar 回滚备份'),
      assertCanonicalBackupFile(sidecarBeforePath, canonicalBackup, 'V2 sidecar 回滚备份'),
    ]);
    sidecarBefore = await fs.readFile(sidecarBeforePath);
    if (sha256(sidecarBefore) !== manifest.sidecar.beforeSha256) {
      throw new Error('V2 sidecar 备份校验失败；拒绝回滚。');
    }
  }
  await atomicWriteFile(adapter, adapterBefore, manifest.adapter.mode);
  if (sidecarBefore !== null) {
    await atomicWriteFile(sidecar, sidecarBefore, manifest.sidecar.mode);
  } else {
    await fs.rm(sidecar, { force: false });
  }
  return { changed: true, root, backupDirectory: backup };
}

function usage() {
  return [
    '用法：',
    '  node integrations/hermes/scripts/install-xiaod-public-video-bridge-v2.mjs --target /absolute/hermes-root [--dry-run]',
    '  node integrations/hermes/scripts/install-xiaod-public-video-bridge-v2.mjs --target /absolute/hermes-root --rollback /absolute/backup-dir',
    '',
    '只支持 Hermes 0.20.1@2be183142c6dd9ac309b6db5b783af5e25c3be18。',
    '默认拒绝 ~/.hermes/hermes-agent 和 ~/.hermes/live；前者仅在外部二次确认后显式加 --allow-live-target。',
    '该工具不迁移旧 commander、审批或移动端补丁。',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--target') options.target = argv[++index];
    else if (value === '--rollback') options.backupDirectory = argv[++index];
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--allow-live-target') options.allowLiveTarget = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.backupDirectory) {
    const result = await rollbackXiaodPublicVideoBridgeV2(options);
    console.log(`已回滚小D公开视频 V2 bridge：${result.backupDirectory}`);
    return;
  }
  const result = await installXiaodPublicVideoBridgeV2(options);
  if (result.dryRun) {
    console.log(result.wouldChange ? 'V2 dry-run 通过：将安装 sidecar 与单一 adapter seam。' : 'V2 dry-run 通过：安装已完整存在。');
    return;
  }
  console.log(result.changed
    ? `已安装小D公开视频 V2 bridge；备份：${result.backupDirectory}`
    : '小D公开视频 V2 bridge 已完整存在。');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
