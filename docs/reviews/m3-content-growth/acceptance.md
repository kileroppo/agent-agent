# M3 内容增长与知识归档验收账本

| 字段 | 内容 |
| --- | --- |
| 状态 | 已验收 |
| 关联 PRD | [M3 内容分析与知识归档](../../../tasks/prd-m3-content-analysis-and-knowledge-archive.md) |
| 最后更新 | 2026-07-30 |

## 验收总览

| 层级 | 当前结论 | 已有证据 | 尚未证明 |
| --- | --- | --- | --- |
| 自动化 | PASS | 2026-07-30 复验 A君运行时 541/541、Manifest/Hermes 聚焦检查 21/21；小D和内容获取中心既有 M3 检查均通过 | 不替代外部平台和人工验收 |
| 本机运行 | PASS | 正式 13 模块拆解、真实视频 48 帧图文联合分析、基于真实报告的抖音待审草稿、真实统一知识库写入和重复幂等回读均通过；人工与飞书证据由 M3-REAL-009 补齐 | 无 M3 关闭阻塞 |
| Hermes / Paperclip | PASS | 两个岗位完成审核、受限试用、显式模型绑定和真实 heartbeat；图文任务 `AGE-506` 通过语义门禁，小创 `AGE-510` 基于该报告生成真实待审草稿 | 无 M3 关闭阻塞 |
| 飞书 | PASS | 真实 URL、听审提醒、人工确认及 13 模块正式报告均经 A君原会话完成；负责人确认 2026-07-29 已完成最终脚本自然语言闭环 | 无 M3 关闭阻塞 |
| 人工验收 | PASS | 负责人已完成真人听审、新版图文报告与草稿质量判断，并确认最终脚本闭环结果 | 无 |

## 自动化证据

### M3-AUTO-001：小D证据链

- 命令：`cd apps/xiaod-media-transcriber && npm test`
- 结果：40/40 通过。
- 覆盖：时间点解析、来源证据、音频覆盖/尾部硬门禁、默认自动质量确认、异常转人工、显式完整听审确认、版本和幂等。

### M3-AUTO-002：A君内容增长与知识归档

- 命令：`cd apps/ajun-runtime && npm test`
- 结果：469/469 通过。
- 覆盖：小拆/小创受控执行、只有 URL 时自动展开小D前置任务、正式与初步证据模式、13 模块、三平台限制、5/12 分钟总预算、最多两次尝试、长任务后台持有与 240 秒分段续查、证据结构局部修复、超预算兜底、归档路径/幂等/脱敏、MCP 工具和既有飞书/治理回归。

### M3-AUTO-004：单链接自动编排与原会话跟进

- 命令：`cd apps/ajun-runtime && npm test`
- 结果：PASS。
- 覆盖：只有 URL 的正式拆解自动展开为“小D内容获取中心/自动质量确认 → 小拆”；用户明确要求时仍保留完整听审门禁；任务参数跨总任务保留；Paperclip 子卡真实指派给小拆；Hermes 原生任务只为原飞书会话登记跟进；异常进入听审时只提醒一次；跟进文件权限固定为 `0600`。

### M3-AUTO-005：B站原生字幕优先与 ASR 兜底

- 命令：`node --test integrations/access/test/common-access.test.js`
- 结果：19/19 通过。
- 覆盖：仅 B站 BV 链接进入原生字幕通道；YouTube、抖音、小红书等非 B站来源不调用该适配器；并覆盖原生字幕优先、受控 CookieBridge、字幕地址白名单、VTT 时间点、片头推广伪字幕拒绝、缺少字幕或授权时继续走音轨通道。Cookie 不进入内容包和测试夹具。
- 本机运行核对：A君 `127.0.0.1:4321` 已加载登记入口；伪造任务登记返回 422；Hermes 飞书目录可解析到 1 个已配置目标。未发送测试消息，因此这些证据不替代真实飞书交付。

### M3-AUTO-006：默认自动确认与人工保留

