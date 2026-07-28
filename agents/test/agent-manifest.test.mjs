import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const manifestPath = path.join(repositoryRoot, "agents/xiaod/manifest.json");
const ajunManifestPath = path.join(repositoryRoot, "agents/ajun/manifest.json");
const onDemandAgentIds = ["architect", "reviewer", "creator", "technical-expert"];
const alwaysOnGovernanceAgentIds = ["operator"];
const configuredFirstTeamAgentIds = ["intel-researcher", "office-assistant"];
const m3ContentAgentIds = ["video-content-analyst", "content-creator"];

const requiredFields = [
  "schemaVersion",
  "agentId",
  "name",
  "department",
  "role",
  "responsibilities",
  "nonResponsibilities",
  "acceptedTaskTypes",
  "toolAllowlist",
  "dataScopes",
  "approvalPolicies",
  "qualityGates",
  "promptRef",
  "runtimeProfileRef",
  "appRef",
  "owner",
  "status"
];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("小D Manifest 具备必填字段和默认拒绝边界", async () => {
  const manifest = await readJson(manifestPath);

  assert.equal(manifest.schemaVersion, "agent.army/v1");
  assert.equal(manifest.agentId, "xiaod");
  assert.equal(manifest.status, "active");
  for (const field of requiredFields) {
    assert.ok(Object.hasOwn(manifest, field), `missing required field: ${field}`);
  }
  assert.ok(manifest.responsibilities.length > 0);
  assert.ok(manifest.nonResponsibilities.length > 0);
  assert.ok(manifest.acceptedTaskTypes.length > 0);
  assert.ok(manifest.qualityGates.every((gate) => gate.required === true));
  assert.ok(manifest.approvalPolicies.some((policy) => policy.decision === "require-approval"));
  assert.ok(!manifest.toolAllowlist.some((tool) => tool.includes("publish")));
});

test("Manifest 引用的仓库文件存在且 Hermes 映射一致", async () => {
  const manifest = await readJson(manifestPath);
  const referencedPaths = [
    manifest.promptRef,
    manifest.runtimeProfileRef,
    manifest.appRef,
    ...manifest.evalRefs
  ];

  for (const reference of referencedPaths) {
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, reference)));
  }

  const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
  assert.equal(profile.status, "active");
  assert.equal(profile.profileId, manifest.agentId);
  assert.equal(profile.agentManifestRef, "agents/xiaod/manifest.json");
  assert.deepEqual(profile.toolAllowlist, manifest.toolAllowlist);
  assert.equal(profile.gateway.allowAllUsers, false);
  assert.equal(profile.secrets.valuesStoredHere, false);
});

test("Manifest 和 Hermes 映射不包含秘密值字段", async () => {
  const documents = [
    await readFile(manifestPath, "utf8"),
    await readFile(path.join(repositoryRoot, "integrations/hermes/profiles/xiaod.profile.json"), "utf8")
  ];
  const forbiddenKeys = /"(?:appSecret|apiKey|accessToken|refreshToken|cookie)"\s*:/i;

  for (const document of documents) {
    assert.doesNotMatch(document, forbiddenKeys);
  }
});

test("A君也有完整岗位卡和独立身份资料，但不会被当成普通员工派活", async () => {
  const manifest = await readJson(ajunManifestPath);
  assert.equal(manifest.agentId, "ajun");
  assert.equal(manifest.kind, "manager");
  assert.deepEqual(manifest.acceptedTaskTypes, ["army.intake", "army.route-task", "army.cross-agent-mission"]);
  for (const field of requiredFields) assert.ok(Object.hasOwn(manifest, field), `missing required field: ${field}`);
  await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.promptRef)));
  await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.runtimeProfileRef)));
  await assert.doesNotReject(() => stat(path.join(repositoryRoot, "agents/ajun/岗位卡.md")));
  const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
  assert.equal(profile.agentManifestRef, "agents/ajun/manifest.json");
  assert.equal(profile.promptRef, manifest.promptRef);
  assert.deepEqual(profile.toolAllowlist, manifest.toolAllowlist);
  assert.equal(profile.secrets.valuesStoredHere, false);
});

