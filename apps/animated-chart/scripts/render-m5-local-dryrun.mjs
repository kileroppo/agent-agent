#!/usr/bin/env node
/* global Buffer, process */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SEVEN_THEMES } from "../../../integrations/paperclip/plugins/content-autonomy/scripts/run-seven-theme-stepfun-batch.mjs";

const exec = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "../..");
const nullCharacter = String.fromCharCode(0);
const preflightOnly = process.argv.includes("--preflight-only");
const stepfunLedgerArgument = argumentValue("--stepfun-ledger");
if (preflightOnly && !stepfunLedgerArgument) {
  throw new Error("--preflight-only 必须同时提供 --stepfun-ledger");
}
let stepfunBatch = stepfunLedgerArgument
  ? await loadStepfunBatch(path.resolve(stepfunLedgerArgument), { stageAssets: false })
  : null;
const outputRoot = stepfunBatch
  ? path.join(
      stepfunBatch.workspaceRoot,
      "stepfun-seven-theme-render",
      stepfunBatch.ledger.batchVersion,
    )
  : path.join(
      repositoryRoot,
      "work/m5-content-autonomy/local-dry-run",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
const fps = 30;
const durationSeconds = 45;
const visualFixtureSources = [
  "designs/m2-authorization-architecture/a-jun-product-runtime-preview.png",
  "designs/m2-authorization-architecture/architecture-preview.png",
  "designs/agent-army-m1/desktop-preview.png",
  "designs/feishu-mobile-army-control/architecture-preview.png",
];
const requiredArtifacts = [
  "master.mp4",
  "douyin.mp4",
  "xiaohongshu.mp4",
  "douyin.copy.json",
  "xiaohongshu.copy.json",
  "cover.png",
  "sources.json",
  "review.json",
  "lineage.json",
];

const localTopics = [
  {
    id: "execution-loop",
    title: "Agent 不是会说就算会做",
    subtitle: "一次真实执行闭环长什么样",
    narration:
      "很多 Agent 看起来很聪明，实际上只完成了回答。真正的执行闭环，要从目标开始，产生计划，调用真实工具，再根据结果纠错。Paperclip 保存任务、预算、审批和恢复，Hermes 负责岗位执行。每一步都要留下证据，失败也必须有明确去向。能连续恢复并交付，才叫真正会做。",
    scenes: [
      ["先看结果", "会写方案，不等于已经执行；真实工具返回才是下一步依据。", "M5 / Observation"],
      ["控制面只保留一套", "Paperclip 管流程、预算、审批与恢复，避免重复状态机互相打架。", "M5 / Paperclip"],
      ["岗位负责执行", "Hermes Profile 按岗位白名单拿工具，不能临时静默扩权。", "M5 / Hermes"],
      ["失败也要能继续", "从最近检查点恢复，不重做已经验证过的产物。", "M5 / checkpoint"],
    ],
  },
  {
    id: "permission-boundary",
    title: "高权限 Agent 为什么还要被限制",
    subtitle: "权限越高，停止条件越明确",
    narration:
      "高权限不是无限权限。内容 Agent 可以生成素材，但不能直接发布。真正的发布只交给无模型的发布网关，而且必须绑定活动、平台、账号引用、时间、数量和预算。遇到验证码、账号切换、风控、违规或重复内容，整条活动立即暂停。权限边界清楚，自治才有可能长期运行。",
    scenes: [
      ["生成和发布分开", "内容岗位只交付成片，Publisher Gateway 独占外部写入。", "M5 / separation"],
      ["授权绑定活动", "平台、账号、日期、次数和预算都写入 CampaignGrant。", "M5 / CampaignGrant"],
      ["异常立即停止", "验证码、风控、违规、未知页面和预算超限全部失败关闭。", "M5 / stop conditions"],
      ["删除另行审批", "暂停不会删除已发布内容，删除永远不是默认动作。", "M5 / non-goal"],
    ],
  },
  {
    id: "evidence-and-recovery",
    title: "Agent 卡住后，最怕的不是失败",
    subtitle: "最怕不知道做到哪、该从哪继续",
    narration:
      "Agent 卡住并不可怕，可怕的是没有检查点。每个步骤都应该记录输入、负责人、工具、预算、成功条件和真实观察。安全失败最多重试两次，路线不对最多重规划三次。进程重启后，从最近已验证产物继续，而不是重新生成全部内容。这样失败才是可管理的状态，不是一次性事故。",
    scenes: [
      ["先保存真实观察", "工具输出、错误分类和产物哈希进入同一条任务证据链。", "M5 / Observation"],
      ["重试必须有上限", "单步最多两次安全重试，整条内容最多三次重规划。", "M5 / retry budget"],
      ["通过检查点恢复", "已验证产物不重做，降低成本，也避免版本漂移。", "M5 / recovery"],
      ["复盘不能直接改生产", "指标只生成改进提案，审核和灰度通过后才升级模板。", "M5 / learning gate"],
    ],
  },
];
const stepfunSceneCopy = Object.freeze({
  "t01-execution-loop": [
    ["会回答，不等于会执行", "先看工具有没有真的调用、结果有没有真的返回，而不是看模型把计划写得多完整。", "M5 / Observation"],
    ["每一步都能改变下一步", "真实 Observation 必须进入判断；结果不对就纠错，路线不通就重规划。", "M5 / execution loop"],
    ["控制面只保留一套", "Paperclip 保存任务、预算、审批与恢复，岗位只负责自己被授权的执行。", "M5 / Paperclip"],
    ["交付要能被复核", "产物、费用和失败记录都留下血缘，能恢复完成才算真的会做。", "M5 / acceptance"],
  ],
  "t02-permission-boundary": [
    ["高权限也必须有边界", "能生成内容，不代表能直接发布；能浏览，也不代表能碰账号设置。", "M5 / least privilege"],
    ["授权绑定具体活动", "平台、账号引用、日期、次数、动作和费用都写进同一份活动授权。", "M5 / CampaignGrant"],
    ["危险信号立即停机", "验证码、风控、账号切换、违规提示和预算超限都必须失败关闭。", "M5 / stop conditions"],
    ["删除永远另审", "暂停只阻止后续动作，不自动清理历史内容，避免把恢复变成破坏。", "M5 / non-goal"],
  ],
  "t03-evidence-chain": [
    ["搜索结果不是证据", "摘要和仓库元数据只能帮助发现来源，不能直接支撑内容中的事实结论。", "M5 / source gate"],
    ["每条事实绑定原文", "Claim 必须对应公开 URL、抓取时间、内容哈希和逐字证据片段。", "M5 / fact binding"],
    ["画面判断绑定帧", "视觉结论必须指出具体帧、时间点和证据类型，拒绝空泛评价。", "M5 / frame evidence"],
    ["脚本继承整条血缘", "改写不能偷换原意，机器审核会逐项核对来源、片段和脚本事实。", "M5 / review"],
  ],
  "t04-role-bundles": [
    ["工具越多，不等于越强", "所有岗位共用一堆工具，会增加误用、越权和难以追责的概率。", "M5 / role boundary"],
    ["岗位拿最小技能包", "研究员查公开资料，素材岗处理媒体，创作岗写脚本和渲染，各做各的。", "M5 / SkillBundle"],
    ["能力升级有门禁", "新技能必须经过发现、审计、合成测试、负责人批准，不能运行中静默安装。", "M5 / activation"],
    ["专长之外也能协作", "开放任务通过父子 Case、明确输入和质量门禁组合，而不是把权限直接摊平。", "M5 / collaboration"],
  ],
  "t05-idempotent-recovery": [
    ["失败不可怕，重复才可怕", "同一次动作必须有稳定标识，重放只读取已确认结果，不能再次扣费。", "M5 / idempotency"],
    ["检查点锁定已验证产物", "重启后从最近成功阶段继续，不重新生成已经通过审核的素材。", "M5 / checkpoint"],
    ["换路线必须真的变化", "输入、工具或策略至少改变一项；只把字段写成“已换路线”属于伪恢复。", "M5 / recovery"],
    ["重试和重规划都有上限", "单步最多两次安全重试，整条内容最多三次重规划，超限就转阻塞。", "M5 / retry budget"],
  ],
  "t06-budget-gates": [
    ["先有预算许可，再调用模型", "任何付费工具都要先核对公司、岗位和项目三层剩余额度。", "M5 / budget preflight"],
    ["票据绑定这一次动作", "短期签名票据同时绑定 Run、action、参数校验和最大费用，篡改立即拒绝。", "M5 / signed ticket"],
    ["费用确认后才推进", "Provider 成功不代表阶段成功；核心费用事件确认完成后才能进入下一步。", "M5 / cost commit"],
    ["不确定就关闭门闩", "调用结果或扣费状态不确定时禁止自动重放，先核对账本再恢复。", "M5 / ambiguity gate"],
  ],
  "t07-review-learning": [
    ["发布前先过硬审核", "事实、版权、隐私、字幕、黑帧、响度、平台范围和重复哈希必须全部通过。", "M5 / machine review"],
    ["一次播放量不能改系统", "指标只进入快照和复盘，不能自动扩权、提频或开启投流。", "M5 / MetricSnapshot"],
    ["至少五条再谈规律", "同类真实样本不足时只记录信息不足，不强行生成所谓增长结论。", "M5 / sample gate"],
    ["新模板先离线再灰度", "审核通过后只试一条，表现或质量下降就自动回退旧版本。", "M5 / learning gate"],
  ],
});
if (preflightOnly) {
  const topics = buildStepfunTopics(stepfunBatch);
  process.stdout.write(`${JSON.stringify({
    status: "preflight_passed",
    batchVersion: stepfunBatch.ledger.batchVersion,
    themes: topics.length,
    logicalActions: stepfunBatch.logicalActionCount,
    newProviderCalls: stepfunBatch.ledger.totalProviderCalls,
    confirmedReplay: stepfunBatch.ledger.confirmedReplay,
    pendingCostRecovery: stepfunBatch.ledger.pendingCostRecovery,
    lifetimeProviderCalls: stepfunBatch.ledger.lifetimeProviderCalls,
    replayActions: stepfunBatch.ledger.replay.actions.length,
    replayProviderCalls: stepfunBatch.ledger.replay.providerCalls,
    rendered: false,
    externalPublished: false,
  }, null, 2)}\n`);
  process.exit(0);
}

const renderWorkspaceRoot = stepfunBatch?.workspaceRoot
  ?? path.join(repositoryRoot, "work/m5-content-autonomy");
if (stepfunBatch) {
  await ensureDirectoryTreeWithoutSymlinks(stepfunBatch.workspaceRoot, outputRoot);
} else {
  await fs.mkdir(outputRoot, { recursive: true });
}
const publicRoot = await prepareRenderPublicRoot(
  renderWorkspaceRoot,
  stepfunBatch?.ledger.batchVersion ?? "local-dry-run",
);
try {
  if (stepfunLedgerArgument) {
    stepfunBatch = await loadStepfunBatch(path.resolve(stepfunLedgerArgument), {
      stageAssets: true,
      publicDirectory: publicRoot,
    });
  }
  const topics = stepfunBatch ? buildStepfunTopics(stepfunBatch) : localTopics;

  const results = [];
  let visualFixtures = [];
  let ledgerVisualAssets = [];
  try {
    visualFixtures = await stageVisualFixtures();
    ledgerVisualAssets = stepfunBatch
      ? [...stepfunBatch.assetsByTheme.values()].map((item) => item.visual)
      : visualFixtures;
    for (const [index, topic] of topics.entries()) {
      const visualAssets = stepfunBatch
        ? [stepfunBatch.assetsByTheme.get(topic.id).visual, ...visualFixtures.slice(0, 3)]
        : visualFixtures;
      results.push(await renderTopic(topic, index + 1, visualAssets));
    }
  } finally {
    const staged = [
      ...visualFixtures,
      ...(stepfunBatch ? [...stepfunBatch.assetsByTheme.values()].map((item) => item.visual) : []),
    ];
    await Promise.all(staged.map((asset) => fs.rm(asset.publicPath, { force: true })));
  }

  await fs.writeFile(
    path.join(outputRoot, "ledger.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: stepfunBatch ? "m5-stepfun-seven-theme-local-render" : "m5-local-dry-run",
        generatedAt: new Date().toISOString(),
        externalPublished: false,
        paidProviderCalls: stepfunBatch?.ledger.totalProviderCalls ?? 0,
        voiceProvider: stepfunBatch ? "StepFun official TTS" : "macOS system voice",
        productionTtsVerified: Boolean(stepfunBatch),
        sourceBatchLedger: stepfunBatch
          ? {
              path: stepfunBatch.workspaceRelativeLedgerPath,
              checksum: stepfunBatch.ledgerChecksum,
              replayProviderCalls: stepfunBatch.ledger.replay?.providerCalls,
            }
          : null,
        visualFixtureSources: ledgerVisualAssets.map((asset) => ({
          sourceRef: asset.sourceRef,
          sourceChecksum: asset.sourceChecksum,
          normalizedChecksum: asset.checksum,
          rightsBasis: asset.rightsBasis,
        })),
        topics: results,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        outputRoot,
        topics: results.length,
        videos: results.length * 3,
        externalPublished: false,
        paidProviderCalls: stepfunBatch?.ledger.totalProviderCalls ?? 0,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await cleanupRenderPublicRoot(publicRoot);
}

async function renderTopic(topic, ordinal, visualAssets) {
  const directory = path.join(outputRoot, `topic-${String(ordinal).padStart(2, "0")}-${topic.id}`);
  const publicAudioName = `m5-local-${process.pid}-${ordinal}.mp3`;
  const publicAudioPath = path.join(publicRoot, publicAudioName);
  const temporaryAiff = path.join(directory, "narration.local.aiff");
  await fs.mkdir(directory, { recursive: true });

  try {
    let audioInputPath = topic.voiceover?.sourcePath;
    if (!audioInputPath) {
      await exec("/usr/bin/say", ["-v", "Tingting", "-r", "185", "-o", temporaryAiff, topic.narration], {
        timeout: 120_000,
      });
      audioInputPath = temporaryAiff;
    }
    await exec(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        audioInputPath,
        "-af",
        "loudnorm=I=-15:LRA=7:TP=-1.5,apad",
        "-t",
        String(durationSeconds),
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        publicAudioPath,
      ],
      { timeout: 120_000 },
    );

    const platformSpecs = {
      master: buildProps(topic, "master", publicAudioName, visualAssets),
      douyin: buildProps(topic, "douyin", publicAudioName, visualAssets),
      xiaohongshu: buildProps(topic, "xiaohongshu", publicAudioName, visualAssets),
    };
    const compositionIds = {
      master: "M5Master",
      douyin: "M5Douyin",
      xiaohongshu: "M5Xiaohongshu",
    };

    for (const platform of Object.keys(platformSpecs)) {
      const propsPath = path.join(directory, `${platform}.props.json`);
      const rawPath = path.join(directory, `${platform}.raw.mp4`);
      const finalPath = path.join(directory, `${platform}.mp4`);
      await fs.writeFile(propsPath, `${JSON.stringify(platformSpecs[platform], null, 2)}\n`);
      await exec(
        path.join(appRoot, "node_modules/.bin/remotion"),
        [
          "render",
          "src/index.ts",
          compositionIds[platform],
          rawPath,
          `--props=${propsPath}`,
          "--codec=h264",
          "--crf=25",
          "--concurrency=4",
          `--public-dir=${publicRoot}`,
          "--log=error",
        ],
        { cwd: appRoot, timeout: 20 * 60_000, maxBuffer: 2_000_000 },
      );
      await finalize(rawPath, finalPath);
      await fs.rm(rawPath, { force: true });
    }

    const coverPropsPath = path.join(directory, "cover.props.json");
    await fs.writeFile(coverPropsPath, `${JSON.stringify(platformSpecs.xiaohongshu, null, 2)}\n`);
    await exec(
      path.join(appRoot, "node_modules/.bin/remotion"),
      [
        "still",
        "src/index.ts",
        "M5Xiaohongshu",
        path.join(directory, "cover.png"),
        `--props=${coverPropsPath}`,
        "--frame=30",
        `--public-dir=${publicRoot}`,
        "--log=error",
      ],
      { cwd: appRoot, timeout: 5 * 60_000, maxBuffer: 2_000_000 },
    );

    await writeJson(path.join(directory, "douyin.copy.json"), {
      title: `别再把会聊天当成会干活：${topic.title}`,
      body: `${topic.subtitle}。这条用真实执行边界说明 Agent 如何从目标走到可核验结果。`,
      tags: ["AI Agent", "智能体实战", "工作流"],
    });
    await writeJson(path.join(directory, "xiaohongshu.copy.json"), {
      title: `${topic.title}｜一张图看懂可恢复的 Agent 工作流`,
      body: `${topic.subtitle}\n\n收藏要点：真实工具结果、明确权限、失败恢复、可追溯产物。`,
      tags: ["AI工具", "Agent工作流", "效率系统"],
    });
    await writeJson(path.join(directory, "sources.json"), {
      sources: [
        { ref: "tasks/prd-m5-high-autonomy-content-operations.md", kind: "local_project_document" },
        { ref: "docs/reviews/m5-high-autonomy-content-operations/acceptance.md", kind: "local_acceptance_ledger" },
      ],
      thirdPartyMedia: [],
      aiGeneratedMedia: visualAssets.filter((asset) => asset.sourceType === "stepfun_ai_generated").map((asset) => ({
        ref: asset.sourceRef,
        sourceChecksum: asset.sourceChecksum,
        normalizedChecksum: asset.checksum,
        bytes: asset.bytes,
        rightsBasis: asset.rightsBasis,
        model: asset.model,
        use: "StepFun 无文字候选经视觉评分择优后进入本地时间线",
      })),
      localGeneratedMedia: visualAssets.filter((asset) => asset.sourceType !== "stepfun_ai_generated").map((asset) => ({
        ref: asset.sourceRef,
        sourceChecksum: asset.sourceChecksum,
        normalizedChecksum: asset.checksum,
        bytes: asset.bytes,
        rightsBasis: asset.rightsBasis,
        use: "本地受控混剪画面 fixture",
      })),
      narration: topic.voiceover
        ? {
            provider: "StepFun",
            model: topic.voiceover.model,
            voice: topic.voiceover.voice,
            checksum: topic.voiceover.checksum,
            productionEligible: true,
          }
        : { provider: "macOS system voice", voice: "Tingting", productionEligible: false },
      externalPublished: false,
    });

    const videoChecks = {};
    for (const platform of ["master", "douyin", "xiaohongshu"]) {
      videoChecks[platform] = await inspectVideo(path.join(directory, `${platform}.mp4`));
    }
    const subtitleChecks = Object.fromEntries(
      Object.entries(platformSpecs).map(([platform, props]) => [
        platform,
        inspectSubtitleLayout(props.captions),
      ]),
    );
    const visualChecks = inspectVisualBindings(platformSpecs, visualAssets);
    const coverCheck = await inspectCover(path.join(directory, "cover.png"));
    const reviewFailures = [
      ...Object.entries(videoChecks).flatMap(([platform, check]) => check.passed ? [] : [`${platform}:media_gate_failed`]),
      ...Object.entries(subtitleChecks).flatMap(([platform, check]) => check.passed ? [] : [`${platform}:subtitle_gate_failed`]),
      ...(visualChecks.passed ? [] : visualChecks.errors),
      ...(coverCheck.passed ? [] : ["cover_gate_failed"]),
    ];
    const review = {
      schemaVersion: 1,
      passed:reviewFailures.length === 0,
      scope: "local_dry_run_only",
      externalPublishAllowed: false,
      failures: reviewFailures,
      checks: {
        ...videoChecks,
        visualAssets: visualChecks,
        cover: coverCheck,
        subtitleLayout: {
          passed: Object.values(subtitleChecks).every((item) => item.passed),
          platforms: subtitleChecks,
        },
      },
      limitations: [
        ...(topic.voiceover
          ? []
          : ["旁白使用 macOS 系统音色，仅验证本地渲染链；不等于、也不替代 StepFun TTS 真实付费调用。"]),
        ...(visualAssets.some((asset) => asset.sourceType === "stepfun_ai_generated")
          ? ["StepFun 补充画面已经过机器视觉门禁；最终事实、版权、隐私和平台规范仍需活动级审核。"]
          : ["画面使用仓库自有设计预览图作为受控本机 fixture；证明真实素材进入时间线，不代表生产选题素材已经完成。"]),
      ],
    };
    await writeJson(path.join(directory, "review.json"), review);
    const lineage = {
      schemaVersion: 1,
      contentVersionId: `m5-local-${topic.id}-v1`,
      sourceTaskId: "m5-local-dry-run",
      generatedBy: "apps/animated-chart/scripts/render-m5-local-dryrun.mjs",
      createdAt: new Date().toISOString(),
      parents: [],
      topicId: topic.id,
    };
    await writeJson(path.join(directory, "lineage.json"), lineage);

    const files = {};
    for (const name of requiredArtifacts) {
      const bytes = await fs.readFile(path.join(directory, name));
      files[name] = {
        path: name,
        checksum: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
        bytes: bytes.length,
      };
    }
    const manifestPath = path.join(directory, "artifact-manifest.json");
    await writeJson(manifestPath, {
      schemaVersion: 1,
      files,
      lineage,
    });
    const manifestValidation = await validateArtifactManifest(directory, manifestPath);
    if (!manifestValidation.passed) {
      throw new Error(`artifact_manifest_invalid:${manifestValidation.errors.join(",")}`);
    }
    if (!review.passed) {
      throw new Error(`local_dry_run_review_failed:${review.failures.join(",")}`);
    }

    return {
      topicId: topic.id,
      directory: path.relative(repositoryRoot, directory),
      reviewPassed: review.passed,
      videos: videoChecks,
      visualAssetsPassed: review.checks.visualAssets.passed,
      artifactManifest: manifestValidation,
      voiceProvider: topic.voiceover ? "StepFun official TTS" : "macOS system voice",
      productionTtsVerified: Boolean(topic.voiceover),
    };
  } finally {
    await fs.rm(publicAudioPath, { force: true });
    await fs.rm(temporaryAiff, { force: true });
  }
}

function buildProps(topic, platform, audioName, visualAssets) {
  const platformHeadline =
    platform === "douyin"
      ? "先说结论："
      : platform === "xiaohongshu"
        ? "可收藏要点："
        : "";
  const sceneFrames = [
    [0, 210],
    [210, 390],
    [600, 390],
    [990, 360],
  ];
  const scenes = topic.scenes.map(([headline, body, evidenceRef], index) => ({
    id: `${topic.id}-${platform}-${index + 1}`,
    startFrame: sceneFrames[index][0],
    durationInFrames: sceneFrames[index][1],
    headline: index === 0 ? `${platformHeadline}${headline}` : headline,
    body:
      platform === "xiaohongshu"
        ? `${body} 记录：第 ${index + 1} 项。`
        : platform === "douyin"
          ? body.replace(/；/g, "，")
          : body,
    imageSrc: visualAssets[index % visualAssets.length].publicName,
    evidenceRef,
  }));
  return {
    platform,
    title: topic.title,
    subtitle:
      platform === "xiaohongshu"
        ? `${topic.subtitle} · 收藏版`
        : platform === "douyin"
          ? `${topic.subtitle} · 快节奏版`
          : topic.subtitle,
    voiceoverSrc: audioName,
    coverSrc: visualAssets[0].publicName,
    assetLedger: visualAssets.map((asset) => ({
      relativePath: asset.publicName,
      checksum: asset.checksum,
    })),
    scenes,
    captions: scenes.map((scene) => ({
      startFrame: scene.startFrame,
      endFrame: scene.startFrame + scene.durationInFrames,
      text: safeCaptionText(scene.body),
    })),
    sourceLabel: topic.voiceover ? "Agent军团 · M5 StepFun 本地成片" : "Agent军团 · M5 本地干跑",
  };
}

function safeCaptionText(value) {
  const characters = [...String(value || "").replace(/\s+/g, " ").trim()];
  const lines = [""];
  let totalUnits = 0;
  let lineUnits = 0;
  for (const character of characters) {
    const units = character.codePointAt(0) <= 0xff ? 0.55 : 1;
    if (totalUnits + units > 66) break;
    if (lineUnits + units > 24) {
      if (lines.length === 3) break;
      lines.push("");
      lineUnits = 0;
    }
    lines[lines.length - 1] += character;
    totalUnits += units;
    lineUnits += units;
  }
  return lines.join("\n");
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--") || process.argv.indexOf(name, index + 1) >= 0) {
    throw new Error(`${name} 参数无效`);
  }
  return value;
}

async function prepareRenderPublicRoot(workspaceRoot, batchVersion) {
  const canonicalWorkspace = await fs.realpath(workspaceRoot);
  const stagingParent = path.join(
    canonicalWorkspace,
    "render-public-staging",
    batchVersion,
  );
  await ensureDirectoryTreeWithoutSymlinks(canonicalWorkspace, stagingParent);

  for (const name of await fs.readdir(stagingParent)) {
    const match = /^run-(\d+)-[0-9a-f-]{36}$/.exec(name);
    if (!match || processIsAlive(Number(match[1]))) continue;
    const stalePath = path.join(stagingParent, name);
    const stat = await fs.lstat(stalePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`render_public_stale_entry_invalid:${name}`);
    }
    await fs.rm(stalePath, { recursive: true });
  }

  const runRoot = path.join(
    stagingParent,
    `run-${process.pid}-${crypto.randomUUID()}`,
  );
  await fs.mkdir(runRoot, { mode: 0o700 });
  return runRoot;
}

