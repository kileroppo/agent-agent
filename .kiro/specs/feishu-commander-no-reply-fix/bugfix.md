# Bugfix Requirements Document

## Introduction

用户在本机通过飞书私聊「A君·军团总管」（`agentId = ajun`）发送文本消息后，飞书会话内**没有任何回复**——既没有业务回复，也没有错误提示或降级说明。

调研确认：真正的缺陷不是链路上某一个环节坏了，而是**这条链上至少 8 个环节会静默失败**，使「无回复」成为不可归因的黑箱。

**链路修订（本轮）**：飞书文本消息实际存在**两条并存路径**，此前本文档与 design.md 只把路径 A 当作主线，是错的。

路径 A —— 确定性 commander 文本路由（叠加在原生路径之前的拦截补丁）：

```
飞书客户端 → Hermes Gateway（adapter.py 的 _route_ajun_commander_event）
→ POST $AJUN_FEISHU_COMMANDER_INGRESS_URL（正式 http://127.0.0.1:4321/api/feishu/commander）
→ commander.handle() → presentCommanderReply() → 202 { reply | handled:false | task }
→ Hermes self.send(chat_id, reply, reply_to=message_id) → 飞书客户端
```

路径 B —— Hermes 原生会话 + Agent Army MCP（`docs/adr/0007-...md`，状态「已接受，已实施」，2026-07-26 定义的日常对话主路径，**独立可用**）：

```
飞书客户端 → Hermes 原生飞书 Gateway → Hermes Session / Profile / Memory
→ 模型按需调用 Agent Army MCP（config.yaml 的 mcp_servers.agent-army）
→ A君本机任务与能力适配 → Paperclip（仅组织级治理条件）→ 业务 Agent / 工具
→ Hermes 回原飞书会话 → 飞书客户端
```

两条路径的关系：路径 A 的 `DIRECT_REPLY_V1` 分支以 `handled:false` 把消息交回路径 B；路径 A 的补丁整体丢失时，消息直接落回路径 B 的 `handle_message`。**因此路径 A 缺口只会让派活类文本失去确定性路由，路径 B 本应照常回复** —— 需求 1.3 与真机第 2 项的 gap 是真实缺口，但**不是「完全零回复」的充分原因**。

静默点包括：环境变量未注入、Profile guard 不匹配、Hermes 升级覆盖 adapter 导致补丁丢失、4321 未监听、`isLocalAddress` 403、Gateway 进程未运行、飞书准入白名单未命中、以及 `handled:false` 之后 Hermes 模型侧异常。用户还极易把 `npm run dev`（4322，且 `AJUN_DISABLE_BACKGROUND_SERVICES=true`）误判为飞书链路已就绪，因为根 `README.md` 的「运行 A君运行台」段落把开发地址写成了 4321。

这一状态违反项目自身的 fail-closed 原则与「能力真相五层」（已声明 → 已配置 → 运行可达 → 任务实证 → 人工验收）要求：进程在线被当作业务可用。

修复范围是**可归因性与可自检**，不是替换现有路由语义。特别地，`handled:false`（`explicit_direct_reply_without_task`）把消息交回 Hermes 普通聊天是既有正确行为，必须原样保留。

飞书、Hermes、StepFun 均为外部能力，本 spec 内所有涉及它们的结论在真机验证前**显式标记未验证**。

### 真机验证证据（已实测 · 切片 A+B）

用户已在本机执行 `npm run diagnose:feishu-chain`，六项检查全部跑完，总判定 `blocking_gap`、退出码 `1`，
零凭据检查（`--json` 输出 grep `sk-|bearer|token|cookie|password`）通过。以下六项判定结果为**真机实测**：

| # | 检查项 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | `gateway-process` | **pass**（实测） | `loaded:true`、`pid` 存活、`state:"running"` |
| 2 | `adapter-patch` | **gap · 阻断**（实测） | `adapterFileExists:true`、`hasCommanderRoute:false`；五个补丁标记（`PROFILE_GUARD_V1` / `INGRESS_TIMEOUT_V1` / `DIRECT_REPLY_V1` / `ADAPTER_SEAM_V1` / `SILENT_FAILURE_EVIDENCE_V1`）**全部 false**；`hermesVersion:"0.20.1"`、`hermesVersionMatchesBaseline:false` |
| 3 | `required-env` | **pass**（实测） | `ingressUrlClassification:"expected_loopback"`；`agentIdPresent:false` —— 空值回退 `ajun`，属正常状态 |
| 4 | `runtime-ingress` | **pass**（实测） | `reachable:true`、`healthStatus:"healthy"`、`releaseStatus:"immutable_release"`、`sourceRelationship:"different_git_head"` |
| 5 | `profile-guard` | **unknown**（实测） | `guardMarkerPresent:false` —— 第 2 项补丁丢失的连带结果 |
| 6 | `feishu-admission` | **unknown**（实测） | `errorCode:"admission_field_not_found"` |

诊断留痕已写入运行时侧证据账本（相对路径 `<repo-root>/apps/ajun-runtime/data/feishu-commander-chain/runtime-evidence-*.jsonl`），
证明切片 B 的落盘路径在真机工作正常。

**根因确认**：Hermes 从 `0.19.0` 升级到 `0.20.1`，升级把 Agent Army 的全部补丁从 `adapter.py` 整体冲掉，
飞书文本消息因此不进入 A君总管链。这是 design.md《Hypothesized Root Cause》**假设 2（补丁存活性无人校验）
在真机上的确认**，也是需求 1.3 的实测坐实；该假设未被推翻。

仍然**未验证**的部分：飞书会话内是否出现回复（真机验证清单步骤 6 尚未通过）、Hermes 模型侧是否正常、
飞书应用事件订阅是否有效、准入白名单是否命中。

### 真机日志实证（已实测 · 第二轮 · Hermes default Profile）

用户在本机读取 Hermes 日志目录后取得以下**实测事实**（只提取异常类名、计数、行数与 mtime，未读消息正文）：

| 日志 | 行数 | 最近写入 | 状态 |
|---|---|---|---|
| `gateway.log` | 25741 | 08-19 11:21 | 当前 |
| `gateway.error.log` | 460144 | 08-19 11:21 | 当前 |
| `errors.log` | 3298 | 08-19 11:21 | 当前 |
| `agent.log` | 57838 | 08-19 11:21 | 当前 |
| `mcp-stderr.log` | 138773 | 08-18 23:57 | **停止写入约 11.5 小时** |
| `gateway-exit-diag.log` | 369 | 08-18 23:57 | **同样停止** |

`gateway.error.log` 尾部 20000 行异常类名直方图：`ConnectError` 974 / `Error` 357 / `NetworkError` 349 /
`RemoteProtocolError` 80 / `ConnectTimeout` 34 / `ReadError` 2 / `CancelledError` 2 —— 除 `Error` 外均为 httpx
出站异常族，即**出站 HTTP 连接持续失败**。

`gateway.log` 通用词计数：`feishu=1223`、`reject=7`、`policy=0`、`mcp=1`、尾部 500 行内 `feishu=0`。

**已实测**：上述行数、mtime、异常类名与计数、通用词计数。
**未验证**：出站失败的目标主机（异常类名不能证明目标是 StepFun endpoint 或任何具体 provider）、MCP server
的实际进程状态、`reject=7` 那 7 次的性质、飞书准入白名单是否命中。

### 真机日志实证（已实测 · 第三轮 · 主机名/模块名直方图 → 证伪第二轮结论）

第二轮把「出站 HTTP 连接持续失败」当作与飞书链路相关的证据，是错的。本轮对同一份
`gateway.error.log` 补做**子系统归属**（统计模块名与主机名，而非只统计异常类名），取得以下**实测计数**：

| 归属线索 | 计数 | 含义 |
|---|---|---|
| `plugins.platforms.telegram` | 1199 | 模块名归属：Telegram 平台插件 |
| `api.telegram.org` | 455 | 出站目标主机名 |
| `telegram.error` | 191 | Telegram SDK 异常模块 |
| `telegram.ext` | 167 | Telegram SDK 扩展模块 |
| `self.bot` | 168 | Telegram SDK 调用点 |

**结论（已实测）**：第二轮记录的 `ConnectError` 974 / `NetworkError` 349 / `ConnectTimeout` 34
**归属于 Telegram 平台插件**，与飞书链路、与模型 provider 调用**均无关**。
另有两个 `149.154.*` 网段 IP 出现在出站失败记录中；「该网段属 Telegram」这一判断来自**通用网络知识，
仓库内无依据**，据此标记为未验证，不作为归属依据（归属已由上表模块名与主机名独立成立）。

**这是本 spec 第三次连续证伪，且本次错误源于分析方法本身**：把**聚合日志签名**（异常类名的全局总计数）
直接当作与飞书链路相关的证据，**未先做子系统归属**。46 万行错误日志被单一无关插件的重试噪音主导时，
任何全局计数都只反映噪音体量。该方法缺陷已在本分支交付修复（`apps/ajun-runtime/src/hermes-log-attribution.ts`，
PR #12：按最深的非第三方栈帧或日志器名归属子系统，主导签名归属到无关子系统时明确判为与本 bug 无关）。

### 真机诊断实证（已实测 · 第四轮 · 外部直连诊断 → 确认网关侧准入拒绝）

用户改用另一个可直接访问本机的工具做诊断，取得以下**真机实测**结论。
**须如实标注的来源限制：这四项结论不是由本 spec 交付的诊断入口取得的**，而是由外部直连诊断取得；
本 spec 的诊断入口在真机上把准入一项报为 `unknown`（`errorCode:"admission_field_not_found"`），
即已按 1.19 预期在安全边界内**结构上不可判定**。

