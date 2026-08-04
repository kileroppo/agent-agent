from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx


REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_AI_ROOT = REPO_ROOT / "integrations" / "local-ai"
TEST_ADAPTER = LOCAL_AI_ROOT / "test" / "fixtures" / "desktop_test_adapter.py"
TEST_PORT = 18183
TEST_TOKEN = "simulated-only-token-00000000000000000000000000000000"


async def wait_for_health(base_url: str) -> dict:
    async with httpx.AsyncClient(timeout=2) as client:
        for _ in range(30):
            try:
                response = await client.get(f"{base_url}/health", headers={"Authorization": f"Bearer {TEST_TOKEN}"})
                if response.status_code == 200:
                    return response.json()
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.25)
    raise RuntimeError("simulated desktop node did not become healthy")


async def run() -> None:
    with tempfile.TemporaryDirectory(prefix="agent-army-desktop-smoke-") as directory:
        root = Path(directory)
        config_path = root / "adapters.json"
        capabilities = {}
        for capability in ("text.generate", "image.edit"):
            capabilities[capability] = {
                "command": [sys.executable, str(TEST_ADAPTER), "invoke", capability],
                "healthCommand": [sys.executable, str(TEST_ADAPTER), "health", capability],
                "resource": "gpu-heavy",
                "timeoutSeconds": 30,
            }
        config_path.write_text(json.dumps({"node": "simulated-4070", "capabilities": capabilities}), encoding="utf-8")
        env = dict(os.environ)
        env.update({
            "PYTHONPATH": str(LOCAL_AI_ROOT),
            "LOCAL_AI_WORK_ROOT": str(root / "mac-work"),
            "LOCAL_AI_DESKTOP_HOST": "127.0.0.1",
            "LOCAL_AI_DESKTOP_PORT": str(TEST_PORT),
            "LOCAL_AI_DESKTOP_TOKEN": TEST_TOKEN,
            "LOCAL_AI_DESKTOP_ADAPTER_CONFIG": str(config_path),
            "LOCAL_AI_DESKTOP_WORK_ROOT": str(root / "desktop-work"),
        })
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "desktop_enhancement_node:app", "--host", "127.0.0.1", "--port", str(TEST_PORT), "--log-level", "warning"],
            cwd=LOCAL_AI_ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        base_url = f"http://127.0.0.1:{TEST_PORT}"
        try:
            health = await wait_for_health(base_url)
            if health["status"] != "healthy" or len(health["capabilities"]) != 2:
                raise RuntimeError(f"unexpected simulated node health: {health}")
            async with httpx.AsyncClient(timeout=3) as client:
                unauthorized = await client.get(f"{base_url}/health")
                if unauthorized.status_code != 401:
                    raise RuntimeError(f"unauthorized health returned {unauthorized.status_code}")

            os.environ["LOCAL_AI_WORK_ROOT"] = str(root / "mac-work")
            sys.path.insert(0, str(LOCAL_AI_ROOT))
            from local_ai_gateway import InvokeRequest, LocalAiRuntime, Settings
            from fastapi import HTTPException

            runtime = LocalAiRuntime(Settings(desktop_url=base_url, desktop_token=TEST_TOKEN))
            text = await runtime._desktop_invoke(
                InvokeRequest(
                    capability="text.generate",
                    request_id="simulated-desktop-text",
                    approved=True,
                    input={"prompt": "return DESKTOP_OK"},
                ),
                "simulated-desktop-text",
                time.monotonic(),
            )
            if text["provider"] != "desktop:desktop-test" or text["result"]["text"] != "DESKTOP_OK":
                raise RuntimeError(f"unexpected desktop text result: {text}")

            source_image = root / "mac-input.png"
            source_image.write_bytes(b"simulated-mac-image")
            edited = await runtime._desktop_invoke(
                InvokeRequest(
                    capability="image.edit",
                    request_id="simulated-desktop-image",
                    approved=True,
                    input={"prompt": "edit", "imagePaths": [str(source_image)]},
                ),
                "simulated-desktop-image",
                time.monotonic(),
            )
            artifact_path = Path(edited["result"]["artifactPath"])
            if not artifact_path.is_file() or artifact_path.stat().st_size == 0:
                raise RuntimeError("desktop artifact was not verified and materialized on Mac")

            cancel_request_id = "simulated-desktop-cancel"
            slow = asyncio.create_task(runtime._desktop_invoke(
                InvokeRequest(
                    capability="text.generate",
                    request_id=cancel_request_id,
                    approved=True,
                    input={"prompt": "slow"},
                    options={"sleepSeconds": 10},
                ),
                cancel_request_id,
                time.monotonic(),
            ))
            for _ in range(50):
                if cancel_request_id in runtime.active_desktop_requests:
                    break
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.2)
            cancelled = await runtime.cancel(cancel_request_id)
            if not cancelled["desktopCancelled"]:
                raise RuntimeError(f"desktop cancellation was not acknowledged: {cancelled}")
            try:
                await slow
                raise RuntimeError("cancelled desktop request unexpectedly succeeded")
            except HTTPException as error:
                if error.status_code != 409 or error.detail.get("code") != "request_cancelled":
                    raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

        desktop_after_stop = await runtime.desktop_health()
        if desktop_after_stop.get("healthy") is not False:
            raise RuntimeError(f"stopped desktop node still reported healthy: {desktop_after_stop}")
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post("http://127.0.0.1:18082/v1/invoke", json={
                "capability": "embedding.create",
                "request_id": "simulated-desktop-down-mac-default",
                "input": {"texts": ["Mac primary remains available"]},
                "options": {"preferredNode": "auto", "timeoutSeconds": 45},
            })
            response.raise_for_status()
            mac = response.json()
        if mac["provider"] != "local-qwen3-embedding" or mac["result"]["dimensions"] != 1024:
            raise RuntimeError(f"live Mac default route failed after desktop disconnect: {mac}")
        print(json.dumps({
            "simulatedDesktopHealth": "healthy",
            "unauthorizedRejected": True,
            "textForwarded": True,
            "attachmentTransferred": True,
            "artifactReturnedToMac": True,
            "remoteCancellation": "request_cancelled",
            "desktopDisconnectObserved": True,
            "macDefaultAfterDisconnect": "local-qwen3-embedding",
        }, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(run())
