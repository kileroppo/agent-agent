#!/bin/zsh
set -euo pipefail

readonly DOMAIN="gui/$(id -u)"
for label in com.agent-army.local-ai.qwen35 com.agent-army.local-ai.gateway; do
  echo "$label"
  launchctl print "$DOMAIN/$label" 2>/dev/null | sed -n '1,28p' || echo '  launchd: not loaded'
done

echo '18081 Qwen3.5'
curl -fsS --max-time 5 http://127.0.0.1:18081/health | jq '{status,loaded_model,continuous_batching_enabled}'
echo '18082 unified gateway'
curl -fsS --max-time 5 http://127.0.0.1:18082/health | jq '{status,node,desktopEnhancement,queues,capabilities:[.capabilities[]|{capability,configured,healthy,e2eVerified,provider}]}'
