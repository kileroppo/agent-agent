from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import signal
import subprocess
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field


DEFAULT_MAX_TRANSFER_BYTES = 256 * 1024 * 1024
PRIVATE_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
)

ATTACHMENT_FIELDS: dict[str, dict[str, bool]] = {
    "vision.analyze": {"imagePath": False, "imagePaths": True},
    "video.analyze": {"videoPath": False},
    "audio.transcribe": {"audioPath": False},
    "image.edit": {"imagePath": False, "imagePaths": True},
}


@dataclass(frozen=True)
class DesktopSettings:
    host: str
    port: int
    token: str
    allowed_cidrs: tuple[ipaddress._BaseNetwork, ...]
    adapter_config: Path
    work_root: Path
    max_transfer_bytes: int = DEFAULT_MAX_TRANSFER_BYTES

    @classmethod
    def from_env(cls) -> "DesktopSettings":
        cidrs = tuple(
            ipaddress.ip_network(value.strip(), strict=False)
            for value in os.environ.get("LOCAL_AI_DESKTOP_ALLOWED_CIDRS", "").split(",")
            if value.strip()
        )
        return cls(
            host=os.environ.get("LOCAL_AI_DESKTOP_HOST", "127.0.0.1"),
            port=int(os.environ.get("LOCAL_AI_DESKTOP_PORT", "18083")),
            token=os.environ.get("LOCAL_AI_DESKTOP_TOKEN", ""),
            allowed_cidrs=cidrs,
            adapter_config=Path(os.environ.get("LOCAL_AI_DESKTOP_ADAPTER_CONFIG", "desktop-adapters.json")).expanduser().resolve(),
            work_root=Path(os.environ.get("LOCAL_AI_DESKTOP_WORK_ROOT", "work/local-ai-desktop")).expanduser().resolve(),
            max_transfer_bytes=int(os.environ.get("LOCAL_AI_DESKTOP_MAX_TRANSFER_BYTES", str(DEFAULT_MAX_TRANSFER_BYTES))),
        )


@dataclass(frozen=True)
class AdapterSpec:
    capability: str
    command: tuple[str, ...]
    health_command: tuple[str, ...]
    resource: str
    timeout_seconds: int


class DesktopInvokeRequest(BaseModel):
    capability: str
    input: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    request_id: str | None = None
    approved: bool = False
    attachments: list[dict[str, Any]] = Field(default_factory=list)


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


