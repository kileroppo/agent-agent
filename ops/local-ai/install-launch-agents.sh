#!/bin/zsh
set -euo pipefail

readonly REPO_ROOT='/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent'
readonly AGENTS_DIR='/Users/pengaro/Library/LaunchAgents'
readonly DOMAIN="gui/$(id -u)"
readonly QWEN_LABEL='com.agent-army.local-ai.qwen35'
readonly QWEN36_LABEL='com.agent-army.local-ai.qwen36-candidate'
readonly GATEWAY_LABEL='com.agent-army.local-ai.gateway'

mkdir -p "$REPO_ROOT/work/local-ai/logs" "$AGENTS_DIR"
for label in "$GATEWAY_LABEL" "$QWEN_LABEL" "$QWEN36_LABEL"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
done

cp "$REPO_ROOT/ops/local-ai/$QWEN_LABEL.plist" "$AGENTS_DIR/$QWEN_LABEL.plist"
cp "$REPO_ROOT/ops/local-ai/$QWEN36_LABEL.plist" "$AGENTS_DIR/$QWEN36_LABEL.plist"
cp "$REPO_ROOT/ops/local-ai/$GATEWAY_LABEL.plist" "$AGENTS_DIR/$GATEWAY_LABEL.plist"
plutil -lint "$AGENTS_DIR/$QWEN_LABEL.plist" "$AGENTS_DIR/$QWEN36_LABEL.plist" "$AGENTS_DIR/$GATEWAY_LABEL.plist"

bootstrap_job() {
  local plist="$1"
  local attempt
  for attempt in 1 2 3; do
    if launchctl bootstrap "$DOMAIN" "$plist"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

bootstrap_job "$AGENTS_DIR/$QWEN_LABEL.plist"
bootstrap_job "$AGENTS_DIR/$QWEN36_LABEL.plist"
bootstrap_job "$AGENTS_DIR/$GATEWAY_LABEL.plist"
launchctl kickstart -k "$DOMAIN/$GATEWAY_LABEL"