test("治理岗位保留独立 Hermes 身份，只有运维官常驻飞书入口", async () => {
  for (const agentId of [...onDemandAgentIds, ...alwaysOnGovernanceAgentIds]) {
    const manifest = await readJson(path.join(repositoryRoot, "agents", agentId, "manifest.json"));
    assert.equal(manifest.schemaVersion, "agent.army/v1");
    assert.equal(manifest.agentId, agentId);
    assert.equal(manifest.status, "active");
    assert.ok(manifest.acceptedTaskTypes.length > 0);
    assert.ok(manifest.nonResponsibilities.length > 0);
    assert.ok(manifest.approvalPolicies.some((policy) => policy.decision !== "auto"));
    assert.deepEqual(manifest.interaction, {
      runtime:"hermes-profile",
      directFeishu:alwaysOnGovernanceAgentIds.includes(agentId) ? "required" : "disabled",
      visibility:"on-demand",
      groupPolicy:"mention-only"
    });
    assert.equal(manifest.executionOwner, "paperclip-hermes");
    assert.ok(manifest.runtimeCapabilities.skills.includes("paperclip"));
    assert.ok(manifest.runtimeCapabilities.mcpTools.includes("paperclip_assignment_get"));
    assert.ok(manifest.runtimeCapabilities.mcpTools.includes("paperclip_assignment_complete"));
    assert.ok(!manifest.runtimeCapabilities.feishuToolsets.some((toolset) => [
      "terminal",
      "file",
      "browser",
      "computer_use",
      "code_execution"
    ].includes(toolset)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.promptRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.appRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.runtimeProfileRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, "agents", agentId, "岗位卡.md")));

    const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
    assert.equal(profile.profileId, agentId);
    assert.equal(profile.status, "verified-local");
    assert.equal(profile.localProfile.created, true);
    assert.equal(profile.localProfile.modelSelectionConfigured, true);
    assert.equal(profile.localProfile.modelConfigured, true);
    assert.equal(profile.localProfile.credentialedTransportVerified, true);
    assert.equal(profile.localProfile.skillsSeeded, true);
    assert.equal(profile.gateway.enabled, alwaysOnGovernanceAgentIds.includes(agentId));
    assert.equal(profile.mcp.server, "agent-army");
    assert.deepEqual(profile.mcp.scope.agentIds, [agentId]);
    assert.ok(profile.mcp.tools.includes("paperclip_assignment_get"));
    assert.ok(profile.mcp.tools.includes("paperclip_assignment_complete"));
    assert.deepEqual(profile.toolAllowlist, manifest.toolAllowlist);
    assert.equal(profile.secrets.valuesStoredHere, false);
  }
});

test("任务协调官已退役，不再被配置器或派活名单发现", async () => {
  const manifest = await readJson(path.join(repositoryRoot, "agents/task-coordinator/manifest.json"));
  const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
  assert.equal(manifest.status, "retired");
  assert.equal(manifest.interaction.directFeishu, "disabled");
  assert.equal(profile.status, "retired");
  assert.equal(profile.gateway.enabled, false);
});