- 小D默认 `reviewPolicy=optional`：完整性硬门禁通过、转录无异常时生成 `automatic_transcript_attestation` 和 `confirmed_transcript`。
- 自动确认稿明确记录 `confirmationMode=automatic`、`completeListen=false`，不会冒充人工听审。
- 转录异常时转入 `waiting_approval`；用户明确要求时可使用 `reviewPolicy=required` 保留人工完整听审。
- 自动或人工确认都不能绕过音频覆盖、尾部缺失等硬失败。
- 证据：小D 40/40、A君 469/469、Manifest 9/9 全部通过。

### M3-AUTO-007：图文联合分析、视觉路由与本机交付边界

- 命令：`cd apps/xiaod-media-transcriber && npm test`、`cd integrations/access && npm test`、`cd apps/ajun-runtime && npm test`、`node --test agents/test/agent-manifest.test.mjs`。
- 结果：40 + 19 + 469 + 9，共 537 项通过。
- 覆盖：`visualMode` 默认与透传、B站/非B站/本地上传路由、转录音轨与视觉视频分流、词级时间轴、真实来源元数据、12/48 帧上限、场景/字幕/均匀补帧、重复帧过滤、故事板、校验值、跨句引用忽略中间时间戳但仍核验来源时间点、关键帧引用门禁、`complete|partial|needs_input` 降级，以及非飞书来源 `local_only` 不创建飞书文档。
- 权限：小拆 Manifest/Profile 没有增加下载器、Cookie、任意文件或独立飞书 Gateway 权限。

### M3-AUTO-003：岗位契约

- 命令：`node --test agents/test/agent-manifest.test.mjs`
- 结果：9/9 通过。
- 覆盖：Manifest/Profile 引用、最小权限、秘密字段检查，以及两个新岗位的后台按需上岗边界。

## 真实闭环记录

### M3-REAL-001：本机纵向产物

- 状态：PASS。
- 命令：`cd apps/ajun-runtime && npm run acceptance:m3-content-growth -- --write-real-vault`
- 输入：明确标记为“本机合成验收、非真实视频听审”的安全确认稿，以及抖音/小红书两个平台目标。
- 结果：13 模块正式拆解、两个平台草稿和统一知识库笔记均成功；草稿 `externalSideEffects=0`。
- 拆解 SHA-256：`f6a08b78bc1d3f83d81dc84a5bf8d17e5f37d31e59c4028fe295e8d1835d48d6`
- 草稿 SHA-256：`71ce3e3fa1917f5df22803fb33bda75075f563662e82ec642ad50113c697e536`
- 说明：该证据只证明本机受控纵向链路，不证明真实视频听审、Hermes/Paperclip、飞书或内容质量。

### M3-REAL-001A：岗位治理与受限技术验收

- 状态：PASS。
- 小拆：Proposal `f56e796d-78a3-4a10-a7d8-620ecfbb46e3`，Paperclip `AGE-429` 已批准；测试实例 `86ec0173-915a-4858-9bd9-436bb1ed281d` 为 `passed`；受限报告 SHA-256 为 `e1640939595d6d0ee16a409247d2f1c7c0f654b6e1533b08b93f0ecb951397e9`。
- 小创：Proposal `8cd78557-c169-49e1-aace-b4978664d01e`，Paperclip `AGE-426` 已批准；测试实例 `d6d4399e-6fc0-483f-94d0-27f9f426ef23` 为 `passed`；受限草稿 SHA-256 为 `b2580a00a42ec9c28686810330e4f9f1a738d1255cfc00b380c9293073cc0848`。
- 两次试用均使用明确标注 `restricted-technical-acceptance-only`、`realVideoReview=false` 的本机安全稿，且 `allowAdvisor=false`，未调用付费模型、未登录平台、未外发或发布。
- 小拆的受控内部技能 `agent-army-video-content` 已导入公司技能库并通过 Paperclip 审计：Skill ID `741c8f25-dbb7-4b18-845f-651b69c1c933`，审计哈希 `sha256:78a669659243e504b2c31d5f7a8d25b8ec4734d310be3b308bd30aa52a4e201f`。
- 说明：该证据证明岗位治理与无外部副作用的受限技术执行链；后续 M3-REAL-001B 和 001C 分别补齐真实模型与 Paperclip heartbeat。两个岗位现为 `active`，但仅通过 A君路由且没有独立飞书 Gateway。

### M3-REAL-001B：Hermes 双岗位真实模型执行

