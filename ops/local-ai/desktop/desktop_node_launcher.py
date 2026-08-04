from __future__ import annotations

import argparse
import asyncio
import os
from pathlib import Path


def load_env(path: Path) -> None:
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or not key.replace("_", "").isalnum():
            raise RuntimeError(f"invalid environment key: {key}")
        os.environ.setdefault(key, value.strip())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", default="desktop-node.env")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    env_path = Path(args.env_file).expanduser().resolve()
    load_env(env_path)

    from desktop_enhancement_node import DesktopEnhancementRuntime, DesktopSettings, app

    settings = DesktopSettings.from_env()
    if args.check:
        async def check() -> None:
            runtime = DesktopEnhancementRuntime(settings)
            await runtime.start()
            health = await runtime.health()
            if health["status"] != "healthy":
                raise SystemExit(1)

        asyncio.run(check())
        return

    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
