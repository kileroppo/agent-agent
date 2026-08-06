#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runner="$script_dir/run-worker.sh"
tunnel_runner="$script_dir/run-iap-tunnel.sh"
private_dir="$HOME/.agent-army"
private_env="$private_dir/mac-worker.env"
launch_agents_dir="$HOME/Library/LaunchAgents"
plist="$launch_agents_dir/ai.agent-army.mac-worker.plist"
tunnel_plist="$launch_agents_dir/ai.agent-army.iap-tunnel.plist"
uid="$(id -u)"

if [[ ! -f "$private_env" ]]; then
  echo "请先从 mac-worker.env.example 创建 $private_env，并在本机填写私有值。" >&2
  exit 1
fi
chmod 600 "$private_env"
mkdir -p "$launch_agents_dir" "$private_dir/logs"

cat > "$tunnel_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.agent-army.iap-tunnel</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${tunnel_runner}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${private_dir}/logs/iap-tunnel.log</string>
  <key>StandardErrorPath</key><string>${private_dir}/logs/iap-tunnel.error.log</string>
</dict>
</plist>
PLIST

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.agent-army.mac-worker</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${runner}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${private_dir}/logs/mac-worker.log</string>
  <key>StandardErrorPath</key><string>${private_dir}/logs/mac-worker.error.log</string>
</dict>
</plist>
PLIST

plutil -lint "$tunnel_plist" "$plist"
launchctl bootout "gui/${uid}/ai.agent-army.iap-tunnel" >/dev/null 2>&1 || true
launchctl bootout "gui/${uid}/ai.agent-army.mac-worker" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${uid}" "$tunnel_plist"
launchctl bootstrap "gui/${uid}" "$plist"
launchctl enable "gui/${uid}/ai.agent-army.iap-tunnel"
launchctl enable "gui/${uid}/ai.agent-army.mac-worker"
launchctl kickstart -k "gui/${uid}/ai.agent-army.iap-tunnel"
launchctl kickstart -k "gui/${uid}/ai.agent-army.mac-worker"
launchctl print "gui/${uid}/ai.agent-army.iap-tunnel" | grep -E 'state =|pid =|path ='
launchctl print "gui/${uid}/ai.agent-army.mac-worker" | grep -E 'state =|pid =|path ='
