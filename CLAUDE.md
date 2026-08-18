# CLAUDE.md

给 Claude Code 在本仓库工作时使用的操作手册。**协作规则与硬性边界以 [`AGENTS.md`](./AGENTS.md) 为准，领域词义以 [`CONTEXT.md`](./CONTEXT.md) 为准，当前阶段与“唯一下一步”以 [`README.md`](./README.md) 为准。**本文件只补充这三份文件没写的可执行细节。

## 项目定位

Agent军团是数字员工系统：**飞书**是日常业务入口，**Hermes** 承载各岗位 Agent 的推理运行时，**Paperclip** 是组织级治理总控（任务、预算、审批、审计），**A君运行时**（`apps/ajun-runtime`）是本机能力网关、执行适配端、诊断与故障恢复面。

A君运行台**不是**第二套军团控制台。日常派活和交付在飞书完成；运行台只负责当前状态、唯一下一步、授权、验收和恢复。

## 架构主链

```text
飞书客户端
   ↓ 事件订阅
Hermes Gateway（launchd ai.hermes.gateway，HERMES_HOME=~/.hermes）
   ↓ 由 integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs
     打进 adapter.py 的 _route_ajun_commander_event
   ↓ HTTP POST  $AJUN_FEISHU_COMMANDER_INGRESS_URL
A君运行时  POST /api/feishu/commander （仅接受本机回环，非本机一律 403）
   ↓ commander.handle() → presentCommanderReply()
   ↓ 202 { reply | handled:false | task }
Hermes  self.send(chat_id, reply, reply_to=message_id)
   ↓
飞书客户端
```

要点：

- **Hermes 侧是 Python `adapter.py`，不在本仓库。**仓库只保存补丁脚本和映射基线（`integrations/hermes/`）。Hermes 升级会覆盖 adapter，必须重跑补丁。
- 五个常驻 Gateway 共用同一份 `adapter.py`，但使用**独立 `HERMES_HOME`、launchd 环境和卡片账本**。不要复制五份 adapter。标签与 Home 对照表见 [Hermes 集成说明](./integrations/hermes/README.md)。
- 只有 `AGENT_ARMY_FEISHU_AGENT_ID=ajun` 的 Profile 拥有 commander 文本路由（`PROFILE_GUARD_V1`）；其他 Profile 即使误留 Commander URL 也必须拒绝进入。
- A君返回 `handled:false` 表示“这句话不该建任务”，Hermes 走普通聊天回复（`DIRECT_REPLY_V1`），这不是错误。
- 所有 `/api/feishu/*` 入口都做 `isLocalAddress` 校验。非本机调用一律 403。

## 目录边界

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `apps/` | 可运行产品、业务 Agent、按需工具、显式标记的回滚资产 | 共享库、岗位定义 |
| `agents/` | 岗位定义四件套：`manifest.json` + `prompts/system.md` + `岗位卡.md` + `README.md` | 可执行业务逻辑 |
| `integrations/` | 飞书 / Hermes / Paperclip / 发布等平台适配层 | 业务逻辑（业务逻辑不得直接依赖平台 SDK） |
| `packages/` | **两个以上真实消费者**才提取的共享 Module | 只有一个消费者的代码 |
| `ops/` | 部署、监控、恢复、回滚协议 | 业务代码 |
| `tasks/` | 总 PRD、里程碑 PRD、实施状态 | 设计细节 |
| `docs/` | 产品 / 架构 / 契约 / 治理 / 验收事实 | 未验证的推测（须显式标记） |
| `work/` | 本机生成物、候选包、隔离工作区（已 gitignore） | 产品源码 |

机器可读真相在 [`repository-catalog.json`](./repository-catalog.json)，由 `npm run check:architecture` 校验。新增或改变目录分类时必须同步它。

## 技术栈事实

- npm Workspace（14 个），无额外构建框架。Node ≥ 22.18。
- TypeScript 5.9 + 原生 ESM。**后端直接以 `node src/server.ts` 运行 TS，不预编译。**相对导入必须带 `.ts` 后缀。
- 测试用原生 `node --test`，全仓 340 个测试文件。不引入 Jest / Vitest。
- `apps/ajun-runtime` 是主运行面：`src/` 有 270 个 `.ts`、约 6 万行。子目录只有 `adapters/ contracts/ runtime/ workflow/ boom-monitor/`，其余平铺，靠文件名前缀分组（`feishu-commander-*`、`campaign-*`、`capability-*`）。