- 状态：PASS。
- 命令：`cd apps/ajun-runtime && npm run acceptance:m3-hermes-content-growth`
- 模型：两个隔离 Profile 均使用 `openai-codex / gpt-5.6-terra`，各调用 1 次。
- 小拆：输入 16065 Token、输出 5049 Token；13 模块全部通过模块名、逐项来源片段、标点容错和逐句覆盖校验；产物 SHA-256 为 `c98377274f051bbd68095adc2a38ac86c07903aa6c44182b9894a5cb7cc5fbbb`。
- 小创：输入 20599 Token、输出 1889 Token；抖音和小红书两个待审版本通过结构校验，`externalSideEffects=0`；产物 SHA-256 为 `7c1d89c1e5b24517a49011a3162309bf55b97026a7aaacf3a3a25ff204d7535d`。
- 两次调用的 Hermes 用量文件均被读取后从临时目录清理；执行器报告费用均为 0 USD。产物已固化到权限 `0600` 的 `apps/ajun-runtime/data/m3-acceptance-evidence/hermes-20260727-1844/`。
- 独立证据单：[Hermes 内容岗位运行证据](./hermes-runtime-evidence-2026-07-27.md)。
- 说明：该证据证明真实 Hermes 模型通道和 A君内容执行器，不证明真实视频听审、飞书交付或人工质量。

### M3-REAL-001C：Paperclip 双岗位真实 heartbeat

- 状态：PASS。
- 命令：`cd apps/ajun-runtime && npm run acceptance:m3-paperclip-heartbeat`
- 输入：明确标记 `realVideoReview=false` 的受控合成确认稿；未抓取、未登录、未外发、未发布。
- 小拆：A君任务 `7e85c700-b1d2-487d-9cbd-bd442554cb79`，Paperclip `AGE-433`；真实调用 `openai-codex / gpt-5.6-terra` 1 次，输入 16001 Token、输出 4252 Token；产物 SHA-256 为 `842fbb46b47fe4156a5990300e997bf3767bb5c192dc5f985b359d0da560f169`。
- 小创：A君任务 `20ceca32-62a5-49d1-8eda-7af4385f20e6`，Paperclip `AGE-434`；真实调用同一模型 1 次，输入 19726 Token、输出 1692 Token；`externalSideEffects=0`，产物 SHA-256 为 `b3638d43b939b733fd3437117874a301fd56c272697883ba604246b4c5d78b2c`。
- 受控证据目录：`apps/ajun-runtime/data/m3-acceptance-evidence/paperclip-20260727110024/`。
- 运行修复记录：首次任务 `AGE-431` 因 Paperclip 将缺省模型强制解析为 `auto` 而失败；现已在 Manifest 和适配器配置中显式绑定 `openai-codex / gpt-5.6-terra`，并以 `AGE-433`、`AGE-434` 重新验证。失败任务保留，不改写为成功。
- 独立证据单：[Paperclip heartbeat 运行证据](./paperclip-heartbeat-evidence-2026-07-27.md)。
- 说明：该证据证明 Paperclip 能以两个岗位的真实身份唤醒 Hermes、调用受控工具并回写任务；不证明真实视频完整听审、飞书原会话交付或人工内容质量。

### M3-REAL-002：飞书公开视频正式拆解

