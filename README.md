# Agent军团

Agent军团是一套以飞书为日常业务入口、以 Hermes 等运行时承载各 Agent、以 Paperclip 作为组织级治理总控、以 A君本地运行时承载通用能力与故障恢复的数字员工系统。用户既可以把目标交给飞书中的“ A君·军团总管”，也可以按需直接私聊独立员工；每名员工拥有自己的 Hermes Profile、会话/记忆、岗位 Prompt、Skill 与最小 MCP 作用域。A君局域网页只作为授权、诊断和应急入口，不与飞书重复日常派活。

这个仓库的根目录用于承载军团级架构、岗位定义、公共能力、平台集成和运维设施。每个可独立运行的业务 Agent 放在 `apps/` 下，不再让某一个 Agent 代表整个项目。

## 目录结构

```text
agent-agent/
├── apps/           可独立运行、部署和验收的业务 Agent
│   └── xiaod-media-transcriber/  小D：音视频转录整理与飞书交付
├── agents/         数字员工的岗位、职责、权限和质量标准
├── integrations/   Paperclip、Hermes、飞书等平台适配层
├── packages/       多个 Agent 共用的代码与能力模块
├── ops/            本地运行、部署、监控和恢复工具
├── tasks/          总 PRD、里程碑 PRD 和实施状态
├── docs/           产品、设计、架构、契约、规范和验收记录
└── designs/        可运行的 UI 原型与设计资产
```

### 局域网项目进度看板

多项目进度 H5 位于 `apps/project-progress-board/`，项目、阶段和任务保存在本机 SQLite。它是按需开发工具，不属于五个常驻服务；需要时执行 `cd apps/project-progress-board && npm run dev`，再访问 `http://127.0.0.1:4320`。详见 [项目进度看板 README](./apps/project-progress-board/README.md) 和 [设计说明](./docs/design/project-progress-board.md)。

仓库已经具备多个真实应用和跨消费者共享模块，因此根目录现使用轻量 npm Workspace；不引入额外构建框架。`npm run test:affected` 按变更触达选择包级回归，`npm run check:architecture` 检查共享包依赖方向，发布前仍保留四个核心运行包的全量测试。

## 当前状态

### 机器事实（2026-08-06）

- **运行身份不再手工猜测**：执行 `npm run runtime:fingerprint` 同时读取当前源码 Git、脏文件计数、不可变 release 身份和关键服务摘要；文档中的历史 PID/release 只保留为验收记录，不能替代当前机器输出。
- **依赖服务健康，生产写入继续关闭**：Paperclip、小D、Publisher 健康接口均为 200；Publisher 为 `disabled`、`realConnectorsConfigured=false`，Campaign 与 M5 Cron 未恢复。本轮未调用 Provider、未执行发布、未发送外部消息。
- **共享主工作树不是 live 源码**：仍位于 `experiment/governance-hermes-full-migration`、HEAD `6cccefb851072866777fa39c0775d1320e7aa590`，保留既有未提交变更且 staged 为 0。live 使用 `codex/m5-release-integration-20260806` 的隔离 clean worktree；从该工作树执行 `runtime:fingerprint` 应为 `same_git_head`。
- **核心编排大文件已按领域行为收敛**：`TaskService` 主入口约 545 行，任务受理、通知、Paperclip 指派和岗位执行分别进入深层 Module；原 1510 行任务执行入口降为约 607 行。M5 `ContentCampaignKernel` 主入口约 294 行，生命周期、Route、Replay、Planning、Work Product 血缘和交付校验各自由明确 Interface 持有；原 1124/1154 行执行文件降为约 36/171 行。Publisher Gateway 由 1287 降为约 243 行，发布尝试和指标采集分别隐藏在单方法 Interface 后。架构门禁限制这些责任 Module 回涨，既有 HTTP、MCP、Publisher 与测试调用方式不变。
- **生产源码已清除千行单体**：本分支把 15 个原千行责任文件按本机内容生产、开放研究、Paperclip 投影、飞书指挥、阶段恢复、CUA 会话、媒体产物、M5 v2 对账和 Controller JWT 切换等完整行为深化为 Module；排除历史 release、测试、数据与运维脚本后，当前最大生产源码为 992 行。架构检查对所有未登记生产源码设置 1000 行硬上限，并为本轮 Module 设置更低的责任上限；这只证明候选源码，不表示 live 已切换。
- **日期炸弹已修复**：Publisher 的 4 个到期 lease 用例注入固定时钟，不再依赖执行当天日期，也没有把批准到期日向后延长。
- **M5 仍为 PARTIAL**。只读 `production:readiness` 当前预期因 Publisher/connector、Campaign 快照、selector、Profile lease 和 provider 缺口返回 `not_ready`；恢复 Campaign、注入 provider、启用 Publisher 或发布均须另行批准。