test("首批业务员工已由独立 Hermes Profile Gateway 承接飞书连续会话", async () => {
  for (const agentId of configuredFirstTeamAgentIds) {
    const manifest = await readJson(path.join(repositoryRoot, "agents", agentId, "manifest.json"));
    assert.equal(manifest.schemaVersion, "agent.army/v1");
    assert.equal(manifest.agentId, agentId);
    assert.equal(manifest.status, "active");
    for (const field of requiredFields) assert.ok(Object.hasOwn(manifest, field), `missing required field: ${field}`);
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.promptRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.runtimeProfileRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, "agents", agentId, "岗位卡.md")));

    const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
    assert.equal(profile.status, "verified-local");
    assert.equal(profile.profileId, agentId);
    assert.equal(profile.agentManifestRef, `agents/${agentId}/manifest.json`);
    assert.equal(profile.localProfile.created, true);
    assert.equal(profile.localProfile.modelSelectionConfigured, true);
    assert.equal(profile.localProfile.modelConfigured, true);
    assert.equal(profile.localProfile.credentialedTransportVerified, true);
    assert.equal(profile.localProfile.gatewayStarted, true);
    assert.equal(profile.gateway.enabled, true);
    assert.ok(manifest.toolAllowlist.every((tool) => profile.toolAllowlist.includes(tool)));
    assert.equal(profile.secrets.valuesStoredHere, false);
  }
});

test("M3 内容增长岗位通过受限验收后以最小权限按需上岗，仍不开独立飞书入口", async () => {
  for (const agentId of m3ContentAgentIds) {
    const manifest = await readJson(path.join(repositoryRoot, "agents", agentId, "manifest.json"));
    const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
    assert.equal(manifest.agentId, agentId);
    assert.equal(manifest.status, "active");
    assert.equal(manifest.executionOwner, "paperclip-hermes");
    assert.deepEqual(manifest.runtimeCapabilities.modelSelection, {
      provider:"openai-codex",
      model:"gpt-5.6-terra"
    });
    assert.equal(manifest.interaction.directFeishu, "disabled");
    assert.ok(manifest.acceptedTaskTypes.length > 0);
    assert.ok(manifest.qualityGates.every((gate) => gate.required === true));
    assert.ok(!manifest.toolAllowlist.some((tool) => /browser|cookie|publish|message\.reply/.test(tool)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.promptRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.appRef)));
    for (const evalRef of manifest.evalRefs) await assert.doesNotReject(() => stat(path.join(repositoryRoot, evalRef)));
    assert.equal(profile.status, "active");
    assert.equal(profile.profileId, agentId);
    assert.equal(profile.gateway.enabled, false);
    assert.equal(profile.localProfile.created, true);
    assert.equal(profile.localProfile.skillsSeeded, true);
    assert.equal(profile.localProfile.restrictedTestingConfigured, true);
    assert.equal(profile.localProfile.modelSelectionConfigured, true);
    assert.equal(profile.localProfile.modelConfigured, true);
    assert.equal(profile.localProfile.credentialedTransportVerified, true);
    assert.deepEqual(profile.modelSelection, {
      provider:"openai-codex",
      model:"gpt-5.6-terra",
      secretStoredHere:false
    });
    assert.deepEqual(profile.toolAllowlist, manifest.toolAllowlist);
    assert.equal(profile.secrets.valuesStoredHere, false);
  }
});

test("M3 候选抓取和私密数据技能没有进入任何正式岗位工具白名单", async () => {
  const forbidden = [
    "wechat-local-vault",
    "wechat-mp-batch-exporter",
    "chatgpt-web-research",
    "douyin-fetcher",
    "xiaohongshu-fetch"
  ];
  const entries = await readdir(path.join(repositoryRoot, "agents"), { withFileTypes:true });
  const forbiddenTaskTypes = [
    "research.external-second-opinion",
    "data.wechat-local-vault"
  ];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const filePath = path.join(repositoryRoot, "agents", entry.name, "manifest.json");
    try {
      const manifest = await readJson(filePath);
      const serializedTools = JSON.stringify({
        toolAllowlist:manifest.toolAllowlist || [],
        mcpTools:manifest.runtimeCapabilities?.mcpTools || []
      });
      for (const candidate of forbidden) assert.ok(!serializedTools.includes(candidate), `${entry.name} 不得直接注册 ${candidate}`);
      for (const taskType of forbiddenTaskTypes) {
        assert.ok(!(manifest.acceptedTaskTypes || []).includes(taskType), `${entry.name} 不得在候选验证前承接 ${taskType}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});