- 状态：运行闭环 PASS；正式拆解质量待负责人验收。
- 真实输入：负责人在 A君原飞书会话提交 B站公开视频并要求“正式完整拆解”。
- 首次失败证据：任务 `d215c09a-455d-47ec-acf0-93173f7caec9` / `AGE-436` 由陈旧 MCP 进程错误直派小拆，在没有确认稿时如实失败；后续恢复又暴露 manager 候选被注册表包装层过滤的问题。两次失败记录均保留，未改写为成功。
- 修复：重新加载 Hermes Gateway；自然语言“完整拆解”强制归一为 `full`、正式模式强制 `reviewPolicy=required`；恢复 manager 候选；B站深度适配器优先使用 `extria_info.audio_url`，不再把无声视频分片当作可转录媒体；听审提醒包含真实飞书文档链接和明确回复语句。
- 真实任务：总任务 `4c510f5f-3a72-4749-9455-db2929df2c07` / `AGE-443`，小D 子任务 `e8536104-172a-4098-92a1-5a352c190388` / `AGE-444`，小D Job `026b21dc-7392-4a85-bb54-4e440e7bd8a6`。
- 已通过证据：真实音轨获取、ASR、内容整理、飞书文档创建、权限检查、负责人完整听审和确认稿均已完成。确认稿仍无时间点，证据等级按 `untimed_machine_transcript` 降级，不伪造时间点。
- 首次小拆任务 `fd0f0a6b-921a-4f44-b96c-fb083ef15c0c` / `AGE-445` 虽被旧逻辑登记为成功，但产物实际标记 `generationMode=deterministic_fallback`、`advisorApplied=false`；原总任务只回传了“2/2”，没有交付业务报告。该状态不能作为正式深度拆解通过。
- 恢复验证：`AGE-447` 暴露 A君 HTTP 调用层 180 秒上限；`AGE-448` 在两次模型结果均未通过语义证据校验后只生成明确标记的兜底稿；`AGE-449`、`AGE-450` 暴露 Hermes 异步工具桥固定 300 秒上限。把 MCP Server timeout 配为 900 秒仍会被 `/Users/pengaro/.hermes/hermes-agent/model_tools.py` 的 `future.result(timeout=300)` 截断。
- 保留的兜底产物：`apps/ajun-runtime/data/content-growth-artifacts/21b54e83-3a4b-4bad-ac00-b8355bb529df/video_content_analysis_report.md`，SHA-256 `fa233ae6dec6d63480b2c962916175cc35e57ba6ca475f0bb2855c91f91ddf1b`。它用于故障取证，不作为正式深度稿。
- 已修复：总任务终态会附带实际分析报告；正式 full 报告必须通过语义校验才能建议成功；未通过校验的兜底稿明确标记并进入待测试；Hermes 已先失败时，迟到产物不能把终态反写成运行中；确认稿会覆盖式归并为最多 30 个连续证据块。长任务改为由 A君后台持有，单次 MCP 等待限制为 240 秒、Hermes MCP timeout 为 290 秒，Paperclip 根据 `continuePolling` 续查同一执行，避开上游固定 300 秒同步边界。
- 正式修复任务：A君 `dd18a461-9469-49ef-a31e-443724f38e74`，Paperclip `AGE-452` / Issue `6b91e575-fc16-4b6d-b764-4572272f18c6`，复用同一人工确认稿，没有重新抓取或转录。
- 真实模型：`openai-codex / gpt-5.6-terra` 调用 2 次，输入 39,420 Token、输出 20,610 Token；总执行 386,785 ms。首轮未通过全部语义门禁，第二轮后以 `hermes_advisor_evidence_repaired` 保留模型模块并仅修复缺失证据结构。
- 正式产物：`apps/ajun-runtime/data/content-growth-artifacts/dd18a461-9469-49ef-a31e-443724f38e74/video_content_analysis_report.md`，权限 `0600`，29,141 bytes，SHA-256 `513bb4e12c8e45c2f80b8834e0b76941ba817806c4947e68c9bf31f15df97357`。用户文件已改为人类可读 Markdown，不再展示原始 JSON；验证项为文件存在/可读/非空、正式确认稿、13 模块、声明关联证据、语义门禁通过、证据结构修复通过。
- 飞书交付：终态消息 1,345 字，13 个模块名、Hermes 深度模式和行动清单均存在，低于 8,000 字发送上限。原会话 completion watch 只在 Hermes 发送进程返回成功后移除；任务完成后对应 watch 已消失。
- 已知限制：确认稿没有可校验时间码，因此报告所有时间定位均明确降为低置信度；如需精确剪辑点，仍需补时间码。正式报告内容质量尚待负责人阅读判断。

### M3-REAL-003：小创真实草稿

- 状态：本机真实业务草稿 PASS；人工内容质量待负责人判断。
- 输入：真实确认稿任务 `1e9b5e77-d734-48f7-9bd7-f0c911d902ab` 与新版图文报告任务 `9c9b745a-7d15-4315-b3b3-10ed076e638a`。
- 任务：`a5415600-1a4e-41e9-8779-655cbd69e058` / Paperclip `AGE-510`。
- 产物：`platform_content_draft.md`，5,039 bytes，SHA-256 `e8e7a9c6359188ff81044a05822d0572cd3fa17ee1b492428c2a2cf55ad0c6f1`。
- 结果：生成一份 35 秒抖音职场短剧待审稿，含 3 个标题、完整台词/节奏、5 条来源证据和 6 项人工检查；`confirmedTranscriptUsed=true`、`formalAnalysisUsed=true`、`advisorApplied=true`。
- 边界：`publishingStatus=draft_only`、`externalSideEffects=0`；没有发布、外发或飞书测试消息。

