# 创建 Hermes Agent 与飞书 Bot 接线教程

本文把“音视频转录 Agent”的创建过程整理成可复制的最小流程。它只解决四件事：独立身份、飞书入口、模型配置、真实收发验收。不要把“能收发消息”误写成“业务能力已经上线”。

## 1. 先划边界

新 Agent 默认先是 `draft`，只允许做接线测试：

- 独立 Hermes Profile、独立会话目录、独立日志目录；
- 独立飞书应用和 bot；
- 工具白名单为空，暂不承接生产任务；
- 不复制其他 Agent 的 `.env`、Cookie、用户 `open_id`、会话数据或审批映射；
- 角色能力、执行规则、模型和工具在真实验收后再逐项放开。

建议先写清“能做什么”和“明确不能做什么”，再建应用。否则很容易先做出一个会聊天、但没有权限边界的空壳。

## 2. 创建独立 Hermes Profile

```bash
hermes profile create <profile-id> \
  --no-skills \
  --no-alias \
  --description '<岗位名称>：当前只用于飞书接线测试，尚未承接正式任务。'
```

约定：

- `<profile-id>` 只用小写字母、数字和短横线，例如 `av-transcriber`；
- Profile 目录通常为 `~/.hermes/profiles/<profile-id>`；
- 不要把默认 `~/.hermes` 当成新 Agent 的运行目录；
- 启动、配置和检查时显式设置 `HERMES_HOME`，避免误用其他 Agent 的凭据。

## 3. 在仓库建立四个版本化边界

业务 Agent 建议至少有下面四项：

```text
agents/<profile-id>/manifest.json
agents/<profile-id>/prompts/system.md
agents/<profile-id>/README.md
integrations/hermes/profiles/<profile-id>.profile.json
```

`manifest.json` 写岗位身份、状态、允许任务类型、工具白名单、数据范围和高风险审批规则。接线阶段应明确：

```json
{
  "status": "draft",
  "toolAllowlist": [],
  "dataScopes": [],
  "highRisk": { "requireApproval": true }
}
```

`system.md` 只允许 Agent 回报接线状态，不允许假装已经具备转录、外部账号访问或文件处理能力。

Hermes 映射文件只放非秘密引用：Profile ID、Manifest/Prompt 路径、飞书平台、事件名、允许名单来源和状态。App Secret、模型 Key 等只能留在 Profile 本机环境变量中。

## 4. 创建并配置飞书应用

在飞书开放平台完成：

1. 创建一个独立应用，名称与 Agent 一致；
2. 启用机器人能力；
3. 开通接收用户消息的权限；
4. 订阅 `im.message.receive_v1`；
5. 选择长连接接收事件；
6. 保存并发布当前应用版本；
7. 记录 App ID 到本地非秘密映射文件，App Secret 只写进 Profile 的 `.env`。

应用后台的一键创建向导可能顺便订阅评论、会议等额外事件。不要默认认为“点击删除”就已经持久生效；刷新后台确认后再记录为最小事件集。暂时无法证明已删除时，记录为风险，不要写成已清理。

## 5. 配置独立模型

```bash
export HERMES_HOME="$HOME/.hermes/profiles/<profile-id>"
hermes setup model
```

交互式配置中只填写该 Profile 专用的模型 Provider、Base URL、模型名和 API Key。完成后只做布尔检查，不回显值：

```bash
HERMES_HOME="$HOME/.hermes/profiles/<profile-id>" hermes config get model.provider >/dev/null \
  && echo model_provider_configured
HERMES_HOME="$HOME/.hermes/profiles/<profile-id>" hermes config get model.default >/dev/null \
  && echo model_default_configured
```

不要用 `cat .env`、全量打印 Gateway 日志或把连接 URL 粘到聊天里。连接参数可能包含可复用的访问票据。

## 6. 启动 Gateway 并确认平台连接

```bash
HERMES_HOME="$HOME/.hermes/profiles/<profile-id>" \
  hermes gateway run --replace
```

第一层只看进程和飞书长连接：

```text
Active profile: <profile-id>
[Feishu] Connected in websocket mode
Gateway running with 1 platform(s)
```

