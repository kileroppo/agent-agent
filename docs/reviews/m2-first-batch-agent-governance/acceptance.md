# M2 第一批 Agent 创建与治理闭环验收记录

| 字段 | 内容 |
| --- | --- |
| 状态 | 部分通过：创建、审核、受限测试准备、公开网页能力、军团总管、local 与组织级审批服务层已测；真实飞书审批卡和 Hermes 业务产物验收待完成 |
| 日期 | 2026-07-21 |
| 范围 | 创建官、治理岗位、Paperclip 审核投影、A君受限测试实例、公开网页获取能力 |

## 已验证事实

| 验收项 | 证据 | 结论 |
| --- | --- | --- |
| 草案默认不激活、重复事件幂等 | `apps/ajun-runtime` 自动化测试 | 通过 |
| 未批准不可建测试实例；失败验收不能上线 | 自动化测试 | 通过 |
| Paperclip 审核投影 | 本机 Paperclip 曾创建审核任务 `AGE-19` 与审批记录；审批状态读取为 `approved`；2026-07-21 已由 `ai.agent-army.paperclip` 常驻，3100 健康检查返回 200 | 当前运行恢复；组织级飞书真实按钮回写待验收 |
| Hermes 隔离身份 | 本机创建 `publicreport` Profile；无 Skills，Gateway 停止；未复制生产配置 | 通过 |
| 飞书创建入口连通性 | 隔离 `xiaod` Hermes Gateway 已真实建立飞书长连接；创建官路由补丁通过语法、幂等和本机入口测试 | 连接通过；真实入站待验收 |
| A君公开网页能力 | 对 `https://example.com/` 实际返回公开正文；对 `127.0.0.1` 请求返回 422 拒绝 | 通过 |
| 候选岗位业务产物 | A君公开网页输入由 `publicreport` 隔离 Hermes Profile 生成[可读报告](./artifacts/publicreport-example-domain.md)；模型为 `openai-codex / gpt-5.4`，未调用工具或外发 | 通过本机业务验收 |
| 小D直达边界 | TaskService 回归测试确认简单小D任务不投影 Paperclip | 通过 |
| 飞书军团总管本机切片 | `FeishuCommander` 自动化测试覆盖“小D素材、系统检查、创建 Agent、缺稳定事件引用拒绝”；任务存储覆盖飞书事件幂等；A君 `POST /api/feishu/commander` 在本机 `4331` 返回 422 输入校验 | 通过代码与本机接口验证 |
| 飞书健康检查真实入站 | A君任务记录中已有一条 `source.channel=feishu` 的任务，带稳定事件引用，路由为 `operations.health-review → operator → health_report_ready → succeeded`；无审批、无 Paperclip 投影 | 飞书入站与 Mac 执行通过；原会话回执是否可见尚待手机侧确认 |
| 普通审批本机恢复 | 自动化测试覆盖 local / Paperclip 分流、范围校验、过期/重复拒绝与批准后单次执行；本机 `POST /api/tasks` → `waiting_approval` → `POST /api/approvals/:id/approve` 实测由运维官完成健康报告 | 通过本机运行验证 |
| 飞书 local 审批卡链路 | Hermes 复用现有交互卡与回调能力，已安装审批卡补丁并通过 Python 语法校验；A君 `POST /api/feishu/commander` 返回 `local` 卡片摘要，`POST /api/feishu/approvals/:id/approve` 以同会话引用恢复任务并实测成功 | 代码、适配器与本机回调接口通过；真实手机点击待验证 |
| A君常驻运行 | `ops/launchd/ai.agent-army.ajun-runtime.plist` 通过 `plutil` 校验，已安装为当前用户 LaunchAgent；监听者工作目录为本仓库 `apps/ajun-runtime`，仅监听 `127.0.0.1:4321` | 通过本机运行验证 |
| 飞书手机控制设计 | 已确认单一“ A君·军团总管”入口、普通审批 local / 组织级审批 Paperclip 分流，见 `docs/adr/0005-feishu-mobile-command-and-approval-boundary.md` | 设计已确认，未实现 |
| 独立 A君飞书应用 | 已创建独立的“ A君·军团总管”机器人应用，启用机器人能力、长连接消息订阅 `im.message.receive_v1`，并在后台确认发布；本机 Hermes 已以该应用建立 Feishu WebSocket 连接 | 平台配置与长连接通过；用户侧搜索、私聊入站和同会话回执待验收 |

## 尚未通过或未执行

- 真实飞书入站消息尚未接到创建官入口：Gateway 已连通，但尚未收到一条真实“创建 Agent”消息，因此不能称为完整飞书验收。
- 尚未获得真实“飞书创建请求 → 报告产物 → 飞书交付”证据：当前报告来自受限本机验收输入。
- 首个候选岗位保持 `testing`，没有创建正式 Manifest、生产 Profile 或飞书路由。
- 飞书军团总管已换用独立的“ A君·军团总管”应用；尚缺手机侧搜索/私聊该机器人并确认同会话回执，以及小D与创建 Agent 两条真实命令，不能称为完整手机控制军团闭环。
- local 飞书审批卡与回调已实现但未收到真实手机点击证据；Mac 离线状态和组织级 Paperclip 审批卡仍未实现，不能称为完整手机审批闭环。
- Paperclip 已恢复。组织级卡片服务层与单元测试已覆盖“先回写 Paperclip，后恢复/关闭原任务”；仍缺真实飞书按钮点击和 Paperclip 审批记录的一致性证据。

## 唯一下一步

在飞书搜索并私聊“ A君·军团总管”，发送“检查系统状态”，验证原会话回显与运维路由；再分别验证小D缺链接与创建 Agent，以及 local / Paperclip 两类审批卡点击。