1. **A君 进程健康、4321 在监听**（已实测）—— 与本 spec 第一轮六项判定的第 1、4 项一致，互相印证。
2. **飞书消息确实到达了 Hermes 网关，但被当作未授权用户丢弃，因此不回复**（已实测）。
   日志签名形状为「`Unauthorized user:` + 账号标识 + 姓名 + `on feishu`」，涉及三条消息
   （当天 14:42 一条、前一日 17:06 两条）。**本文档只描述签名形状，不记录任何真实姓名、账号标识或
   `open_id` 及其片段。**
3. **两套用户准入白名单未对齐**（已实测）—— 军团配置里 A君 允许该用户的飞书 `open_id`，而 Hermes 网关
   另有一套独立白名单，两边不同步：军团侧允许，网关侧拒绝。
4. **A君 运行台显示飞书通道为空，且模型状态仍为 `model_transport_pending`**（已实测）—— 即使白名单
   修好，回复能力仍可能不完整。

**仓库侧核实结果（本轮已核实，用以判定「两套白名单」是否为仓库事实而非仅外部诊断说法）**：
该说法在仓库内**可以证实**，两套配置各有独立存储与独立写入路径 ——

- **军团侧**：`<AGENT_ARMY_PRIVATE_DIR>/feishu-agent-apps.json` 的 `apps[].allowedUserIds`
  （`apps/ajun-runtime/src/agent-feishu-app-store.ts`，schema `agent.army/feishu-agent-apps/v1`），
  经 `agent-feishu-channel-fleet.ts` 的 `agentChannelOptions()` 成为军团自有飞书通道的
  `policy.dmAllowlist`（`dmMode:'allowlist'`）。
- **Hermes 网关侧**：Hermes Profile 本地环境文件中的 `FEISHU_ALLOWED_USERS`，由
  `apps/ajun-runtime/scripts/provision-hermes-employee-feishu.mjs` 写入；A君 对应的 profileDir
  即 `HERMES_HOME`（default Profile），与 `ajun.profile.json` 的 `gateway.runtimeProfile:"default"` 一致。
- **同步是单向且仅发生在 provision 时刻的一次性拷贝**：`provisionHermesEmployeeFeishu` 在仓库内只有
  定义处与自身 CLI 两处引用；运行台接线路径 `EmployeeFeishuConnectionService.connect()` 只写军团侧 store
  并调用 `fleet.startApp(app)`，**不触发 provision**。因此军团侧更新后网关侧保持旧值。
- **无任何漂移检测**：仓库内 `allowlistDrift` / `whitelistDrift` 零命中；既有「漂移」校验全部属 release、
  技能审计与治理同步，与准入白名单无关。
- `ajun.profile.json` 的 `gateway` 块**不声明**准入来源，而 `xiaod.profile.json` 声明了
  `allowedUsersSource:"environment:FEISHU_ALLOWED_USERS"` —— 即「A君 的准入以哪一侧为准」在仓库内
  连声明都没有。

**未验证**：两套白名单在真机上的具体取值与差异条目（属凭据/PII 范围，本 spec 不读取）、
网关侧拒绝是否为三条消息的**唯一**原因、模型侧是否真的不可用。

### 已知约束（附带事实，不构成新缺陷条款）

- **运行中的 4321 是旧 release**：第 4 项证据 `sourceRelationship:"different_git_head"` 表明当前不可变
  release 的 git HEAD 与工作树不同，因此切片 B 的**运行时侧**证据落盘在正式 4321 上尚未生效，
  需执行 `npm run release:immutable` 重新发布后才启用。Hermes 侧证据不受此影响。
- **诊断结论只覆盖本机**：六项检查的层级上限最高为 `configured` / `reachable`，任一项 `pass`
  都不能证明「飞书可用」。

### 根因已确认（第四轮）

**零回复的直接原因是 Hermes 网关侧用户准入白名单拒绝了发送者**：消息在到达网关后被丢弃，
且**不向用户产生任何可见说明**。这是本 spec 首次取得的**确认级**结论（已实测，来源为外部直连诊断）。