> 以下按日期保留历史验收，不再作为当前 PID、release 或唯一下一步的依据。

- **2026-08-05 小红书已完成一次负责人明确授权的受控真实发布冒烟，但 M5 仍未完成**：使用隔离命名 Profile 和 CuaDriver 在真实创作后台上传 1 秒合成黑色视频，填写测试标题、正文与标签并只点击一次发布；平台跳转到 `published=true`，笔记管理返回内容 ID `6a72ddf8000000002201484e`，当前状态为“审核中”。Publisher 候选源码现支持跳转笔记管理、精确唯一标题、平台状态和详情 URL 内容 ID 的组合回读；缺 ID、重复标题或跨域均硬停，全量 `221/221` 与 `check` 通过。该回读尚未在获批 selector/Profile lease 的 production Runtime 中真实验收，因此不是 `PublishReceipt`；抖音、指标与 7 天闭环仍未完成，Campaign、Cron 和 Publisher 继续关闭。

- **2026-08-05 自媒体内容方法 1–6 已进入 A君 live，第 7 项随不可变包封装但 Publisher 仍关闭**：A君、小R、小创、审核官和小办已分别接入结构化创作简报、公开机会研究、四平台原生写法、视觉锚点、六项语义质量门和同类样本中位数/P75 复盘；公众号新增基于 Wenyan CLI 的独立草稿连接器，逐次核验 Paperclip 授权、只接受 Secret Reference 与不可变文件租约，回执固定 `externalPublished=false`、`groupSent=false`。不可变 release `e3b7ae7b…` 受控重启后 `/api/overview=200`，Publisher 仍为 `disabled`。没有复制上游任务状态机，Paperclip 仍是唯一任务真相；没有安装或调用真实 Wenyan、读取公众号密钥、创建真实草稿或群发。设计与验收边界见 [自媒体内容方法与公众号草稿接入](./docs/design/self-media-content-method-and-wechat-draft.md)。

- **2026-08-04 A君已成为本地 AI 的统一控制入口**：`账号与接入 → AI 能力中心` 可查看 Mac 与 4070 的服务、负载模式、固定启停动作、替代路线及检测/重连。Mac 只让轻量 18082 控制面随登录运行；Qwen3.5 18081、Embedding、Reranker、Whisper、Qwen3-TTS 与 MFLUX 均改为真实任务触发，状态查询不会加载重模型。原来藏在 `screen` 中常驻的 Qwen3.6 35B 18080 也已纳管，默认禁用且不进入任何 Agent 路由。六个岗位已用 Manifest 白名单声明所需本地能力，Agent 不能自行批准把数据发到 4070；图片经批准时优先 4070，失联自动回 Mac。Windows 新版 18083 轻量节点已部署，A君已实测远程启动、停止、重启、重连 ComfyUI，且完成 4070 生成/编辑、断线回 Mac 和恢复后再次调用；ComfyUI 默认按需运行，当前已停止且不占用显存。见 [控制 PRD](./tasks/prd-local-ai-capability-control.md)、[控制设计](./docs/design/local-ai-capability-control.md)、[系统架构](./docs/architecture/local-ai-capability-system.md) 与 [验收账本](./docs/reviews/local-ai-capability-system/acceptance.md)。