async function cleanupRenderPublicRoot(runRoot) {
  const stat = await fs.lstat(runRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("render_public_root_invalid");
  }
  await fs.rm(runRoot, { recursive: true });
}

async function ensureDirectoryTreeWithoutSymlinks(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("render_public_path_escape");
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`render_public_path_invalid:${current}`);
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function buildStepfunTopics(batch) {
  return SEVEN_THEMES.map((source) => {
    const ledgerTheme = batch.ledger.themes.find((item) => item.id === source.id);
    const assets = batch.assetsByTheme.get(source.id);
    if (!ledgerTheme || !assets || !stepfunSceneCopy[source.id]) {
      throw new Error(`stepfun_batch_theme_incomplete:${source.id}`);
    }
    if (ledgerTheme.narrationChecksum !== hashBytes(Buffer.from(source.narration))) {
      throw new Error(`stepfun_batch_narration_drift:${source.id}`);
    }
    return {
      id:source.id,
      title:source.title,
      subtitle:"真实工具、真实门禁、真实恢复",
      narration:source.narration,
      scenes:stepfunSceneCopy[source.id],
      voiceover:assets.voiceover,
    };
  });
}

function validateSuccessfulStepfunLedger(ledger) {
  const logicalActionCount = 35;
  const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  if (
    ledger?.schemaVersion !== "agent.army/stepfun-seven-theme-batch/v1"
    || !/^[A-Za-z0-9_-]{2,24}$/.test(String(ledger.batchVersion || ""))
    || ledger.provider !== "stepfun"
    || typeof ledger.officialVoice !== "string"
    || !ledger.officialVoice.trim()
    || ledger.themeCount !== 7
    || !Array.isArray(ledger.themes)
    || ledger.themes.length !== 7
    || !nonNegativeInteger(ledger.totalProviderCalls)
    || !nonNegativeInteger(ledger.expectedNewProviderCalls)
    || !nonNegativeInteger(ledger.confirmedReplay)
    || !nonNegativeInteger(ledger.pendingCostRecovery)
    || !nonNegativeInteger(ledger.lifetimeProviderCalls)
    || ledger.expectedNewProviderCalls !== ledger.totalProviderCalls
    || ledger.totalProviderCalls
      + ledger.confirmedReplay
      + ledger.pendingCostRecovery !== logicalActionCount
    || ledger.lifetimeProviderCalls < ledger.totalProviderCalls
    || ledger.replay?.providerCalls !== 0
    || !Array.isArray(ledger.replay?.actions)
    || ledger.replay.actions.length !== logicalActionCount
    || ledger.execution?.maxProviderConcurrency !== 4
    || !Number.isInteger(ledger.execution?.peakProviderConcurrency)
    || ledger.execution.peakProviderConcurrency < 1
    || ledger.execution.peakProviderConcurrency > 4
  ) {
    throw new Error("stepfun_batch_ledger_invalid");
  }

  const embeddedActions = [];
  for (const theme of ledger.themes) {
    if (!Array.isArray(theme?.candidates) || theme.candidates.length !== 2 || !theme.narration) {
      throw new Error(`stepfun_batch_actions_incomplete:${theme?.id || "unknown"}`);
    }
    embeddedActions.push(
      [theme.narration, "tts"],
      ...theme.candidates.flatMap((candidate) => [
        [candidate, "image_generate"],
        [candidate.vision, "vision"],
      ]),
    );
  }
  if (embeddedActions.length !== logicalActionCount) {
    throw new Error("stepfun_batch_action_count_invalid");
  }
  const embeddedById = new Map();
  let confirmedReplay = 0;
  let pendingCostRecovery = 0;
  for (const [action, operation] of embeddedActions) {
    const actionId = String(action?.actionId || "");
    if (
      !/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)
      || action?.operation !== operation
      || typeof action.replayed !== "boolean"
      || typeof action.providerCallReplayed !== "boolean"
      || (action.replayed && action.providerCallReplayed)
      || embeddedById.has(actionId)
    ) {
      throw new Error("stepfun_batch_embedded_action_invalid");
    }
    embeddedById.set(actionId, operation);
    if (action.replayed) confirmedReplay += 1;
    if (action.providerCallReplayed) pendingCostRecovery += 1;
  }
  if (confirmedReplay !== ledger.confirmedReplay) {
    throw new Error("stepfun_batch_confirmed_replay_mismatch");
  }
  if (pendingCostRecovery !== ledger.pendingCostRecovery) {
    throw new Error("stepfun_batch_pending_cost_recovery_mismatch");
  }

  const replayIds = new Set();
  for (const action of ledger.replay.actions) {
    const actionId = String(action?.actionId || "");
    if (
      action?.replayed !== true
      || embeddedById.get(actionId) !== action?.operation
      || replayIds.has(actionId)
    ) {
      throw new Error("stepfun_batch_replay_action_invalid");
    }
    replayIds.add(actionId);
  }
  if (replayIds.size !== embeddedById.size) {
    throw new Error("stepfun_batch_replay_action_set_invalid");
  }
  return { logicalActionCount };
}