## 常用命令

```bash
# 仓库级
npm run check                 # 架构边界 + 各 workspace 的 check（改代码后必跑）
npm run check:architecture    # 只查共享包依赖方向与目录分类
npm run test:affected         # 按变更触达选择包级回归（日常用这个）
npm test                      # 全量，慢
npm run test:core             # 四个核心运行包
npm run runtime:fingerprint   # 线上 release / PID / cwd / argv / HTTP 回读的唯一真相来源

# A君运行时（cd apps/ajun-runtime）
npm run check                 # tsc + 前端构建 + TS 占比门禁（pretest 会自动跑）
npm test                      # node --test
npm run dev                    # 开发实例，127.0.0.1:4322
```

**改完代码至少跑 `npm run test:affected`；涉及 ajun-runtime 时跑 `npm run check`。**仓库没有 CI，门禁全靠本地执行。

## 端口真相

| 端口 | 谁 | 说明 |
|---|---|---|
| `4321` | A君 **正式** 运行台 | launchd 受控启动项，跑**不可变 release**，不加载工作树里的未验证修改 |
| `4322` | A君 **开发** 实例 | `npm run dev`；关闭 Paperclip、飞书、小D 等后台协调服务（`AJUN_DISABLE_BACKGROUND_SERVICES=true`） |
| `4318` | 小D 媒体转写 | `apps/xiaod-media-transcriber` |
| `4320` | 项目进度看板 | 按需工具，非常驻 |
| `18082` | 本地 AI 插件 | 仓库外运行根，可独立安装 / 回滚 |

**易错点：改工作树代码不会影响 4321。**正式端口跑的是已发布 release，需要走 `npm run release:immutable` 才会变。

## 硬性规则

- **复用优先**：新增控制台、任务队列、调度、预算、审批、审计、Agent 运行时或通用连接器前，必须先查本仓库 → 已安装 CLI / 技能库 → 官方文档、源码、公开实现。只有确实缺失且属本项目业务边界，才自研最小缺口。不得复制 Paperclip 的控制面。
- **能力真相五层**：已声明 → 已配置 → 运行可达 → 任务实证 → 人工验收。**禁止用前一层冒充后一层。**Manifest `active` 和进程在线都不能单独证明业务可用。
- **能力决策先于能力执行**：Model 只能提出请求，不能批准自己的权限、费用或外部副作用。
- **不把聊天展示状态当作任务真相**，不把部分成功标记为完整成功。
- **不删除现有能力来换取表面简洁。**按真实工作流分组、渐进披露。
- **不读取、回显、复制或提交真实 `.env`。**secret、token、Cookie、授权链接不得进入代码、文档、Prompt、日志或测试快照。
- **默认冻结、重开需重新授权**：M5 高权限自治、Boom Radar 自动扫描、Campaign、Cron、Publisher 与一切外部写入。
- 运行与测试结果必须事实化描述，未验证的外部能力**显式标记未验证**。

## 常见陷阱

1. **Hermes adapter 补丁会被 Hermes 升级覆盖。**飞书行为异常时先确认 `adapter.py` 里 `_route_ajun_commander_event` 还在，再查其他环节。
2. **`public/*.js` 与 `frontend/src/*.ts` 同时入库**（21 对）。改了 `.ts` 必须 `npm run build:frontend`，否则页面跑的还是旧 JS。
3. **根 `README.md` 的“运行 A君运行台”段落写的是 4321，实际开发实例是 4322。**
4. **`apps/boom-monitor` 是 legacy Python / Docker 回滚资产**，不在 workspace，不是正式入口。现役实现在 `apps/ajun-runtime/src/boom-monitor/`。
5. **不要在 README 手写 release hash。**用 `npm run runtime:fingerprint` 取实时事实。
6. 开发实例关掉了后台协调服务，**“本机能收到飞书消息”这件事在 4322 上验证不了。**

## 交接与文档

小而明确的局部修复直接做，不为流程新增文档。发生换人、换会话、未完成外部验证或里程碑切换时，按 [`docs/handoffs/README.md`](./docs/handoffs/README.md) 在 `docs/handoffs/current/` 建立或更新交接单——只记可验证事实，写明唯一下一步、继续条件、验证账本、风险和关闭条件，不记凭据。

文档门禁与灵活边界见 [`docs/governance/document-lifecycle.md`](./docs/governance/document-lifecycle.md)。