该结论**确认了既有条款 1.7 与 2.7**（发送者不在白名单内 → 消息被丢弃、用户收不到说明），
也确认了下方「候选 2」以及 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md` 记录的 2026-07-19
同类故障模式（当时签名为 `dm_policy_rejected`）在当前版本以**不同措辞**复现。

**根因已定位，但验收仍未达成。** 判定本 spec 验收目标达成仍须同时满足：
（a）两套白名单对齐后，在飞书私聊发出真实文本消息并**收到回复**（真机验证清单步骤 6）；
（b）模型侧独立验证通过 —— 见下方「候选 1」，它可能构成**第二道独立阻断**。
因此**不得因根因已定位就宣布 bug 已修复**。

### 尚未排除的开放项（第四轮重排：候选 2 升为已确认；候选 1 依据部分撤回）

**「零回复」症状未被第 2 项完全解释。** 补丁丢失后，飞书文本消息会落回路径 B 的 Hermes 原生会话
（`handle_message`），而原生会话本应仍然产生回复；用户报告的是**完全无回复**。因此缺口一定在路径 B 侧或飞书应用侧。

**第四轮状态更新（覆盖下方各候选的强度排序）**：候选 2 已确认为直接原因，不再是候选；候选 1 的第二轮出站失败
依据已撤回，降为「开放项 · 依据回到制度性状态」，但作为**第二道可能阻断**仍需独立验证；候选 3、4、5 保持开放，
均**未在真机关闭，一律标记未验证**。各候选原文保留于下，以完整记录判断迁移过程。

**候选 1（第四轮改判 · 仍是开放项 · 依据回到「制度性状态」，出站失败证据已撤回）· 模型侧回复能力可能仍不完整。**
**本项的第二轮机制认定（出站 HTTP 连接持续失败 → 必然完全静默）在本轮被撤回**：第三轮主机名/模块名直方图
已证伪该证据归属（`ConnectError` 974 / `NetworkError` 349 / `ConnectTimeout` 34 全部归属 Telegram 平台插件，
与飞书链路和模型 provider 均无关，**已实测**）。那批 `ConnectError` 证据**不再属于本项依据**。
本项的现有依据回到**制度性状态**：外部直连诊断实测 A君 模型状态仍为 `model_transport_pending`、
运行台飞书通道显示为空（**已实测**）；`ajun.profile.json` 的
`credentialedTransportVerification.status` 为 `model-transport-pending`、`fallbackModels` 为 `[]`（已核实）。
**含义**：**白名单修复后仍可能无回复**，模型侧须独立验证。
**边界**：`model-transport-pending` 按 ADR-0013 是「缺少凭据调用证据」的制度性状态，
**不等于「模型已确认不可用」**；模型侧是否真的不可用属**未验证**。

以下为第二轮原文，**整体保留作为已撤回记录，不再作为当前依据**：

**候选 1（第二轮记录 · 已撤回）· 出站 HTTP 连接持续失败 + 回退链按 ADR 决策显式为空 → 必然完全静默。**
上一轮把本项的机制写为「主模型传输未验证（`credentialedTransportVerified:false`）」这一**制度性状态**，本轮真机日志证明
实际机制不同且更强：`gateway.error.log` 尾部 20000 行内 `ConnectError` 974 次（另有 `NetworkError` 349、
`RemoteProtocolError` 80、`ConnectTimeout` 34、`ReadError` 2，均为 httpx 出站异常族，**已实测**），即出站连接正在
持续失败。结合 `docs/adr/0013-stepfun-primary-reasoning-restoration.md` 两条已逐字核实的原文 —— 第 81 行
「endpoint 为 `api.stepfun.com/step_plan/v1`，凭据存在且 fallback 为空」，第 33–34 行「本次不恢复历史 DeepSeek
文本回退，避免 StepFun 不可用时静默产生另一家 Provider 调用与费用」—— 可得：**出站连不上 + 回退链按 ADR 决策
显式为空 = 必然完全静默**。这与用户报告的「完全无回复」症状完全吻合，且与路径 A 的 adapter 补丁无关。
**必须同时写明的限制（不得 overclaim）**：异常类名只能证明「出站连接在失败」，**不能证明失败目标就是 StepFun
endpoint**；目标主机未经确认，属**未验证**；也可能同时或另有其他出站目标在失败。因此本项状态为
「**已实测出站失败，目标主机未确认**」，是当前最强候选，仍不构成结论。（对应新增条款 1.28、2.32–2.34。）
上一轮记录的制度性事实仍然成立并作为背景保留：
`integrations/hermes/profiles/ajun.profile.json` 的 `localProfile.credentialedTransportVerified` 为 `false`，
`credentialedTransportVerification.status` 为 `model-transport-pending`、`primary` 为 `stepfun / step-3.7-flash / verified:false`、
`fallback` 为 `null`；顶层 `fallbackModels` 为 `[]`。`docs/adr/0013-...md` 明确「回退链保持为空」「本次不恢复历史
DeepSeek 文本回退」，并规定「没有当前凭据调用证据前，Profile 保持 `model-transport-pending`」。
13 个 profile 里 12 个 `credentialedTransportVerified:false`，唯一 `true` 的 `task-coordinator` 已按
`integrations/hermes/README.md`「任务协调官已并入 A君并退役」退役。
**含义**：主模型调不通时没有任何回退，会直接静默失败，症状与用户报告一致，且与路径 A 补丁无关。
**必须同时说明的边界**：`credentialedTransportVerified:false` 按 ADR-0013 是「缺少凭据调用证据」的**制度性状态**，
不等于「模型已确认不可用」；它只把本项抬为**最强候选**，不构成结论。ADR-0013 另规定运行期有效模型以
外部策略文件 `stepfun-model-policy.json` 与实际 Profile 回读为准，仓库 Manifest 只是发布初始值 —— 因此
「实际生效的 provider/model」同样未验证。

**候选 2（第四轮：已确认为直接原因，不再是候选）· Hermes 网关侧飞书用户准入白名单拒绝发送者。**
第四轮外部直连诊断已实测确认：消息到达网关后被当作未授权用户丢弃，签名形状为
「`Unauthorized user:` + 账号标识 + 姓名 + `on feishu`」（三条消息），且不产生任何用户可见说明。
本项由此从「未排除的候选」升为**已确认的直接原因**，详见上方「根因已确认（第四轮）」。
新发现的结构性缺陷是**两套白名单无单一真相、无漂移检测**（军团侧允许、网关侧拒绝，见新增条款
1.30–1.33、2.38–2.42）。以下为本项此前的记录，保留其历史先例与判定边界：

该机制在本仓库有**已确认的历史真机先例**：
`docs/reviews/m1-xiaod-feishu-closure/acceptance.md` 记录 2026-07-19 的诊断结论为「飞书投递与 Hermes WebSocket
适配器正常，阻塞点是 `FEISHU_ALLOWED_USERS` 未匹配发送者的用户 `open_id`」，入站事件全部为 `dm_policy_rejected`，
修正白名单并重启 Gateway 后恢复。该症状同样是**完全零回复**。（对应新增条款 1.18。）
**本轮修正 · 旧关键词判定不成立，本项仍未排除。** 真机 `gateway.log` 的 `policy=0`（**已实测**）证明
`dm_policy_rejected` 这一措辞在 Hermes `0.20.1` 的日志里根本不存在 —— 它取自上述 2026-07-19 的 0.19 时代记录，
且该记录本身未登记当时的 Hermes 版本（已核实）。因此上一轮的 `dm_policy=0` / `no_llm=0`**不构成「白名单正常」
或「模型配置正常」的证据**，只说明这两个旧关键词未出现。其中 `no llm provider` 的**来源为
`docs/reviews/m1-xiaod-feishu-closure/acceptance.md:92`**，该处以 `RuntimeError: No LLM provider configured`
的形式记录（2026-07-19，同样**未登记当时的 Hermes 版本**）。**此处更正上一轮的事实错误**：上一轮称该措辞
「在本仓库任何文件中都检索不到、**来源无据**」并标注「已核实」，实为用小写 `no llm provider` 检索导致的
**大小写敏感漏检**，该未经证实的结论被**误标为「已核实」**。该更正**加强**原论点 —— 该措辞正是 0.19 时代
针对「Profile 未在 `config.yaml` 选择模型 Provider」这一**不同故障**的措辞，用它匹配 0.20.1 的零回复故障
本就不成立。
这与本 spec 已记录的 `config.yaml` 字段名猜测（缺陷 D）是**同一类错误**。实测事实为 `reject=7`（低但非零）
与 `feishu=1223`（飞书事件大量到达）；`reject` 那 7 次的性质**未确认**，白名单是否命中**仍未验证**。
（对应新增条款 1.26、2.35。）

**候选 3（本轮降级，不删除）· 飞书应用事件订阅侧**（未订阅消息事件、事件回调地址失效、应用被停用）。
降级依据：`gateway.log` 的 `feishu=1223` 且该日志写到当前时间（**已实测**），说明飞书事件确实在到达 Hermes。
本项不删除 —— 仍未在真机逐项关闭，且尾部 500 行内 `feishu=0` 的含义未确认。

**候选 4（本轮新增开放项）· Agent Army MCP 这条腿失联，且诊断对此无任何判定。**
`mcp-stderr.log` 与 `gateway-exit-diag.log` 自 08-18 23:57 起停止写入，而 Gateway 其余日志持续到 08-19 11:21
（约 11.5 小时落差，**已实测**）；`gateway.log` 全部 25741 行内 `mcp|agent-army` 仅出现 **1 次**（**已实测**）。
`docs/adr/0007-...md` 决定 3 规定「A君以本机 MCP Server 向 Hermes 暴露军团工具」，其《对话与任务边界》拓扑中
MCP 是从 Hermes 模型通往「A君本机任务与能力适配」的**唯一被描述的通道**，并规定「查询状态先调用只读 MCP 工具，
不能凭模型记忆编造」；MCP 不被调用意味着即使模型可用，军团能力在飞书侧也拿不到。
**限制**：日志停止写入与出现次数少**不能证明 MCP server 已崩溃或未加载**，只能证明「近 11.5 小时无 stderr 输出
且 Gateway 侧极少提及」，具体状态属**未验证**。（对应新增条款 1.27、2.36。）

**候选 5（附带开放项）· Hermes 错误日志无人管理，信号被淹没。**
`gateway.error.log` 已达 460144 行且持续增长（**已实测**）。用户真机 `config.yaml` 存在 `logging.max_size_mb` /
`logging.backup_count` 键（用户实测所报，属真机侧事实），而仓库内检索不到任何对 Hermes gateway 日志轮转的约定
或校验（已核实：`logrotate` / `max_size` / `backup_count` / 「轮转」零命中）。46 万行错误日志既是故障信号被淹没
的原因，也是运维负担。（对应新增条款 1.29、2.37。）

**A君 Profile 的承载事实**：`ajun.profile.json` 的 `gateway.runtimeProfile` 为 `"default"`，
`reason` 记为「当前 A君飞书应用由 Hermes default Profile 常驻 Gateway 承载；独立 ajun Profile 保留为隔离与回退身份」。
即诊断必须针对 **default Profile 的 `HERMES_HOME`**，与真机 config.yaml 路径一致；独立 `ajun` Profile 目录不是承载体。

**design.md 推翻条件的实际状态（如实分级）**：该文档 §Exploratory 的字面推翻条件是
「若 `_route_ajun_commander_event` 在位、六项全 `pass` 而飞书仍无回复」。真机上第 2 项为 `gap`、第 5/6 项为 `unknown`，
**字面前提不成立，故字面条件未被触发**；但它要保护的实质推理（症状未被已定位项解释即须回到需求重新假设）
已被真机症状触发。按实质处理：**根因假设需要修订** —— 路径 A 缺口从「主线根因」降为「真实缺口但非充分原因」，
路径 B 的模型传输未验证 + 无回退升为最强候选。

**本轮（第二轮）该推翻条件再次被实质触发。** 真机日志实证使根因假设从「adapter 补丁缺口」进一步修正到
「**出站 HTTP 连接持续失败 + 回退链按 ADR-0013 显式为空 → 必然完全静默**」。字面推翻条件依旧不成立
（第 2 项仍为 `gap`），但实质推理已第二次触发：症状的主导解释再次落在六项检查完全看不到的地方。
明确记录本轮的假设迁移路径：**假设 2（补丁存活性无人校验）→ 已在真机确认为真实缺口，但非零回复的充分原因；
新主导假设 = 出站失败 + 无回退**（目标主机未确认）；并新增独立开放项 **MCP 腿失联**（状态未验证）。
据此，design.md 的《Hypothesized Root Cause》与《Testing Strategy》在下一次进入 design 阶段时须同步修订
—— 本轮按约束**只更新 bugfix.md**，未改动 design.md / tasks.md / real-machine-verification.md。

**本轮（第四轮）该推翻条件第三次被实质触发，且本轮同时给出确认级结论。** 根因假设的完整迁移过程如下：

| 轮次 | 主导假设 | 结局 |
|---|---|---|
| 第一轮 | 假设 2 · adapter 补丁存活性无人校验（1.3） | **证伪其充分性** —— 补丁缺口是真实缺口，但消息会落回路径 B，不足以解释完全零回复 |
| 第二轮 | 出站 HTTP 连接持续失败 + 回退链为空 → 必然静默 | **已撤回** —— 第三轮证明该批异常归属 Telegram 插件，与飞书链路无关 |
| 第三轮 | （方法修正轮，未提出新根因） | 按子系统归属后证伪第二轮，并交付 `hermes-log-attribution`（PR #12） |
| 第四轮 | Hermes 网关侧准入白名单拒绝发送者 | **已确认为直接原因**（外部直连诊断实测） |

**连续三次证伪的共同原因不是任何单个候选，而是同一个方法缺陷：依赖猜测的外部标识符 + 缺少证据归属。**
三次分别表现为：猜 `config.yaml` 字段名（缺陷 D）、用 0.19 时代的日志措辞匹配 0.20.1（缺陷 H）、
把无子系统归属的聚合异常计数当作飞书链路证据（第三轮所证伪者）。**既有条款 2.35 正是针对这一缺陷设立的**
—— 它要求任何依赖外部标识符的判定必须标注来源与适用版本、失配时报「不适用」而非「未命中」——
**但本 spec 自身的排查过程未遵守它**。这比任何单个候选根因都更根本，也是本轮新增条款 2.43–2.45
（日志归属必须覆盖非异常型拒绝记录、多版本措辞并标注适用范围）的直接动因。

据此重申：**不得因为定位到第 2 项就宣布 bug 已修复** ——
只有真机验证清单步骤 6（飞书会话内出现业务回复或可归因中文说明）通过，才可判定本 spec 的验收目标达成。
本轮根因已定位，该重申**仍然成立**：白名单对齐只解除第一道阻断，模型侧可能构成第二道。

## Bug Analysis

### Current Behavior (Defect)

用户发出文本消息后，任一环节失败都可能不产生任何用户可见的说明，也不留下可判定的本机证据。

1.1 WHEN `AJUN_FEISHU_COMMANDER_INGRESS_URL` 未注入 Hermes launchd 环境 THEN 系统在 `_route_ajun_commander_event` 开头静默 `return False`，飞书会话内没有任何说明
1.2 WHEN `AGENT_ARMY_FEISHU_AGENT_ID`（旧安装兼容 `AJUN_FEISHU_ENTRY_AGENT_ID`）不等于 `ajun` THEN 系统在 Profile guard 处静默 `return False`，用户无法得知消息未进入总管路由
1.3 WHEN Hermes 升级覆盖 `adapter.py` 使 `_route_ajun_commander_event` 整体丢失 THEN 消息落回普通 `handle_message`，系统不提示补丁已失效
1.4 WHEN A君 4321 未监听（launchd 未加载或不可变 release 未上线）THEN 系统仅发送不含归因的降级文案；若 `self.send` 同时失败则飞书会话内彻底无声
1.5 WHEN 请求来源未通过 `isLocalAddress` 校验（如混合在线部署接线错误）THEN 系统返回 403 且仅写入本机 warning 日志，飞书会话内没有说明
1.6 WHEN Hermes Gateway 进程未运行 THEN 飞书事件无人消费，本机不产生可判定「消息是否到达」的证据
1.7 WHEN 发送者不在飞书用户准入白名单内 THEN 消息被丢弃，用户收不到「未获准入」的说明
1.8 WHEN A君返回 `handled:false` 而 Hermes 模型侧异常（入口、密钥、预算或轮次上限）THEN 飞书会话内没有回复，用户无法区分「有意静默」与「链路故障」
1.9 WHEN 用户想自行定位无回复原因 THEN 系统没有任何本机一次性诊断入口，只能逐个环节猜测
1.10 WHEN 用户按根 `README.md` 的「运行 A君运行台」段落启动服务 THEN 系统实际在 4322 以关闭飞书后台协调服务的开发实例运行，而文档标注为 4321，使用户误判飞书链路已就绪

以下四条由真机验证新发现（缺陷 A：1.11–1.13；缺陷 B：1.14）：

1.11 WHEN `adapter-patch` 判定为 `gap` 且证据中 `hermesVersionMatchesBaseline` 为 `false` THEN 系统仍输出「重跑补丁脚本 `patch-feishu-agent-proposal-router.mjs`」作为唯一下一步，而该脚本会被版本锁定校验拒绝执行，用户按指令操作只会得到版本门禁错误，「唯一下一步必须可执行」的初衷落空
1.12 WHEN `profile-guard` 因 `guardMarkerPresent` 为 `false` 判定为 `unknown` 且 `hermesVersionMatchesBaseline` 为 `false` THEN 系统同样输出「重跑补丁脚本恢复 guard 标记」作为下一步，该指令在版本漂移下同样无法执行
1.13 WHEN 观测层计算 `hermesVersionMatchesBaseline` THEN 系统只比对 `pyproject.toml` 的 version 与基线版本号，不比对 Hermes 安装的 git HEAD；而版本锁定校验要求版本号与 git commit **两者同时匹配**，因此该字段为 `true` 时补丁脚本仍可能被门禁拒绝，判定与门禁不同源
1.14 WHEN 飞书准入白名单在 Hermes `config.yaml` 中使用的字段名不在硬编码候选列表内 THEN 系统报 `errorCode:"admission_field_not_found"`、`configured:false`，`feishu-admission` 一项永远给不出结论，且用户无法在不改代码的情况下让该项判定生效

以下十条由本轮链路重定义与仓库事实复核新发现（缺陷 C 链路主线错位：1.15–1.17；缺陷 D 准入检查找错位置：1.18–1.19；缺陷 E 平行实现：1.20–1.21；缺陷 F 升级韧性缺失：1.22–1.24）：

1.15 WHEN 诊断给出链路结论 THEN 系统只沿「adapter 补丁路由 → 4321 → `commander.handle()`」一条路径判定，不覆盖 `docs/adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md`（状态「已接受，已实施」）定义的 Hermes 原生会话 + Agent Army MCP 主路径，使补丁缺口被当作零回复的唯一或充分原因
1.16 WHEN 六项检查执行完毕 THEN 系统对 Hermes 原生会话侧一律无判定：`config.yaml` 的 `mcp_servers.agent-army` 是否存在且 `enabled`、主模型 provider/model 实际取值是否与 `ajun.profile.json` 的 `modelSelection` 基线一致、`credentialedTransportVerified` 是否仍为 `false`、`fallbackModels` 是否为空，均无对应字段，用户拿不到任何原生路径线索
1.17 WHEN 主模型传输未取得凭据调用证据（`credentialedTransportVerified:false`、`credentialedTransportVerification.status:"model-transport-pending"`）且 `fallbackModels` 为 `[]`（`docs/adr/0013-...md` 明确不恢复 DeepSeek 文本回退）THEN 系统不报告「模型调不通时没有任何回退、会直接静默无回复」，也不把它列为零回复候选根因，用户无法看到当前最强候选
1.18 WHEN 系统判定飞书用户准入 THEN 它在 Hermes `config.yaml` 内按七个硬编码候选字段名扫描，而仓库内可核实的真实准入配置是 **Hermes Profile 本地环境文件中的 `FEISHU_ALLOWED_USERS`**（`apps/ajun-runtime/scripts/provision-hermes-employee-feishu.mjs` 写入 `<profileDir>/.env`，`integrations/feishu/README.md` 说明它只能填授权人员的用户 `open_id` 且变更后须重启 Gateway）；检查因此找错了配置位置，永远返回 `admission_field_not_found`，并漏掉 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md` 已记录过的「白名单不命中 → `dm_policy_rejected` → 完全零回复」这一已验证故障模式
1.19 WHEN 诊断入口在「只读、绝不读取 `.env`」的硬性约束下运行 THEN 由于真实准入配置只存在于 `.env`，`feishu-admission` 一项在当前约束内**结构上不可判定**，而系统用 `admission_field_not_found`（「字段找不到」）这一错误码表述，掩盖了「位置正确但按约束不可读」与「位置找错」两种情形的区别
1.20 WHEN 需要解析 Hermes `config.yaml` THEN 系统在 `apps/ajun-runtime/src/feishu-commander-chain-observations.ts` 内手写行扫描解析器 `scanAdmissionWhitelist()`，而仓库已存在两处可复用能力：`integrations/hermes/scripts/set-feishu-toolsets.py` 的 `inspect` 动作（用 Hermes 自带 venv python 安全解析，输出 `mcp`（含 `enabled`、`timeout`、按白名单过滤的 scope env、命令/参数摘要）、`feishuToolsets`、`runtimePolicy`，并内建 `audit-config-secrets` 凭据审计与失败关闭）与 `integrations/hermes/scripts/check-hermes-business-profile-policy.mjs`（`evaluateHermesBusinessProfilePolicy()` / `checkHermesBusinessProfileHomes()`），构成 `AGENTS.md`「复用优先／不得为已有工具覆盖的问题另造平行实现」的违反
1.21 WHEN `scanAdmissionWhitelist()` 扫描 `config.yaml` THEN 它按裸键名逐行匹配、不区分父级路径，任何嵌套层级下的同名键（例如其他平台段落或无关配置段内的 `allowlist`）都会被当作飞书准入白名单返回，并以 `configured:true` 连同 `entryCount` 输出，形成用户无法察觉的假阳性
1.22 WHEN 诊断计算版本基线 THEN 它从 `integrations/hermes/scripts/patch-support.mjs` 取 `SUPPORTED_HERMES_VERSION`（`0.19.0`），而仓库内版本基线已三处重复且已漂移：`patch-support.mjs` 为 `0.19.0`、`integrations/hermes/runtime/agent_army_feishu_task_card.py` 为 `0.19.0`、`integrations/hermes/scripts/install-xiaod-public-video-bridge-v2.mjs` 已适配 `0.20.1`（含独立 commit pin）；真机 `0.20.1` 因此必然判为不匹配，且没有任何地方报出「基线自身漂移」这一事实
1.23 WHEN Hermes 升级覆盖 `adapter.py` 后 Gateway 重新启动 THEN 启动门禁 `integrations/hermes/scripts/start-hermes-gateway-guarded.mjs` 只校验技能白名单收敛与 bundled skills 退出，不校验补丁是否在位、也不校验版本/commit 是否仍在基线，Gateway 照常启动，故障只能在用户发出飞书消息且收不到回复时才被发现，同一缺陷会在每次升级后重复发生
1.24 WHEN 记录长期方向 THEN 现状与 ADR-0007 的既有结论相反：该 ADR 已决定「业务工具不再写入 Hermes 安装目录补丁」，而飞书总管链目前仍依赖十余个写入 Hermes 安装目录的补丁脚本，且仓库没有记录「哪些补丁是必需的、哪些可由原生能力 + MCP 替代」，使每次升级都必须重新适配整包补丁