### M3-REAL-004：Obsidian归档

- 状态：真实任务受限写入 PASS；未发送飞书测试消息。
- 任务：`b22b9828-a9ce-41c7-b75d-c6debfe88dca`，明确引用真实素材、图文报告和小创草稿三项任务。
- 产物：`10.Auto-work内容系统/Agent军团/2026-07-28-归档-BV1GM796EENj-图文拆解与小创真实草稿闭环-v2-b22b9828.md`，2,451 bytes。
- SHA-256：`6888f787b6df0af6c34e246d03db2b873a15770a92b7c0a991096827c980f9d5`
- 验证：文件权限 `0600`，路径受限、可读、非空；笔记包含真实报告摘要、草稿首选标题、`未发布` 边界及人工复核待办。旧版本仅列产物名的质量问题已保留，并在 v2 修复。

### M3-REAL-005：B站字幕到 ASR 真实降级

- 状态：本机真实链路 PASS；未触发飞书交付。
- 输入：公开 B站视频 `BV1GM796EENj`，时长 363.179 秒。
- 原生字幕判断：接口返回的中文轨只有 1 条，结束于 9.525 秒，内容为片头推广；覆盖门禁拒绝将其作为完整转录。
- 降级结果：内容获取中心自动切换至 MediaCrawlerPro 独立音轨，获取 8,922,318 bytes 音频；随后本机 `mlx_whisper` 生成 1,418 个中文字符、502 行转写。
- 转写 SHA-256：`e703a1bd40630fda87e4ef5d179511cd5b7a03701c91e7306c612b5ed276cbbc`。
- 边界：本次只证明本机“原生字幕质量判断 → 音轨 → ASR”，不替代飞书交付和人工校对。

### M3-REAL-006：图文联合证据包与本地上传路由

- 状态：本机真实图文联合闭环 PASS；新版报告未发送飞书，人工内容质量待验收。
- B站输入：公开样本 `BV1GM796EENj`；任务 `1e9b5e77-d734-48f7-9bd7-f0c911d902ab`，小D Job `b36513f9-368e-4c89-8f3d-8c09bc1b2e98`。
- 来源：真实标题“陈翔六点半：你有你的张良计，我有我的过墙梯”，作者“陈翔六点半”，平台 `bili`，标准链接不含追踪参数；没有发布时间或互动数据时保持空值。
- 时间轴：本机 ASR 同时生成 TXT/VTT/JSON；230 个证据段，音轨覆盖率 `1`，尾部差 `0.038688` 秒，系统质量门禁自动确认，`completeListen=false`。
- 视觉：真实视频校验后生成 48 帧、4 张故事板，覆盖 `00:00–06:02`；其中 14 帧来自场景变化、3 帧来自字幕重点，其余为均匀补帧；视觉包 SHA-256 为 `7130831f83c4110f3f70bafba8d06bdb2eb3d3ec59267e4951f96c537e10ecd2`，文件权限 `0600`。
- 本地上传：将同一公开样本的视频与音轨合成本地测试文件，经 `/api/jobs/upload` 直接复用本地视频；Job `1c8bd5a9-a426-48e8-8986-b8909e7d5f25` 生成 12 帧、1 张故事板并自动确认，视觉包 SHA-256 为 `f5fc487e480e4804056b0028278561c1c29d95654ad699a1becfad09679b3d54`，文件权限 `0600`。
- 外部副作用：两次任务均为 `deliveryMode=local_only`，`larkUrl=null`；没有创建飞书文档、发送飞书消息或发布内容。
- 失败保留：首次真实运行暴露平台整数时长导致的覆盖率误报，第二次暴露视觉用途仍返回独立音轨；两处均修复并新增回归测试。首次本地上传使用纯视频分片，因缺少音轨按 `needs_input` 拒绝，随后改用含视频和音轨的有效本地文件通过。
- 失败保留：首次图文报告 `7c0dff9a-defe-48fa-bdab-2f8cf8eff456` 及首次复验 `8dc40da3-68c0-4846-9267-9a9a47663733` 均保持 `waiting_test/partial`，没有冒充完整成功。诊断确认模型已生成有效图文分析，但旧校验把连续台词之间的时间戳数字混入正文比对，导致真实跨句引用被误拒。
- 小拆通过：修正为“正文连续比对 + 引用时间点必须来自确认稿”后，任务 `9c9b745a-7d15-4315-b3b3-10ed076e638a` / Paperclip `AGE-506` 复用同一确认稿、来源记录和视觉包，没有重新抓取或转录；`openai-codex / gpt-5.6-terra` 调用 5 次，输入 30,371 Token、输出 9,785 Token，总执行 197,692 ms，报告为原生 `hermes_advisor`，未使用语义修复。
- 正式产物：`apps/ajun-runtime/data/content-growth-artifacts/9c9b745a-7d15-4315-b3b3-10ed076e638a/video_content_analysis_report.md`，23,847 bytes，SHA-256 `2d853e85c5e36cda47c5d03169f83d86abbce7813eb4643ea1c871802bb31898`。验证项为正式自动确认稿、13 模块、29 个连续证据段、48 帧/4 故事板、6 条画面结论覆盖 5 类视觉观察、文本与画面证据均合法，`completeness=complete`。
- 边界：该任务来源为 `hermes-native`，未登记飞书 completion watch，也未创建飞书文档或发送测试消息；这次证据证明本机真实素材、Paperclip/Hermes 和真实产物，不替代负责人对内容质量的判断。

