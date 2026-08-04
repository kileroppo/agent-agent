from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path


PNG_1X1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


def main() -> None:
    mode = sys.argv[1]
    capability = sys.argv[2]
    if mode == "health":
        print(json.dumps({"healthy": True, "provider": "desktop-test", "detail": capability}))
        return
    payload = json.loads(sys.stdin.read())
    time.sleep(float(payload.get("options", {}).get("sleepSeconds", 0)))
    if capability == "text.generate":
        print(json.dumps({"provider": "desktop-test", "result": {"text": "DESKTOP_OK", "received": payload["input"]}}))
        return
    output = Path(payload["outputDirectory"]) / "desktop-test.png"
    output.write_bytes(PNG_1X1)
    print(json.dumps({"provider": "desktop-test", "result": {"artifactPath": str(output), "received": payload["input"]}}))


if __name__ == "__main__":
    main()
