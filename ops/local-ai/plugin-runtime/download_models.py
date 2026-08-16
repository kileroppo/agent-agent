#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from huggingface_hub import snapshot_download


def main() -> None:
    parser = argparse.ArgumentParser(description="下载本地 AI 插件固定版本模型")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    selected = set(args.only)
    for model in manifest["models"]:
        if selected and model["id"] not in selected:
            continue
        print(f"downloading {model['id']} ({model['repoId']}@{model['revision']})", flush=True)
        snapshot_download(repo_id=model["repoId"], revision=model["revision"])


if __name__ == "__main__":
    main()
