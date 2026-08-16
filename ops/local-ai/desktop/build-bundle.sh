#!/bin/zsh
set -euo pipefail

readonly SCRIPT_DIR="${0:A:h}"
readonly REPO_ROOT="${SCRIPT_DIR:h:h:h}"
readonly LOCAL_AI_HOME="${AGENT_ARMY_LOCAL_AI_HOME:-$HOME/Library/Application Support/AgentArmy/local-ai}"
readonly OUTPUT_ROOT="$LOCAL_AI_HOME/desktop-node-bundles"
readonly OUTPUT_FILE="$OUTPUT_ROOT/agent-army-4070-node-20260804.zip"
bundle_tmp=$(mktemp -d /tmp/agent-army-4070-bundle.XXXXXX)
trap 'rm -rf "$bundle_tmp"' EXIT

mkdir -p "$bundle_tmp/agent-army-4070-node/workflows" "$OUTPUT_ROOT"
cp "$REPO_ROOT/integrations/local-ai/desktop_enhancement_node.py" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/integrations/local-ai/desktop_comfyui_adapter.py" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/desktop_node_launcher.py" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/requirements.txt" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/model-manifest.json" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/download-desktop-models.py" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/adapter-config.example.json" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/install-linux.sh" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/install-windows.ps1" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/README.md" "$bundle_tmp/agent-army-4070-node/"
cp "$REPO_ROOT/ops/local-ai/desktop/workflows/README.md" "$bundle_tmp/agent-army-4070-node/workflows/"
chmod +x "$bundle_tmp/agent-army-4070-node/install-linux.sh"
rm -f "$OUTPUT_FILE"
(cd "$bundle_tmp" && /usr/bin/zip -qr "$OUTPUT_FILE" agent-army-4070-node)
shasum -a 256 "$OUTPUT_FILE"