async function loadStepfunBatch(
  ledgerPath,
  { stageAssets = true, publicDirectory = null } = {},
) {
  const stat = await fs.lstat(ledgerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("stepfun_batch_ledger_not_regular_file");
  const bytes = await fs.readFile(ledgerPath);
  const ledger = JSON.parse(bytes.toString("utf8"));
  const { logicalActionCount } = validateSuccessfulStepfunLedger(ledger);
  const expectedIds = new Set(SEVEN_THEMES.map((item) => item.id));
  if (
    ledger.themes.some((item) => !expectedIds.has(item?.id))
    || new Set(ledger.themes.map((item) => item.id)).size !== expectedIds.size
  ) {
    throw new Error("stepfun_batch_theme_set_invalid");
  }
  const ledgerRealPath = await fs.realpath(ledgerPath);
  const workspaceRoot = await fs.realpath(path.resolve(path.dirname(ledgerPath), "../../.."));
  const expectedLedgerPath = path.join(
    workspaceRoot,
    "provider",
    "7-theme",
    ledger.batchVersion,
    "ledger.json",
  );
  if (ledgerRealPath !== expectedLedgerPath) {
    throw new Error("stepfun_batch_ledger_path_invalid");
  }
  if (stageAssets && !publicDirectory) {
    throw new Error("stepfun_batch_public_directory_required");
  }
  const assetsByTheme = new Map();
  const stagedPaths = [];
  try {
    for (const [index, item] of ledger.themes.entries()) {
      const selectedCandidate = item.candidates?.find(
        (candidate) => candidate.index === item.selectedCandidate,
      );
      if (
        selectedCandidate?.quality?.textFree !== true
        || selectedCandidate?.quality?.brandSafe !== true
        || selectedCandidate.outputPath !== item.selectedPath
        || selectedCandidate.outputChecksum !== item.selectedChecksum
      ) {
        throw new Error(`stepfun_batch_selected_candidate_invalid:${item.id}`);
      }
      const selected = await secureBatchFile(workspaceRoot, item.selectedPath, item.selectedChecksum);
      const narration = await secureBatchFile(
        workspaceRoot,
        item.narration?.outputPath,
        item.narration?.outputChecksum,
      );
      if (!stageAssets) {
        assetsByTheme.set(item.id, {
          visual:{
            sourceRef:item.selectedPath,
            sourceChecksum:item.selectedChecksum,
            checksum:item.selectedChecksum,
            bytes:selected.bytes,
            rightsBasis:"StepFun 生成、无文字与品牌安全机器门禁通过，仅用于本地成片。",
            sourceType:"stepfun_ai_generated",
            model:selectedCandidate.model || "step-image-edit-2",
          },
          voiceover:{
            sourcePath:narration.realPath,
            checksum:item.narration.outputChecksum,
            model:item.narration.model,
            voice:ledger.officialVoice,
          },
        });
        continue;
      }
      const publicName = `m5-stepfun-${process.pid}-${index + 1}.png`;
      const publicPath = path.join(publicDirectory, publicName);
      stagedPaths.push(publicPath);
      await exec(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          selected.realPath,
          "-vf",
          "scale=1000:1180:force_original_aspect_ratio=decrease,pad=1080:1280:(ow-iw)/2:(oh-ih)/2:color=0x101936",
          "-frames:v",
          "1",
          "-c:v",
          "png",
          publicPath,
        ],
        { timeout:60_000, maxBuffer:2_000_000 },
      );
      const normalized = await fs.readFile(publicPath);
      if (!normalized.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )) {
        throw new Error(`stepfun_batch_image_not_png:${item.id}`);
      }
      assetsByTheme.set(item.id, {
        visual:{
          sourceRef:item.selectedPath,
          sourceChecksum:item.selectedChecksum,
          publicName,
          publicPath,
          checksum:hashBytes(normalized),
          bytes:normalized.length,
          rightsBasis:"StepFun 生成、无文字与品牌安全机器门禁通过，仅用于本地成片。",
          sourceType:"stepfun_ai_generated",
          model:selectedCandidate.model || "step-image-edit-2",
        },
        voiceover:{
          sourcePath:narration.realPath,
          checksum:item.narration.outputChecksum,
          model:item.narration.model,
          voice:ledger.officialVoice,
        },
      });
    }
  } catch (error) {
    await Promise.all(stagedPaths.map((file) => fs.rm(file, { force:true })));
    throw error;
  }
  return {
    ledger,
    ledgerPath:ledgerRealPath,
    ledgerChecksum:hashBytes(bytes),
    workspaceRoot,
    workspaceRelativeLedgerPath:path.relative(workspaceRoot, ledgerRealPath),
    assetsByTheme,
    logicalActionCount,
  };
}