- **11 个正式岗位的主文本模型仍为 DeepSeek**：AgentManifest、Hermes 映射、本机 Profile 与 Paperclip Adapter 均保持 `deepseek/deepseek-v4-flash`，回退链为空；A君当前运行不可变 release `0a49f0dc…`（PID `6388`），本轮只给六个相关岗位增加本地 AI 能力白名单，没有改动其主文本模型。配置与 live 对账不等于真实 DeepSeek 付费调用通过；M5 StepFun 媒体能力继续独立失败关闭。
- **2026-08-02 架构负债候选 1–7 已完成并切入本机 live**：任务状态 mutation 已统一进入生命周期 Module；M5 平台、动作、模型和 schema 进入共享契约及 Campaign 内核；主业务路径不再拼接 Paperclip URL 或读取原始响应结构，旧 stage recovery 兼容仍封装在内核适配层；`server.js` 已从 816 行收敛为 3 行启动入口，构造、HTTP 路由、监听与后台服务可分别测试；根 Workspace、显式包依赖、架构检查和动态 affected tests 已启用。Node 22 根回归 `1557/1557`、Node 24 全量 `test`/`check` 均通过。最终 JSON 快照以事务方式迁入 SQLite，`587/25/16/6/5` 条记录及关键 ID 校验一致，原 JSON 与 `0600` 校验备份保留。A君已从提交 `26a4a461…` 的独立干净源码 worktree 和不可变 release `389141e4…` 运行；二次重启 PID `52608 → 52870` 后数量一致且进程继续持有 `runtime.sqlite`。Publisher 仍为 `disabled`，本轮没有调用 Provider 或发布平台内容。实施与恢复边界见 [ADR-0010](./docs/adr/0010-modular-monolith-contract-kernel-and-workspaces.md)。
- **2026-08-03 架构深化已进入候选源码，尚未切换 live**：任务能力目录、执行协调器和概览关注点已从 TaskService 分离；M5ControlPlane 使用真实调用面契约；Paperclip 组织级客户端与任务投影独立；M5 路由/Routine 测试归回内核，深层 Module 支持精确 affected tests，未知变更仍跑 Workspace 全量。当前证据仅为源码与自动化测试，不代表不可变 release、运行进程、Paperclip 资源或外部 Provider 已更新；详见 [ADR-0010 的深化记录](./docs/adr/0010-modular-monolith-contract-kernel-and-workspaces.md#2026-08-03-抽象边界深化)。
- 当前里程碑：**A君架构重构版、本机 AI 能力中心、岗位能力白名单与 Windows 按需 ComfyUI 控制已进入真实运行链，SQLite 与 Paperclip 既有状态目录保持不变，真实发布仍关闭**。本轮没有 apply Paperclip 流程资源，也没有修改旧 v1 Pipeline、Case、Issue 或 Work Product。
- **当前 live 事实是 15 阶段、17 个有效 Routine、5 个控制器，活动已暂停**：v2 Pipeline `6dfd94da…`、Project `86ad0a0a…`、活动 `8dd29a3b…` 当前 `campaignGrant.status=paused`、无 active work；M5 每日 Routine Cron 关闭。没有任何分支引用且从未触发的旧 `m5-research` Routine 已归档并保留记录。内容插件 live `0.4.9` 为 `ready/healthy`，Secret Reference 有效，`0.4.6` 不可变回滚链保留，已淘汰的 `0.4.7` 本地包删除；Publisher `4390` 仍为 `disabled`、`realConnectorsConfigured=false`。这次版本收敛没有调用 Provider 或发布平台内容。
- **StepFun 文本传输与复杂任务语义证据已转为历史基线**：2026-07-31 的 11/11 文本探针、岗位语义和跨岗位门禁继续保留，但自 ADR-0011 切到 DeepSeek 后不再代表当前主模型。当前 DeepSeek 只完成配置、Gateway、Paperclip Adapter 与 fresh A君 runtime 对账，尚未执行付费模型探针；历史证据见 [StepFun 文本探针账本](./docs/reviews/m5-high-autonomy-content-operations/artifacts/2026-07-31-stepfun-text-probes.json) 与 [`2026-07-31-stepfun-3.5-role-quality`](./docs/reviews/m5-high-autonomy-content-operations/artifacts/2026-07-31-stepfun-3.5-role-quality/)。
- **16/18/6 A君代码已进入当前 live，但 Paperclip 资源仍是 15/17/5**：当前源码声明 16 个阶段、18 个 Routine（17 个阶段/分支 Routine + 1 个 daily Routine）和 6 个无模型控制器。当前根自动化为 `1557/1557`，其中 A君 `1092/1092`、Pipeline `67/67`、内容插件 `97/97`、Publisher `203/203`；这些证明源码与本机运行边界，Paperclip 的 16/18/6 资源尚未 apply。
- **R4 已由架构重构版替代**：上一版 source commit `7ac6defc…`、release `7b90e666…` 继续作为历史回滚证据；当前正式 source commit 为 `26a4a461…`，`releaseHash=389141e4473c74ce5b1e4d95a3cfbc38c3c066d1bb26e9bfba5a34c6fb235910`、`payloadHash=948cbbcecf7585b425a7bcc918b0dce84f89370978a577cdc56ab4a37ae1be8f`，main/recovery smoke、静态闭包与快照绑定均通过。
- **degraded 恢复已可用并在切换中实跑，exact previous 仍未建立**：首次 bootstrap 遇到 launchd 卸载竞态后，R4 的独立只读 recovery entrypoint 曾接管 4321，返回 `local_recovery_only`、`externalEffects=false`、`writableRoutes=false`；等待旧 label 完全卸载后生产入口切换成功。恢复不挂正式状态，不冒充精确旧 live。Paperclip `/api/health` 为 200，Publisher 仍为 `disabled`；本轮没有真实 Provider 调用或平台发布。
- **正式视觉与原生血缘门禁已随 `0.4.9` 进入 live，但仍没有真实 Campaign 视觉证据**：内容插件固定视觉模型 `step-1o-turbo-vision`、生图/改图模型 `step-image-edit-2`、TTS 模型 `stepaudio-2.5-tts`。通用 Hermes one-shot 已移除 `--ignore-rules`，普通调用固定为 `clarify`，只有无 Provider 的受控故事板分支允许 `vision`；正式视觉只能由当前 Paperclip Run 的单用途回调调用，绑定固定 action、相对 PNG、帧哈希、时间点、confirmed receipt 和同一 Project。新产物和已有视觉 Work Product 的重放都必须通过同一校验，漂移时阻塞且不覆盖；渲染必须实际消费可信 `GeneratedImagePackage`，机器审核必须反查同 Project 的图片、视觉、TTS 三条 confirmed action/cost。live 不可变包位于 `work/m5-content-autonomy/plugin-packages/content-autonomy-bundle-0.4.9-b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d/`，`payloadHash=b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d`、`entryCount=19986`、`manifestSha256=dabf16ac255eec3348e5800239f907793db1c1e507d1aa2820cd57fb71ec8dd7`、独立全目录哈希 `82f75845b927c8fa817e45e8e4d588338c7131677f2681c7297dba987db0c8bd`。Paperclip API 与 worker 进程均已对账到该路径，插件健康检查为 `ready/healthy`；这仍不等于执行过真实 M5 Campaign StepFun 视觉调用。历史 `native-artifact-smoke`、旧 StepFun Provider 账本和 `m5v2-lineage-v2` 继续作为本地产物证据保留，全部 `externalPublished=false`，不证明真实平台发布。
- **`0.5.0` 仅是本地静态卡候选，不是 live**：现有 `render` 阶段会从 baseline 脚本、可信图片账本、版权依据和生产模板绑定派生 3 页小红书 `SocialCardPackage`，固定输出 1080×1440 PNG、props/manifest/逐文件 SHA-256，并嵌入原 `RenderPackage`。没有新增 Pipeline 阶段、控制器或发布能力；真实 Chrome 本地验收产物在 `work/m5-social-card-acceptance-20260806-e/`，未调用 Provider、未启用 Campaign/Cron/Publisher、未外发。
- **Computer Use 仍未完成完整假页验收**：已修复把 `browser_consent_required` 误报成 `prepared_browser_pid_missing` 的诊断错误；现在会保留 CuaDriver 的真实授权失败。完整本地假页验收仍需要当次生成、五分钟有效、单次使用的 browser approval token；Token 不得打印、落盘或复用。真实账号、真实 selector、Profile lease 和平台写入仍未验收。
- **11 个正式 Hermes Profile 已实际收敛，但 M5 尚未完成**：11 岗模型已按 ADR-0011 切到 DeepSeek，岗位 MCP/Feishu toolset 与技能白名单边界不变。Paperclip live 插件和 Publisher 状态不因文本模型切换而改变，真实 M5 Campaign 的媒体 Provider 调用仍须独立验证，不能写成 M5 完成。完整分层证据见 [M5 验收账本](./docs/reviews/m5-high-autonomy-content-operations/acceptance.md)。
- 2026-08-04 微信聊天取件员已统一为回环 `Qwen3.5-9B` OpenAI-compatible 服务，并在真实执行前按需唤醒 18081：默认采用“今天至现在、最多 200 条、增量刷新、同名会话选最近活跃”，只有缺联系人/群名时才补问；首次确认生成绑定同一飞书会话、岗位、微信会话与固定范围的 30 分钟临时授权，最多 10 次，可撤销。Manifest、Profile、Prompt 与真实执行路径均不再声明已删除的 `qwen3:14b`。原文和发送者只在本机内存及 `127.0.0.1:18081` 中流转，不进入 StepFun、DeepSeek、Paperclip、飞书、日志、台式机或报告；本机模型或 Vault 未就绪时不扣次数且不云端降级。该岗位没有常驻监听，也不能发送微信消息。
- 2026-07-30 完成所有 Agent 的飞书中文运行提示与移动端消息排版：用户消息到达后只在原消息上显示一个“处理中”图标，最终回复出现后移除，不再叠加第二条确认消息；运行中补充要求仍可一键选择“下一步单独处理 / 查看当前设置 / 停止当前任务”。长条目和多分区回复会自动增加留白，短回答、短列表保持紧凑；长单元格或宽表转成手机可读的纵向分组。仓库补丁、真实 Hermes 编译和长短内容样例通过，五个常驻 Gateway 已重新连接飞书；真实手机渲染与按钮点击仍按 [ARMY-047](./docs/reviews/m2-real-small-army/acceptance.md) 待负责人验收。
- 2026-07-30 完成 A君运行台认知减负：总览首屏先给唯一下一步和三个关键数，能力说明与飞书示例按需展开；账号页优先展示最近真实读取结果，低频模型、API 和员工接线设置折叠；记录页默认只看待复盘、支持搜索并每次加载 24 条，不再一次渲染 517 条。A君 829/829，正式服务与 1440、900、390 像素真实浏览器检查通过，见 [ARMY-048](./docs/reviews/m2-real-small-army/acceptance.md)。
- 2026-07-29 完成 Agent 人性化表达的本机落地：A君控制台、MCP 与完成提醒统一使用中文摘要、中文状态、一个下一步和可点击短任务号，完整 UUID 与内部状态收进技术细节；Hermes `/new` 增加中文原生按钮和中文降级提示。自动检查、运行时与桌面/中间宽度/390 像素真实浏览器检查已通过；真实飞书按钮点击和链接仍按 [ARMY-046](./docs/reviews/m2-real-small-army/acceptance.md) 待负责人验收，手机链接需另配安全可达地址。
- 2026-07-27 完成军团运行编制收缩：常驻仅保留 A君、小D、小R、小办、运维官；创建官、审核官、架构师、技术专家保留 Paperclip/Hermes 后台按需能力。任务协调官并入 A君，小G的 GitHub 检索并入小R；音视频转录接线样板和公开资料报告员候选岗位归档。Manifest 是活动岗位唯一真相，草案不能生成“幽灵员工”。
- 已确认 Agent军团长期目标、M0–M4 路线和 M1 小D需求。
- 已建立文档治理、系统架构、核心契约、代码/目录规范和测试门禁。
- M1 飞书交互原型已通过 A 君人工评审。
- 小D版本化 AgentManifest、Prompt、评测样例和 Hermes Profile 映射已建立并通过本地契约检查；A君可把带公开链接的素材任务委派给本机小D并跟踪其状态，真实素材、失败恢复和原会话交付均已完成 M1 验收。
- 隔离 `xiaod` Hermes Profile 与传统飞书机器人测试应用已创建并发布；传统机器人已完成真实文本消息收发与模型回复验证。短媒体已真实完成转录、飞书文档权限与交付，并通过一次“受控失败 → 飞书重试 → 同一任务单次交付”回归；约 10 分钟媒体已完成真实阶段与交付验证。M1 已按当前正式飞书闭环关闭，历史接入故障继续保留在验收账本；Paperclip 按原决策进入 M2。
- M2 已完成：小D 已接入统一账号管家、通用内容获取中心和脱敏运维事件；YouTube 公开视频与小红书从零登录素材均完成真实交付。A君提供白名单平台登录、刷新账号、续期、暂时禁用和撤销；小红书连接完成真实禁用与同 ID 续期恢复。当前为单用户、本机回环服务，负责人接受来源链接敏感参数保存在本机任务状态的已知风险；进入多人、云端或远程访问前必须重新处理该安全项。
- 2026-07-30 运行台新增同平台默认账号、任务显式账号绑定和最近真实读取结果；桌面与 390 像素浏览器检查通过。抖音、哔哩哔哩以及一条从小红书发现页自然取得、带当前 `xsec_token` 的公开笔记均完成真实只读；健康灯、登录状态和历史结果没有被当作成功证据。
- M1 已完成真实飞书闭环：受控失败会先回原会话说明“运维官已接手”，网关重启后恢复并只交付一次；小D已在原会话交付公开视频文档。验收账本见 [ARMY-008 / ARMY-009](./docs/reviews/m2-real-small-army/acceptance.md#army-008--army-009)。
- M2 第一批军团能力已完成最小真实验收：公开资料报告员从真实飞书接到公开网页、生成摘要并回到原会话；两份含风险描述的岗位草案已在飞书分别实际批准和拒绝；零预算多人工作也已由真人点击飞书审批卡，随后自动分工、完成并同步 Paperclip。没有真实执行能力的批准草案只转为待补能力，不试用、不上线。小红书登录型只读、撤销恢复和连接续期/禁用已验收；其他平台和更高风险动作仍须逐项授权。
- 当前持续迭代：现在不只是小D，任何普通员工执行报错都会先交给运维官；安全条件满足时只重试一次，再失败则升级技术专家。恢复任务和技术修理任务本身失败不会无限套娃；技术检查卡住就标为待测试，其他工作继续。2026-07-24 的真实飞书受控网页故障已完整看到“运维接手 → 安全重试 → 技术专家待测试”，ARMY-024 通过。总管会在有人接手时主动说明，并继续等待最后的真实结果；A君 在小D恢复任务处理中重启后，原会话仍只收到一次最终交付。审核官现可只读复核已上岗岗位，技术专家拿到真实任务号后可直接给出只读故障链判断；创建官、审核官、架构师、技术专家的独立飞书岗位任务均已通过。A君 自动检查覆盖恢复、技术修复、小D路由和这些岗位边界；当前测试结果以 `cd apps/ajun-runtime && npm test` 为准。所有已上岗员工会同步登记到 Paperclip；新员工通过受限试用后立即登记。统一进度见 [真实小军团验收账本](./docs/reviews/m2-real-small-army/acceptance.md)。
- 小D任务支持安全暂停与继续：飞书提出暂停或继续后先由 Paperclip 记录确认，确认前原任务不变；ARMY-020 已用真实任务验证 22% 安全暂停、确认继续和最终完成，两张审批卡都替换成无按钮终态。
- 运维官由 Paperclip 每半小时巡检 A君、小D和 Paperclip。2026-08-06 已切换为本机无模型 HTTP 控制器：正常巡检不再调用 DeepSeek，只有发现异常时才幂等派发运维事故；真实手动触发 AGE-986 的 assignment 与 automation 两条运行均成功，Hermes 会话、API 调用和 Token 计数均未增加。ARMY-021 继续通过。
- 总管会把同一飞书聊天里的“不错/有用”或“不行/需要改进”关联到刚完成的工作，不新建任务也不自动重做；真实负面评价和后续架构复盘已完成，ARMY-022 通过。
- 每件新工作保存实际处理次数；只有执行方真实回传费用才显示金额。真实飞书已验证“今天花了多少”会返回处理记录并明确不猜金额，ARMY-023 通过。
- 对当前没有员工能直接完成的陌生目标，A君 会说明目标、交付物、缺少材料和安全下一步，不编造员工或结果；真实客户投诉分类请求已验证，ARMY-025 通过。
- 现用 `A君·军团总管` 已由 Hermes 原生 Gateway 承载日常飞书对话：同一会话能自然追问，Gateway 重启后仍能承接指代；能力、员工、任务和审批通过本机 Agent Army MCP 读取 A君/Paperclip 真相，不另建记忆库或任务队列。真实飞书已完成“小D状态不建任务”“审批拒绝不执行”“运维官只读健康检查单次执行并返回已验证报告”验收，ARMY-041 通过。官方 Channel SDK 继续承载尚未迁移的独立员工入口并作为回退，既有私聊、卡片、重启恢复和群内 @ 能力不删除；小R与小办已改由各自独立 Hermes Profile Gateway 承接。详见 [ADR-0007](./docs/adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md)、ARMY-032 与 ARMY-041。
- 治理岗位保留独立 Hermes Profile、岗位 Skill、受限 Agent Army MCP 与 Paperclip `hermes_local` 身份。运维官继续常驻并负责巡检和安全恢复；创建官、审核官、架构师、技术专家改为后台按需运行，不再保持独立 Gateway。历史六岗位直聊验收仅作为历史证据，不代表收缩后的当前入口；当前真实飞书回归以五个常驻入口和后台按需任务为准。
- 架构师现在采用“事实—判断—候选方案”三层工作法：当前事实必须引用活动 Manifest、真实任务类型或近期任务记录；架构判断可以推理，但要写明依据、假设和置信度；候选方案可以提出当前不存在的新岗位、能力或接口，但必须附最小验证计划、风险和非目标，不能冒充已经上线。技术专家现在先区分代码故障、授权/权限、输入/来源、外部瞬时故障和未知故障；只有诊断出的代码与测试路径在当前仓库真实存在时才进入隔离修复，其余情况交付诊断和明确下一步并停在“待测试”，不再盲改代码或笼统报失败。
- 数字员工公司体验已完成本机三员工闭环：A君可用一次 `mission_create` 把最多三项工作分给小D、小R和办公助理，独立工作并行，办公汇报按依赖等待，最后只给老板一份基于真实产物的统一汇报；同一幂等请求不会重复招工或重复交付，服务重启后任务仍可继续读取。真实飞书回归已验证自动分工、3/3 产物、只回最终汇报，以及 A君与 Hermes 同时重启后在原会话继续“刚才任务”且任务数不变；模型把最终汇报误派给小R或父任务标题含“老板汇报”时，服务端契约会阻止错误路由。三员工独立 Hermes Profile 与最小 MCP 权限边界已建立；私人云端办公室与 Mac 工作间的出站短租约桥接、无 Mac 轻量员工执行、重启恢复、上线前体检和隔离运行验收也已完成。小R与小办的最小权限独立飞书应用已创建并发布，两名员工均已完成独立模型真实调用，并由各自 Hermes Gateway 完成老板真实私聊入站、同会话任务执行、产物回传和连续追问；本机和云端还有唯一接管门，避免迁移时重复收消息。运行台对 Hermes 已接管员工只显示脱敏真实状态，不再提供会造成双连接的凭据修改入口。真实云主机上的 Mac 关机后验收仍未完成，因此目前是本机持续可用，不是全天云端在线。证据见 [数字员工公司体验验收账本](./docs/reviews/m2-digital-employee-company/acceptance.md)。
- 公开资料报告员可以一次对比一到五条公开网页并保留来源、中文重点、共同点、差别和建议；真实飞书两条 CERN 链接回归已通过 ARMY-026。
- 公开资料报告员现在也能在目标明确、但你没给链接时，先自己找最多三条公开网页再交付中文重点和来源；它只看公开网页，不登录、不付费、不外发。2026-07-24 已在真实飞书完成无链接 AutoGen 主题检索并交付两条可读来源；第三条返回 403 时如实忽略，ARMY-031 通过，资料提炼质量仍可继续优化。
- 对当前没人能直接完成、但没有登录、付费、外发等风险的工作，A君 会自动交给架构师评估能力缺口与最小下一步，不要求用户再说“继续”；真实飞书回归已通过 ARMY-027。
- 你问“你能干什么”时，A君 会按当前上岗员工的真实能力直接列出可办事项，不新建任务、不暴露内部岗位选择；真实飞书回归已通过 ARMY-028。

## 正式文档入口

### 产品与计划

- [Agent军团项目说明](./docs/Agent军团项目说明.md)
- [Agent军团总 PRD](./tasks/prd-agent-army-master.md)
- [M1 小D飞书业务闭环 PRD](./tasks/prd-m1-xiaod-feishu-closure.md)
- [M2 A君独立运行时、通用连接与内容获取、治理控制面 PRD](./tasks/prd-m2-authorization-connectors.md)
- [M2 第一批 Agent 创建与治理闭环 PRD](./tasks/prd-m2-first-batch-agent-governance.md)
- [M3 内容分析与知识归档 PRD](./tasks/prd-m3-content-analysis-and-knowledge-archive.md)
- [M4 岗位自主执行与能力深化 PRD](./tasks/prd-m4-autonomous-agent-capabilities.md)
- [M5 高权限内容自治 PRD](./tasks/prd-m5-high-autonomy-content-operations.md)
- [M2 通用访问底座实施计划](./docs/plans/m2-common-access-foundation-implementation-plan.md)
- [M2 军团运行骨架实施约定](./docs/plans/m2-army-runtime-skeleton-plan.md)
- [M2 第一批 Agent 创建与治理闭环实施计划](./docs/plans/m2-first-batch-agent-governance-plan.md)
- [M2 真实小军团持续迭代计划](./docs/plans/m2-real-small-army-iteration-plan.md)
- [M2 数字员工公司体验实施计划](./docs/plans/m2-digital-employee-company-implementation-plan.md)
- [任务与 PRD 状态](./tasks/README.md)

### 设计

- [数字员工公司体验设计](./docs/design/digital-employee-company-experience.md)
- [M1 飞书用户流程](./docs/design/m1-feishu-user-flow.md)
- [M1 飞书交互规范](./docs/design/m1-feishu-interaction-spec.md)
- [M1 可点击原型](./designs/agent-army-m1/feishu-xiaod-task-flow.html)
- [M2 通用访问底座设计](./docs/design/m2-common-access-foundation.md)
- [飞书手机控制军团流程](./docs/design/feishu-mobile-army-control.md)
- [飞书手机控制交互图](./designs/feishu-mobile-army-control/feishu-mobile-army-control.html)

### 技术与工程

- [系统架构](./docs/architecture/system-architecture.md)
- [M1 平台兼容性验证](./docs/architecture/m1-platform-compatibility-validation.md)
- [核心契约](./docs/contracts/core-contracts.md)
- [Agent 搭建与上线流程](./agents/agent-build-and-release.md)
- [创建 Hermes Agent 与飞书 Bot 接线教程](./docs/guides/创建Hermes-Agent与飞书Bot接线教程.md)
- [目录与代码规范](./docs/standards/repository-and-code.md)
- [测试与验收规范](./docs/standards/testing-and-acceptance.md)
- [ADR-0001：控制面、运行时与交互通道分离](./docs/adr/0001-control-plane-runtime-and-channel.md)
- [ADR-0002：先闭合运行链路，再接入 Paperclip 军团总控](./docs/adr/0002-phase-paperclip-after-m1-runtime-closure.md)
- [ADR-0003：M1 使用传统飞书机器人接入 Hermes](./docs/adr/0003-m1-use-traditional-feishu-bot.md)
- [ADR-0004：通用账号连接、内容获取与运维观察边界](./docs/adr/0004-common-access-foundation.md)
- [ADR-0005：飞书手机总管与审批分流边界](./docs/adr/0005-feishu-mobile-command-and-approval-boundary.md)
- [现成能力复用调研与采用边界](./docs/research/2026-07-agent-army-reuse-landscape.md)

### 治理与依据

- [文档迭代与治理规范](./docs/governance/document-lifecycle.md)
- [项目交接与闭环](./docs/handoffs/README.md)
- [验收记录入口](./docs/reviews/README.md)
- [Claude 交叉 AI 审核任务书](./docs/reviews/cross-ai-audit-prompt.md)
- [AI 推测内容评估与采纳](./docs/AI推测内容评估与采纳.md)
- [仓库协作规则](./AGENTS.md)

## 编码前门禁

当前 M1 首批实现前需要完成：

- 创建版本化小D AgentManifest 和 Hermes Profile 映射；
- 由所有者在隔离 Profile 配置真实凭据后，完成飞书与 Hermes 的真实受控验证；
- 将验证结果写入契约映射和验收记录。

小而明确、不改变工作流和跨系统契约的修复仍可直接处理。

## 运行小D

```bash
cd apps/xiaod-media-transcriber
npm install
npm run dev
```

默认访问地址：`http://127.0.0.1:4318`。

凭据保存在应用自己的 `.env` 中，不应放在仓库根目录、任务正文或项目文档里。

## 运行 A君运行台

```bash
cd apps/ajun-runtime
npm test
npm run dev
```

默认访问地址：`http://127.0.0.1:4321`。它是本机连接授权、组件健康、恢复和脱敏诊断页；已能作为本机 Paperclip HTTP Agent 的执行适配端，完成低风险健康任务并回报同一 Paperclip 任务单。日常派活、结果交付和用户审批在飞书完成；A君不维护第二套军团队列。小D任务仅调用本机 `4318` 服务，公开链接以外的外部账号、飞书和 Hermes 不由运行台直接调用。
