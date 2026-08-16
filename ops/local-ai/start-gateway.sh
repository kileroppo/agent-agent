#!/bin/zsh
set -euo pipefail

readonly RUNTIME_ROOT="${AGENT_ARMY_LOCAL_AI_HOME:-$HOME/Library/Application Support/AgentArmy/local-ai}"
readonly PLUGIN_ROOT="${AGENT_ARMY_LOCAL_AI_PLUGIN_ROOT:-$HOME/Library/Application Support/AgentArmy/plugins/local-ai}"
if [[ -x "$RUNTIME_ROOT/venvs/gateway/bin/python" && -f "$PLUGIN_ROOT/current/bin/launcher.py" ]]; then
  exec "$RUNTIME_ROOT/venvs/gateway/bin/python" "$PLUGIN_ROOT/current/bin/launcher.py" gateway
fi

# 仅供旧版硬编码 LaunchAgent 在首次迁移失败时恢复；正常安装的 plist 不调用本脚本。
readonly REPO_ROOT="${0:A:h:h:h}"
readonly LEGACY_ROOT="$REPO_ROOT/work/local-ai"
readonly LEGACY_PYTHON="$LEGACY_ROOT/venvs/retrieval/bin/python"
readonly PAIRING_FILE="${LOCAL_AI_DESKTOP_PAIRING_FILE:-$HOME/Library/Application Support/AgentArmy/local-ai/mac-pairing.json}"
[[ -x "$LEGACY_PYTHON" ]] || { print -u2 '本地 AI 插件尚未安装，且没有可回滚的旧环境。'; exit 1; }
export AGENT_ARMY_ROOT="$REPO_ROOT"
export LOCAL_AI_WORK_ROOT="$LEGACY_ROOT"
export LOCAL_AI_HOST='127.0.0.1'
export LOCAL_AI_PORT='18082'
export WECHAT_LOCAL_MODEL_BASE_URL='http://127.0.0.1:18081'
if [[ -f "$PAIRING_FILE" ]]; then
  [[ "$(stat -f '%Lp' "$PAIRING_FILE")" == '600' ]] || { print -u2 '配对文件权限必须为 0600。'; exit 1; }
  export LOCAL_AI_DESKTOP_BASE_URL="$($LEGACY_PYTHON -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["baseUrl"])' "$PAIRING_FILE")"
  export LOCAL_AI_DESKTOP_TOKEN="$($LEGACY_PYTHON -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["token"])' "$PAIRING_FILE")"
fi
exec "$LEGACY_PYTHON" "$REPO_ROOT/integrations/local-ai/local_ai_gateway.py"