以下五条由本轮真机日志实证新发现（缺陷 G 诊断不读 Hermes 自身日志：1.25；缺陷 H 标识符猜测被实证：1.26；缺陷 I MCP 腿活性无判定：1.27；缺陷 J 无回退状态不被告知：1.28；缺陷 K 错误日志无轮转：1.29）：

1.25 WHEN 六项诊断执行完毕 THEN 系统完全不读取 Hermes 自身的日志（`apps/ajun-runtime/src/feishu-commander-chain-diagnosis.ts` 与 `feishu-commander-chain-observations.ts` 内不存在任何日志读取路径，已核实），而真机 `gateway.error.log` 尾部 20000 行的异常类名直方图为 `ConnectError` 974 / `Error` 357 / `NetworkError` 349 / `RemoteProtocolError` 80 / `ConnectTimeout` 34 / `ReadError` 2 / `CancelledError` 2（**已实测**，仅提取类名未读消息正文），全部属 httpx 出站异常族，即**出站 HTTP 连接正在持续失败**；该决定性信号在诊断输出中完全不可见，使当前最强活跃阻断点无法被任何一项检查发现
1.26 WHEN 排查依据来自外部系统的标识符 THEN 系统用旧版本措辞匹配当前版本并把失配表述为「未命中」：真机 `gateway.log` 全量计数中 `policy=0`（**已实测**）证明 `dm_policy_rejected` 这一措辞在 Hermes `0.20.1` 的日志里根本不出现，而该措辞取自 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md`（日期 2026-07-19，该记录**未登记当时的 Hermes 版本**，已核实）；另一个曾被用作判据的 `no llm provider`，其**来源为 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md:92`**，该处以 `RuntimeError: No LLM provider configured` 的形式记录（日期 2026-07-19，该记录**同样未登记当时的 Hermes 版本**）；**此处更正上一轮的事实错误** —— 上一轮称该措辞「在本仓库任何文件中都检索不到、**来源无据**」并标注「已核实」，这是用小写 `no llm provider` 检索导致的**大小写敏感漏检**，属检索方法失误，且该未经证实的结论被**误标为「已核实」**；该更正**加强而非削弱本条论点**：该措辞恰恰是 0.19 时代针对「Profile 未在 `config.yaml` 选择模型 Provider」这一**与本 spec 完全不同的故障**的措辞，因此用它匹配 0.20.1 的零回复故障本就不成立，其计数为 0 更不构成「模型配置正常」的证据；同时这次漏检本身又是一次「未溯源即断言」，正是本条所批评的错误类型；仓库内另有被标记「已验证」的正向签名（`Inbound dm message received` / `inbound message: platform=feishu` / `response ready: platform=feishu` / `[Feishu] Sending response`，见 `docs/guides/创建Hermes-Agent与飞书Bot接线教程.md` 与 `docs/archive/handoffs/av-transcriber-feishu-provisioning-handoff.md`）同样**未登记适用版本**且诊断未使用；因此「旧关键词计数为 0」既不构成「白名单正常」也不构成「模型配置正常」，只说明旧关键词未出现，与缺陷 D（`config.yaml` 字段名猜测）属**同一类错误**：失配时返回「未命中」而非「该标识符在当前版本不适用」，使排查者把「没匹配到」误读成「该故障不存在」
1.27 WHEN 诊断给出链路结论 THEN 系统对 Agent Army MCP 这条腿的活性无任何判定，而真机上该腿已呈失联迹象：`mcp-stderr.log` 与 `gateway-exit-diag.log` 的 mtime 停在 08-18 23:57，而 `gateway.log` / `gateway.error.log` / `errors.log` / `agent.log` 持续写到 08-19 11:21（约 11.5 小时落差，**已实测**），且 `gateway.log` 全部 25741 行内 `mcp|agent-army` 仅出现 **1 次**（**已实测**）；ADR-0007 决定 3 规定「A君以本机 MCP Server 向 Hermes 暴露军团工具」，其《对话与任务边界》拓扑中 MCP 是从 Hermes 模型通往「A君本机任务与能力适配」的**唯一被描述的通道**，且「查询状态先调用只读 MCP 工具，不能凭模型记忆编造」；MCP 不被调用意味着即使模型可用，军团能力在飞书侧也拿不到
1.28 WHEN 出站连接失败而 `fallbackModels` 按 `docs/adr/0013-stepfun-primary-reasoning-restoration.md` 显式为空 THEN 结果必然是完全静默（无业务回复、无错误提示、无降级说明），而系统不在任何地方报告「当前处于无回退状态、一旦出站失败即静默」这一事实，用户与运维无法预先知道该风险，也无法在故障发生时把静默归因到它
1.29 WHEN Hermes gateway 错误日志持续增长 THEN 无任何轮转或规模约定对其生效：真机 `gateway.error.log` 已达 460144 行且仍在写入（**已实测**），而仓库内检索不到任何针对 Hermes gateway 日志的轮转约定、规模阈值或校验（`logrotate` / `max_size` / `backup_count` / 「轮转」在仓库内零命中；`rotate` 的命中仅为 LAN 共享密钥轮换与 `boom-monitor` 备份保留，与 Hermes 日志无关，已核实）；46 万行错误日志本身既使故障信号被淹没，也构成运维负担

