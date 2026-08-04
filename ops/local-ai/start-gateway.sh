#!/bin/zsh
set -euo pipefail

readonly REPO_ROOT='/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent'
export AGENT_ARMY_ROOT="$REPO_ROOT"
export LOCAL_AI_HOST='127.0.0.1'
export LOCAL_AI_PORT='18082'
export WECHAT_LOCAL_MODEL_BASE_URL='http://127.0.0.1:18081'

exec "$REPO_ROOT/work/local-ai/venvs/retrieval/bin/python" \
  "$REPO_ROOT/integrations/local-ai/local_ai_gateway.py"
