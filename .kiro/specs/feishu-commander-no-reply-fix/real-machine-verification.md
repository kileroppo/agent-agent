# 飞书总管无回复 · 真机验证清单

## 未验证声明（先读这一段）

**「代码已写」不等于「能力可用」。** 本次修复涉及飞书、Hermes Gateway、StepFun 与 launchd，
这四者都不在沙箱内，因此下列结论在本清单的步骤 1–7 于你自己的 Mac 上跑完前**一律标记未验证**：

- `adapter.py` 补丁是否在位、是否被当前 Gateway 进程真正加载；
- launchd 环境变量是否已注入**运行中的进程**（改了 plist 不等于进程已注入）；
- 4321 是否为预期的不可变 release；
- 飞书准入白名单是否命中；
- 飞书会话内是否真的出现了回复或可归因说明。

沙箱内已经关闭的只有：判定逻辑、脱敏、证据 schema、补丁幂等与保持性（`handled:false` / 202 / 403
的对外行为逐字节不变）。

每一步都给出：命令、预期输出、判定标准、失败时的**唯一下一步**。按顺序做，不要跳步。

---

## 步骤 1 · 一条命令跑出结论

```bash
cd <repo-root>
npm run diagnose:feishu-chain
```

- **预期输出**：六项检查逐条输出四行（结论 / 能力真相层级（含是否需真机验证）/ 已脱敏证据 / 唯一下一步），
  顺序固定为 `gateway-process`、`adapter-patch`、`required-env`、`runtime-ingress`、`profile-guard`、
  `feishu-admission`；末尾打印总判定与告示，并打印最近证据摘要。
- **判定标准**：
  - 退出码 `0` = 本机未发现阻断性缺口（**不等于飞书可用**，继续步骤 2）；
  - 退出码 `1` = 存在阻断性缺口，输出里的「唯一下一步」就是你要做的下一件事；
  - 退出码 `2` = 诊断自身没跑完（例如 `HERMES_HOME` 不可读）。
  - 这条命令在 4321 未监听、Gateway 未起、依赖未安装时也必须跑完 —— 跑不完本身就是缺陷。
- **失败时的唯一下一步**：退出码 `2` ⇒ 确认仓库路径与 `HERMES_HOME` 可读（`ls -ld "$HERMES_HOME"`）后重跑本步。

## 步骤 2 · 确认输出零凭据

```bash
npm run diagnose:feishu-chain -- --json | grep -Ei 'sk-|bearer|token|cookie|password'
```

- **预期输出**：无任何匹配行。
- **判定标准**：`grep` 退出码为 `1`（无匹配）即通过。有任何一行输出即为**不通过**。
- **失败时的唯一下一步**：立刻停止后续步骤，把匹配到的字段名（**不要贴值**）反馈回来修脱敏，
  在修好之前不要把 `--json` 输出粘贴到任何地方。

## 步骤 3 · 补丁不在位时重跑补丁脚本

仅当步骤 1 的 `adapter-patch` 报 `gap` 时执行；**在维护窗口内做**（会重写 `adapter.py`，需重启 Gateway）。

```bash
node integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs
node integrations/hermes/scripts/patch-hermes-agent-army-task-card-events.mjs
```

- **预期输出**：首次输出「已安装 …」；再次执行输出「已存在 …」（幂等）。
- **判定标准**：重跑一次后输出变为「已存在 …」，且 `npm run diagnose:feishu-chain` 的 `adapter-patch`
  转为 `pass`（`truthLayer` 仍为 `configured` —— 刚打完补丁**不代表**当前进程已加载它）。
- **失败时的唯一下一步**：脚本报「结构不匹配 / 找不到锚点」⇒ 记下报错整行，不要手改 `adapter.py`；
  这说明 Hermes 版本变了，需要先更新补丁锚点。

补丁重写后让 Gateway 重新加载：

```bash
launchctl kickstart -k "gui/$UID/ai.hermes.gateway"
```

## 步骤 4 · 环境变量未注入时写 launchd 并重载

仅当步骤 1 的 `required-env` 报 `gap`（结论含「已声明但未配置」）时执行。

```bash
# 写入 ai.hermes.gateway 的 EnvironmentVariables 后，必须重载才算注入到进程
launchctl kickstart -k "gui/$UID/ai.hermes.gateway"
npm run diagnose:feishu-chain
```

- **预期输出**：`required-env` 与 `profile-guard` 转为 `pass`。
- **判定标准**：`required-env` 的 `processInjection` 字段仍为 `unproven` 是**正常**的 ——
  plist 有值只能证明到 `configured` 层；「进程确实注入了」只有步骤 6 的真实消息能证明。
  注意 `AGENT_ARMY_FEISHU_AGENT_ID` 为空或未设置**不是缺口**（Hermes 侧回退为 `ajun`）。
