#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo 'usage: ./install-linux.sh <mac-private-ip>' >&2
  exit 2
fi

readonly MAC_PRIVATE_IP="$1"
readonly BUNDLE_ROOT="$(cd "$(dirname "$0")" && pwd)"
readonly VENV_ROOT="$BUNDLE_ROOT/.venv"
readonly ENV_FILE="$BUNDLE_ROOT/desktop-node.env"
readonly CONFIG_FILE="$BUNDLE_ROOT/desktop-adapters.json"
readonly PAIRING_FILE="$BUNDLE_ROOT/mac-pairing.json"

python3 - "$MAC_PRIVATE_IP" <<'PY'
import ipaddress
import sys
ipaddress.ip_address(sys.argv[1])
PY

python3 -m venv "$VENV_ROOT"
"$VENV_ROOT/bin/python" -m pip install --disable-pip-version-check -r "$BUNDLE_ROOT/requirements.txt"

TOKEN=$("$VENV_ROOT/bin/python" -c 'import secrets; print(secrets.token_urlsafe(48))')
"$VENV_ROOT/bin/python" - "$BUNDLE_ROOT" "$CONFIG_FILE" "$ENV_FILE" "$PAIRING_FILE" "$MAC_PRIVATE_IP" "$TOKEN" <<'PY'
import json
import os
import sys
from pathlib import Path

root, config_path, env_path, pairing_path, mac_ip, token = sys.argv[1:]
root = Path(root).resolve()
python = root / '.venv' / 'bin' / 'python'
adapter = root / 'desktop_comfyui_adapter.py'
capabilities = {}
for capability in ('image.generate', 'image.edit'):
    capabilities[capability] = {
        'command': [str(python), str(adapter), 'invoke', capability],
        'healthCommand': [str(python), str(adapter), 'health', capability],
        'resource': 'gpu-heavy',
        'timeoutSeconds': 3600,
    }
Path(config_path).write_text(json.dumps({'node': 'rtx-4070ti-super', 'capabilities': capabilities}, indent=2), encoding='utf-8')
env_lines = [
    'LOCAL_AI_DESKTOP_HOST=0.0.0.0',
    'LOCAL_AI_DESKTOP_PORT=18083',
    f'LOCAL_AI_DESKTOP_TOKEN={token}',
    f'LOCAL_AI_DESKTOP_ALLOWED_CIDRS={mac_ip}/32',
    f'LOCAL_AI_DESKTOP_ADAPTER_CONFIG={config_path}',
    f'LOCAL_AI_DESKTOP_WORK_ROOT={root / "work"}',
    'COMFYUI_BASE_URL=http://127.0.0.1:8188',
    f'COMFYUI_GENERATE_WORKFLOW={root / "workflows" / "flux2-klein-generate-api.json"}',
    f'COMFYUI_EDIT_WORKFLOW={root / "workflows" / "flux2-klein-edit-api.json"}',
]
Path(env_path).write_text('\n'.join(env_lines) + '\n', encoding='utf-8')
Path(pairing_path).write_text(json.dumps({'baseUrl': 'http://DESKTOP_PRIVATE_IP:18083', 'token': token}, indent=2), encoding='utf-8')
os.chmod(env_path, 0o600)
os.chmod(pairing_path, 0o600)
PY

mkdir -p "$BUNDLE_ROOT/workflows" "$BUNDLE_ROOT/work"
chmod 600 "$ENV_FILE" "$PAIRING_FILE"
echo "4070 node runtime installed. Pairing data was written to $PAIRING_FILE; do not paste its token into chat or logs."
echo "After ComfyUI and both API workflows are ready, run: $VENV_ROOT/bin/python $BUNDLE_ROOT/desktop_node_launcher.py --env-file $ENV_FILE --check"