以下八条由第四轮外部直连诊断确认根因后新发现（缺陷 L 两套准入白名单无单一真相：1.30–1.33；缺陷 M 日志归属漏掉非异常型拒绝记录：1.34–1.36；缺陷 N 第二道阻断不被告知：1.37）：

1.30 WHEN 飞书用户准入被配置 THEN 系统并存两套互不校验的准入白名单：军团侧 `<AGENT_ARMY_PRIVATE_DIR>/feishu-agent-apps.json` 的 `apps[].allowedUserIds`（`apps/ajun-runtime/src/agent-feishu-app-store.ts`，schema `agent.army/feishu-agent-apps/v1`，经 `agent-feishu-channel-fleet.ts` 的 `agentChannelOptions()` 成为军团自有飞书通道的 `policy.dmAllowlist`）与 Hermes 网关侧 Profile 本地环境文件中的 `FEISHU_ALLOWED_USERS`（由 `apps/ajun-runtime/scripts/provision-hermes-employee-feishu.mjs` 写入，A君 对应 profileDir 即 `HERMES_HOME`）；两者可以不一致，而系统没有任何单一真相、对齐校验或漂移检测（已核实：仓库内 `allowlistDrift` / `whitelistDrift` 零命中，既有「漂移」校验全部属 release、技能审计与治理同步，与准入白名单无关）

1.31 WHEN 用户从运行台更新某员工的飞书准入人员 THEN `EmployeeFeishuConnectionService.connect()` 只写军团侧 store 并调用 `fleet.startApp(app)`，不调用 `provisionHermesEmployeeFeishu`（已核实：该函数在仓库内只有定义处与自身 CLI 两处引用），因此 Hermes 网关侧 `FEISHU_ALLOWED_USERS` 保持上一次 provision 时刻的取值；两套白名单的同步是**单向且仅发生在 provision 时刻**的一次性拷贝，此后各自漂移无人发现，且 `integrations/feishu/README.md` 已记录白名单变化后必须重启 Gateway 才生效这一额外前提

1.32 WHEN 军团侧白名单允许某发送者而 Hermes 网关侧白名单不允许（第四轮真机即为此状态，**已实测**）THEN 消息在到达网关后被静默丢弃，军团侧看起来「已授权」，**两侧都不向用户产生任何可见说明**，用户只观察到完全零回复，且无法区分「未获准入」与「链路故障」

1.33 WHEN 需要判定 A君 的准入白名单以哪一侧为准 THEN `ajun.profile.json` 的 `gateway` 块内不声明准入来源（对比 `xiaod.profile.json` 声明了 `allowedUsersSource:"environment:FEISHU_ALLOWED_USERS"`，已核实），因此连「哪一套白名单是 A君 飞书准入的真相」这一事实在仓库内都没有可核对的声明，排查者只能靠猜

1.34 WHEN 本分支已交付的日志归属工具（`apps/ajun-runtime/src/hermes-log-attribution.ts` 与 `apps/ajun-runtime/scripts/attribute-hermes-logs.mjs`，PR #12）扫描 Hermes 错误日志 THEN 它只识别以 `Traceback (most recent call last):` 开头的异常块（已核实：解析由 `TRACEBACK_HEADER` 门控，归属依据为最深的非第三方栈帧或日志器名），而用户准入拒绝在真机上是一条**不带 traceback 的结构化日志行**（签名形状为「`Unauthorized user:` + 账号标识 + 姓名 + `on feishu`」，本文档只描述形状不记录任何真实取值），因此该类飞书相关拒绝记录被完全漏掉

1.35 WHEN 飞书侧的失败全部以非异常型拒绝记录存在（第四轮真机即为此情形）THEN `feishuChainTracebacks` 为空，`renderAttributionVerdict()` 输出「扫描窗口内没有任何归属到飞书链路的 traceback…飞书侧的失败根本没有被记录到错误日志…这本身是一个证据缺口」，CLI 退出码为 `1`（已核实为该函数与 CLI 的既有行为），**而真机上失败被记录得非常明确**；该工具因此会把「已明确记录的失败」主动误报为「失败未被记录」，是一个会主动误导排查者的缺陷，且恰好发生在为消除误导而建的工具上

