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
  assert.deepEqual(manifest.acceptedTaskTypes, [
    "army.intake",
    "army.route-task",
    "army.cross-agent-mission",
    "army.goal-program",
    "content.campaign-topic"
  ]);
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

test("A君收到明确成品请求时必须建立业务任务，不能只在聊天里直接生成", async () => {
  const prompt = await readFile(path.join(repositoryRoot, "agents/ajun/prompts/system.md"), "utf8");
  assert.match(prompt, /明确要求(?:生成|修改|保存).{0,40}成品/);
  assert.match(prompt, /必须调用 `task_create`/);
  assert.match(prompt, /不能只在聊天里直接写出/);
});

test("所有已上岗 Agent 统一使用中文任务摘要，内部状态只留在技术详情", async () => {
  const entries = await readdir(path.join(repositoryRoot, "agents"), { withFileTypes:true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const filePath = path.join(repositoryRoot, "agents", entry.name, "manifest.json");
    try {
      const manifest = await readJson(filePath);
      if (manifest.status !== "active") continue;
      const prompt = await readFile(path.join(repositoryRoot, manifest.promptRef), "utf8");
      assert.match(prompt, /任务工具返回 `presentation`/u, `${manifest.agentId} 缺少统一任务表达约定`);
      assert.match(prompt, /完整 UUID/u, `${manifest.agentId} 没有把完整编号收进技术详情`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
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
    assert.equal(profile.localProfile.credentialedTransportVerification.status, "verified-current-model-policy");
    assert.equal(profile.localProfile.credentialedTransportVerification.primary.verified, true);
    assert.equal(
      profile.localProfile.credentialedTransportVerification.fallback.verified,
      agentId === "technical-expert"
    );
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
    assert.equal(profile.localProfile.credentialedTransportVerification.status, "verified-current-model-policy");
    assert.equal(profile.localProfile.credentialedTransportVerification.primary.verified, true);
    assert.equal(profile.localProfile.credentialedTransportVerification.fallback.verified, false);
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
      provider:"stepfun",
      model:"step-3.5-flash-2603"
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
    assert.equal(profile.localProfile.credentialedTransportVerification.status, "verified-current-model-policy");
    assert.equal(profile.localProfile.credentialedTransportVerification.primary.verified, true);
    assert.equal(profile.localProfile.credentialedTransportVerification.fallback.verified, false);
    assert.deepEqual(profile.modelSelection, {
      provider:"stepfun",
      model:"step-3.5-flash-2603",
      secretStoredHere:false
    });
    assert.deepEqual(profile.toolAllowlist, manifest.toolAllowlist);
    assert.equal(profile.secrets.valuesStoredHere, false);
  }
});

test("小拆把指标来源约束下沉到 Prompt、Skill、Manifest 和 Eval", async () => {
  const manifest = await readJson(
    path.join(repositoryRoot, "agents/video-content-analyst/manifest.json")
  );
  const prompt = await readFile(
    path.join(repositoryRoot, manifest.promptRef),
    "utf8"
  );
  const skill = await readFile(
    path.join(
      repositoryRoot,
      "agents/video-content-analyst/skills/agent-army-video-content/SKILL.md"
    ),
    "utf8"
  );
  const evals = await readJson(path.join(repositoryRoot, manifest.evalRefs[0]));

  assert.equal(manifest.manifestVersion, "0.4.1");
  assert.match(prompt, /任一字段只要出现指标数字、比例或由其推导的算术结果/u);
  assert.match(prompt, /不能依赖其他字段代为标注/u);
  assert.match(prompt, /没有平台或行业基线时禁止/u);
  assert.match(skill, /evidenceKind=acceptance_fixture\|platform_observed\|derived_from_observed/u);
  assert.match(skill, /禁止用相邻字段的标签覆盖当前字段/u);
  assert.ok(manifest.qualityGates.some(
    ({ gate }) => gate === "metric-fields-carry-local-evidence-kind-and-source"
  ));
  assert.ok(manifest.qualityGates.some(
    ({ gate }) => gate === "metric-comparisons-require-explicit-baseline"
  ));
  assert.ok(evals.cases.some(({ id }) => id === "metric-provenance-is-field-local"));
  assert.ok(evals.cases.some(
    ({ id }) => id === "missing-baseline-forbids-comparative-verdict"
  ));
});

test("创建官和审核官固定使用本机 StepFun 路由，Profile 不保存密钥", async () => {
  for (const agentId of ["creator", "reviewer"]) {
    const manifest = await readJson(path.join(repositoryRoot, "agents", agentId, "manifest.json"));
    const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
    assert.deepEqual(manifest.runtimeCapabilities.modelSelection, {
      provider:"stepfun",
      model:"step-3.5-flash-2603"
    });
    assert.deepEqual(profile.modelSelection, {
      provider:"stepfun",
      model:"step-3.5-flash-2603",
      secretStoredHere:false
    });
    assert.equal(profile.secrets.valuesStoredHere, false);
  }
});

test("11 个自主岗位统一明确 StepFun 模型，私密只读岗位不开放模型处理与自主扩权", async () => {
  const entries = await readdir(path.join(repositoryRoot, "agents"), { withFileTypes:true });
  const formalAutonomousAgentIds = [
    "ajun",
    "xiaod",
    "intel-researcher",
    "office-assistant",
    "operator",
    "creator",
    "reviewer",
    "architect",
    "technical-expert",
    "video-content-analyst",
    "content-creator"
  ];
  const formal = [];
  let privateWechatSeen = false;
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const filePath = path.join(repositoryRoot, "agents", entry.name, "manifest.json");
    try {
      const manifest = await readJson(filePath);
      if (manifest.status !== "active") continue;
      if (manifest.agentId === "wechat-chat-retriever") {
        privateWechatSeen = true;
        assert.equal(manifest.executionOwner, "ajun-local");
        assert.equal(manifest.operationalPolicy.privateContentModelAccess, "disabled");
        assert.equal(manifest.operationalPolicy.rawChatPersistence, "disabled");
        assert.deepEqual(manifest.runtimeCapabilities.mcpTools, []);
        assert.deepEqual(manifest.runtimeCapabilities.modelSelection, {
          provider:"stepfun",
          model:"step-3.5-flash-2603"
        });
        assert.deepEqual(manifest.runtimeCapabilities.fallbackModels, [{
          provider:"deepseek",
          model:"deepseek-v4-flash",
          trigger:"transport_unavailable"
        }]);
        const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
        assert.equal(profile.status, "pending-local-profile");
        assert.equal(profile.localProfile.created, false);
        assert.equal(profile.localProfile.modelSelectionConfigured, false);
        assert.equal(profile.localProfile.modelConfigured, false);
        assert.equal(profile.localProfile.credentialedTransportVerified, false);
        assert.equal(
          profile.localProfile.credentialedTransportVerification.status,
          "pending-local-profile"
        );
        assert.equal(profile.localProfile.skillsSeeded, false);
        assert.deepEqual(profile.modelSelection, {
          provider:"stepfun",
          model:"step-3.5-flash-2603",
          secretStoredHere:false
        });
        assert.deepEqual(profile.fallbackModels, [{
          provider:"deepseek",
          model:"deepseek-v4-flash",
          trigger:"transport_unavailable",
          secretStoredHere:false
        }]);
        assert.equal(profile.gateway.enabled, false);
        assert.deepEqual(profile.mcp.tools, []);
        continue;
      }
      formal.push(manifest);
      assert.deepEqual(manifest.runtimeCapabilities.modelSelection, {
        provider:"stepfun",
        model:"step-3.5-flash-2603"
      });
      assert.deepEqual(manifest.runtimeCapabilities.fallbackModels, [{
        provider:"deepseek",
        model:"deepseek-v4-flash",
        trigger:"transport_unavailable"
      }]);
      assert.equal(manifest.dynamicCapabilityPolicy.modelPolicyMutable, false);
      assert.deepEqual(manifest.dynamicCapabilityPolicy.approvalRequiredFor, [
        "credentials",
        "external-write",
        "paid-action",
        "permission-expansion"
      ]);
      assert.deepEqual(manifest.autonomyBudgetPolicy, {
        maxRuntimeMinutes:60,
        maxModelCalls:20,
        maxConcurrentSubtasks:4,
        maxDelegationDepth:2,
        paidApprovalThresholdUsd:5
      });
      assert.ok(
        manifest.acceptedTaskTypes.some((taskType) => taskType.endsWith("-program")
          || taskType.endsWith("-production")
          || taskType.endsWith("-investigation")
          || taskType.endsWith("-response")
          || taskType.endsWith("-design")
          || taskType.endsWith("-review")
          || taskType.endsWith("-experiment")
          || taskType.endsWith("-resolution")),
        `${manifest.agentId} 缺少开放任务类型`
      );
      if (manifest.agentId === "ajun") {
        assert.ok(!manifest.toolAllowlist.some((tool) => /browser|terminal|shell|exec|publish/.test(tool)));
        assert.ok(manifest.runtimeCapabilities.mcpTools.includes("paperclip_assignment_get"));
        assert.ok(manifest.runtimeCapabilities.mcpTools.includes("employee_assignment_execute"));
        assert.ok(manifest.runtimeCapabilities.mcpTools.includes("paperclip_assignment_complete"));
        assert.ok(!manifest.runtimeCapabilities.feishuToolsets.some((toolset) =>
          ["terminal", "file", "browser", "computer_use", "code_execution"].includes(toolset)
        ));
      }
      if (["creator", "architect"].includes(manifest.agentId)) {
        assert.equal(manifest.dynamicCapabilityPolicy.capabilityLifecycleMode, "propose-only");
        assert.ok(!manifest.toolAllowlist.some((tool) => /install|enable|grant|permission|expand/.test(tool)));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  assert.deepEqual(formal.map((manifest) => manifest.agentId).sort(), formalAutonomousAgentIds.sort());
  assert.equal(privateWechatSeen, true);
});

test("M5 岗位通过受限 Hermes heartbeat 执行 Paperclip 当前指派", async () => {
  const expectedTaskTypes = {
    ajun:{
      executionTool:"employee_assignment_execute",
      taskTypes:["content.campaign-topic"]
    },
    "intel-researcher":{
      executionTool:"employee_assignment_execute",
      taskTypes:["content.campaign-research", "content.campaign-evidence"]
    },
    xiaod:{
      executionTool:"employee_assignment_execute",
      taskTypes:["content.campaign-assets"]
    },
    "office-assistant":{
      executionTool:"employee_assignment_execute",
      taskTypes:["content.campaign-metrics"]
    },
    "video-content-analyst":{
      executionTool:"video_content_analyze_execute",
      taskTypes:["content.campaign-visual-analysis"]
    },
    "content-creator":{
      executionTool:"m5_stage_execute",
      taskTypes:[
        "content.campaign-image-generation",
        "content.campaign-voice",
        "content.campaign-render"
      ]
    },
    reviewer:{
      executionTool:"m5_stage_execute",
      taskTypes:[
        "content.campaign-machine-review",
        "content.campaign-publish-approval",
        "content.campaign-verify"
      ]
    }
  };
  for (const [agentId, expected] of Object.entries(expectedTaskTypes)) {
    const manifest = await readJson(path.join(repositoryRoot, "agents", agentId, "manifest.json"));
    const profile = await readJson(path.join(repositoryRoot, manifest.runtimeProfileRef));
    assert.equal(manifest.status, "active");
    assert.equal(manifest.executionOwner, "paperclip-hermes");
    assert.equal(manifest.interaction.runtime, "hermes-profile");
    assert.ok(manifest.runtimeCapabilities.skills.includes("paperclip"));
    for (const tool of [
      "paperclip_assignment_get",
      expected.executionTool,
      "paperclip_assignment_complete"
    ]) {
      assert.ok(manifest.runtimeCapabilities.mcpTools.includes(tool), `${agentId} 缺少 ${tool}`);
      assert.ok(profile.mcp.tools.includes(tool), `${agentId} Profile 缺少 ${tool}`);
    }
    for (const taskType of expected.taskTypes) {
      assert.ok(manifest.acceptedTaskTypes.includes(taskType), `${agentId} 未声明 ${taskType}`);
      assert.ok(profile.mcp.scope.taskTypes.includes(taskType), `${agentId} Profile 未限制到 ${taskType}`);
    }
    assert.deepEqual(profile.mcp.scope.agentIds, [agentId]);
    assert.equal(profile.mcp.scope.allowMissions, agentId === "ajun");
    assert.ok(!manifest.runtimeCapabilities.feishuToolsets.some((toolset) =>
      ["terminal", "file", "browser", "computer_use", "code_execution"].includes(toolset)
    ));
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
