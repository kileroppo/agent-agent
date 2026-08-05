from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the pinned FLUX.2 Klein 4B ComfyUI model set.")
    parser.add_argument("--comfy-root", required=True, help="Path to the target ComfyUI directory")
    parser.add_argument("--manifest", default=str(Path(__file__).with_name("model-manifest.json")))
    args = parser.parse_args()

    # This network showed repeated TLS close errors through Xet while normal
    # Hugging Face HTTP range downloads were stable and resumable. Callers can
    # explicitly set HF_HUB_DISABLE_XET=0 when the target network supports Xet.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from huggingface_hub import hf_hub_download

    comfy_root = Path(args.comfy_root).expanduser().resolve()
    if not comfy_root.is_dir():
        raise SystemExit(f"ComfyUI directory does not exist: {comfy_root}")
    manifest = json.loads(Path(args.manifest).expanduser().resolve().read_text(encoding="utf-8"))
    staging = comfy_root / ".agent-army-model-downloads"
    staging.mkdir(parents=True, exist_ok=True)

    for model in manifest["models"]:
        destination = (comfy_root / model["destination"]).resolve()
        if comfy_root not in destination.parents:
            raise RuntimeError("model destination escaped ComfyUI root")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_file() and destination.stat().st_size == model["size"] and sha256_file(destination) == model["sha256"]:
            print(f"VERIFIED_EXISTING {destination}", flush=True)
            continue
        print(f"DOWNLOAD_START {model['repoId']} {model['revision']} {model['filename']}", flush=True)
        downloaded = Path(hf_hub_download(
            repo_id=model["repoId"],
            revision=model["revision"],
            filename=model["filename"],
            local_dir=staging,
        )).resolve()
        if downloaded.stat().st_size != model["size"]:
            raise RuntimeError(f"model size mismatch: {downloaded}")
        actual_sha = sha256_file(downloaded)
        if actual_sha != model["sha256"]:
            raise RuntimeError(f"model checksum mismatch: {downloaded}")
        temporary = destination.with_name(f".{destination.name}.agent-army-download")
        if temporary.exists():
            temporary.unlink()
        os.replace(downloaded, temporary)
        os.replace(temporary, destination)
        print(f"DOWNLOAD_VERIFIED {destination} {actual_sha}", flush=True)

    print("DESKTOP_MODEL_SET_READY", flush=True)


if __name__ == "__main__":
    main()
