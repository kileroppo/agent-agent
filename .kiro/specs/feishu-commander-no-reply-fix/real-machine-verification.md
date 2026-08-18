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
