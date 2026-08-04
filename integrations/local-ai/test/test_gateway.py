import tempfile
import unittest
import base64
import hashlib
from pathlib import Path

from fastapi import HTTPException

from local_ai_gateway import (
    InvokeRequest,
    LocalAiRuntime,
    Settings,
    image_parameters,
    normalize_request_id,
    prepare_desktop_payload,
    require_local_file,
    sample_timestamps,
    unpack_desktop_artifact,
    validate_private_base_url,
)


class GatewayContractTest(unittest.TestCase):
    def test_samples_video_without_using_exact_edges(self):
        self.assertEqual(sample_timestamps(4.0, 3), [0.25, 2.0, 3.75])

    def test_image_parameters_are_bounded_and_aligned(self):
        self.assertEqual(image_parameters({"width": 513, "height": 250, "steps": 99}), (512, 256, 20))

    def test_request_id_rejects_shell_characters(self):
        with self.assertRaises(Exception):
            normalize_request_id("bad;id")

    def test_local_file_must_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "input.txt"
            file.write_text("ok", encoding="utf-8")
            self.assertEqual(require_local_file(file), file.resolve())

    def test_desktop_node_must_stay_on_private_network(self):
        validate_private_base_url("http://192.168.10.20:18082")
        with self.assertRaisesRegex(ValueError, "private network"):
            validate_private_base_url("https://8.8.8.8:18082")

    def test_desktop_node_rejects_embedded_credentials(self):
        with self.assertRaisesRegex(ValueError, "without embedded credentials"):
            validate_private_base_url("http://user:secret@192.168.10.20:18082")

    def test_desktop_payload_transfers_file_bytes_not_mac_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "商品图.png"
            image.write_bytes(b"image-data")
            payload, attachments = prepare_desktop_payload(
                "image.edit",
                {"prompt": "change color", "imagePaths": [str(image)]},
                1024,
            )
            self.assertNotIn("imagePaths", payload)
            self.assertEqual(payload["prompt"], "change color")
            self.assertEqual(attachments[0]["field"], "imagePaths")
            self.assertEqual(base64.b64decode(attachments[0]["dataBase64"]), b"image-data")
            self.assertEqual(attachments[0]["sha256"], hashlib.sha256(b"image-data").hexdigest())

    def test_desktop_payload_enforces_transfer_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "input.wav"
            audio.write_bytes(b"12345")
            with self.assertRaises(HTTPException) as raised:
                prepare_desktop_payload("audio.transcribe", {"audioPath": str(audio)}, 4)
            self.assertEqual(raised.exception.status_code, 413)

    def test_desktop_artifact_is_verified_and_saved_on_mac(self):
        data = b"remote-result"
        artifact = {
            "name": "result.bin",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "dataBase64": base64.b64encode(data).decode("ascii"),
        }
        with tempfile.TemporaryDirectory() as directory:
            result = unpack_desktop_artifact("desktop-result-test", {"artifact": artifact}, Path(directory), 1024)
            path = Path(result["artifactPath"])
            self.assertEqual(path.read_bytes(), data)
            broken = dict(artifact, sha256="0" * 64)
            with self.assertRaises(HTTPException) as raised:
                unpack_desktop_artifact("desktop-result-broken", {"artifact": broken}, Path(directory), 1024)
            self.assertEqual(raised.exception.status_code, 502)


class DesktopRoutingTest(unittest.IsolatedAsyncioTestCase):
    async def test_auto_route_uses_mac_without_probing_configured_desktop(self):
        runtime = LocalAiRuntime(Settings(
            desktop_url="http://127.0.0.1:9",
            desktop_token="offline-test-token",
        ))
        calls = []

        async def local_text(request_id, payload, options):
            calls.append((request_id, payload, options))
            return {"provider": "local-qwen35", "text": "MAC_OK"}

        runtime.text_generate = local_text
        result = await runtime.invoke(InvokeRequest(
            capability="text.generate",
            request_id="desktop-offline-auto",
            input={"prompt": "test"},
            options={"preferredNode": "auto"},
        ))
        self.assertEqual(result["provider"], "local-qwen35")
        self.assertEqual(result["result"]["text"], "MAC_OK")
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