- **失败时的唯一下一步**：`kickstart` 报 `Could not find service` ⇒ Gateway 启动项未加载，
  先按步骤 1 里 `gateway-process` 的唯一下一步把 `ai.hermes.gateway` 加载起来。

## 步骤 5 · 核对 4321 是正式不可变 release（不是 4322 开发实例）

```bash
npm run runtime:fingerprint
```

- **预期输出**：`live.services.ajun.runtime.status === 'immutable_release'`，且 4321 有 listener pid。
- **判定标准**：状态不是 `immutable_release`（例如指向工作树、或只有 4322 在监听）就说明你验证的是
  **开发实例**，而 `npm run dev` 的 4322 带 `AJUN_DISABLE_BACKGROUND_SERVICES=true`，**飞书链路在它上面不通**。
- **失败时的唯一下一步**：执行 `npm run release:immutable` 发布不可变 release 并让 launchd 拉起 4321，
  然后回到步骤 1 重跑诊断。**不要**用 `npm run dev` 代替。

## 步骤 6 · 真机验收：在飞书私聊发一条真实文本消息

**这是唯一能证明「飞书可用」的一步。前五步全绿也不能替代它。**

在飞书私聊「A君·军团总管」发一条普通中文文本消息（例如：`帮我把这周的公开资料整理成一页说明`）。

- **预期输出**：飞书会话内出现业务回复（任务已登记 / 直接回答），**或**出现可归因的中文说明
  （发生了什么 + 是否启动了外部动作 + 下一步做什么）。
- **判定标准**：**会话内有任何一种可读回复即通过**。仍然完全无回复即不通过 —— 那正是本次要消除的黑箱。
- **失败时的唯一下一步**：立刻执行 `npm run diagnose:feishu-chain`，并查看两侧证据账本
  （命令见步骤 7）；账本里出现 `kind` 就说明消息到达了哪一环、在哪一环停下。

## 步骤 7 · （可选）制造一次失败，确认可归因性真的落地

```bash
launchctl bootout "gui/$UID/ai.agent-army.ajun-runtime" 2>/dev/null || true
# 再在飞书私聊发一条文本消息，然后：
ls -l "$HERMES_HOME/"agent_army_commander_evidence-*.jsonl
tail -n 3 "$HERMES_HOME/"agent_army_commander_evidence-*.jsonl
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist
```

- **预期输出**：文件权限为 `-rw-------`（0600）；最后几行里出现 `kind` 为 `ingress_unreachable`
  或 `degraded_notice_send_failed`，带 `sourceEventRef`（形如 `feishu:om_xxx`）。
- **判定标准**：记录中**不得**出现消息正文、token、Cookie、授权链接；`chatRefDigest` /
  `requesterRefDigest` 只应是 `sha256:` 加 12 位十六进制。`externalActionStarted` 恒为 `false`。
- **失败时的唯一下一步**：账本文件根本没生成 ⇒ Hermes 侧补丁单元或 py module 没装上，
  回到步骤 3 重跑 `patch-feishu-agent-proposal-router.mjs`（它会一并安装
  `agent_army_commander_evidence.py`），再重载 Gateway。
- 结束后务必确认 `launchctl bootstrap` 已把 4321 恢复：重跑步骤 5。

运行时侧账本（403 拒绝、有意不建任务、诊断留痕）在另一侧：

```bash
tail -n 3 "${AGENT_ARMY_DATA_DIR:-apps/ajun-runtime/data}/feishu-commander-chain/"runtime-evidence-*.jsonl
```

---

## 推翻条件（必须遵守）

若步骤 1 的六项全部 `pass`、`adapter.py` 补丁在位、4321 为不可变 release，**而步骤 6 在飞书里依然没有任何回复**，
那么本 spec 的根因假设在你的机器上被**推翻**：根因落在

- **需求 1.8**：A君返回 `handled:false` 之后的 Hermes 模型侧异常（模型入口、密钥、预算、轮次上限），或
- **飞书应用事件订阅侧**（应用未订阅消息事件、事件回调地址失效、应用被停用）。

此时必须**回到需求重新假设**，把上述两处纳入 Bug Analysis 后再走一轮 bugfix 流程。
**不得用「已修复」结案**，也不得因为六项全绿就宣布飞书链路可用 —— 诊断只判定本机，
「飞书可用」永远只能由步骤 6 的真实消息证明。

---

## 验收结果

### 步骤 6 已通过（本 spec 唯一真正达成的验收）