### M3-REAL-007：参考案例到可拍脚本生产包

- 状态：本机真实产物 PASS；飞书自然语言与负责人质量验收待验证。
- 输入：明确引用真实图文报告任务 `9c9b745a-7d15-4315-b3b3-10ed076e638a`，新主题为“家庭关系里为什么不要把试探当沟通”。
- 匹配：`user_specified_reference`，来源标题为“陈翔六点半：你有你的张良计，我有我的过墙梯”；只复用冲突开场、逐步加深、反转和收束的结构作用，没有复制人物、私房钱案例、金额、台词或笑点。
- 真实 Hermes：`openai-codex / gpt-5.6-terra` 调用 1 次，输入 16,180 Token、输出 1,058 Token，执行器报告费用 0 USD。
- 主脚本：`apps/ajun-runtime/data/content-growth-artifacts/m3-script-package-hermes-v2-20260728/video-script-package/script.md`，SHA-256 `22f92323ef11bce72228d71bbc28676da432a0c60323311f158ecdb0e43f1a0a`。
- 生产包：`script.md`、`shots.json`、`subtitles.srt`、`sources.md`、`manifest.json` 均存在、可读、权限受控且有独立校验值；共 6 个镜头，默认抖音 9:16、45 秒。
- 用户界面：默认交付只展示标题、平台/时长、开场、完整口播、拍摄提示和一个下一步“用这版”；内部文件、模板 ID 和评分不进入默认回复。
- 生命周期：参考拆解先作为案例；“用这版”后才标记 `trial`。至少三次使用、至少两次达到账号基准且基准样本不少于五条时建议 `validated`；连续三次低于基准时建议 `retired`。
- ASR 修复：本地 Whisper JSON 的词概率、段落平均 logprob、无语音比例和压缩率进入自动确认门禁；低置信信号即使音频覆盖完整也会转人工，避免只检查覆盖率。
- 外部副作用：`0`；没有创建成片、发送飞书消息或发布。
- 已知限制：本轮没有获准发送飞书测试消息，也没有真实发布表现截图；因此自然语言“主题 → 脚本 → 用这版”和生命周期变化目前只有自动化及本机产物证据。

### M3-REAL-008：微信本机 Vault 岗位受控合成验收

