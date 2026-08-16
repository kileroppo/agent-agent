from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import signal
import time
import uuid
from ipaddress import ip_address
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from knowledge_index import KnowledgeIndex
from retrieval_engine import RetrievalEngine, RetrievalPaths


WORK_ROOT = Path(
    os.environ.get(
        "LOCAL_AI_WORK_ROOT",
        Path.home() / "Library/Application Support/AgentArmy/local-ai",
    )
).expanduser().resolve()
ARTIFACT_ROOT = WORK_ROOT / "artifacts"
DESKTOP_ATTACHMENT_FIELDS: dict[str, dict[str, bool]] = {
    "vision.analyze": {"imagePath": False, "imagePaths": True},
    "video.analyze": {"videoPath": False},
    "audio.transcribe": {"audioPath": False},
    "image.edit": {"imagePath": False, "imagePaths": True},
}


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("LOCAL_AI_HOST", "127.0.0.1")
    port: int = int(os.environ.get("LOCAL_AI_PORT", "18082"))
    qwen_url: str = os.environ.get("LOCAL_AI_QWEN_URL", "http://127.0.0.1:18081")
    qwen_model: str = os.environ.get(
        "LOCAL_AI_QWEN_MODEL",
        "mlx-community/Qwen3.5-9B-MLX-4bit",
    )
    tts_model: str = os.environ.get(
        "LOCAL_AI_TTS_MODEL",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
    )
    embedding_model: str = os.environ.get(
        "LOCAL_AI_EMBEDDING_MODEL",
        "mlx-community/Qwen3-Embedding-0.6B-8bit",
    )
    reranker_model: str = os.environ.get(
        "LOCAL_AI_RERANKER_MODEL",
        "mlx-community/Qwen3-Reranker-0.6B-4bit",
    )
    flux_model: str = os.environ.get(
        "LOCAL_AI_FLUX_MODEL",
        "Comfy-Org/flux2-klein-4B",
    )
    whisper_model: str = os.environ.get(
        "LOCAL_AI_WHISPER_MODEL",
        "mlx-community/whisper-large-v3-turbo",
    )
    mlx_whisper: str = os.environ.get("LOCAL_AI_MLX_WHISPER", "mlx_whisper")
    ffmpeg: str = os.environ.get("LOCAL_AI_FFMPEG", "ffmpeg")
    ffprobe: str = os.environ.get("LOCAL_AI_FFPROBE", "ffprobe")
    tts_python: str = os.environ.get("LOCAL_AI_TTS_PYTHON", str(WORK_ROOT / "venvs/gateway/bin/python"))
    mflux_generate: str = os.environ.get("LOCAL_AI_MFLUX_GENERATE", str(WORK_ROOT / "venvs/mflux/bin/mflux-generate-flux2"))
    mflux_edit: str = os.environ.get("LOCAL_AI_MFLUX_EDIT", str(WORK_ROOT / "venvs/mflux/bin/mflux-generate-flux2-edit"))
    desktop_url: str | None = os.environ.get("LOCAL_AI_DESKTOP_BASE_URL") or None
    desktop_token: str | None = os.environ.get("LOCAL_AI_DESKTOP_TOKEN") or None
    desktop_max_transfer_bytes: int = int(os.environ.get("LOCAL_AI_DESKTOP_MAX_TRANSFER_BYTES", str(256 * 1024 * 1024)))
    evidence_file: Path = Path(os.environ.get("LOCAL_AI_E2E_EVIDENCE", WORK_ROOT / "e2e-evidence.json"))
    knowledge_root: Path = Path(os.environ.get("LOCAL_AI_KNOWLEDGE_ROOT", WORK_ROOT / "indexes"))
    control_policy_file: Path = Path(os.environ.get("LOCAL_AI_CONTROL_POLICY_FILE", WORK_ROOT / "control-policy.json"))
    qwen_launch_label: str = os.environ.get("LOCAL_AI_QWEN_LAUNCH_LABEL", "com.agent-army.local-ai.qwen35")
    qwen_start_timeout_seconds: int = int(os.environ.get("LOCAL_AI_QWEN_START_TIMEOUT_SECONDS", "120"))
    qwen36_url: str = os.environ.get("LOCAL_AI_QWEN36_URL", "http://127.0.0.1:18080")
    qwen36_launch_label: str = os.environ.get("LOCAL_AI_QWEN36_LAUNCH_LABEL", "com.agent-army.local-ai.qwen36-candidate")
    qwen36_start_timeout_seconds: int = int(os.environ.get("LOCAL_AI_QWEN36_START_TIMEOUT_SECONDS", "300"))


class InvokeRequest(BaseModel):
    capability: str
    input: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    request_id: str | None = None
    approved: bool = False


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str | None = None


class RerankRequest(BaseModel):
    query: str
    documents: list[str]
    instruct: str | None = None


class ServicePolicyRequest(BaseModel):
    mode: str
    idle_seconds: int = 900


class ResourceGate:
    def __init__(self, name: str):
        self.name = name
        self.lock = asyncio.Lock()
        self.pending = 0
        self.active_request_id: str | None = None

    @asynccontextmanager
    async def acquire(self, request_id: str):
        self.pending += 1
        try:
            async with self.lock:
                self.active_request_id = request_id
                yield
        finally:
            self.pending -= 1
            if self.active_request_id == request_id:
                self.active_request_id = None

    def status(self) -> dict[str, Any]:
        return {"activeRequestId": self.active_request_id, "pending": self.pending}