class AdapterProcessRunner:
    def __init__(self):
        self.active: dict[str, asyncio.subprocess.Process] = {}
        self.cancelled: set[str] = set()

    async def run_json(
        self,
        request_id: str,
        command: tuple[str, ...],
        payload: dict[str, Any] | None,
        timeout_seconds: int,
        env: dict[str, str],
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            **kwargs,
        )
        self.active[request_id] = process
        try:
            stdin = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
            stdout, stderr = await asyncio.wait_for(process.communicate(stdin), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            self._terminate(process)
            await process.wait()
            raise
        finally:
            self.active.pop(request_id, None)
        if request_id in self.cancelled:
            self.cancelled.discard(request_id)
            raise AdapterCancelledError(request_id)
        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace")[-2000:]
            raise RuntimeError(f"desktop adapter exited with {process.returncode}: {detail}")
        try:
            result = json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("desktop adapter must write one JSON object to stdout") from error
        if not isinstance(result, dict):
            raise RuntimeError("desktop adapter result must be a JSON object")
        return result

    def cancel(self, request_id: str) -> bool:
        process = self.active.get(request_id)
        if process is None or process.returncode is not None:
            return False
        self.cancelled.add(request_id)
        self._terminate(process)
        return True

    @staticmethod
    def _terminate(process: asyncio.subprocess.Process) -> None:
        try:
            if os.name != "nt" and process.pid:
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            pass


class DesktopEnhancementRuntime:
    def __init__(self, settings: DesktopSettings):
        self.settings = settings
        self.node_name = "rtx-4070ti-super"
        self.adapters: dict[str, AdapterSpec] = {}
        self.gates: dict[str, ResourceGate] = {}
        self.runner = AdapterProcessRunner()

    async def start(self) -> None:
        validate_desktop_settings(self.settings)
        self.settings.work_root.mkdir(parents=True, exist_ok=True)
        config = load_adapter_config(self.settings.adapter_config)
        self.node_name = config["node"]
        self.adapters = config["adapters"]
        self.gates = {spec.resource: ResourceGate(spec.resource) for spec in self.adapters.values()}

    async def health(self) -> dict[str, Any]:
        rows = []
        for capability, spec in self.adapters.items():
            try:
                result = await self.runner.run_json(
                    f"health-{hashlib.sha256(capability.encode()).hexdigest()[:16]}",
                    spec.health_command,
                    None,
                    min(spec.timeout_seconds, 30),
                    self._adapter_env(None),
                )
                healthy = result.get("healthy") is True
                rows.append({
                    "capability": capability,
                    "configured": True,
                    "healthy": healthy,
                    "provider": result.get("provider"),
                    "detail": result.get("detail"),
                })
            except Exception as error:
                rows.append({
                    "capability": capability,
                    "configured": True,
                    "healthy": False,
                    "error": str(error)[-500:],
                })
        return {
            "status": "healthy" if rows and all(row["healthy"] for row in rows) else "degraded",
            "node": self.node_name,
            "queues": {name: gate.status() for name, gate in self.gates.items()},
            "capabilities": rows,
        }

    async def invoke(self, request: DesktopInvokeRequest) -> dict[str, Any]:
        if not request.approved:
            raise HTTPException(409, detail={"code": "desktop_dispatch_approval_required", "message": "台式机执行需要本次请求显式 approved=true。"})
        request_id = normalize_request_id(request.request_id)
        spec = self.adapters.get(request.capability)
        if spec is None:
            raise HTTPException(404, detail={"code": "desktop_capability_not_configured", "message": request.capability})
        request_root = self.settings.work_root / "requests" / request_id
        input_root = request_root / "input"
        output_root = request_root / "output"
        input_root.mkdir(parents=True, exist_ok=True)
        output_root.mkdir(parents=True, exist_ok=True)
        payload_input = materialize_attachments(
            request.capability,
            request.input,
            request.attachments,
            input_root,
            self.settings.max_transfer_bytes,
        )
        adapter_payload = {
            "requestId": request_id,
            "capability": request.capability,
            "input": payload_input,
            "options": request.options,
            "outputDirectory": str(output_root),
        }
        try:
            async with self.gates[spec.resource].acquire(request_id):
                result = await self.runner.run_json(
                    request_id,
                    spec.command,
                    adapter_payload,
                    min(int(request.options.get("timeoutSeconds", spec.timeout_seconds)), spec.timeout_seconds),
                    self._adapter_env(request_root),
                )
        except asyncio.TimeoutError as error:
            raise HTTPException(504, detail={"code": "desktop_model_timeout", "message": "台式机模型执行超时。"}) from error
        except AdapterCancelledError as error:
            raise HTTPException(409, detail={"code": "request_cancelled", "message": f"台式机模型请求已取消：{error}"}) from error
        except HTTPException:
            raise
        except Exception as error:
            code = "desktop_model_oom" if "out of memory" in str(error).lower() else "desktop_model_failed"
            raise HTTPException(500, detail={"code": code, "message": str(error)[-1000:]}) from error
        provider = str(result.pop("provider", self.node_name))
        packed = pack_result_artifact(result.get("result", result), output_root, self.settings.max_transfer_bytes)
        return {"requestId": request_id, "capability": request.capability, "provider": provider, "result": packed}

    def authorize(self, request: Request) -> None:
        client_host = request.client.host if request.client else ""
        if not client_allowed(client_host, self.settings.allowed_cidrs):
            raise HTTPException(403, detail={"code": "desktop_client_not_allowed", "message": "请求来源不在台式机节点 allowlist。"})
        authorization = request.headers.get("authorization", "")
        expected = f"Bearer {self.settings.token}"
        if not self.settings.token or not hmac.compare_digest(authorization, expected):
            raise HTTPException(401, detail={"code": "desktop_auth_required", "message": "台式机节点需要有效 Bearer token。"})

    def _adapter_env(self, request_root: Path | None) -> dict[str, str]:
        exact = {
            "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
            "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PYTHONPATH",
        }
        prefixes = ("COMFYUI_", "DESKTOP_OPENAI_", "CUDA_", "LOCAL_AI_ADAPTER_")
        env = {
            key: value
            for key, value in os.environ.items()
            if key in exact or key.startswith(prefixes)
        }
        env["PYTHONIOENCODING"] = "utf-8"
        env["LOCAL_AI_DESKTOP_WORK_ROOT"] = str(self.settings.work_root)
        if request_root is not None:
            env["LOCAL_AI_DESKTOP_REQUEST_ROOT"] = str(request_root)
        return env


class AdapterCancelledError(RuntimeError):
    pass


def validate_desktop_settings(settings: DesktopSettings) -> None:
    host = settings.host.strip().lower()
    loopback = host in {"127.0.0.1", "localhost", "::1"}
    if not loopback and len(settings.token) < 32:
        raise RuntimeError("LAN desktop node requires a Bearer token of at least 32 characters")
    if not loopback and not settings.allowed_cidrs:
        raise RuntimeError("LAN desktop node requires LOCAL_AI_DESKTOP_ALLOWED_CIDRS")
    if settings.max_transfer_bytes < 1:
        raise RuntimeError("LOCAL_AI_DESKTOP_MAX_TRANSFER_BYTES must be positive")


def load_adapter_config(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"desktop adapter config is not readable JSON: {path}") from error
    node = str(raw.get("node") or "rtx-4070ti-super").strip()
    capabilities = raw.get("capabilities")
    if not isinstance(capabilities, dict) or not capabilities:
        raise RuntimeError("desktop adapter config must declare at least one capability")
    adapters: dict[str, AdapterSpec] = {}
    for capability, value in capabilities.items():
        if not isinstance(value, dict):
            raise RuntimeError(f"adapter config for {capability} must be an object")
        command = validate_command(value.get("command"), capability, "command")
        health_command = validate_command(value.get("healthCommand"), capability, "healthCommand")
        timeout = max(1, min(int(value.get("timeoutSeconds", 3600)), 7200))
        resource = str(value.get("resource") or "gpu-heavy").strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", resource):
            raise RuntimeError(f"invalid resource name for {capability}")
        adapters[str(capability)] = AdapterSpec(str(capability), command, health_command, resource, timeout)
    return {"node": node, "adapters": adapters}


def validate_command(value: Any, capability: str, field: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        raise RuntimeError(f"{field} for {capability} must be a non-empty string array")
    return tuple(value)


def normalize_request_id(value: str | None) -> str:
    candidate = value or str(uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", candidate):
        raise HTTPException(400, detail={"code": "invalid_request_id", "message": "request_id contains unsupported characters"})
    return candidate


def client_allowed(host: str, networks: tuple[ipaddress._BaseNetwork, ...]) -> bool:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if address.is_loopback:
        return True
    return any(address in network for network in networks)


def materialize_attachments(
    capability: str,
    payload: dict[str, Any],
    attachments: list[dict[str, Any]],
    input_root: Path,
    max_bytes: int,
) -> dict[str, Any]:
    allowed = ATTACHMENT_FIELDS.get(capability, {})
    result = json.loads(json.dumps(payload))
    total = 0
    for position, attachment in enumerate(attachments):
        field = str(attachment.get("field") or "")
        if field not in allowed:
            raise HTTPException(400, detail={"code": "invalid_desktop_attachment_field", "message": field})
        index = attachment.get("index")
        if allowed[field]:
            if not isinstance(index, int) or index < 0 or index > 15:
                raise HTTPException(400, detail={"code": "invalid_desktop_attachment_index", "message": field})
        elif index is not None:
            raise HTTPException(400, detail={"code": "unexpected_desktop_attachment_index", "message": field})
        try:
            data = base64.b64decode(str(attachment.get("dataBase64") or ""), validate=True)
        except (ValueError, TypeError) as error:
            raise HTTPException(400, detail={"code": "invalid_desktop_attachment", "message": field}) from error
        total += len(data)
        if total > max_bytes:
            raise HTTPException(413, detail={"code": "desktop_attachment_too_large", "message": str(max_bytes)})
        expected_sha = str(attachment.get("sha256") or "")
        actual_sha = hashlib.sha256(data).hexdigest()
        if not hmac.compare_digest(expected_sha, actual_sha):
            raise HTTPException(400, detail={"code": "desktop_attachment_checksum_mismatch", "message": field})
        suffix = Path(str(attachment.get("name") or "file.bin")).suffix[:16]
        path = input_root / f"{position:02d}-{actual_sha[:16]}{suffix}"
        path.write_bytes(data)
        if allowed[field]:
            values = result.setdefault(field, [])
            if not isinstance(values, list):
                values = []
                result[field] = values
            while len(values) <= index:
                values.append(None)
            values[index] = str(path)
        else:
            result[field] = str(path)
    return result


def pack_result_artifact(result: Any, output_root: Path, max_bytes: int) -> Any:
    if not isinstance(result, dict) or not result.get("artifactPath"):
        return result
    artifact_path = Path(str(result["artifactPath"])).expanduser().resolve()
    output_resolved = output_root.resolve()
    if artifact_path != output_resolved and output_resolved not in artifact_path.parents:
        raise RuntimeError("desktop adapter artifactPath must stay inside the request output directory")
    if not artifact_path.is_file():
        raise RuntimeError("desktop adapter artifactPath does not exist")
    data = artifact_path.read_bytes()
    if len(data) > max_bytes:
        raise RuntimeError("desktop adapter artifact exceeds transfer limit")
    packed = dict(result)
    packed.pop("artifactPath", None)
    packed["artifact"] = {
        "name": artifact_path.name,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "dataBase64": base64.b64encode(data).decode("ascii"),
    }
    return packed


def create_app(settings: DesktopSettings) -> FastAPI:
    runtime = DesktopEnhancementRuntime(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await runtime.start()
        yield

    app = FastAPI(title="Agent Army 4070 Enhancement Node", version="0.1.0", lifespan=lifespan)

    @app.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        runtime.authorize(request)
        return await runtime.health()

    @app.get("/v1/capabilities")
    async def capabilities(request: Request) -> dict[str, Any]:
        runtime.authorize(request)
        return await runtime.health()

    @app.post("/v1/invoke")
    async def invoke(request: Request, body: DesktopInvokeRequest) -> dict[str, Any]:
        runtime.authorize(request)
        return await runtime.invoke(body)

    @app.delete("/v1/requests/{request_id}")
    async def cancel(request: Request, request_id: str) -> dict[str, Any]:
        runtime.authorize(request)
        normalized = normalize_request_id(request_id)
        return {"requestId": normalized, "cancelled": runtime.runner.cancel(normalized)}

    app.state.desktop_runtime = runtime
    return app


settings = DesktopSettings.from_env()
app = create_app(settings)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