- 状态：治理审核与合成技术验收 PASS；真实微信聊天读取未执行，岗位未激活。
- 草案：Proposal `430380ef-932d-4eea-98c3-27e905668771`，候选岗位 `wechat-chat-retriever`；仅允许 `wechat.local-vault.chat.read`，复用 `yichen-wechat-local-vault` 的只读查询边界，不向 Agent 暴露密钥提取、数据库解密、终端或微信 UI。
- StepFun 审核：审核任务 `032c6f94-3539-409a-8631-5b9c3ff89fcf` / Paperclip `AGE-582` 使用隔离审核官 Profile，真实日志为 `step-router-v1 / custom:stepfun`；报告结论为可交负责人决定一次受限合成测试。组织级审批投影为 `AGE-583`，只批准测试，不代表上岗。
- 测试实例：`9614bbd8-0c5a-4951-83fa-20826fc9c0a8`，隔离配置、无生产凭据、最多一次、无外部消费。
- 验收产物：`apps/ajun-runtime/data/proposal-acceptance-artifacts/430380ef-932d-4eea-98c3-27e905668771/9614bbd8-0c5a-4951-83fa-20826fc9c0a8/wechat-local-vault-synthetic-acceptance.json`，权限 `0600`。报告为 `synthetic-only`、`realChatRead=false`，逐次审批绑定、单一会话、限定时间范围、原文不落盘、无密钥或数据库暴露、外部副作用为 0。
- 失败保留：早期 `AGE-575` 为 DeepSeek 余额不足，`AGE-576` 要求补范围，`AGE-578/579` 实际仍走旧 DeepSeek 配置，`AGE-580` 因 Paperclip 未识别自定义 Provider 名称失败；这些记录均不作为 StepFun 通过证据。修复后以 `custom:stepfun` 显式命中 Step Plan Messages API，并由 `AGE-582` 重新审核。
- 自动化：A君运行台 `540/540`、内容获取层 `22/22`、Manifest `13/13` 通过。
- 边界：草案当前保持 `testing`，没有正式 Manifest，也没有进入活动岗位清单。真实私密验收仍需负责人另行提供一个明确联系人或群聊及开始/结束时间，并逐次批准；真实读取结果不得以原文形式进入 Paperclip、日志或验收报告。
- 后续状态（2026-07-30，不回写为 M3 完成证据）：负责人另行允许初始化本机 Vault，并批准一次指定群、限定时间范围的真实只读验证；Vault 返回 6 条消息，原文未持久化。随后建立正式 Manifest、A君按需执行器和逐次审批链，Proposal `430380ef-932d-4eea-98c3-27e905668771` 已单独激活并同步 Paperclip。新默认是今天至现在、最多 200 条、增量刷新、同名会话选最近活跃；每次真实读取仍只确认一次当前范围。

### M3-REAL-009：负责人最终内容与飞书闭环验收

- 状态：PASS。
- 负责人于 2026-07-30 确认，已在 2026-07-29 完成新版内容质量判断和最终飞书自然语言脚本闭环。
- 验收结果：M3 新版图文报告、真实草稿、可拍脚本和“用这版”业务路径获得负责人确认，M3 人工质量门禁关闭。
- 证据边界：本条记录的是负责人最终验收确认，不补造飞书消息 ID、截图或任务 ID；既有自动化、本机运行、Hermes/Paperclip、飞书链路和产物证据仍分别保留。
- 微信本机 Vault 的真实私密读取不属于 M3 完成条件；该候选岗位继续保持 `testing`，不得因 M3 关闭而激活或扩权。

## 候选能力状态

| 能力 | 状态 | 结论 |
| --- | --- | --- |
| 微信公众号公开文章 | 候选 | 未注册生产适配器 |
| ChatGPT Web Research | 候选 | 未获得单次外发批准时拒绝 |
| 微信本地 Vault | 已按需上岗 | 已注册受控生产适配器与本机执行器；每次真实读取仍需逐次批准，原文不进模型和外部平台 |
| 抖音/小红书候选脚本 | 不接入 | 继续走既有内容获取中心与连接授权 |

## 关闭条件

- M3-REAL-001 至 M3-REAL-004 均有事实证据；
- 两个新岗位的治理流转、后台按需激活和 Paperclip heartbeat 已有事实证据；
- PRD、总 PRD、README、架构、契约和本账本状态一致；
- 人工确认拆解质量与草稿质量，且没有自动发布或敏感数据泄漏。

以上关闭条件已于 2026-07-30 满足，M3 正式关闭并进入 M4。
