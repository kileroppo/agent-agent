import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const manifestPath = path.join(repositoryRoot, "agents/xiaod/manifest.json");
const ajunManifestPath = path.join(repositoryRoot, "agents/ajun/manifest.json");
const independentAgentIds = ["task-coordinator", "architect", "reviewer", "operator", "creator", "technical-expert"];
const configuredFirstTeamAgentIds = ["intel-researcher", "office-assistant"];
const draftAgentIds = ["github-scout"];

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
  assert.equal(profile.status, "draft");
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
  assert.deepEqual(manifest.acceptedTaskTypes, []);
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

test("现有治理岗位都有独立 Hermes 身份、岗位能力和已启用 Gateway", async () => {
  for (const agentId of independentAgentIds) {
    const manifest = await readJson(path.join(repositoryRoot, "agents", agentId, "manifest.json"));
    assert.equal(manifest.schemaVersion, "agent.army/v1");
    assert.equal(manifest.agentId, agentId);
    assert.equal(manifest.status, "active");
    assert.ok(manifest.acceptedTaskTypes.length > 0);
    assert.ok(manifest.nonResponsibilities.length > 0);
    assert.ok(manifest.approvalPolicies.some((policy) => policy.decision !== "auto"));
    assert.deepEqual(manifest.interaction, {
      runtime:"hermes-profile",
      directFeishu:"required",
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
    assert.equal(profile.gateway.enabled, true);
    assert.equal(profile.mcp.server, "agent-army");
    assert.deepEqual(profile.mcp.scope.agentIds, [agentId]);
    assert.ok(profile.mcp.tools.includes("paperclip_assignment_get"));
    assert.ok(profile.mcp.tools.includes("paperclip_assignment_complete"));
    assert.deepEqual(profile.toolAllowlist, manifest.toolAllowlist);
    assert.equal(profile.secrets.valuesStoredHere, false);
  }
});

test("新增岗位在审核前保持草案，并有完整的无凭据身份映射", async () => {
  for (const agentId of draftAgentIds) {
    const manifest = await readJson(path.join(repositoryRoot, "agents", agentId, "manifest.json"));
    assert.equal(manifest.schemaVersion, "agent.army/v1");
    assert.equal(manifest.agentId, agentId);
    assert.equal(manifest.status, "draft");
    for (const field of requiredFields) assert.ok(Object.hasOwn(manifest, field), `missing required field: ${field}`);
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.promptRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, manifest.runtimeProfileRef)));
    await assert.doesNotReject(() => stat(path.join(repositoryRoot, "agents", agentId, "岗位卡.md")));
    const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
    assert.equal(profile.status, "draft");
    assert.equal(profile.profileId, agentId);
    assert.equal(profile.agentManifestRef, `agents/${agentId}/manifest.json`);
    assert.deepEqual(profile.toolAllowlist, manifest.toolAllowlist);
    assert.equal(profile.gateway.enabled, false);
    assert.equal(profile.secrets.valuesStoredHere, false);
  }
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
