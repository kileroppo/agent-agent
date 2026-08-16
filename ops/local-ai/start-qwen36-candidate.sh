#!/bin/zsh
set -euo pipefail

readonly RUNTIME_ROOT="${AGENT_ARMY_LOCAL_AI_HOME:-$HOME/Library/Application Support/AgentArmy/local-ai}"
readonly PLUGIN_ROOT="${AGENT_ARMY_LOCAL_AI_PLUGIN_ROOT:-$HOME/Library/Application Support/AgentArmy/plugins/local-ai}"
exec "$RUNTIME_ROOT/venvs/gateway/bin/python" "$PLUGIN_ROOT/current/bin/launcher.py" qwen36-candidate