async function secureBatchFile(workspaceRoot, relativePath, expectedChecksum) {
  if (
    typeof relativePath !== "string"
    || path.isAbsolute(relativePath)
    || relativePath.includes(nullCharacter)
    || !/^sha256:[a-f0-9]{64}$/.test(String(expectedChecksum || ""))
  ) {
    throw new Error("stepfun_batch_asset_reference_invalid");
  }
  const candidate = path.resolve(workspaceRoot, relativePath);
  if (!candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("stepfun_batch_asset_path_escape");
  }
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("stepfun_batch_asset_not_regular_file");
  const realPath = await fs.realpath(candidate);
  if (!realPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("stepfun_batch_asset_symlink_escape");
  }
  const bytes = await fs.readFile(realPath);
  if (hashBytes(bytes) !== expectedChecksum) throw new Error("stepfun_batch_asset_checksum_mismatch");
  return { realPath, bytes:bytes.length };
}

async function stageVisualFixtures() {
  const assets = [];
  const stagedPaths = [];
  try {
    for (const [index, sourceRef] of visualFixtureSources.entries()) {
      const sourcePath = path.resolve(repositoryRoot, sourceRef);
      const sourceBytes = await fs.readFile(sourcePath);
      if (!sourceBytes.length) throw new Error(`visual_fixture_empty:${sourceRef}`);
      const publicName = `m5-local-visual-${process.pid}-${index + 1}.png`;
      const publicPath = path.join(publicRoot, publicName);
      stagedPaths.push(publicPath);
      await exec(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          sourcePath,
          "-vf",
          "scale=1000:1180:force_original_aspect_ratio=decrease,pad=1080:1280:(ow-iw)/2:(oh-ih)/2:color=0x101936",
          "-frames:v",
          "1",
          "-c:v",
          "png",
          publicPath,
        ],
        { timeout: 60_000, maxBuffer: 2_000_000 },
      );
      const normalizedBytes = await fs.readFile(publicPath);
      if (!normalizedBytes.length || !normalizedBytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )) {
        throw new Error(`visual_fixture_not_png:${sourceRef}`);
      }
      assets.push({
        sourceRef,
        sourceChecksum: hashBytes(sourceBytes),
        publicName,
        publicPath,
        checksum: hashBytes(normalizedBytes),
        bytes: normalizedBytes.length,
        rightsBasis: "本仓库自有设计预览图，仅用于无外发、无付费的本地受控干跑。",
        sourceType: "repository_owned_fixture",
      });
    }
    return assets;
  } catch (error) {
    await Promise.all(stagedPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }
}