在 Hermes 网关侧的用户准入白名单与实际发送者对齐后，飞书私聊内**恢复正常回复**（已实测）。
按步骤 6 的判定标准「会话内有任何一种可读回复即通过」，本步**通过**。这是本清单中唯一达成的真机验收。

### 根因

消息到达 Hermes 网关后，被网关侧的**飞书用户准入白名单**判为未授权发送者并丢弃，不产生任何用户可见说明，
因此表现为完全零回复。日志签名形状为「`Unauthorized user:` + 账号标识 + 姓名 + `on feishu`」。

> 本节及本清单**不记录任何真实姓名、账号标识、`open_id` 或其片段**，只记录签名形状。

### 必须如实写明的三点

1. **修复由配置变更达成，不是由本 spec 的代码达成。** 恢复回复的直接动作是**白名单对齐**这一项配置变更；
   本 spec 交付的任何代码都不是该修复的构成部分，也没有参与该修复。
2. **Property 1（Fix Checking）未被本 spec 代码满足。** 本 spec 的诊断入口在真机上把准入一项报为
   `unknown`（`errorCode:"admission_field_not_found"`，见 `bugfix.md` 第 6 项检查）。即：在根因真实存在、
   且正是准入白名单的那次运行里，诊断入口**没有**把它判定出来。因此 Property 1 在本 spec 代码上
   **未被满足**，不得因为「飞书恢复回复」而记为通过。
3. **根因由外部直连诊断工具定位，非本 spec 的诊断入口。** 第四轮的定位工作由外部直连诊断完成；
   本 spec 的诊断入口既未给出该结论，也未指向该方向。

### 本 spec 实际交付的价值（事实化）

- 诊断入口在真机上**确实排除了三项**：`gateway-process`（第 1 项 pass）、`runtime-ingress` 即 4321 可达性与
  不可变 release 状态（第 4 项 pass）、`required-env` 必需环境变量（第 3 项 pass）。这三项此前均为未验证状态。
- 诊断入口**暴露了一个真实缺口**：Agent Army 的 adapter 补丁因 Hermes `0.19.0 → 0.20.1` 升级而**整体丢失**
  （第 2 项 gap，五个补丁标记全为 false）。该缺口是真实的、此前未被任何机制发现；但它**不是**本次零回复的
  充分原因 —— 零回复由白名单拒绝造成，消息在到达补丁所在环节之前就已被丢弃。
- 诊断留痕落盘路径在真机工作正常（运行时侧证据账本写入成功）。

### 仍未验证 / 留档不做

- **模型侧仍未验证**：`credentialedTransportVerification.status` 仍为 `model-transport-pending`，
  `fallbackModels` 仍为 `[]`。这**可能构成第二道阻断** —— 白名单修好后未对模型侧做独立验证，
  当前无法区分「模型侧本来就正常」与「模型侧仍有问题但被恢复的回复掩盖」。**未验证，留档。**
- **两套白名单无单一真相、无漂移检测**（军团侧允许、网关侧拒绝）：该机制已在 2026-07-19 与本次
  **共导致两次故障**，属已确认的结构性缺陷（条款 1.30–1.33、2.38–2.42）。**留档不做。**
- `bugfix.md` 中其余 30 余条缺陷条款：**留档不做。**

### 推翻条件的最终状态

本清单「推翻条件」一节要求：若步骤 6 无回复，则根因假设被推翻、必须回到需求重新假设。该条件在本 spec
中**被触发了三次**：根因假设历经四轮，**连续三次被真机证伪** ——

1. **adapter 补丁丢失**（第二轮判定为根因）→ 被证伪：补丁确实丢失，但不是零回复的充分原因；
2. **出站 HTTP 连接失败**（第三轮判定为根因）→ **已撤回**：所依据的异常日志实为 Telegram 侧噪音，
   与飞书链路无关；
3. **网关用户准入白名单拒绝**（第四轮）→ **已确认**，并由白名单对齐实测修复。

三次证伪的**共同原因是同一个**：依赖猜测得来的外部标识符（`config.yaml` 字段名、日志关键词、异常类名措辞），
且缺少证据归属（未确认异常记录属于哪条链路、哪个平台）。既有条款 **2.35** 正是针对这一类错误而写
（要求标注标识符来源与适用版本，禁止把「未命中」当作「该故障不存在」），但**本 spec 自身的排查过程并未遵守它**。
上文 `bugfix.md` 1.26 中被更正的 `no llm provider` 漏检，是同一类错误的又一个实例。

**结案状态**：步骤 6 通过（由配置变更达成）；Property 1 未被本 spec 代码满足；模型侧与白名单漂移检测留档不做。
