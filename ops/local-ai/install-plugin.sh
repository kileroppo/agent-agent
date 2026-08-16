#!/bin/zsh
set -euo pipefail

readonly SCRIPT_DIR="${0:A:h}"
readonly REPO_ROOT="${SCRIPT_DIR:h:h}"
readonly RUNTIME_ROOT="${AGENT_ARMY_LOCAL_AI_HOME:-$HOME/Library/Application Support/AgentArmy/local-ai}"
readonly PLUGIN_ROOT="${AGENT_ARMY_LOCAL_AI_PLUGIN_ROOT:-$HOME/Library/Application Support/AgentArmy/plugins/local-ai}"
readonly LAUNCH_AGENTS_DIR="${AGENT_ARMY_LOCAL_AI_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
readonly DOMAIN="gui/$(id -u)"
readonly MANAGER="$SCRIPT_DIR/plugin-manager.mjs"
readonly OLD_RUNTIME_ROOT="$REPO_ROOT/work/local-ai"
readonly LABELS=(com.agent-army.local-ai.gateway com.agent-army.local-ai.qwen35 com.agent-army.local-ai.qwen36-candidate)

bootstrap=false
download_models=false
migrate_existing=false
start_services=true

usage() {
  print '用法: ops/local-ai/install-plugin.sh [--bootstrap] [--download-models] [--migrate-existing] [--no-start]'
  print '  --bootstrap         在外置运行根创建固定 Python 3.12 环境并安装锁定依赖'
  print '  --download-models   下载 model-manifest.json 中固定版本的 Mac 模型'
  print '  --migrate-existing  迁移当前仓库 work/local-ai，合并重复的 MLX-VLM 环境'
  print '  --no-start          只安装插件和 LaunchAgent 文件，不启动'
}

while (( $# > 0 )); do
  case "$1" in
    --bootstrap) bootstrap=true ;;
    --download-models) download_models=true ;;
    --migrate-existing) migrate_existing=true ;;
    --no-start) start_services=false ;;
    --help|-h) usage; exit 0 ;;
    *) print -u2 "未知参数: $1"; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  print -u2 'Mac 本地 AI 插件目前只支持 Apple Silicon macOS；4070 节点使用 ops/local-ai/desktop 安装器。'
  exit 1
fi

mkdir -p "$RUNTIME_ROOT" "$PLUGIN_ROOT" "$LAUNCH_AGENTS_DIR"
chmod 700 "$RUNTIME_ROOT"

node "$MANAGER" install \
  --repo-root "$REPO_ROOT" \
  --runtime-root "$RUNTIME_ROOT" \
  --plugin-root "$PLUGIN_ROOT" \
  --launch-agents-dir "$LAUNCH_AGENTS_DIR" \
  --activate >/dev/null

migration_record=''
plist_backup=''
migration_complete=false

restore_previous_runtime() {
  local exit_code=$?
  if [[ "$migration_complete" == true && -n "$migration_record" && -f "$migration_record" ]]; then
    for label in "${LABELS[@]}"; do
      launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    done
    node "$MANAGER" rollback-runtime --record "$migration_record" >/dev/null || true
  fi
  if [[ -n "$plist_backup" && -d "$plist_backup" ]]; then
    for label in "${LABELS[@]}"; do
      if [[ -f "$plist_backup/$label.plist" ]]; then
        cp "$plist_backup/$label.plist" "$LAUNCH_AGENTS_DIR/$label.plist"
        launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$label.plist" 2>/dev/null || true
      fi
    done
  fi
  return $exit_code
}

bootstrap_job() {
  local plist="$1"
  local attempt
  for attempt in 1 2; do
    if launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  launchctl bootstrap "$DOMAIN" "$plist"
}