function inspectVisualBindings(platformSpecs, visualAssets) {
  const ledger = new Map(visualAssets.map((asset) => [asset.publicName, asset.checksum]));
  const errors = [];
  for (const [platform, props] of Object.entries(platformSpecs)) {
    const declared = new Map(
      (Array.isArray(props.assetLedger) ? props.assetLedger : [])
        .map((asset) => [asset.relativePath, asset.checksum]),
    );
    if (!ledger.has(props.coverSrc) || declared.get(props.coverSrc) !== ledger.get(props.coverSrc)) {
      errors.push(`${platform}:cover_not_bound`);
    }
    for (const [index, scene] of props.scenes.entries()) {
      if (!ledger.has(scene.imageSrc) || declared.get(scene.imageSrc) !== ledger.get(scene.imageSrc)) {
        errors.push(`${platform}:scene_${index + 1}_not_bound`);
      }
    }
    if (declared.size !== visualAssets.length) errors.push(`${platform}:asset_ledger_incomplete`);
  }
  return {
    passed: errors.length === 0,
    errors,
    checkedPlatforms: Object.keys(platformSpecs).length,
    checkedAssets: visualAssets.length,
    rightsBasis: [...new Set(visualAssets.map((asset) => asset.sourceType))],
  };
}

async function finalize(inputPath, outputPath) {
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-vf",
      "scale=1080:1920,setsar=1",
      "-af",
      "loudnorm=I=-15:LRA=7:TP=-1.5",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-t",
      String(durationSeconds),
      outputPath,
    ],
    { timeout: 10 * 60_000, maxBuffer: 2_000_000 },
  );
}

