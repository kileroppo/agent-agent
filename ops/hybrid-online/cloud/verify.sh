#!/usr/bin/env bash
set -euo pipefail

overview="$(curl --fail --silent --show-error http://127.0.0.1:4321/api/overview)"
node -e '
const overview = JSON.parse(process.argv[1]);
const capability = overview.capabilities?.find((item) => item.id === "mac-worker");
if (!capability) throw new Error("缺少 Mac工作间能力状态");
if (!["waiting", "ready"].includes(capability.status)) throw new Error(`Mac工作间状态不正确：${capability.status}`);
if (!Array.isArray(overview.agents) || overview.agents.length < 4) throw new Error("员工清单不完整");
console.log(JSON.stringify({ agents:overview.agents.length, macWorker:capability.status, pendingApprovals:(overview.approvals || []).filter((item) => item.status === "pending").length }));
' "$overview"

systemctl is-active --quiet agent-army-ajun-cloud.service
systemctl is-active --quiet agent-army-paperclip.service
systemctl is-active --quiet hermes-gateway.service
systemctl is-active --quiet hermes-gateway-intel-researcher.service
systemctl is-active --quiet hermes-gateway-office-assistant.service
