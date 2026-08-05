#!/bin/zsh
set -euo pipefail

readonly REPO_ROOT='/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent'
readonly PYTHON="$REPO_ROOT/work/local-ai/venvs/retrieval/bin/python"
readonly DESKTOP_PAIRING_FILE="${LOCAL_AI_DESKTOP_PAIRING_FILE:-$HOME/Library/Application Support/AgentArmy/local-ai/mac-pairing.json}"
export AGENT_ARMY_ROOT="$REPO_ROOT"
export LOCAL_AI_HOST='127.0.0.1'
export LOCAL_AI_PORT='18082'
export WECHAT_LOCAL_MODEL_BASE_URL='http://127.0.0.1:18081'

if [ -f "$DESKTOP_PAIRING_FILE" ]; then
  test "$(stat -f '%Lp' "$DESKTOP_PAIRING_FILE")" = '600'
  export LOCAL_AI_DESKTOP_BASE_URL="$($PYTHON -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["baseUrl"])' "$DESKTOP_PAIRING_FILE")"
  export LOCAL_AI_DESKTOP_TOKEN="$($PYTHON -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["token"])' "$DESKTOP_PAIRING_FILE")"
fi

exec "$PYTHON" \
  "$REPO_ROOT/integrations/local-ai/local_ai_gateway.py"