async function inspectVideo(filePath) {
  const { stdout } = await exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height",
      "-of",
      "json",
      filePath,
    ],
    { timeout: 30_000 },
  );
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format.duration || 0);
  const { stderr: analysisLog } = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-vf",
      "blackdetect=d=0.5:pic_th=0.98",
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    { timeout: 120_000, maxBuffer: 4_000_000 },
  );
  const blackSegments = [...analysisLog.matchAll(
    /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g,
  )].map((match) => ({
    start:Number(match[1]),
    end:Number(match[2]),
    duration:Number(match[3]),
  }));
  const integratedMatches = [...analysisLog.matchAll(/\bI:\s*(-?[\d.]+)\s+LUFS/g)];
  const peakMatches = [...analysisLog.matchAll(/\bPeak:\s*(-?[\d.]+)\s+dBFS/g)];
  const integratedLufs = Number(integratedMatches.at(-1)?.[1]);
  const truePeakDbfs = Number(peakMatches.at(-1)?.[1]);
  const formatPassed =
    video?.codec_name === "h264" &&
    video?.width === 1080 &&
    video?.height === 1920 &&
    audio?.codec_name === "aac" &&
    duration >= 44.5 &&
    duration <= 45.5;
  const blackFramePassed = blackSegments.length === 0;
  const loudnessPassed =
    Number.isFinite(integratedLufs) &&
    integratedLufs >= -17 &&
    integratedLufs <= -13 &&
    Number.isFinite(truePeakDbfs) &&
    truePeakDbfs <= -1;
  return {
    passed: formatPassed && blackFramePassed && loudnessPassed,
    formatPassed,
    blackFramePassed,
    loudnessPassed,
    durationSeconds: duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    blackSegments,
    integratedLufs:Number.isFinite(integratedLufs) ? integratedLufs : null,
    truePeakDbfs:Number.isFinite(truePeakDbfs) ? truePeakDbfs : null,
  };
}

