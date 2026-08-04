#!/bin/zsh
set -euo pipefail

readonly REPO_ROOT='/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent'
readonly AGENTS_DIR='/Users/pengaro/Library/LaunchAgents'
readonly DOMAIN="gui/$(id -u)"
readonly QWEN_LABEL='com.agent-army.local-ai.qwen35'
readonly GATEWAY_LABEL='com.agent-army.local-ai.gateway'

mkdir -p "$REPO_ROOT/work/local-ai/logs" "$AGENTS_DIR"
for label in "$GATEWAY_LABEL" "$QWEN_LABEL"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
done

cp "$REPO_ROOT/ops/local-ai/$QWEN_LABEL.plist" "$AGENTS_DIR/$QWEN_LABEL.plist"
cp "$REPO_ROOT/ops/local-ai/$GATEWAY_LABEL.plist" "$AGENTS_DIR/$GATEWAY_LABEL.plist"
plutil -lint "$AGENTS_DIR/$QWEN_LABEL.plist" "$AGENTS_DIR/$GATEWAY_LABEL.plist"

launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$QWEN_LABEL.plist"
launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$GATEWAY_LABEL.plist"
launchctl kickstart -k "$DOMAIN/$QWEN_LABEL"
launchctl kickstart -k "$DOMAIN/$GATEWAY_LABEL"
