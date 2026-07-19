import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const manifestPath = path.join(repositoryRoot, "agents/xiaod/manifest.json");

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
  assert.equal(manifest.status, "draft");
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