async function inspectCover(filePath) {
  const bytes = await fs.readFile(filePath);
  const pngSignature = bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const { stdout } = await exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "json",
      filePath,
    ],
    { timeout: 30_000 },
  );
  const stream = JSON.parse(stdout).streams?.[0];
  return {
    passed:pngSignature && stream?.codec_name === "png" && stream?.width === 1080 && stream?.height === 1920,
    codec:stream?.codec_name || null,
    width:stream?.width || null,
    height:stream?.height || null,
    checksum:hashBytes(bytes),
    bytes:bytes.length,
  };
}

async function validateArtifactManifest(directory, manifestPath) {
  const errors = [];
  const manifestBytes = await fs.readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    return { passed:false, errors:["manifest_invalid_json"] };
  }
  const names = Object.keys(manifest?.files || {});
  if (
    names.length !== requiredArtifacts.length
    || new Set(names).size !== requiredArtifacts.length
    || requiredArtifacts.some((name) => !names.includes(name))
  ) {
    errors.push("fixed_artifact_set_mismatch");
  }
  for (const name of requiredArtifacts) {
    const entry = manifest?.files?.[name];
    if (entry?.path !== name || !/^sha256:[0-9a-f]{64}$/i.test(String(entry?.checksum || ""))) {
      errors.push(`${name}:invalid_entry`);
      continue;
    }
    const filePath = path.resolve(directory, entry.path);
    if (path.dirname(filePath) !== path.resolve(directory)) {
      errors.push(`${name}:path_escape`);
      continue;
    }
    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes?.length) {
      errors.push(`${name}:missing_or_empty`);
      continue;
    }
    if (hashBytes(bytes) !== entry.checksum || bytes.length !== entry.bytes) {
      errors.push(`${name}:checksum_or_size_mismatch`);
    }
  }
  const lineageBytes = await fs.readFile(path.join(directory, "lineage.json")).catch(() => null);
  if (!lineageBytes) {
    errors.push("lineage_missing");
  } else {
    const lineage = JSON.parse(lineageBytes);
    if (
      lineage.contentVersionId !== manifest?.lineage?.contentVersionId
      || lineage.sourceTaskId !== manifest?.lineage?.sourceTaskId
      || lineage.generatedBy !== manifest?.lineage?.generatedBy
      || lineage.createdAt !== manifest?.lineage?.createdAt
    ) {
      errors.push("lineage_mismatch");
    }
  }
  return {
    passed:errors.length === 0,
    errors,
    requiredArtifacts:[...requiredArtifacts],
    manifestPath:path.basename(manifestPath),
    manifestChecksum:hashBytes(manifestBytes),
  };
}

function inspectSubtitleLayout(captions) {
  const errors = [];
  let previousEnd = 0;
  for (const [index, caption] of captions.entries()) {
    const lines = String(caption.text || "").split("\n");
    if (caption.startFrame < previousEnd) errors.push(`caption-${index + 1}:overlap`);
    previousEnd = caption.endFrame;
    if (caption.endFrame > durationSeconds * fps) errors.push(`caption-${index + 1}:outside-duration`);
    if (lines.length > 3) errors.push(`caption-${index + 1}:too-many-lines`);
    if (lines.some((line) => displayUnits(line) > 28)) errors.push(`caption-${index + 1}:unsafe-width`);
    if (displayUnits(lines.join("")) > 72) errors.push(`caption-${index + 1}:unsafe-height`);
  }
  return { passed: errors.length === 0, errors };
}

function displayUnits(value) {
  return [...String(value || "")].reduce(
    (sum, character) => sum + (character.codePointAt(0) <= 0xff ? 0.55 : 1),
    0,
  );
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashBytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
