import asyncio
import base64
import hashlib
import ipaddress
import json
import sys
import tempfile
import unittest
import os
from pathlib import Path

from fastapi import HTTPException

from desktop_enhancement_node import (
    DesktopEnhancementRuntime,
    DesktopInvokeRequest,
    DesktopSettings,
    client_allowed,
    materialize_attachments,
    pack_result_artifact,
    validate_desktop_settings,
)


FIXTURE = Path(__file__).parent / "fixtures" / "desktop_test_adapter.py"
MODEL_MANIFEST = Path(__file__).resolve().parents[3] / "ops" / "local-ai" / "desktop" / "model-manifest.json"


class DesktopNodeContractTest(unittest.TestCase):
    def test_desktop_model_manifest_is_pinned_and_checksummed(self):
        manifest = json.loads(MODEL_MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["models"]), 3)
        destinations = set()
        for model in manifest["models"]:
            self.assertRegex(model["revision"], r"^[0-9a-f]{40}$")
            self.assertRegex(model["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(model["size"], 0)
            destination = Path(model["destination"])
            self.assertFalse(destination.is_absolute())
            self.assertNotIn("..", destination.parts)
            destinations.add(model["destination"])
        self.assertEqual(len(destinations), 3)

    def test_lan_binding_requires_token_and_allowlist(self):
        settings = DesktopSettings(
            host="0.0.0.0",
            port=18083,
            token="short",
            allowed_cidrs=(),
            adapter_config=Path("missing"),
            work_root=Path("work"),
        )
        with self.assertRaisesRegex(RuntimeError, "at least 32"):
            validate_desktop_settings(settings)

    def test_client_allowlist_accepts_only_selected_network(self):
        networks = (ipaddress.ip_network("192.168.10.111/32"),)
        self.assertTrue(client_allowed("192.168.10.111", networks))
        self.assertFalse(client_allowed("192.168.10.112", networks))

    def test_attachment_checksum_and_field_are_enforced(self):
        data = b"image-bytes"
        attachment = {
            "field": "imagePaths",
            "index": 0,
            "name": "input.png",
            "sha256": hashlib.sha256(data).hexdigest(),
            "dataBase64": base64.b64encode(data).decode("ascii"),
        }
        with tempfile.TemporaryDirectory() as directory:
            result = materialize_attachments("image.edit", {}, [attachment], Path(directory), 1024)
            self.assertEqual(Path(result["imagePaths"][0]).read_bytes(), data)
            broken = dict(attachment, sha256="0" * 64)
            with self.assertRaises(HTTPException) as raised:
                materialize_attachments("image.edit", {}, [broken], Path(directory), 1024)
            self.assertEqual(raised.exception.status_code, 400)

    def test_artifact_must_stay_in_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            output.mkdir()
            artifact = output / "result.bin"
            artifact.write_bytes(b"result")
            packed = pack_result_artifact({"artifactPath": str(artifact)}, output, 100)
            self.assertEqual(base64.b64decode(packed["artifact"]["dataBase64"]), b"result")
            outside = root / "outside.bin"
            outside.write_bytes(b"secret")
            with self.assertRaisesRegex(RuntimeError, "must stay inside"):
                pack_result_artifact({"artifactPath": str(outside)}, output, 100)


class DesktopNodeRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        config = root / "adapters.json"
        capabilities = {}
        for capability in ("text.generate", "image.generate"):
            capabilities[capability] = {
                "command": [sys.executable, str(FIXTURE), "invoke", capability],
                "healthCommand": [sys.executable, str(FIXTURE), "health", capability],
                "resource": "gpu-heavy",
                "timeoutSeconds": 30,
            }
        config.write_text(json.dumps({"node": "test-4070", "capabilities": capabilities}), encoding="utf-8")
        self.runtime = DesktopEnhancementRuntime(DesktopSettings(
            host="127.0.0.1",
            port=18083,
            token="test-token",
            allowed_cidrs=(),
            adapter_config=config,
            work_root=root / "work",
            max_transfer_bytes=1024 * 1024,
        ))
        await self.runtime.start()

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_health_and_text_invoke(self):
        health = await self.runtime.health()
        self.assertEqual(health["status"], "healthy")
        self.assertEqual(len(health["capabilities"]), 2)
        result = await self.runtime.invoke(DesktopInvokeRequest(
            capability="text.generate",
            request_id="desktop-text-test",
            approved=True,
            input={"prompt": "test"},
        ))
        self.assertEqual(result["result"]["text"], "DESKTOP_OK")

    async def test_image_artifact_is_packed_for_mac(self):
        result = await self.runtime.invoke(DesktopInvokeRequest(
            capability="image.generate",
            request_id="desktop-image-test",
            approved=True,
            input={"prompt": "red square"},
        ))
        self.assertNotIn("artifactPath", result["result"])
        self.assertGreater(result["result"]["artifact"]["size"], 0)

    async def test_unapproved_request_is_closed(self):
        with self.assertRaises(HTTPException) as raised:
            await self.runtime.invoke(DesktopInvokeRequest(capability="text.generate", approved=False))
        self.assertEqual(raised.exception.status_code, 409)

    async def test_adapter_environment_does_not_inherit_unrelated_secrets(self):
        os.environ["SHOULD_NOT_REACH_ADAPTER"] = "secret"
        try:
            env = self.runtime._adapter_env(None)
            self.assertNotIn("SHOULD_NOT_REACH_ADAPTER", env)
            self.assertNotIn("LOCAL_AI_DESKTOP_TOKEN", env)
        finally:
            os.environ.pop("SHOULD_NOT_REACH_ADAPTER", None)

    async def test_active_adapter_can_be_cancelled(self):
        task = asyncio.create_task(self.runtime.invoke(DesktopInvokeRequest(
            capability="text.generate",
            request_id="desktop-cancel-test",
            approved=True,
            input={"prompt": "slow"},
            options={"sleepSeconds": 10},
        )))
        for _ in range(50):
            if "desktop-cancel-test" in self.runtime.runner.active:
                break
            await asyncio.sleep(0.01)
        self.assertTrue(self.runtime.runner.cancel("desktop-cancel-test"))
        with self.assertRaises(HTTPException) as raised:
            await task
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "request_cancelled")


if __name__ == "__main__":
    unittest.main()