class ProcessRunner:
    def __init__(self):
        self.active: dict[str, asyncio.subprocess.Process] = {}
        self.cancelled: set[str] = set()

    async def run(self, request_id: str, command: str, args: list[str], timeout: int) -> tuple[str, str]:
        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self.active[request_id] = process
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._terminate(process)
            await process.wait()
            raise
        finally:
            self.active.pop(request_id, None)
        text_out = stdout.decode("utf-8", errors="replace")
        text_err = stderr.decode("utf-8", errors="replace")
        if request_id in self.cancelled:
            self.cancelled.discard(request_id)
            raise ProcessCancelledError(request_id)
        if process.returncode != 0:
            raise RuntimeError(f"process failed ({process.returncode}): {(text_err or text_out)[-2000:]}")
        return text_out, text_err

    def cancel(self, request_id: str) -> bool:
        process = self.active.get(request_id)
        if not process:
            return False
        self.cancelled.add(request_id)
        self._terminate(process)
        return True

    @staticmethod
    def _terminate(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return


class ProcessCancelledError(RuntimeError):
    pass


class LocalAiRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.retrieval = RetrievalEngine(RetrievalPaths(settings.embedding_model, settings.reranker_model))
        self.knowledge = KnowledgeIndex(settings.knowledge_root)
        self.runner = ProcessRunner()
        self.gates = {
            "speech": ResourceGate("speech"),
            "heavy": ResourceGate("heavy"),
            "retrieval": ResourceGate("retrieval"),
        }
        self.last_failures: dict[str, dict[str, Any]] = {}
        self.active_desktop_requests: set[str] = set()
        self.desktop_health_snapshot: dict[str, Any] = {
            "configured": bool(settings.desktop_url),
            "reachable": False,
            "healthy": False,
        }
        self.desktop_health_refresh_task: asyncio.Task[None] | None = None
        self.idle_release_task: asyncio.Task[None] | None = None
        self.qwen_active_requests = 0
        self.qwen_last_used = time.monotonic()
        self.qwen36_last_used = time.monotonic()
        self.retrieval_last_used = time.monotonic()
        self.control_policy = self._load_control_policy()

    async def start(self) -> None:
        ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)
        if self.settings.desktop_url:
            await self._refresh_desktop_health()
            self.desktop_health_refresh_task = asyncio.create_task(self._desktop_health_loop())
        self.idle_release_task = asyncio.create_task(self._idle_release_loop())

    async def stop(self) -> None:
        for task in (self.desktop_health_refresh_task, self.idle_release_task):
            if task:
                task.cancel()
        await asyncio.gather(
            *(task for task in (self.desktop_health_refresh_task, self.idle_release_task) if task),
            return_exceptions=True,
        )

    async def qwen_health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(f"{self.settings.qwen_url}/health")
                response.raise_for_status()
                return response.json()
        except Exception as error:
            return {"status": "unavailable", "error": str(error)}

    async def qwen36_health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(f"{self.settings.qwen36_url}/health")
                response.raise_for_status()
                return response.json()
        except Exception as error:
            return {"status": "unavailable", "error": str(error)}

    async def desktop_health(self) -> dict[str, Any]:
        if not self.settings.desktop_url:
            return {"configured": False, "healthy": False}
        return dict(self.desktop_health_snapshot)

    async def _desktop_health_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            await self._refresh_desktop_health()

    async def _refresh_desktop_health(self) -> None:
        validate_private_base_url(self.settings.desktop_url)
        try:
            # The Windows node probes two ComfyUI adapters in fresh Python
            # processes. CUDA is healthy, but cold health checks can exceed the
            # 3-second Mac-local budget and produce a false unavailable state.
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    f"{self.settings.desktop_url.rstrip('/')}/health",
                    headers=self._desktop_headers(),
                )
                response.raise_for_status()
                body = response.json()
                self.desktop_health_snapshot = {
                    "configured": True,
                    # A successful authenticated /health response proves that
                    # the lightweight 18083 control node is reachable.  The
                    # aggregate capability status may still be degraded while
                    # an on-demand ComfyUI process is intentionally stopped.
                    "reachable": True,
                    "healthy": body.get("status") == "healthy",
                    "node": body.get("node"),
                    "capabilities": [
                        row.get("capability")
                        for row in body.get("capabilities", [])
                        if row.get("healthy")
                    ],
                    "services": body.get("services", []),
                }
        except Exception as error:
            self.desktop_health_snapshot = {
                "configured": True,
                "reachable": False,
                "healthy": False,
                "error": (str(error) or type(error).__name__)[-500:],
            }

    def _load_control_policy(self) -> dict[str, dict[str, Any]]:
        defaults = {
            "qwen35": {"mode": "on_demand", "idleSeconds": 900},
            "qwen36-candidate": {"mode": "disabled", "idleSeconds": 900},
            "embedding": {"mode": "on_demand", "idleSeconds": 900},
            "reranker": {"mode": "on_demand", "idleSeconds": 900},
            "comfyui": {"mode": "on_demand", "idleSeconds": 900},
        }
        try:
            raw = json.loads(self.settings.control_policy_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return defaults
        for service_id, default in defaults.items():
            candidate = raw.get(service_id, {}) if isinstance(raw, dict) else {}
            mode = candidate.get("mode") if candidate.get("mode") in {"on_demand", "always_on", "disabled"} else default["mode"]
            idle_seconds = max(60, min(int(candidate.get("idleSeconds", default["idleSeconds"])), 86400))
            defaults[service_id] = {"mode": mode, "idleSeconds": idle_seconds}
        return defaults

    def _save_control_policy(self) -> None:
        self.settings.control_policy_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.settings.control_policy_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.control_policy, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.settings.control_policy_file)

    async def _idle_release_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            now = time.monotonic()
            qwen_policy = self.control_policy["qwen35"]
            if (
                qwen_policy["mode"] == "on_demand"
                and self.qwen_active_requests == 0
                and now - self.qwen_last_used >= qwen_policy["idleSeconds"]
                and (await self.qwen_health()).get("status") in {"healthy", "ok"}
            ):
                await self._launchctl_qwen("stop")
            qwen36_policy = self.control_policy["qwen36-candidate"]
            if (
                qwen36_policy["mode"] == "on_demand"
                and now - self.qwen36_last_used >= qwen36_policy["idleSeconds"]
                and (await self.qwen36_health()).get("status") in {"healthy", "ok"}
            ):
                await self._launchctl_qwen36("stop")
            if now - self.retrieval_last_used >= self.control_policy["embedding"]["idleSeconds"]:
                if self.control_policy["embedding"]["mode"] == "on_demand":
                    await asyncio.to_thread(self.retrieval.unload_embedding)
                if self.control_policy["reranker"]["mode"] == "on_demand":
                    await asyncio.to_thread(self.retrieval.unload_reranker)

    async def _launchctl_qwen(self, action: str) -> None:
        target = f"gui/{os.getuid()}/{self.settings.qwen_launch_label}"
        arguments = {
            "start": ("kickstart", target),
            "restart": ("kickstart", "-k", target),
            "stop": ("kill", "SIGTERM", target),
        }.get(action)
        if not arguments:
            raise HTTPException(400, detail={"code": "invalid_service_action", "message": action})
        process = await asyncio.create_subprocess_exec(
            "/bin/launchctl",
            *arguments,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        if process.returncode != 0 and not (action == "stop" and b"No such process" in stderr):
            raise HTTPException(503, detail={"code": "service_control_failed", "message": stderr.decode("utf-8", errors="replace")[-500:]})
        if action == "stop":
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if (await self.qwen_health()).get("status") not in {"healthy", "ok"}:
                    break
                await asyncio.sleep(0.5)

    async def _ensure_qwen_ready(self) -> None:
        policy = self.control_policy["qwen35"]
        if policy["mode"] == "disabled":
            raise HTTPException(409, detail={"code": "service_disabled", "message": "Qwen3.5 已在 A君中禁用。"})
        if (await self.qwen_health()).get("status") in {"healthy", "ok"}:
            return
        await self._launchctl_qwen("start")
        deadline = time.monotonic() + self.settings.qwen_start_timeout_seconds
        while time.monotonic() < deadline:
            if (await self.qwen_health()).get("status") in {"healthy", "ok"}:
                return
            await asyncio.sleep(2)
        raise HTTPException(503, detail={"code": "service_start_timeout", "message": "Qwen3.5 启动超时。"})

    async def _launchctl_qwen36(self, action: str) -> None:
        target = f"gui/{os.getuid()}/{self.settings.qwen36_launch_label}"
        arguments = {
            "start": ("kickstart", target),
            "restart": ("kickstart", "-k", target),
            "stop": ("kill", "SIGTERM", target),
        }.get(action)
        if not arguments:
            raise HTTPException(400, detail={"code": "invalid_service_action", "message": action})
        process = await asyncio.create_subprocess_exec(
            "/bin/launchctl",
            *arguments,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        if process.returncode != 0 and not (action == "stop" and b"No such process" in stderr):
            raise HTTPException(503, detail={"code": "service_control_failed", "message": stderr.decode("utf-8", errors="replace")[-500:]})
        if action == "stop":
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if (await self.qwen36_health()).get("status") not in {"healthy", "ok"}:
                    break
                await asyncio.sleep(0.5)

    async def _ensure_qwen36_ready(self, action: str = "start") -> None:
        policy = self.control_policy["qwen36-candidate"]
        if policy["mode"] == "disabled":
            raise HTTPException(409, detail={"code": "service_disabled", "message": "Qwen3.6 35B 候选已在 A君中禁用。"})
        if action == "start" and (await self.qwen36_health()).get("status") in {"healthy", "ok"}:
            return
        await self._launchctl_qwen36(action)
        self.qwen36_last_used = time.monotonic()
        deadline = time.monotonic() + self.settings.qwen36_start_timeout_seconds
        while time.monotonic() < deadline:
            if (await self.qwen36_health()).get("status") in {"healthy", "ok"}:
                return
            await asyncio.sleep(2)
        raise HTTPException(503, detail={"code": "service_start_timeout", "message": "Qwen3.6 35B 候选启动超时。"})

    async def control_snapshot(self) -> dict[str, Any]:
        qwen = await self.qwen_health()
        qwen36 = await self.qwen36_health()
        desktop = await self.desktop_health()
        qwen_running = qwen.get("status") in {"healthy", "ok"}
        qwen36_running = qwen36.get("status") in {"healthy", "ok"}
        remote_services = {
            str(row.get("id")): row
            for row in desktop.get("services", [])
            if isinstance(row, dict) and row.get("id")
        }
        comfy = remote_services.get("comfyui", {})
        return {
            "status": "ready",
            "services": [
                service_row("gateway", "Mac AI 控制网关", "mac", "127.0.0.1:18082", "always_on", "running", [], "A君的轻量路由与控制入口"),
                service_row("qwen35", "Qwen3.5 9B", "mac", "127.0.0.1:18081", self.control_policy["qwen35"]["mode"], "running" if qwen_running else "stopped", ["start", "stop", "restart"], "文本、视觉与视频理解", self.control_policy["qwen35"]["idleSeconds"]),
                service_row("qwen36-candidate", "Qwen3.6 35B 候选", "mac", "127.0.0.1:18080", self.control_policy["qwen36-candidate"]["mode"], "running" if qwen36_running else "stopped", ["start", "stop", "restart"], "旧文本候选；不在任何 Agent 默认路由中", self.control_policy["qwen36-candidate"]["idleSeconds"]),
                service_row("embedding", "Qwen3 Embedding 0.6B", "mac", "进程内", self.control_policy["embedding"]["mode"], "running" if self.retrieval.embedding_loaded else "stopped", ["stop"], "知识索引与检索", self.control_policy["embedding"]["idleSeconds"]),
                service_row("reranker", "Qwen3 Reranker 0.6B", "mac", "进程内", self.control_policy["reranker"]["mode"], "running" if self.retrieval.reranker_loaded else "stopped", ["stop"], "检索结果重排", self.control_policy["reranker"]["idleSeconds"]),
                service_row("speech-tools", "Whisper / Qwen3-TTS", "mac", "每次任务", "per_request", "ready", [], "ASR 与语音合成，用完即退出"),
                service_row("mflux", "MFLUX 图片能力", "mac", "每次任务", "per_request", "ready", [], "4070 不可用时的图片替代", None),
                service_row("desktop-node", "4070 增强节点", "windows", "192.168.10.110:18083", "always_on", "running" if desktop.get("reachable") else "offline", ["reconnect"], "轻量检测节点；计划任务 \\AgentArmy\\RTX4070EnhancementNode"),
                service_row(
                    "comfyui",
                    "ComfyUI",
                    "windows",
                    "127.0.0.1:8188",
                    self.control_policy["comfyui"]["mode"],
                    str(comfy.get("state") or ("running" if desktop.get("reachable") else "unknown")),
                    ["start", "stop", "restart", "reconnect"] if comfy else [],
                    "4070 图片生成与编辑；只停止节点自己启动的进程" if comfy else "当前可检测图片能力；Windows 节点升级后开放按需启停",
                    self.control_policy["comfyui"]["idleSeconds"],
                    managed=comfy.get("managed"),
                ),
            ],
            "routing": [
                {"capability": "image.generate", "providers": ["4070 ComfyUI（需批准）", "Mac MFLUX"]},
                {"capability": "image.edit", "providers": ["4070 ComfyUI（需批准）", "Mac MFLUX"]},
                {"capability": "text / vision / video", "providers": ["Mac Qwen3.5", "受控重启一次"]},
                {"capability": "audio.transcribe", "providers": ["Mac Whisper", "Qwen3-ASR 待接入"]},
                {"capability": "audio.synthesize", "providers": ["Mac Qwen3-TTS"]},
            ],
        }

    async def control_service(self, service_id: str, action: str) -> dict[str, Any]:
        if service_id == "qwen35":
            if action in {"start", "restart"} and self.control_policy["qwen35"]["mode"] == "disabled":
                raise HTTPException(409, detail={"code": "service_disabled", "message": "Qwen3.5 已在 A君中禁用。"})
            await self._launchctl_qwen(action)
            if action in {"start", "restart"}:
                await self._ensure_qwen_ready()
            return await self.control_snapshot()
        if service_id == "qwen36-candidate":
            if action == "stop":
                await self._launchctl_qwen36("stop")
            elif action in {"start", "restart"}:
                await self._ensure_qwen36_ready(action)
            else:
                raise HTTPException(400, detail={"code": "service_action_not_allowed", "message": f"{service_id}:{action}"})
            return await self.control_snapshot()
        if service_id == "embedding" and action == "stop":
            await asyncio.to_thread(self.retrieval.unload_embedding)
            return await self.control_snapshot()
        if service_id == "reranker" and action == "stop":
            await asyncio.to_thread(self.retrieval.unload_reranker)
            return await self.control_snapshot()
        if service_id == "desktop-node" and action == "reconnect":
            await self._refresh_desktop_health()
            return await self.control_snapshot()
        if service_id == "comfyui" and action in {"start", "stop", "restart", "reconnect"}:
            if action == "reconnect":
                await self._refresh_desktop_health()
                return await self.control_snapshot()
            await self._desktop_control(service_id, action)
            await self._refresh_desktop_health()
            return await self.control_snapshot()
        raise HTTPException(400, detail={"code": "service_action_not_allowed", "message": f"{service_id}:{action}"})

    async def update_service_policy(self, service_id: str, request: ServicePolicyRequest) -> dict[str, Any]:
        if service_id not in self.control_policy or request.mode not in {"on_demand", "always_on", "disabled"}:
            raise HTTPException(400, detail={"code": "invalid_service_policy", "message": service_id})
        self.control_policy[service_id] = {"mode": request.mode, "idleSeconds": max(60, min(request.idle_seconds, 86400))}
        self._save_control_policy()
        if request.mode == "disabled":
            if service_id == "qwen35":
                await self._launchctl_qwen("stop")
            elif service_id == "qwen36-candidate":
                await self._launchctl_qwen36("stop")
            elif service_id == "embedding":
                await asyncio.to_thread(self.retrieval.unload_embedding)
            elif service_id == "reranker":
                await asyncio.to_thread(self.retrieval.unload_reranker)
            elif service_id == "comfyui" and self.settings.desktop_url:
                await self._desktop_control("comfyui", "stop")
        elif request.mode == "always_on":
            if service_id == "qwen35":
                await self._ensure_qwen_ready()
            elif service_id == "qwen36-candidate":
                await self._ensure_qwen36_ready()
        return await self.control_snapshot()

    async def _desktop_control(self, service_id: str, action: str) -> None:
        if not self.settings.desktop_url:
            raise HTTPException(409, detail={"code": "desktop_node_not_configured", "message": "4070 节点未配置。"})
        validate_private_base_url(self.settings.desktop_url)
        try:
            async with httpx.AsyncClient(timeout=150 if action in {"start", "restart"} else 20) as client:
                response = await client.post(
                    f"{self.settings.desktop_url.rstrip('/')}/v1/control/services/{service_id}/{action}",
                    headers=self._desktop_headers(),
                )
                response.raise_for_status()
        except Exception as error:
            raise HTTPException(502, detail={"code": "desktop_control_failed", "message": str(error)[-500:]}) from error

    def evidence(self) -> dict[str, Any]:
        try:
            return json.loads(self.settings.evidence_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"capabilities": {}}

    async def capabilities(self) -> dict[str, Any]:
        qwen = await self.qwen_health()
        desktop = await self.desktop_health()
        qwen_ok = qwen.get("status") in {"healthy", "ok"}
        evidence = self.evidence().get("capabilities", {})
        definitions = {
            "text.generate": (Path(self.settings.qwen_model).exists(), qwen_ok, "local-qwen35"),
            "vision.analyze": (Path(self.settings.qwen_model).exists(), qwen_ok, "local-qwen35"),
            "video.analyze": (Path(self.settings.ffmpeg).exists() and Path(self.settings.ffprobe).exists() and Path(self.settings.qwen_model).exists(), qwen_ok, "local-qwen35-frames"),
            "audio.transcribe": (Path(self.settings.mlx_whisper).exists() and self._whisper_model_path() is not None, True, "local-whisper"),
            "audio.synthesize": (Path(self.settings.tts_python).exists() and Path(self.settings.tts_model).exists(), True, "local-qwen3-tts"),
            "audio.clone_authorized": (False, False, "not-installed"),
            "image.generate": (Path(self.settings.mflux_generate).exists() and Path(self.settings.flux_model).exists(), True, "local-mflux"),
            "image.edit": (Path(self.settings.mflux_edit).exists() and Path(self.settings.flux_model).exists(), True, "local-mflux"),
            "embedding.create": (Path(self.settings.embedding_model).exists(), True, "local-qwen3-embedding"),
            "rerank.score": (Path(self.settings.reranker_model).exists(), True, "local-qwen3-reranker"),
            "knowledge.index": (Path(self.settings.embedding_model).exists(), True, "local-versioned-index"),
            "knowledge.search": (Path(self.settings.embedding_model).exists() and Path(self.settings.reranker_model).exists(), True, "local-vector-rerank"),
            "video.generate": (False, False, "network-approval-gated"),
        }
        rows = []
        for capability, (configured, healthy, provider) in definitions.items():
            proof = evidence.get(capability)
            rows.append({
                "capability": capability,
                "declared": True,
                "configured": configured,
                "healthy": bool(configured and healthy),
                "e2eVerified": bool(proof),
                "verifiedAt": proof.get("verifiedAt") if isinstance(proof, dict) else None,
                "provider": provider,
                "failure": self.last_failures.get(capability),
            })
        return {
            "status": "healthy" if all(row["healthy"] for row in rows if row["capability"] not in {"audio.clone_authorized", "video.generate"}) else "degraded",
            "node": "m1-max-primary",
            "desktopEnhancement": desktop,
            "queues": {name: gate.status() for name, gate in self.gates.items()},
            "capabilities": rows,
        }

    async def invoke(self, request: InvokeRequest) -> dict[str, Any]:
        request_id = normalize_request_id(request.request_id)
        started = time.monotonic()
        preferred_node = str(request.options.get("preferredNode") or "mac")
        if preferred_node == "desktop":
            return await self._desktop_invoke(request, request_id, started)
        if preferred_node not in {"mac", "auto"}:
            raise HTTPException(400, detail={"code": "invalid_preferred_node", "message": preferred_node})
        handlers = {
            "text.generate": self.text_generate,
            "vision.analyze": self.vision_analyze,
            "video.analyze": self.video_analyze,
            "audio.transcribe": self.audio_transcribe,
            "audio.synthesize": self.audio_synthesize,
            "image.generate": self.image_generate,
            "image.edit": self.image_edit,
            "embedding.create": self.embedding_create,
            "rerank.score": self.rerank_score,
            "knowledge.index": self.knowledge_index,
            "knowledge.search": self.knowledge_search,
        }
        if request.capability == "video.generate":
            raise HTTPException(409, detail={"code": "external_approval_required", "message": "视频生成是联网能力，当前未获外发与费用授权。"})
        if request.capability == "audio.clone_authorized":
            raise HTTPException(409, detail={"code": "voice_clone_model_not_installed", "message": "当前 CustomVoice 只提供固定音色；授权克隆模型未安装。"})
        handler = handlers.get(request.capability)
        if handler is None:
            raise HTTPException(404, detail={"code": "unknown_capability", "message": request.capability})
        desktop_failure: str | None = None
        if (
            preferred_node == "auto"
            and request.approved
            and request.capability in {"image.generate", "image.edit"}
            and self.settings.desktop_url
        ):
            try:
                return await self._desktop_invoke(request, request_id, started)
            except HTTPException as error:
                desktop_failure = str(error.detail)[-500:]
        try:
            result = await handler(request_id, request.input, request.options)
            self.last_failures.pop(request.capability, None)
            response = {
                "requestId": request_id,
                "capability": request.capability,
                "provider": result.pop("provider", "local"),
                "elapsedSeconds": round(time.monotonic() - started, 3),
                "result": result,
            }
            if desktop_failure:
                response["fallbackFrom"] = {"node": "rtx-4070ti-super", "error": desktop_failure}
            return response
        except HTTPException:
            raise
        except ProcessCancelledError as error:
            raise HTTPException(409, detail={"code": "request_cancelled", "message": f"本机模型请求已取消：{error}"}) from error
        except asyncio.TimeoutError as error:
            self._remember_failure(request.capability, "timeout", str(error))
            raise HTTPException(504, detail={"code": "local_model_timeout", "message": "本机模型执行超时。"}) from error
        except Exception as error:
            if request.options.get("allowDesktopFallback") and request.approved and self.settings.desktop_url:
                return await self._desktop_invoke(request, request_id, started, local_error=str(error))
            code = "local_model_oom" if "out of memory" in str(error).lower() else "local_model_failed"
            self._remember_failure(request.capability, code, str(error))
            raise HTTPException(500, detail={"code": code, "message": str(error)[-1000:]}) from error

    async def text_generate(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        prompt = required_text(payload, "prompt", 120_000)
        messages = []
        if payload.get("system"):
            messages.append({"role": "system", "content": str(payload["system"])[:20_000]})
        messages.append({"role": "user", "content": prompt})
        response = await self._qwen_chat(messages, options)
        return {"provider": "local-qwen35", "text": response["choices"][0]["message"]["content"], "usage": response.get("usage"), "timings": response.get("timings")}

    async def vision_analyze(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        prompt = required_text(payload, "prompt", 20_000)
        paths = payload.get("imagePaths") or ([payload["imagePath"]] if payload.get("imagePath") else [])
        if not 1 <= len(paths) <= 12:
            raise ValueError("imagePaths must contain 1 to 12 files")
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for value in paths:
            path = require_local_file(value)
            mime = mimetypes.guess_type(path.name)[0] or "image/png"
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
            content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}})
        response = await self._qwen_chat([{"role": "user", "content": content}], options)
        return {"provider": "local-qwen35", "text": response["choices"][0]["message"]["content"], "imageCount": len(paths), "usage": response.get("usage"), "timings": response.get("timings")}

    async def video_analyze(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        video = require_local_file(payload.get("videoPath"))
        prompt = str(payload.get("prompt") or "按时间顺序概括视频内容，并引用给出的时间点。")[:20_000]
        frame_count = max(2, min(int(options.get("frameCount", 6)), 12))
        duration = await self._probe_duration(request_id, video)
        timestamps = sample_timestamps(duration, frame_count)
        frame_dir = ARTIFACT_ROOT / "video" / request_id
        frame_dir.mkdir(parents=True, exist_ok=True)
        frame_paths = []
        async with self.gates["heavy"].acquire(request_id):
            for index, timestamp in enumerate(timestamps):
                target = frame_dir / f"frame-{index:02d}-{timestamp:.3f}.jpg"
                await self.runner.run(
                    request_id,
                    self.settings.ffmpeg,
                    ["-hide_banner", "-loglevel", "error", "-ss", f"{timestamp:.3f}", "-i", str(video), "-frames:v", "1", "-q:v", "2", "-y", str(target)],
                    60,
                )
                frame_paths.append(str(target))
        time_legend = "；".join(f"图{index + 1}={timestamp:.2f}秒" for index, timestamp in enumerate(timestamps))
        result = await self.vision_analyze(request_id, {"prompt": f"{prompt}\n时间点映射：{time_legend}", "imagePaths": frame_paths}, options)
        result.update({"provider": "local-qwen35-frames", "durationSeconds": duration, "frames": [{"timestamp": timestamp, "path": path} for timestamp, path in zip(timestamps, frame_paths)]})
        return result

    async def audio_transcribe(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        audio = require_local_file(payload.get("audioPath"))
        model = self._whisper_model_path()
        if model is None:
            raise RuntimeError("Whisper model snapshot is missing")
        output_dir = ARTIFACT_ROOT / "asr" / request_id
        output_dir.mkdir(parents=True, exist_ok=True)
        args = [str(audio), "--model", str(model), "--output-dir", str(output_dir), "--output-name", "transcript", "--output-format", "json", "--verbose", "False"]
        if payload.get("language"):
            args.extend(["--language", str(payload["language"])])
        async with self.gates["speech"].acquire(request_id):
            await self.runner.run(request_id, self.settings.mlx_whisper, args, int(options.get("timeoutSeconds", 3600)))
        output = json.loads((output_dir / "transcript.json").read_text(encoding="utf-8"))
        return {"provider": "local-whisper", "text": output.get("text", ""), "language": output.get("language"), "segments": output.get("segments", []), "artifactPath": str(output_dir / "transcript.json")}

    async def audio_synthesize(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        text = required_text(payload, "text", 20_000)
        output_dir = ARTIFACT_ROOT / "tts" / request_id
        output_dir.mkdir(parents=True, exist_ok=True)
        args = ["-m", "mlx_audio.tts.generate", "--model", self.settings.tts_model, "--text", text, "--voice", str(payload.get("voice") or "Vivian"), "--max_tokens", str(min(int(options.get("maxTokens", 4096)), 8192)), "--output_path", str(output_dir), "--file_prefix", "speech", "--audio_format", "wav"]
        if payload.get("instruct"):
            args.extend(["--instruct", str(payload["instruct"])[:1000]])
        async with self.gates["speech"].acquire(request_id):
            await self.runner.run(request_id, self.settings.tts_python, args, int(options.get("timeoutSeconds", 1800)))
        files = sorted(output_dir.glob("speech*.wav"))
        if not files:
            raise RuntimeError("TTS completed without an audio artifact")
        duration = await self._probe_duration(request_id, files[0])
        return {"provider": "local-qwen3-tts", "artifactPath": str(files[0]), "durationSeconds": duration, "voice": payload.get("voice") or "Vivian"}

    async def embedding_create(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        if self.control_policy["embedding"]["mode"] == "disabled":
            raise HTTPException(409, detail={"code": "service_disabled", "message": "Embedding 已在 A君中禁用。"})
        self.retrieval_last_used = time.monotonic()
        texts = payload.get("texts") or ([payload["text"]] if payload.get("text") else [])
        texts = [str(value)[:100_000] for value in texts]
        async with self.gates["retrieval"].acquire(request_id):
            embeddings = await asyncio.to_thread(self.retrieval.embed, texts)
        return {"provider": "local-qwen3-embedding", "model": self.settings.embedding_model, "dimensions": len(embeddings[0]), "embeddings": embeddings}

    async def rerank_score(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        if self.control_policy["reranker"]["mode"] == "disabled":
            raise HTTPException(409, detail={"code": "service_disabled", "message": "Reranker 已在 A君中禁用。"})
        self.retrieval_last_used = time.monotonic()
        query = required_text(payload, "query", 20_000)
        documents = [str(value)[:100_000] for value in payload.get("documents", [])]
        async with self.gates["retrieval"].acquire(request_id):
            scores = await asyncio.to_thread(self.retrieval.rerank, query, documents, payload.get("instruct"))
        return {"provider": "local-qwen3-reranker", "model": self.settings.reranker_model, "results": scores}

    async def knowledge_index(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        documents = payload.get("documents") or []
        if not isinstance(documents, list):
            raise ValueError("documents must be an array")
        texts = [required_text(document, "text", 100_000) for document in documents]
        async with self.gates["retrieval"].acquire(request_id):
            vectors = await asyncio.to_thread(self.retrieval.embed, texts)
            result = await asyncio.to_thread(
                self.knowledge.upsert,
                name=str(payload.get("indexName") or ""),
                index_version=str(payload.get("indexVersion") or ""),
                chunk_version=str(payload.get("chunkVersion") or ""),
                model_revision=self.settings.embedding_model,
                documents=documents,
                vectors=vectors,
                replace=bool(options.get("replace", False)),
            )
        return {"provider": "local-versioned-index", **result}

    async def knowledge_search(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        query = required_text(payload, "query", 20_000)
        top_k = max(1, min(int(options.get("topK", 20)), 50))
        rerank_top_k = max(1, min(int(options.get("rerankTopK", 5)), top_k))
        access_scopes = payload.get("accessScopes") or ["local-private"]
        if not isinstance(access_scopes, list) or not all(isinstance(value, str) for value in access_scopes):
            raise ValueError("accessScopes must be an array of strings")
        async with self.gates["retrieval"].acquire(request_id):
            query_vector = (await asyncio.to_thread(self.retrieval.embed, [query]))[0]
            candidates = await asyncio.to_thread(
                self.knowledge.candidates,
                name=str(payload.get("indexName") or ""),
                index_version=str(payload.get("indexVersion") or ""),
                query_vector=query_vector,
                access_scopes=access_scopes,
                top_k=top_k,
            )
            if candidates:
                reranked = await asyncio.to_thread(
                    self.retrieval.rerank,
                    query,
                    [candidate["text"] for candidate in candidates],
                    payload.get("instruct"),
                )
                for score in reranked:
                    candidates[score["index"]]["rerankScore"] = score["score"]
                candidates.sort(key=lambda item: item.get("rerankScore", 0), reverse=True)
        return {
            "provider": "local-vector-rerank",
            "indexName": payload.get("indexName"),
            "indexVersion": payload.get("indexVersion"),
            "results": candidates[:rerank_top_k],
        }

    async def image_generate(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        prompt = required_text(payload, "prompt", 10_000)
        width, height, steps = image_parameters(options)
        output_dir = ARTIFACT_ROOT / "images" / request_id
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / "generated.png"
        args = ["--model", self.settings.flux_model, "--base-model", "flux2-klein-4b", "--prompt", prompt, "--seed", str(int(options.get("seed", int(time.time()) % 1_000_000_000))), "--height", str(height), "--width", str(width), "--steps", str(steps), "--guidance", str(float(options.get("guidance", 1.0))), "--low-ram", "--mlx-cache-limit-gb", "12", "--metadata", "--output", str(output)]
        async with self.gates["heavy"].acquire(request_id):
            stdout, stderr = await self.runner.run(request_id, self.settings.mflux_generate, args, int(options.get("timeoutSeconds", 3600)))
        return {"provider": "local-mflux", "artifactPath": str(output), "width": width, "height": height, "steps": steps, "runtimeLog": (stdout + stderr)[-1000:]}

    async def image_edit(self, request_id: str, payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        prompt = required_text(payload, "prompt", 10_000)
        paths = payload.get("imagePaths") or ([payload["imagePath"]] if payload.get("imagePath") else [])
        if not 1 <= len(paths) <= 4:
            raise ValueError("imagePaths must contain 1 to 4 files")
        images = [str(require_local_file(value)) for value in paths]
        width, height, steps = image_parameters(options)
        output_dir = ARTIFACT_ROOT / "images" / request_id
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / "edited.png"
        args = ["--model", self.settings.flux_model, "--base-model", "flux2-klein-4b", "--image-paths", *images, "--prompt", prompt, "--seed", str(int(options.get("seed", int(time.time()) % 1_000_000_000))), "--height", str(height), "--width", str(width), "--steps", str(steps), "--guidance", str(float(options.get("guidance", 1.0))), "--low-ram", "--mlx-cache-limit-gb", "12", "--metadata", "--output", str(output)]
        async with self.gates["heavy"].acquire(request_id):
            stdout, stderr = await self.runner.run(request_id, self.settings.mflux_edit, args, int(options.get("timeoutSeconds", 3600)))
        return {"provider": "local-mflux", "artifactPath": str(output), "inputCount": len(images), "width": width, "height": height, "steps": steps, "runtimeLog": (stdout + stderr)[-1000:]}

    async def _qwen_chat(self, messages: list[dict[str, Any]], options: dict[str, Any]) -> dict[str, Any]:
        await self._ensure_qwen_ready()
        self.qwen_active_requests += 1
        self.qwen_last_used = time.monotonic()
        body = {
            "model": self.settings.qwen_model,
            "messages": messages,
            "temperature": float(options.get("temperature", 0)),
            "max_tokens": max(1, min(int(options.get("maxTokens", 2048)), 4096)),
            "stream": False,
        }
        try:
            async with httpx.AsyncClient(timeout=float(options.get("timeoutSeconds", 300))) as client:
                response = await client.post(f"{self.settings.qwen_url}/v1/chat/completions", json=body)
                response.raise_for_status()
                return response.json()
        finally:
            self.qwen_active_requests -= 1
            self.qwen_last_used = time.monotonic()

    async def _desktop_invoke(
        self,
        request: InvokeRequest,
        request_id: str,
        started: float,
        local_error: str | None = None,
    ) -> dict[str, Any]:
        if not request.approved:
            raise HTTPException(
                409,
                detail={"code": "desktop_dispatch_approval_required", "message": "跨设备发送输入需要本次请求显式 approved=true。"},
            )
        if not self.settings.desktop_url:
            raise HTTPException(
                409,
                detail={"code": "desktop_node_not_configured", "message": "4070 Ti Super 节点尚未配置地址与凭据。"},
            )
        validate_private_base_url(self.settings.desktop_url)
        options = dict(request.options)
        options.pop("preferredNode", None)
        options.pop("allowDesktopFallback", None)
        remote_input, attachments = prepare_desktop_payload(
            request.capability,
            request.input,
            self.settings.desktop_max_transfer_bytes,
        )
        body = request.model_dump()
        body.update({
            "request_id": request_id,
            "input": remote_input,
            "options": options,
            "approved": True,
            "attachments": attachments,
        })
        self.active_desktop_requests.add(request_id)
        try:
            async with httpx.AsyncClient(timeout=float(options.get("timeoutSeconds", 3600))) as client:
                response = await client.post(
                    f"{self.settings.desktop_url.rstrip('/')}/v1/invoke",
                    json=body,
                    headers=self._desktop_headers(),
                )
                if response.status_code == 409:
                    detail = response.json().get("detail", {})
                    if detail.get("code") == "request_cancelled":
                        raise HTTPException(409, detail=detail)
                response.raise_for_status()
                remote = response.json()
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(
                502,
                detail={"code": "desktop_node_failed", "message": str(error)[-1000:]},
            ) from error
        finally:
            self.active_desktop_requests.discard(request_id)
        remote_result = unpack_desktop_artifact(
            request_id,
            remote.get("result", remote),
            ARTIFACT_ROOT / "desktop",
            self.settings.desktop_max_transfer_bytes,
        )
        return {
            "requestId": request_id,
            "capability": request.capability,
            "provider": f"desktop:{remote.get('provider', 'remote')}",
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "result": remote_result,
            "fallbackFrom": {"node": "m1-max-primary", "error": local_error[-500:]} if local_error else None,
        }

    def _desktop_headers(self) -> dict[str, str]:
        if not self.settings.desktop_token:
            return {}
        return {"Authorization": f"Bearer {self.settings.desktop_token}"}

    async def cancel(self, request_id: str) -> dict[str, Any]:
        local_cancelled = self.runner.cancel(request_id)
        desktop_cancelled = False
        if request_id in self.active_desktop_requests and self.settings.desktop_url:
            validate_private_base_url(self.settings.desktop_url)
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    response = await client.delete(
                        f"{self.settings.desktop_url.rstrip('/')}/v1/requests/{request_id}",
                        headers=self._desktop_headers(),
                    )
                    response.raise_for_status()
                    desktop_cancelled = response.json().get("cancelled") is True
            except Exception:
                desktop_cancelled = False
        return {
            "requestId": request_id,
            "cancelled": local_cancelled or desktop_cancelled,
            "localCancelled": local_cancelled,
            "desktopCancelled": desktop_cancelled,
        }

    async def _probe_duration(self, request_id: str, path: Path) -> float:
        stdout, _ = await self.runner.run(request_id, self.settings.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)], 30)
        return round(float(stdout.strip()), 3)

    def _whisper_model_path(self) -> Path | None:
        configured = Path(self.settings.whisper_model)
        if configured.is_dir() and (configured / "config.json").exists():
            return configured
        if configured.is_dir():
            candidates = [path for path in configured.iterdir() if path.is_dir() and (path / "config.json").exists()]
            return sorted(candidates)[-1] if candidates else None
        return None

    def _remember_failure(self, capability: str, code: str, message: str) -> None:
        self.last_failures[capability] = {"code": code, "message": message[-500:], "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def normalize_request_id(value: str | None) -> str:
    candidate = value or str(uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", candidate):
        raise HTTPException(400, detail={"code": "invalid_request_id", "message": "request_id contains unsupported characters"})
    return candidate


def required_text(payload: dict[str, Any], key: str, limit: int) -> str:
    value = str(payload.get(key) or "").strip()
    if not value:
        raise ValueError(f"{key} is required")
    return value[:limit]


def require_local_file(value: Any) -> Path:
    if not value:
        raise ValueError("file path is required")
    path = Path(str(value)).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"local file does not exist: {path}")
    return path


def image_parameters(options: dict[str, Any]) -> tuple[int, int, int]:
    width = max(256, min(int(options.get("width", 1024)), 1536))
    height = max(256, min(int(options.get("height", 1024)), 1536))
    width -= width % 16
    height -= height % 16
    steps = max(1, min(int(options.get("steps", 4)), 20))
    return width, height, steps


def sample_timestamps(duration: float, count: int) -> list[float]:
    if duration <= 0:
        raise ValueError("video duration must be positive")
    if count == 1:
        return [duration / 2]
    margin = min(0.25, duration / 10)
    usable = max(duration - 2 * margin, 0)
    return [round(margin + usable * index / (count - 1), 3) for index in range(count)]


def validate_private_base_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("desktop base URL must be an http(s) URL without embedded credentials")
    hostname = parsed.hostname
    if hostname == "localhost":
        return
    try:
        address = ip_address(hostname)
    except ValueError as error:
        raise ValueError("desktop base URL must use a private IP address or localhost") from error
    if not (address.is_private or address.is_loopback):
        raise ValueError("desktop base URL must stay on a private network")


def prepare_desktop_payload(
    capability: str,
    payload: dict[str, Any],
    max_bytes: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    remote_input = json.loads(json.dumps(payload))
    attachments: list[dict[str, Any]] = []
    total = 0
    for field, multiple in DESKTOP_ATTACHMENT_FIELDS.get(capability, {}).items():
        raw = payload.get(field)
        values = raw if multiple and isinstance(raw, list) else ([raw] if raw else [])
        if not values:
            continue
        remote_input.pop(field, None)
        for index, value in enumerate(values):
            path = require_local_file(value)
            size = path.stat().st_size
            total += size
            if total > max_bytes:
                raise HTTPException(
                    413,
                    detail={"code": "desktop_attachment_too_large", "message": f"跨设备附件超过 {max_bytes} 字节上限。"},
                )
            data = path.read_bytes()
            attachment = {
                "field": field,
                "name": path.name,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "dataBase64": base64.b64encode(data).decode("ascii"),
            }
            if multiple:
                attachment["index"] = index
            attachments.append(attachment)
    return remote_input, attachments


def unpack_desktop_artifact(
    request_id: str,
    result: Any,
    artifact_root: Path,
    max_bytes: int,
) -> Any:
    if not isinstance(result, dict) or not isinstance(result.get("artifact"), dict):
        return result
    artifact = result["artifact"]
    try:
        data = base64.b64decode(str(artifact.get("dataBase64") or ""), validate=True)
    except (ValueError, TypeError) as error:
        raise HTTPException(502, detail={"code": "desktop_artifact_invalid", "message": "台式机返回了无效产物编码。"}) from error
    if len(data) > max_bytes:
        raise HTTPException(502, detail={"code": "desktop_artifact_too_large", "message": str(max_bytes)})
    expected_size = int(artifact.get("size", len(data)))
    expected_sha = str(artifact.get("sha256") or "")
    actual_sha = hashlib.sha256(data).hexdigest()
    if expected_size != len(data) or not hmac.compare_digest(expected_sha, actual_sha):
        raise HTTPException(502, detail={"code": "desktop_artifact_checksum_mismatch", "message": "台式机产物完整性校验失败。"})
    raw_name = Path(str(artifact.get("name") or "artifact.bin")).name
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", raw_name)[:120] or "artifact.bin"
    output_dir = artifact_root / normalize_request_id(request_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / safe_name
    output.write_bytes(data)
    unpacked = dict(result)
    unpacked.pop("artifact", None)
    unpacked["artifactPath"] = str(output)
    return unpacked


def service_row(
    service_id: str,
    name: str,
    node: str,
    endpoint: str,
    mode: str,
    state: str,
    actions: list[str],
    detail: str,
    idle_seconds: int | None = None,
    managed: bool | None = None,
) -> dict[str, Any]:
    return {
        "id": service_id,
        "name": name,
        "node": node,
        "endpoint": endpoint,
        "mode": mode,
        "state": state,
        "actions": actions,
        "detail": detail,
        "idleSeconds": idle_seconds,
        "managed": managed,
    }


settings = Settings()
runtime = LocalAiRuntime(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.host not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Local AI gateway must bind to a loopback address")
    await runtime.start()
    try:
        yield
    finally:
        await runtime.stop()


app = FastAPI(title="Agent Army Local AI", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return await runtime.capabilities()


@app.get("/v1/capabilities")
async def capabilities() -> dict[str, Any]:
    return await runtime.capabilities()


@app.get("/v1/control")
async def control() -> dict[str, Any]:
    return await runtime.control_snapshot()


@app.post("/v1/control/services/{service_id}/{action}")
async def control_service(service_id: str, action: str) -> dict[str, Any]:
    return await runtime.control_service(service_id, action)


@app.put("/v1/control/services/{service_id}/policy")
async def update_service_policy(service_id: str, request: ServicePolicyRequest) -> dict[str, Any]:
    return await runtime.update_service_policy(service_id, request)


@app.post("/v1/invoke")
async def invoke(request: InvokeRequest) -> dict[str, Any]:
    return await runtime.invoke(request)


@app.post("/v1/embeddings")
async def embeddings(request: EmbeddingRequest) -> dict[str, Any]:
    texts = request.input if isinstance(request.input, list) else [request.input]
    result = await runtime.embedding_create(str(uuid.uuid4()), {"texts": texts}, {})
    return {"object": "list", "model": result["model"], "data": [{"object": "embedding", "index": index, "embedding": vector} for index, vector in enumerate(result["embeddings"])]}


@app.post("/v1/rerank")
async def rerank(request: RerankRequest) -> dict[str, Any]:
    result = await runtime.rerank_score(str(uuid.uuid4()), request.model_dump(), {})
    return {"model": result["model"], "results": result["results"]}


@app.delete("/v1/requests/{request_id}")
async def cancel(request_id: str) -> dict[str, Any]:
    normalized = normalize_request_id(request_id)
    return await runtime.cancel(normalized)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
