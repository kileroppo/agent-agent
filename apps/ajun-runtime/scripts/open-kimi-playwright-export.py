#!/usr/bin/env python3
"""Run the pinned OpenKimi exporters with one controlled Playwright browser context."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import select
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Dict, Optional, Sequence


EXPORT_ERROR: Any = RuntimeError
EXPORT_MODE = "unknown"
LAST_DOWNLOAD_ERROR_CODE: Optional[str] = None
LAST_NORMALIZED_IMAGE_DOWNLOAD: Optional[Path] = None
LAST_PROGRESS_STAGE: Optional[str] = None
LAST_PROGRESS_STATUS: Optional[str] = None
MAX_IMAGE_DOWNLOAD_RPC_TIMEOUT_SECONDS = 120
MAX_PPTX_DOWNLOAD_RPC_TIMEOUT_SECONDS = 180
MAX_IMAGE_DOWNLOAD_WAIT_SECONDS = 45.0
MAX_PPTX_DOWNLOAD_WAIT_SECONDS = 180.0
MAX_NORMALIZED_IMAGES = 30
MAX_NORMALIZED_IMAGE_BYTES = 200 * 1024 * 1024
PROGRESS_SCHEMA = "agent.army/open-kimi-ppt-stage-progress/v1"
PROGRESS_STAGES = {
    "visualQa.images",
    "export.pptx",
    "browser.launch",
    "browser.navigation",
    "deck.ready",
    "browser.viewport",
    "editor.snapshot",
    "editor.control",
    "editor.export_dialog",
    "editor.image_format",
    "visualQa.download",
    "visualQa.download_wait",
    "visualQa.extract",
    "visualQa.overview",
    "pptx.download",
    "pptx.download_wait",
}
PROGRESS_STATUSES = {"started", "completed", "failed"}
RPC_STAGES = {
    "open": "browser.navigation",
    "waitFunction": "deck.ready",
    "viewport": "browser.viewport",
    "snapshot": "editor.snapshot",
    "clickRef": "editor.control",
    "selectImageFormat": "editor.image_format",
}


class PlaywrightBrowserSession:
    def __init__(self, _executable: str, _session: str, cwd: Path, _download_dir: Path):
        write_progress("browser.launch", "started")
        node = required_absolute_env("AGENT_ARMY_OPEN_KIMI_NODE_REAL")
        driver = required_absolute_env("AGENT_ARMY_OPEN_KIMI_PLAYWRIGHT_DRIVER")
        self.process = subprocess.Popen(
            [node, driver],
            cwd=cwd,
            env={**os.environ, "AGENT_ARMY_OPEN_KIMI_BROWSER_WORK_ROOT": str(cwd.resolve())},
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=1,
        )
        self.sequence = 0
        self.cwd = cwd.resolve()
        self.download_dir = _download_dir.resolve()
        write_progress("browser.launch", "completed")

    def rpc(self, action: str, *, timeout: int = 90, **values: Any) -> Dict[str, Any]:
        stage = None if action == "close" else stage_for_action(action)
        if stage is not None:
            write_progress(stage, "started")
        try:
            if self.process.poll() is not None or self.process.stdin is None or self.process.stdout is None:
                raise EXPORT_ERROR("playwright_browser_unavailable: browser session stopped")
            self.sequence += 1
            request = {"id": self.sequence, "action": action, "timeoutMs": timeout * 1000, **values}
            self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            ready, _, _ = select.select([self.process.stdout], [], [], timeout + 5)
            if not ready:
                raise EXPORT_ERROR("playwright_timeout: browser command timed out")
            line = self.process.stdout.readline()
            try:
                response = json.loads(line)
            except json.JSONDecodeError as exc:
                raise EXPORT_ERROR("playwright_protocol_invalid: invalid browser response") from exc
            if response.get("id") != self.sequence or response.get("ok") is not True:
                code = str(response.get("code") or "playwright_operation_failed")
                raise EXPORT_ERROR(f"{code}: browser command failed")
            result = response.get("result")
            if stage is not None:
                write_progress(stage, "completed")
            return result if isinstance(result, dict) else {}
        except Exception as exc:
            if stage is not None:
                write_progress(stage, "failed", error_code=error_code(exc))
            raise

    def run(
        self,
        args: Sequence[str],
        *,
        timeout: int = 90,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        global LAST_DOWNLOAD_ERROR_CODE, LAST_NORMALIZED_IMAGE_DOWNLOAD
        try:
            if list(args[:2]) == ["wait", "--fn"] and len(args) == 3:
                self.rpc("waitFunction", timeout=timeout, expression=args[2])
            elif list(args[:2]) == ["set", "viewport"] and len(args) == 4:
                self.rpc("viewport", timeout=timeout, width=int(args[2]), height=int(args[3]))
            elif len(args) == 2 and args[0] == "click":
                self.rpc("clickRef", timeout=timeout, ref=args[1])
            elif len(args) == 3 and args[0] == "download":
                LAST_DOWNLOAD_ERROR_CODE = None
                output = Path(args[2]).resolve()
                if EXPORT_MODE == "pptx":
                    # Current Kimi/Chrome builds can generate a PPTX without
                    # emitting the Playwright page.download event. Trigger the
                    # official button and let the upstream validated file poll
                    # consume only this context's controlled downloads folder.
                    self.rpc(
                        "triggerDownloadRef",
                        timeout=min(timeout, download_rpc_timeout_seconds()),
                        ref=args[1],
                    )
                else:
                    self.rpc(
                        "downloadRef",
                        timeout=min(timeout, download_rpc_timeout_seconds()),
                        ref=args[1],
                        output=str(output),
                    )
                    LAST_NORMALIZED_IMAGE_DOWNLOAD = normalize_image_download(output, self.download_dir)
            else:
                raise EXPORT_ERROR("playwright_command_denied: unsupported browser command")
            return subprocess.CompletedProcess(list(args), 0, stdout="")
        except Exception as exc:
            if len(args) == 3 and args[0] == "download":
                LAST_DOWNLOAD_ERROR_CODE = error_code(exc)
                write_progress(
                    stage_for_action("downloadRef"),
                    "failed",
                    error_code=LAST_DOWNLOAD_ERROR_CODE,
                )
            if check:
                raise
            return subprocess.CompletedProcess(list(args), 1, stdout=str(exc))

    def open(self, url: str) -> None:
        self.rpc("open", timeout=90, url=url)

    def snapshot(self) -> Dict[str, Any]:
        return self.rpc("snapshot", timeout=30)

    def select_image_format(self) -> None:
        self.rpc("selectImageFormat", timeout=30)

    def close(self) -> None:
        if self.process.poll() is not None:
            return
        try:
            self.rpc("close", timeout=20)
        except Exception:
            pass
        finally:
            if self.process.stdin is not None:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)


def required_absolute_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not Path(value).is_absolute():
        raise RuntimeError(f"{name} is not an absolute path")
    return value


def stage_for_action(action: str) -> str:
    if action in {"downloadRef", "triggerDownloadRef"}:
        return "visualQa.download" if EXPORT_MODE == "images" else "pptx.download"
    stage = RPC_STAGES.get(action)
    if stage is None:
        raise RuntimeError("unsupported diagnostic action")
    return stage


def download_rpc_timeout_seconds() -> int:
    return (
        MAX_IMAGE_DOWNLOAD_RPC_TIMEOUT_SECONDS
        if EXPORT_MODE == "images"
        else MAX_PPTX_DOWNLOAD_RPC_TIMEOUT_SECONDS
    )


def error_code(error: Exception) -> str:
    candidate = str(error).split(":", 1)[0].strip()
    return candidate if re.fullmatch(r"[a-z0-9_]{1,80}", candidate, re.IGNORECASE) else "export_failed"


def write_progress(stage: str, status: str, *, error_code: Optional[str] = None) -> None:
    global LAST_PROGRESS_STAGE, LAST_PROGRESS_STATUS
    if stage not in PROGRESS_STAGES or status not in PROGRESS_STATUSES:
        raise RuntimeError("invalid export diagnostic")
    record = Path(required_absolute_env("AGENT_ARMY_OPEN_KIMI_PROGRESS_RECORD"))
    if record.name != "stage-progress.json" or not record.parent.is_dir() or record.is_symlink():
        raise RuntimeError("invalid export diagnostic path")
    safe_error = error_code if error_code and re.fullmatch(r"[a-z0-9_]{1,80}", error_code, re.IGNORECASE) else None
    document = {
        "schemaVersion": PROGRESS_SCHEMA,
        "mode": EXPORT_MODE,
        "stage": stage,
        "status": status,
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "errorCode": safe_error,
    }
    temporary = record.with_name("stage-progress.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(document, stream, ensure_ascii=True, separators=(",", ":"))
            stream.write("\n")
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    os.replace(temporary, record)
    os.chmod(record, 0o600)
    LAST_PROGRESS_STAGE = stage
    LAST_PROGRESS_STATUS = status


def progress_wrapper(function: Any, stage: str) -> Any:
    @wraps(function)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        write_progress(stage, "started")
        try:
            result = function(*args, **kwargs)
        except Exception as exc:
            write_progress(stage, "failed", error_code=error_code(exc))
            raise
        write_progress(stage, "completed")
        return result

    return wrapped


def download_wait_wrapper(function: Any, stage: str) -> Any:
    @wraps(function)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        global LAST_DOWNLOAD_ERROR_CODE, LAST_NORMALIZED_IMAGE_DOWNLOAD
        prior_error = LAST_DOWNLOAD_ERROR_CODE
        if prior_error is None:
            write_progress(stage, "started")
        if (
            EXPORT_MODE == "images"
            and prior_error is None
            and LAST_NORMALIZED_IMAGE_DOWNLOAD is not None
            and LAST_NORMALIZED_IMAGE_DOWNLOAD.is_file()
        ):
            result = LAST_NORMALIZED_IMAGE_DOWNLOAD
            LAST_NORMALIZED_IMAGE_DOWNLOAD = None
            write_progress(stage, "completed")
            return result
        bounded_kwargs = dict(kwargs)
        if EXPORT_MODE == "pptx":
            bounded_kwargs["timeout"] = MAX_PPTX_DOWNLOAD_WAIT_SECONDS
        else:
            bounded_kwargs["timeout"] = min(
                float(bounded_kwargs.get("timeout", MAX_IMAGE_DOWNLOAD_WAIT_SECONDS)),
                MAX_IMAGE_DOWNLOAD_WAIT_SECONDS,
            )
        try:
            result = function(*args, **bounded_kwargs)
        except Exception as exc:
            if prior_error is None:
                failure_code = (
                    "playwright_download_file_timeout"
                    if EXPORT_MODE == "pptx"
                    else error_code(exc)
                )
                write_progress(stage, "failed", error_code=failure_code)
            raise
        LAST_DOWNLOAD_ERROR_CODE = None
        write_progress(stage, "completed")
        return result

    return wrapped


def normalize_image_download(output: Path, download_dir: Path) -> Path:
    candidates = wait_for_stable_download_candidates(output, download_dir)
    for candidate in candidates:
        payloads = read_validated_image_zip(candidate)
        if payloads:
            return write_normalized_image_zip(output, payloads)

    source_candidates = [
        candidate
        for candidate in candidates
        if is_within(candidate, download_dir) and detect_image_suffix(candidate) is not None
    ]
    if not source_candidates and detect_image_suffix(output) is not None:
        source_candidates = [output]
    if not source_candidates:
        raise EXPORT_ERROR("playwright_download_invalid_image_archive: no accepted image archive")
    if len(source_candidates) > MAX_NORMALIZED_IMAGES:
        raise EXPORT_ERROR("playwright_download_invalid_image_archive: too many image files")
    total = sum(candidate.stat().st_size for candidate in source_candidates)
    if total < 1 or total > MAX_NORMALIZED_IMAGE_BYTES:
        raise EXPORT_ERROR("playwright_download_invalid_image_archive: image payload size rejected")

    payloads = []
    for candidate in source_candidates:
        suffix = detect_image_suffix(candidate)
        if suffix is None:
            raise EXPORT_ERROR("playwright_download_invalid_image_archive: invalid image file")
        payloads.append((candidate.read_bytes(), suffix))
    return write_normalized_image_zip(output, payloads)


def read_validated_image_zip(candidate: Path) -> Optional[Sequence[tuple[bytes, str]]]:
    if candidate.is_symlink() or not candidate.is_file() or candidate.name.endswith(".crdownload"):
        return None
    try:
        with zipfile.ZipFile(candidate) as archive:
            infos = [info for info in archive.infolist() if not info.is_dir()]
            if len(infos) > MAX_NORMALIZED_IMAGES:
                raise EXPORT_ERROR("playwright_download_invalid_image_archive: too many archive files")
            if sum(info.file_size for info in infos) > MAX_NORMALIZED_IMAGE_BYTES:
                raise EXPORT_ERROR("playwright_download_invalid_image_archive: archive payload size rejected")
            payloads = []
            for info in infos:
                if info.flag_bits & 0x1:
                    raise EXPORT_ERROR("playwright_download_invalid_image_archive: encrypted archive rejected")
                payload = archive.read(info)
                suffix = detect_image_suffix_bytes(payload)
                if suffix is not None:
                    payloads.append((payload, suffix))
            if not payloads:
                return None
            return tuple(payloads)
    except EXPORT_ERROR:
        raise
    except (OSError, RuntimeError, NotImplementedError, zipfile.BadZipFile, zipfile.LargeZipFile):
        return None


def write_normalized_image_zip(output: Path, payloads: Sequence[tuple[bytes, str]]) -> Path:
    if not payloads or len(payloads) > MAX_NORMALIZED_IMAGES:
        raise EXPORT_ERROR("playwright_download_invalid_image_archive: normalized image count rejected")
    total = sum(len(payload) for payload, _suffix in payloads)
    if total < 1 or total > MAX_NORMALIZED_IMAGE_BYTES:
        raise EXPORT_ERROR("playwright_download_invalid_image_archive: normalized payload size rejected")
    normalized = output.with_name("normalized-image-output.zip")
    if normalized.exists() or normalized.is_symlink():
        raise EXPORT_ERROR("playwright_download_output_exists: normalized output exists")
    with zipfile.ZipFile(normalized, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for index, (payload, suffix) in enumerate(payloads, start=1):
            archive.writestr(f"{index:02d}{suffix}", payload)
    if not is_image_zip(normalized):
        raise EXPORT_ERROR("playwright_download_invalid_image_archive: normalized archive rejected")
    return normalized


def wait_for_stable_download_candidates(output: Path, download_dir: Path) -> Sequence[Path]:
    deadline = time.monotonic() + 10.0
    previous: Optional[tuple[tuple[str, int], ...]] = None
    stable_polls = 0
    observed: Dict[str, tuple[Path, int]] = {}
    while time.monotonic() < deadline:
        current: Dict[str, tuple[Path, int, int]] = {}
        for candidate in [output, *sorted(download_dir.rglob("*"))]:
            try:
                if candidate.is_symlink() or not candidate.is_file() or candidate.name.endswith(".crdownload"):
                    continue
                stat = candidate.stat()
                size = stat.st_size
            except OSError:
                continue
            if size > 0:
                current[str(candidate)] = (candidate, size, stat.st_mtime_ns)
        snapshot = tuple(sorted((name, value[1]) for name, value in current.items()))
        observed.update((name, (value[0], value[2])) for name, value in current.items())
        if snapshot and snapshot == previous:
            stable_polls += 1
        else:
            stable_polls = 0
        if stable_polls >= 4:
            break
        previous = snapshot
        time.sleep(0.25)
    return tuple(item[0] for item in sorted(observed.values(), key=lambda item: (item[1], str(item[0]))))


def detect_image_suffix(path: Path) -> Optional[str]:
    try:
        with path.open("rb") as stream:
            header = stream.read(16)
    except OSError:
        return None
    return detect_image_suffix_bytes(header)


def detect_image_suffix_bytes(header: bytes) -> Optional[str]:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith(b"\xff\xd8\xff"):
        return ".jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return ".webp"
    return None


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def is_image_zip(path: Path) -> bool:
    if path.is_symlink() or not path.is_file() or path.name.endswith(".crdownload"):
        return False
    try:
        with zipfile.ZipFile(path) as archive:
            return any(
                Path(name).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                for name in archive.namelist()
            )
    except (OSError, zipfile.BadZipFile):
        return False


def record_overall_result(stage: str, result: int) -> None:
    if result == 0:
        write_progress(stage, "completed")
    elif LAST_PROGRESS_STATUS != "failed":
        write_progress(stage, "failed", error_code="upstream_nonzero")


def load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load controlled exporter: {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main(argv: Optional[Sequence[str]] = None) -> int:
    global EXPORT_ERROR, EXPORT_MODE
    values = list(argv if argv is not None else sys.argv[1:])
    if len(values) < 2 or values[0] not in {"images", "pptx"}:
        print("usage: open-kimi-playwright-export.py <images|pptx> <upstream-script-dir> ...", file=sys.stderr)
        return 2
    mode = values.pop(0)
    EXPORT_MODE = mode
    upstream_dir = Path(values.pop(0)).resolve()
    pptx = load_module("export_pptx", upstream_dir / "export_pptx.py")
    EXPORT_ERROR = pptx.ExportError
    pptx.BrowserSession = PlaywrightBrowserSession
    pptx.ensure_agent_browser = lambda: "playwright-controlled"
    pptx.wait_for_export_dialog = progress_wrapper(pptx.wait_for_export_dialog, "editor.export_dialog")
    pptx.find_download = download_wait_wrapper(
        pptx.find_download,
        "visualQa.download_wait" if mode == "images" else "pptx.download_wait",
    )
    overall_stage = "visualQa.images" if mode == "images" else "export.pptx"
    write_progress(overall_stage, "started")
    if mode == "pptx":
        result = int(pptx.main(values))
        record_overall_result(overall_stage, result)
        return result
    images = load_module("export_images", upstream_dir / "export_images.py")
    images.BrowserSession = PlaywrightBrowserSession
    images.ensure_agent_browser = lambda: "playwright-controlled"
    images.select_image_format = lambda browser: browser.select_image_format()
    images.unzip_images = progress_wrapper(images.unzip_images, "visualQa.extract")
    images.stitch_overview = progress_wrapper(images.stitch_overview, "visualQa.overview")
    result = int(images.main(values))
    record_overall_result(overall_stage, result)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