这一步只证明本机连上飞书，不证明消息能进来，更不证明 Agent 能回复。

## 7. 私聊验收

用一个无敏感、可重复的测试句发送给新 bot，例如“连接验收-私聊”。验收必须同时看到：

```text
[Feishu] Inbound dm message received
inbound message: platform=feishu
response ready: platform=feishu
[Feishu] Sending response
```

只看到“Connected”或聊天列表里出现 bot，都不能标记私聊通过。最小通过标准是：同一私聊会话中，真实消息入站、Agent 运行、原会话出站回复三段都成立。

## 8. 群聊 @ 验收

1. 创建临时测试群；
2. 把新 bot 加入群；
3. 发送一条真正的 `@` 机器人消息，而不是只输入机器人名字；
4. 检查群事件和同群回复。

应看到：

```text
[Feishu] Inbound group message received
inbound message: platform=feishu
response ready: platform=feishu
[Feishu] Sending response
```

如果群配置要求 `@`，普通群文本不算测试。结构化消息中的 `at` 用户必须是当前应用对应的 bot 身份，不能拿另一个应用的 `open_id` 代替。

## 9. 验收账本怎么写

| 层级 | 证明什么 | 典型结论 |
| --- | --- | --- |
| 自动化 | Manifest、映射、秘密字段边界没被破坏 | PASS |
| 本机运行 | 目标 Profile、进程、模型配置和长连接正确 | PASS/PARTIAL |
| 外部平台 | 飞书权限、事件订阅、版本发布正确 | PASS/PARTIAL |
| 真实收发 | 私聊/群聊事件进出同一会话 | PASS/PARTIAL |
| 业务能力 | 真正完成转录、文件生成、交付和失败恢复 | 另行验收 |

任一层没有证据，就写 `PARTIAL` 或“未验证”，不要用其他层的绿灯替代它。

## 10. 常见故障与止损

### 飞书网页聊天打不开

如果网页端账号接口超时，不要反复刷新，也不要重建应用。改用已登录的飞书客户端或受控 CLI 做一次消息测试；测试仍需回到 Hermes 入站和出站日志确认。

### 网关连接成功但没有回复

按顺序检查：

1. 应用是否已发布；
2. 是否订阅 `im.message.receive_v1`；
3. 是否真的启用单聊消息和群内 @ 权限；
4. Gateway 是否使用了目标 `HERMES_HOME`；
5. 是否误用了另一个应用的用户身份或允许名单；
6. 是否只看了聊天列表，没有查入站和出站日志。

不要先改 Prompt 或重建 bot。没有事件入站证据时，问题还在接入层。

### 群聊有消息但 Agent 不回

先确认消息里是当前 bot 的真实 `at` 标签，再确认 Hermes 映射开启了 `groupMentionRequired`。普通文本、机器人名称或其他应用的 `open_id` 都不能替代真实 @。

### 日志出现无关错误

多平台 Gateway 可能同时检查浏览器、看板或其他连接器。只筛选目标 Profile 的飞书事件、入站、响应和发送记录，不要把无关平台的警告当成飞书链路失败。

## 11. 可复用模板

每次新 Agent 接入前，复制下面这份清单：

- [ ] 独立 Profile 已创建，未复制其他 Agent 数据
- [ ] Manifest、Prompt、Hermes 映射已入仓库
- [ ] 默认 `draft`，工具白名单为空
- [ ] 飞书应用、bot 能力、消息权限已启用
- [ ] `im.message.receive_v1` 已订阅，版本已发布
- [ ] 长连接已建立
- [ ] 独立模型配置已完成
- [ ] 私聊：入站 → 运行 → 同会话回复
- [ ] 群聊：真实 @ → 入站 → 运行 → 同群回复
- [ ] 只记录脱敏证据，不记录 secret、Key、Cookie、open_id、聊天 ID
- [ ] 业务能力另立验收，不把接线通过写成正式上线

## 本次实例

本次实例是“音视频转录 Agent”：创建了独立 `av-transcriber` Profile 和飞书 bot，完成了模型配置、Gateway 长连接、私聊收发和群聊 @ 收发验收；但转录岗位能力尚未定义，因此仍保持 `draft`，没有启用任何工具白名单。