1.36 WHEN 归属工具需要识别飞书侧拒绝记录 THEN 它没有任何拒绝措辞的来源与适用版本登记：当前 Hermes 版本的准入拒绝签名形状与 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md` 记录的 0.19 时代 `dm_policy_rejected` **措辞不同**（已实测：两种措辞并存于不同版本），而工具既不容纳多版本措辞、也不标注各措辞的适用范围，构成既有条款 2.35 所确立原则在新工具上的未落实

1.37 WHEN 网关侧准入白名单缺口被修复 THEN 系统不告知「回复能力可能仍不完整」这一并存阻断：`ajun.profile.json` 的 `credentialedTransportVerification.status` 仍为 `model-transport-pending`（已核实），运行台按 `agent-registry.ts` 与 `employee-feishu-connection-service.ts` 把该状态呈现为 `model_transport_pending`「独立身份已建立，模型授权和真实调用仍待完成」（已核实），且第四轮外部直连诊断实测 A君 运行台飞书通道显示为空（**已实测**）；用户可能在准入修好后仍收不到回复，而没有任何地方预先说明这是第二道独立阻断（模型侧是否真的不可用属**未验证**）

### Expected Behavior (Correct)

每一种失败路径都必须产出飞书会话内可读的中文说明（发生了什么、是否启动了外部动作、下一步做什么），或至少在本机留下可判定的诊断证据；并提供一次性自检入口。

2.1 WHEN `AJUN_FEISHU_COMMANDER_INGRESS_URL` 未注入 Hermes launchd 环境 THEN 系统 SHALL 在本机留下可判定的「已声明但未配置」诊断证据，并使诊断入口报告该变量缺失
2.2 WHEN `AGENT_ARMY_FEISHU_AGENT_ID` 不等于 `ajun` THEN 系统 SHALL 使诊断入口报告实际 `agentId` 与期望值 `ajun` 的差异，并说明该 Profile 不拥有总管文本路由
2.3 WHEN `_route_ajun_commander_event` 在 `adapter.py` 中缺失 THEN 系统 SHALL 通过诊断入口报告补丁不在位，并给出重跑 `integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs` 的唯一下一步
2.4 WHEN A君 4321 不可达 THEN 系统 SHALL 在飞书会话内回复可归因的中文说明，明确未启动任何外部动作，并指向本机自检；`self.send` 亦失败时 SHALL 在本机留下带 `sourceEventRef` 的失败证据
2.5 WHEN `/api/feishu/commander` 因 `isLocalAddress` 返回 403 THEN 系统 SHALL 在飞书会话内说明入口拒绝了非本机调用且未启动任何外部动作，并在本机留下同一事件的证据
2.6 WHEN Hermes Gateway 进程未运行 THEN 诊断入口 SHALL 报告 Gateway 进程与 launchd 标签 `ai.hermes.gateway` 的实际状态，并明确「飞书消息此刻无人消费」
2.7 WHEN 发送者不在飞书用户准入白名单内 THEN 系统 SHALL 使诊断入口报告白名单是否命中，并说明消息因未获准入而被丢弃
2.8 WHEN A君返回 `handled:false` THEN 系统 SHALL 在本机记录该次「有意不建任务」的判定证据（含 `reason`），使无回复可与链路故障区分
2.9 WHEN 用户或运维触发本机诊断入口 THEN 系统 SHALL 一次性判定并逐项输出：Gateway 进程、adapter 补丁是否在位、必需环境变量是否注入、4321 是否可达且为预期 release、Profile guard 是否匹配、白名单是否命中；每项 SHALL 标注结论所处的能力真相层级（已声明 / 已配置 / 运行可达），且 SHALL NOT 用前一层冒充后一层
2.10 WHEN 用户查阅运行说明以启动飞书可用的服务 THEN 文档 SHALL 明确区分正式 4321（launchd 受控、跑不可变 release、飞书链路生效）与开发 4322（`AJUN_DISABLE_BACKGROUND_SERVICES=true`、飞书链路不通）
2.11 WHEN 诊断入口输出任何结论 THEN 系统 SHALL NOT 回显 secret、token、Cookie、授权链接或真实 `.env` 内容
2.12 WHEN 需要实现上述诊断能力 THEN 系统 SHALL 复用既有 `deterministic-local-health-probe.ts`、`/api/health`、`scripts/runtime-fingerprint.mjs` 与 `ops/ajun-release-helper/`，SHALL NOT 新建平行的诊断或控制面实现

以下七条对应真机新发现的缺陷（缺陷 A：2.13–2.17；缺陷 B：2.18–2.19）：

2.13 WHEN `adapter-patch` 判定为 `gap` 且 `hermesVersionMatchesBaseline` 为 `false` THEN 该项的唯一下一步 SHALL 说明补丁脚本已被版本锁定校验挡住（并给出实际版本与基线版本），且 SHALL 指向「补丁锚点需针对当前 Hermes 版本重新适配」，SHALL NOT 把「直接重跑补丁脚本」作为唯一下一步
2.14 WHEN `profile-guard` 因 `guardMarkerPresent` 为 `false` 判定为 `unknown` 且 `hermesVersionMatchesBaseline` 为 `false` THEN 该项的下一步 SHALL 同样说明版本锁定原因并指向锚点重新适配，SHALL NOT 建议直接重跑补丁脚本
2.15 WHEN 诊断因版本漂移调整下一步 THEN 系统 SHALL NOT 建议降低、绕过、放宽或删除版本锁定校验；该门禁挡住的正是「锚点对不上却硬打补丁」，SHALL 在结论中把它表述为保护而非障碍
2.16 WHEN `hermesVersionMatchesBaseline` 为 `null`（基线版本未注入、或 `pyproject.toml` 读不出）THEN 系统 SHALL 把它原样报为观测事实并说明版本无法判定，SHALL NOT 冒充「匹配」或「不匹配」，且 SHALL NOT 因此使诊断失败退出
2.17 WHEN 判定补丁脚本是否可执行 THEN 版本基线比对 SHALL 与版本锁定校验同源（版本号与 git commit 两者），或在只比对到版本号时 SHALL 明确标注该结论不足以证明门禁会放行
2.18 WHEN 用户需要让 `feishu-admission` 一项给出结论 THEN 准入白名单的候选字段路径 SHALL 可由调用方通过 CLI 参数或环境变量配置，使用户无需改动代码即可完成该项判定
2.19 WHEN 使用调用方提供的候选字段路径 THEN 系统 SHALL 只把配置值当作字段名使用，SHALL NOT 把 Hermes `config.yaml` 的字段值回显到输出，现有脱敏与摘要化处理 SHALL NOT 因可配置而放宽

以下十二条对应本轮新发现的缺陷（缺陷 C：2.20–2.22；缺陷 D：2.23–2.25；缺陷 E：2.26–2.28；缺陷 F 升级韧性：2.29–2.31）。**2.18 在当前 Hermes 版本下前提不成立**（真实准入配置不在 `config.yaml`），其目标由 2.23–2.25 取代；design 阶段须显式说明 2.18 的处置方式：

2.20 WHEN 诊断入口运行 THEN 系统 SHALL 覆盖 Hermes 原生会话侧，至少判定三项：（a）`config.yaml` 的 `mcp_servers.agent-army` 是否存在且未被 `enabled:false` 关闭；（b）实际生效的主模型 provider/model 是否与 `ajun.profile.json` 的 `modelSelection` 基线一致；（c）`credentialedTransportVerified` 是否仍为 `false`（即主模型传输尚未取得凭据调用证据）。每项 SHALL 标注所处能力真相层级并 SHALL NOT 超过其上限
2.21 WHEN 主模型传输未验证且 `fallbackModels` 为空 THEN 系统 SHALL 明确说明「主模型调不通时没有任何回退链，会直接静默失败、飞书会话内不产生任何回复」，并 SHALL 把它列为零回复的候选根因；同时 SHALL 说明该状态按 `docs/adr/0013-...md` 是「缺少凭据调用证据」的制度性状态，SHALL NOT 表述为「模型已确认不可用」
2.22 WHEN 诊断输出总体结论 THEN 系统 SHALL 区分两条并存路径（确定性 commander 路由 / Hermes 原生会话 + MCP）并分别给出该路径的判定，SHALL NOT 把 adapter 补丁缺口表述为零回复的唯一或充分原因
2.23 WHEN 判定飞书用户准入 THEN 系统 SHALL 如实报告位置事实：仓库内可核实的准入配置是 Hermes Profile 本地环境文件中的 `FEISHU_ALLOWED_USERS`（配套 `FEISHU_ALLOW_ALL_USERS` / `FEISHU_GROUP_POLICY`），当前 Hermes 版本的 `config.yaml` 内不存在飞书准入字段；SHALL NOT 继续以推测字段名给出判定，SHALL NOT 因读不出而暗示白名单已生效或已失效
2.24 WHEN 该项在「只读且绝不读取 `.env`」边界内无法判定 THEN 系统 SHALL 明确输出「按安全约束不可判定」这一结构性结论（区别于「字段找不到」），并 SHALL 给出不涉及凭据的下一步：由所有者自行确认发送者用户 `open_id` 是否在白名单内、并核对 Gateway 侧脱敏日志是否出现 `dm_policy_rejected`（该故障模式已有真机先例可循）
2.25 WHEN 输出准入相关结论 THEN 系统 SHALL NOT 读取、回显或摘要化 `.env` 的任何键值，SHALL NOT 输出 `open_id` 原值；需要引用发送者身份时 SHALL CONTINUE TO 只用现有摘要（`requesterRefDigest`）表达
2.26 WHEN 需要读取 Hermes `config.yaml` THEN 系统 SHALL 复用既有能力（`integrations/hermes/scripts/set-feishu-toolsets.py` 的 `inspect` 安全解析与凭据审计，或 `check-hermes-business-profile-policy.mjs` 的既有策略读取），SHALL NOT 另造平行 YAML 解析实现；同时 SHALL NOT 破坏诊断 CLI 的零第三方 npm 依赖与「`npm install` 未执行仍可跑完」属性。已核实的取舍事实 SHALL 写入 design：`check-hermes-business-profile-policy.mjs` 在模块顶层 `import yaml from 'js-yaml'`，而 `js-yaml` 未在仓库任何一方 `package.json` 中声明（仅作为其他包的传递依赖出现在 `node_modules`）；`set-feishu-toolsets.py` 走 Hermes 自带 venv python，不引入任何 npm 依赖。具体选型由 design 决定，但 SHALL NOT 以「新增一个第三方 npm 依赖」作为解法
2.27 WHEN 读取 `config.yaml` 内任何键 THEN 系统 SHALL 按完整父级路径限定（例如平台段落下的具体字段路径），SHALL NOT 按裸键名做全局匹配，且 SHALL 在结构不符合预期时报 `unknown` 而非猜测
2.28 WHEN 输出涉及模型 provider、MCP 或模型策略的结论 THEN 系统 SHALL 只输出「是否配置、是否与基线一致、是否启用」，SHALL NOT 回显 `api_key`、`base_url`、token、命令行原值或 `.env` 内容；引用敏感上下文键时 SHALL 复用既有做法（哈希摘要或 `${KEY}` 占位）
2.29 WHEN Hermes 版本或 git HEAD 与补丁基线不一致，或补丁标记不在位 THEN 系统 SHALL 在用户发出飞书消息之前的确定性检查点上报告该事实（复用 `start-hermes-gateway-guarded.mjs` 既有启动门禁位或等效的升级后自检点），使升级导致的补丁丢失可被主动发现，SHALL NOT 依赖「人记得升级后重跑补丁脚本」
2.30 WHEN 需要为新 Hermes 版本重新适配补丁 THEN 系统 SHALL 复用仓库内已验证的适配模式（`install-xiaod-public-video-bridge-v2.mjs` 针对 `0.20.1` 的显式锚点拓扑断言 + 本机源码只读 dry-run + 版本与 commit 双锁），并 SHALL 使版本基线单一来源化、在多处 pin 漂移时报出漂移本身；SHALL NOT 降低锚点校验强度、SHALL NOT 改为模糊匹配、SHALL NOT 绕过双锁
2.31 WHEN 记录长期升级韧性方向 THEN 系统 SHALL 按 ADR-0007「业务工具不再写入 Hermes 安装目录补丁」的既有结论，记录当前每个补丁标记「必需 / 可由原生能力 + MCP 替代」的判定，以缩小写入 Hermes 安装目录的补丁面；SHALL NOT 在本 spec 范围内删除任何既有补丁能力（属独立决策）

以下六条对应本轮真机日志实证新发现的缺陷（缺陷 G：2.32–2.33；缺陷 I 无回退告知：2.34；缺陷 H 标识符溯源：2.35；缺陷 I MCP 腿：2.36；缺陷 K 日志规模：2.37）：

2.32 WHEN 诊断入口运行 THEN 系统 SHALL 读取 Hermes 自身的错误日志并报告主导出站失败签名，至少含：异常类名、出现计数、最近发生时间、统计所覆盖的行范围；SHALL 只提取异常类名与计数，SHALL NOT 输出日志消息正文、URL、endpoint、凭据、请求头或任何消息内容；该项 SHALL 标注其能力真相层级并 SHALL NOT 超过其上限
2.33 WHEN 实现 2.32 的判定 THEN 该判定 SHALL 通过读取 Hermes 既有日志实现，SHALL NOT 通过发起 provider 网络调用或探针实现。**此为本条的关键设计约束与显式取舍**：读日志既能暴露真实活跃阻断点，又不触碰 3.20（不发起任何 provider 网络调用、不刷新账号模型目录、不产生任何计费）与 2.28（不回显 `api_key` / `base_url` / token）；反之，若改用主动探针实现同一判定，就必然违反 3.20，因此 SHALL NOT 采用
2.34 WHEN 检测到主导出站失败签名且 `fallbackModels` 为空 THEN 系统 SHALL 说明「出站连接正在失败且没有任何回退链，结果会是直接静默、飞书会话内不产生任何回复」，并 SHALL 把它报为当前最强候选根因；SHALL NOT 声称已确认失败目标为某具体 provider（异常类名只证明出站连接在失败，不证明目标主机是哪一个），除非该目标已被独立证据确认；SHALL 在结论中标注「失败目标主机未确认」这一层级限制
2.35 WHEN 任何判定依赖外部系统的标识符（Hermes `config.yaml` 字段名、日志关键词、异常类名措辞、日志文件名）THEN 系统 SHALL 标注该标识符的来源（仓库内具体文档或代码位置）与其适用版本，并在当前运行版本与来源版本不一致或来源未登记版本时报「该标识符在当前版本不适用 / 适用性未知」；SHALL NOT 以「未命中」表述失配，也 SHALL NOT 把「计数为 0」表述为「该故障不存在」。本条与既有 2.16（`null` 不得冒充「匹配」或「不匹配」）为同一原则，从取值层面扩展到标识符层面
2.36 WHEN 诊断入口运行 THEN 系统 SHALL 判定 Agent Army MCP 腿的活性，至少含：（a）MCP stderr 日志的最近写入时间相对 Gateway 其他日志的最近写入时间是否显著滞后（报告滞后量，不报告日志内容）；（b）`config.yaml` 的 `mcp_servers.agent-army` 是否存在且未被 `enabled:false` 关闭；并 SHALL 显式标注层级限制「无 stderr 输出且 Gateway 侧极少提及，不等于 MCP server 已崩溃或未加载」，SHALL NOT 由此断言 MCP 已失效
2.37 WHEN 诊断入口运行 THEN 系统 SHALL 报告 Hermes 日志的规模与轮转状态（至少：错误日志行数或字节量、最近写入时间、是否存在生效的轮转约定），使「信号被淹没」这一状态本身可被发现；SHALL 只报告规模与时间等元数据，SHALL NOT 输出日志内容

以下九条对应第四轮新发现的缺陷（缺陷 L 白名单单一真相与漂移检测：2.38–2.42；缺陷 M 日志归属覆盖非异常型记录：2.43–2.45；缺陷 N 第二道阻断告知：2.46）。**既有 2.32 与 2.34 在本轮被修正**：它们要求把「主导出站失败签名 + 无回退链」报为最强候选根因，而该批签名已被证伪为无关子系统噪音；修正以本轮新条款表达，既有条款文字不变，design 阶段须显式说明 2.32 / 2.34 的处置方式（判定保留，但结论 SHALL 先通过子系统归属，且 SHALL NOT 在归属为无关子系统时报为本 bug 的候选根因）：

2.38 WHEN 系统内并存两套飞书用户准入白名单 THEN 系统 SHALL 存在单一真相，或提供显式的对齐校验，使「两套白名单不一致」这一状态本身可被检测并报告；SHALL 报告比对所依据的两侧位置（军团侧 store 与 Hermes Profile 环境文件）与该结论所处的能力真相层级，SHALL NOT 仅凭任一侧取值单独给出准入结论

2.39 WHEN 两侧白名单不一致 THEN 系统 SHALL 把该状态报为**阻断性缺口**并给出唯一下一步，SHALL NOT 因军团侧允许发送者就判定准入正常，SHALL NOT 把军团侧的「已授权」表述为消息可被 Hermes 网关接受

2.40 WHEN 输出任何准入或对齐结论 THEN 系统 SHALL NOT 输出 `open_id` 原值或其片段、真实姓名或其片段、`.env` 键值、日志正文；引用发送者身份时 SHALL CONTINUE TO 只用既有摘要（`requesterRefDigest`）表达；比对两侧集合时 SHALL 只输出「是否一致 / 差异条目数 / 摘要」，SHALL NOT 输出条目原值

2.41 WHEN 对齐校验需要取得网关侧取值 THEN 该校验 SHALL 在不读取 `.env` 的前提下完成；若确实需要读取受保护配置才能取得该取值 THEN 系统 SHALL 明确报「按安全约束不可判定」这一结构性结论（与 2.24 同一表述层级，区别于「字段找不到」），并 SHALL 给出不涉及凭据的人工核对步骤

2.42 WHEN 军团侧准入白名单被更新（运行台接线或 CLI 路径）THEN 系统 SHALL 使 Hermes 网关侧的对应取值要么同步更新、要么被报为「待同步」状态，并 SHALL 说明 `integrations/feishu/README.md` 已记录的「白名单变化后必须重启 Gateway 才生效」这一前提；SHALL NOT 依赖「人记得手动重跑 provision 脚本」

2.43 WHEN 日志归属工具扫描 Hermes 日志 THEN 它 SHALL 同时覆盖**非异常型的结构化拒绝/丢弃记录**（至少含用户准入拒绝），SHALL NOT 只解析 traceback；该类记录 SHALL 与 traceback 一样先归属到子系统再报告，且 SHALL 只输出签名形状、计数、时间与行范围，SHALL NOT 输出日志正文、账号标识、真实姓名、`open_id` 或其片段

2.44 WHEN 存在归属到飞书链路的非 traceback 失败记录 THEN 系统 SHALL NOT 输出「失败未被记录到任何可判定位置」或任何等价表述，SHALL 把该类记录报为**已定位的失败证据**并给出对应的唯一下一步；CLI 退出码语义 SHALL 与「是否找到飞书归属证据」保持一致，SHALL NOT 在证据实际存在时返回「未找到」

2.45 WHEN 归属依据某条拒绝措辞 THEN 该措辞 SHALL 按 2.35 标注来源（仓库内具体文档或代码位置）与适用版本，并 SHALL 同时容纳多版本措辞（至少含当前版本的准入拒绝签名形状与 0.19 时代的 `dm_policy_rejected`）、分别标注各自适用范围；某版本措辞未命中 SHALL 报「该措辞在当前版本不适用 / 适用性未知」，SHALL NOT 表述为「未发生该类拒绝」

2.46 WHEN 准入白名单缺口被修复 THEN 系统 SHALL 独立判定并单独报告模型侧回复能力（至少：`credentialedTransportVerification.status` 是否仍为 `model-transport-pending`、运行台飞书通道是否为空），并 SHALL 说明「准入修好后仍可能无回复、模型侧构成第二道独立阻断」；SHALL NOT 把准入修复表述为本 spec 验收达成，SHALL NOT 把 `model-transport-pending` 表述为「模型已确认不可用」

### Unchanged Behavior (Regression Prevention)

3.1 WHEN A君返回 `handled:false`（`explicit_direct_reply_without_task`）且 Hermes 模型侧正常 THEN 系统 SHALL CONTINUE TO 由 Hermes 普通聊天路径回复，不插入任何诊断或降级文案
3.2 WHEN 文本消息成功创建任务 THEN 系统 SHALL CONTINUE TO 返回 202 并按 `presentCommanderReply()` 现有契约在飞书回复任务信息
3.3 WHEN `/api/feishu/commander` 收到非本机来源的调用 THEN 系统 SHALL CONTINUE TO 返回 403 拒绝，不为诊断需要放宽本机校验
3.4 WHEN Feishu Profile 的 `agentId` 不是 `ajun` THEN 系统 SHALL CONTINUE TO 拒绝进入总管路由，即使该 Profile 误留了 Commander URL
3.5 WHEN 重复执行 `integrations/hermes/scripts/` 下的补丁脚本 THEN 系统 SHALL CONTINUE TO 按 `_V1` 标记保持幂等，不重复注入
3.6 WHEN 消息类型不是 `MessageType.TEXT` THEN 系统 SHALL CONTINUE TO 不进入总管文本路由
3.7 WHEN 调用既有 `/api/health` 与 `runtime-fingerprint` THEN 系统 SHALL CONTINUE TO 满足 `agent.army/runtime-health/v1` 与现有 fingerprint 输出契约
3.8 WHEN 其他四个常驻 Gateway（非 `ajun` 标签）处理各自 Profile 的消息 THEN 系统 SHALL CONTINUE TO 使用其独立 `HERMES_HOME`、launchd 环境与卡片账本，不受本次修复影响
3.9 WHEN 运行既有测试 THEN 系统 SHALL CONTINUE TO 使用原生 `node --test`，不引入新测试框架

以下四条对应真机新发现缺陷的保持性要求：

3.10 WHEN `hermesVersionMatchesBaseline` 为 `true` THEN `adapter-patch` 与 `profile-guard` SHALL CONTINUE TO 输出原有的「重跑补丁脚本并重载 Gateway」下一步，不得因新增版本分支而回归
3.11 WHEN 配置了候选字段路径后仍读不出准入白名单字段 THEN `feishu-admission` SHALL CONTINUE TO 报 `status:'unknown'`（既不是 `pass` 也不是 `gap`）、`truthLayer:'declared'`，且 SHALL CONTINUE TO 不输出 `hit`；不得因字段可配置而退化成猜字段
3.12 WHEN 诊断入口运行 THEN 系统 SHALL CONTINUE TO 保持只读、不读 `.env`、不产生外部副作用，且六项检查的 id、顺序、`truthLayerCeiling` 与退出码语义（`0` / `1` / `2`）保持不变
3.13 WHEN 版本锁定校验被补丁脚本调用 THEN `assertSupportedHermesCompatibility` SHALL CONTINUE TO 在版本号或 git commit 任一不匹配时拒绝执行并抛出中文错误，不为诊断可执行性放宽

以下七条对应本轮新增检查与升级韧性改动的保持性要求：

3.14 WHEN 新增 Hermes 原生会话侧检查 THEN 既有六项的 id、顺序、`truthLayerCeiling` 与退出码语义（`0` / `1` / `2`）SHALL CONTINUE TO 不变；design SHALL 明确新增项是扩展还是替换，若为扩展则 `CHAIN_CHECK_IDS` 的变更 SHALL 在 design 中说明对既有测试（含以六项齐全为断言的用例）的影响与迁移方式
3.15 WHEN 实施本轮任何改动 THEN `DIRECT_REPLY_V1` 分支 SHALL CONTINUE TO 一字不改，`handled:false` 交回 Hermes 原生会话的语义 SHALL CONTINUE TO 保持
3.16 WHEN 诊断入口运行 THEN 系统 SHALL CONTINUE TO 保持只读、不读取 `.env`、不产生任何外部副作用，且输出中零凭据
3.17 WHEN 诊断入口运行在未执行 `npm install` 的环境 THEN 系统 SHALL CONTINUE TO 跑完并给出六项（或扩展后的全部）判定，即零第三方 npm 依赖属性不被打破。（该属性此前只写在 design.md，本条把它固定为需求层约束）
3.18 WHEN 复用 Hermes 侧既有安全解析能力 THEN 其既有凭据审计与失败关闭语义（如检出疑似明文凭据、解析失败、结构不安全时拒绝继续）SHALL CONTINUE TO 不被放宽，且诊断 SHALL CONTINUE TO 只读不写 `config.yaml`
3.19 WHEN Gateway 启动门禁新增补丁在位与版本基线校验 THEN 既有的技能白名单收敛校验与 bundled skills 自动注入退出校验 SHALL CONTINUE TO 原样生效，不得被新增校验弱化、跳过或改为告警
3.20 WHEN 判定实际生效的主模型 provider/model THEN 系统 SHALL CONTINUE TO 只做本机只读回读（运行期模型策略文件与 Profile 映射），SHALL CONTINUE TO 不发起任何 provider 网络调用、不刷新账号模型目录、不产生任何计费


以下三条对应本轮新增日志读取与出站失败判定的保持性要求：

3.21 WHEN 新增出站失败签名判定、MCP 腿活性判定与日志规模判定 THEN 系统 SHALL CONTINUE TO 不发起任何 provider 网络调用、不刷新账号模型目录、不产生任何计费；3.20 的边界 SHALL CONTINUE TO 不因新增判定而放宽、放行或例外
3.22 WHEN 新增判定读取 Hermes 日志 THEN 系统 SHALL CONTINUE TO 保持只读、不读取 `.env`、不产生任何外部副作用、输出中零凭据；新增的日志读取 SHALL CONTINUE TO 只输出异常类名、计数与时间/规模等元数据，SHALL CONTINUE TO 不输出日志消息正文、URL、endpoint、`open_id` 原值或任何消息内容
3.23 WHEN 本轮新增判定被加入诊断 THEN 既有六项（`gateway-process` / `adapter-patch` / `required-env` / `runtime-ingress` / `profile-guard` / `feishu-admission`）的 id、顺序、`truthLayerCeiling` 与退出码语义（`0` / `1` / `2`）SHALL CONTINUE TO 不变；新增项为扩展而非替换，其对 `CHAIN_CHECK_IDS` 与既有以六项齐全为断言的测试的影响 SHALL 在 design 中说明迁移方式（与 3.14 同一处置）


以下四条对应第四轮新增准入对齐校验与非 traceback 日志归属的保持性要求：

3.24 WHEN 新增准入对齐校验与非 traceback 日志归属 THEN 系统 SHALL CONTINUE TO 保持只读、不读取 `.env`、不产生任何外部副作用、输出中零凭据，且 SHALL CONTINUE TO 不发起任何 provider 网络调用、不刷新账号模型目录、不产生任何计费；3.20 与 3.21 的边界 SHALL CONTINUE TO 不因新增判定而放宽、放行或例外

3.25 WHEN 日志归属扩展到非 traceback 记录 THEN 既有按子系统归属的判定 SHALL CONTINUE TO 生效：归属到与飞书链路无关子系统（如其他平台插件）的主导签名 SHALL CONTINUE TO 被明确判为与本 bug 无关，且 SHALL CONTINUE TO 不得据此推导飞书侧根因；既有形状白名单与失败关闭语义（形状不符即丢弃并计入 `redactedFieldCount`）SHALL CONTINUE TO 不被放宽，只读文件尾部、不整体载入内存与零第三方 npm 依赖属性 SHALL CONTINUE TO 保持

3.26 WHEN 准入对齐校验被加入诊断 THEN 既有六项检查的 id、顺序、`truthLayerCeiling` 与退出码语义（`0` / `1` / `2`）SHALL CONTINUE TO 不变；`feishu-admission` 在按安全约束或结构原因无法判定时 SHALL CONTINUE TO 报 `status:'unknown'`（既不是 `pass` 也不是 `gap`）而非猜测（与 3.11、3.23 同一处置）

3.27 WHEN 网关侧准入白名单被修正或对齐 THEN 军团侧既有的 `ou_` 前缀格式校验、密钥本地存储权限（`0o600`）与 `dmMode:'allowlist'` 默认拒绝语义 SHALL CONTINUE TO 不被放宽；对齐校验 SHALL CONTINUE TO 不引入「允许全部用户」旁路（`FEISHU_ALLOW_ALL_USERS` 保持 `false`、`FEISHU_GROUP_POLICY` 保持 `allowlist`）