if [[ "$migrate_existing" == true ]]; then
  if [[ ! -d "$OLD_RUNTIME_ROOT/venvs/retrieval" || ! -d "$OLD_RUNTIME_ROOT/venvs/mflux" ]]; then
    print -u2 "找不到可迁移的旧环境: $OLD_RUNTIME_ROOT"
    exit 1
  fi
  migration_record="$(mktemp -t agent-army-local-ai-migration)"
  plist_backup="$(mktemp -d -t agent-army-local-ai-plists)"
  for label in "${LABELS[@]}"; do
    if [[ -f "$LAUNCH_AGENTS_DIR/$label.plist" ]]; then
      cp "$LAUNCH_AGENTS_DIR/$label.plist" "$plist_backup/$label.plist"
    fi
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  done
  trap restore_previous_runtime EXIT INT TERM
  node "$MANAGER" migrate-runtime \
    --source "$OLD_RUNTIME_ROOT" \
    --runtime-root "$RUNTIME_ROOT" \
    --plugin-root "$PLUGIN_ROOT" \
    --record "$migration_record" >/dev/null
  migration_complete=true
  node "$MANAGER" repair-runtime --runtime-root "$RUNTIME_ROOT" --plugin-root "$PLUGIN_ROOT" >/dev/null
fi

if [[ "$bootstrap" == true ]]; then
  if ! command -v uv >/dev/null 2>&1; then
    print -u2 '缺少 uv。请先安装 uv，再重新运行本命令。'
    exit 1
  fi
  if [[ ! -x "$RUNTIME_ROOT/venvs/gateway/bin/python" ]]; then
    uv venv --python 3.12 "$RUNTIME_ROOT/venvs/gateway"
  fi
  uv pip sync "$SCRIPT_DIR/requirements/gateway.lock" --python "$RUNTIME_ROOT/venvs/gateway/bin/python"
  if [[ ! -x "$RUNTIME_ROOT/venvs/mflux/bin/python" ]]; then
    uv venv --python 3.12 "$RUNTIME_ROOT/venvs/mflux"
  fi
  uv pip sync "$SCRIPT_DIR/requirements/mflux.lock" --python "$RUNTIME_ROOT/venvs/mflux/bin/python"
fi

if [[ ! -x "$RUNTIME_ROOT/venvs/gateway/bin/python" || ! -x "$RUNTIME_ROOT/venvs/mflux/bin/python" ]]; then
  print -u2 '外置运行环境不存在。新电脑请加 --bootstrap；旧项目迁移请加 --migrate-existing。'
  exit 1
fi

mkdir -p "$RUNTIME_ROOT/logs"
chmod 700 "$RUNTIME_ROOT/logs"

node "$MANAGER" install \
  --repo-root "$REPO_ROOT" \
  --runtime-root "$RUNTIME_ROOT" \
  --plugin-root "$PLUGIN_ROOT" \
  --launch-agents-dir "$LAUNCH_AGENTS_DIR" \
  --activate \
  --write-launch-agents >/dev/null

for label in "${LABELS[@]}"; do
  plutil -lint "$LAUNCH_AGENTS_DIR/$label.plist" >/dev/null
done

if [[ "$download_models" == true ]]; then
  "$RUNTIME_ROOT/venvs/gateway/bin/python" \
    "$PLUGIN_ROOT/current/bin/download_models.py" \
    --manifest "$PLUGIN_ROOT/current/model-manifest.json"
fi

if [[ "$start_services" == true ]]; then
  for label in "${LABELS[@]}"; do
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    bootstrap_job "$LAUNCH_AGENTS_DIR/$label.plist"
  done
  launchctl kickstart -k "$DOMAIN/com.agent-army.local-ai.gateway"
  gateway_ready=false
  for attempt in {1..30}; do
    if curl -fsS --max-time 2 http://127.0.0.1:18082/health >/dev/null 2>&1; then
      gateway_ready=true
      break
    fi
    sleep 1
  done
  if [[ "$gateway_ready" != true ]]; then
    print -u2 '外置本地 AI 网关未在 30 秒内恢复，正在回滚。'
    exit 1
  fi
fi

trap - EXIT INT TERM
print "本地 AI 插件已安装"
node "$MANAGER" status --runtime-root "$RUNTIME_ROOT" --plugin-root "$PLUGIN_ROOT"
print "运行根: $RUNTIME_ROOT"
print "插件根: $PLUGIN_ROOT"
