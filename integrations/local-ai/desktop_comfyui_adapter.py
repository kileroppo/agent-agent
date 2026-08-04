from __future__ import annotations

import json
import mimetypes
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx


PLACEHOLDERS = {
    "{{PROMPT}}": "prompt",
    "{{NEGATIVE_PROMPT}}": "negativePrompt",
    "{{WIDTH}}": "width",
    "{{HEIGHT}}": "height",
    "{{STEPS}}": "steps",
    "{{SEED}}": "seed",
    "{{INPUT_IMAGE_0}}": "inputImage0",
    "{{INPUT_IMAGE_1}}": "inputImage1",
    "{{INPUT_IMAGE_2}}": "inputImage2",
    "{{INPUT_IMAGE_3}}": "inputImage3",
}


def workflow_path(capability: str) -> Path:
    variable = "COMFYUI_GENERATE_WORKFLOW" if capability == "image.generate" else "COMFYUI_EDIT_WORKFLOW"
    value = os.environ.get(variable, "")
    if not value:
        raise RuntimeError(f"{variable} is not configured")
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise RuntimeError(f"ComfyUI API workflow does not exist: {path}")
    return path


def render_workflow(value: Any, replacements: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {key: render_workflow(item, replacements) for key, item in value.items()}
    if isinstance(value, list):
        return [render_workflow(item, replacements) for item in value]
    if not isinstance(value, str):
        return value
    if value in replacements:
        return replacements[value]
    rendered = value
    for placeholder, replacement in replacements.items():
        rendered = rendered.replace(placeholder, str(replacement))
    return rendered


def select_output_image(history: dict[str, Any], prompt_id: str) -> dict[str, str]:
    record = history.get(prompt_id, history)
    outputs = record.get("outputs", {}) if isinstance(record, dict) else {}
    candidates: list[dict[str, str]] = []
    for node in outputs.values():
        if not isinstance(node, dict):
            continue
        for image in node.get("images", []):
            if isinstance(image, dict) and image.get("filename"):
                candidates.append(image)
    if not candidates:
        raise RuntimeError("ComfyUI history contains no output image")
    return candidates[-1]


def upload_image(client: httpx.Client, base_url: str, path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    with path.open("rb") as stream:
        response = client.post(
            f"{base_url}/upload/image",
            files={"image": (path.name, stream, mime)},
            data={"overwrite": "true", "type": "input"},
        )
    response.raise_for_status()
    body = response.json()
    name = str(body.get("name") or path.name)
    subfolder = str(body.get("subfolder") or "").strip("/\\")
    return f"{subfolder}/{name}" if subfolder else name


def run_health(capability: str) -> None:
    path = workflow_path(capability)
    base_url = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
    try:
        response = httpx.get(f"{base_url}/system_stats", timeout=10)
        response.raise_for_status()
        stats = response.json()
        device_text = json.dumps(stats.get("devices", []), ensure_ascii=False).lower()
        has_cuda = "cuda" in device_text or "nvidia" in device_text
        print(json.dumps({
            "healthy": has_cuda,
            "provider": "comfyui-flux2-klein",
            "detail": f"workflow={path.name}; cuda={str(has_cuda).lower()}",
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"healthy": False, "provider": "comfyui-flux2-klein", "detail": str(error)[-500:]}, ensure_ascii=False))


def run_invoke(capability: str) -> None:
    if capability not in {"image.generate", "image.edit"}:
        raise RuntimeError(f"unsupported ComfyUI capability: {capability}")
    payload = json.loads(sys.stdin.read())
    inputs = payload.get("input", {})
    options = payload.get("options", {})
    prompt = str(inputs.get("prompt") or "").strip()
    if not prompt:
        raise RuntimeError("prompt is required")
    base_url = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
    timeout = max(30, min(int(options.get("timeoutSeconds", os.environ.get("COMFYUI_TIMEOUT_SECONDS", "1800"))), 7200))
    replacements: dict[str, Any] = {
        "{{PROMPT}}": prompt,
        "{{NEGATIVE_PROMPT}}": str(inputs.get("negativePrompt") or options.get("negativePrompt") or ""),
        "{{WIDTH}}": max(256, min(int(options.get("width", 1024)), 1536)),
        "{{HEIGHT}}": max(256, min(int(options.get("height", 1024)), 1536)),
        "{{STEPS}}": max(1, min(int(options.get("steps", 4)), 50)),
        "{{SEED}}": int(options.get("seed", int(time.time()) % 1_000_000_000)),
    }
    workflow = json.loads(workflow_path(capability).read_text(encoding="utf-8"))
    started = time.monotonic()
    with httpx.Client(timeout=30) as client:
        if capability == "image.edit":
            paths = inputs.get("imagePaths") or ([inputs["imagePath"]] if inputs.get("imagePath") else [])
            if not 1 <= len(paths) <= 4:
                raise RuntimeError("image.edit requires 1 to 4 input images")
            for index, raw_path in enumerate(paths):
                replacements[f"{{{{INPUT_IMAGE_{index}}}}}"] = upload_image(client, base_url, Path(raw_path).resolve())
        rendered = render_workflow(workflow, replacements)
        queue = client.post(f"{base_url}/prompt", json={"prompt": rendered, "client_id": str(uuid.uuid4())})
        queue.raise_for_status()
        prompt_id = str(queue.json().get("prompt_id") or "")
        if not prompt_id:
            raise RuntimeError("ComfyUI did not return prompt_id")
        history: dict[str, Any] | None = None
        while time.monotonic() - started < timeout:
            response = client.get(f"{base_url}/history/{prompt_id}")
            response.raise_for_status()
            candidate = response.json()
            if candidate and (prompt_id in candidate or candidate.get("outputs")):
                history = candidate
                break
            time.sleep(1)
        if history is None:
            raise TimeoutError("ComfyUI image generation timed out")
        image = select_output_image(history, prompt_id)
        view = client.get(
            f"{base_url}/view",
            params={
                "filename": image["filename"],
                "subfolder": image.get("subfolder", ""),
                "type": image.get("type", "output"),
            },
        )
        view.raise_for_status()
    output_dir = Path(payload["outputDirectory"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(image["filename"]).suffix or ".png"
    output = output_dir / f"comfyui-{prompt_id[:16]}{suffix}"
    output.write_bytes(view.content)
    print(json.dumps({
        "provider": "comfyui-flux2-klein",
        "result": {
            "artifactPath": str(output),
            "width": replacements["{{WIDTH}}"],
            "height": replacements["{{HEIGHT}}"],
            "steps": replacements["{{STEPS}}"],
            "seed": replacements["{{SEED}}"],
            "comfyPromptId": prompt_id,
        },
    }, ensure_ascii=False))


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in {"health", "invoke"}:
        raise SystemExit("usage: desktop_comfyui_adapter.py <health|invoke> <image.generate|image.edit>")
    mode, capability = sys.argv[1:]
    if mode == "health":
        run_health(capability)
    else:
        run_invoke(capability)


if __name__ == "__main__":
    main()
