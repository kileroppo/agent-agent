# Agent 技能接线与微信本机分析交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-02 08:07 Asia/Shanghai |
| 交出者 | Codex |
| 接手者 | A君 / 运行验收者 |
| 关联任务 | [README 当前状态](../../../README.md)、[核心契约](../../contracts/core-contracts.md)、[系统架构](../../architecture/system-architecture.md) |
| 截止条件 | Grok 按未订阅状态安全停用，并由主人批准一次微信本机摘要验收 |

## 1. 接手目标

- 目标：让已安装的逸尘技能真正进入岗位能力、就绪检查和受控执行链，并把微信私聊分析限制在本机。
- 用户约束与不可做事项：不得读取或展示登录凭据；不得把微信原文、发送者或授权内容发送到云模型、Paperclip、飞书、日志或报告；不得把技能安装等同于可执行。
- 做完的定义：岗位能看见技能就绪状态；Grok 登录文件不再冒充订阅可用，未订阅时小R继续使用网页研究和统一搜索；微信读取在 Vault 与本机模型就绪后才消耗临时授权，且能从控制台或原飞书会话撤销。
- 唯一下一步：先把当前混杂工作树收敛为可追溯 source revision，冻结包含本轮最终加固的不可变 release，并与 A君 Profile 撤销工具一起切换。
- 允许继续的前提：微信验收必须由主人明确批准当前范围，且不外发结果；Grok 未显式声明订阅可用时禁止调用。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 7 个逸尘技能进入审计清单和岗位 Manifest；技能就绪注册表、Grok MCP 适配器、微信临时授权及本机分析器已实现 | `agents/*/manifest.json`、`apps/ajun-runtime/src/skill-execution-registry.js`、`grok-consult-mcp-adapter.js`、`private-read-grant.js`、`local-private-chat-analyzer.js` | 已验证 |
| 本地运行时 | Hermes 的小R、小D、办公助理已同步岗位技能；A君 Profile 已加载微信授权撤销工具；`qwen3:14b` 已安装并只在 Homebrew Ollama 回环监听；4321 通过可追溯不可变 release 运行 | Hermes Profile 0 drift、Ollama `/api/tags`、4321 PID/cwd/entrypoint 与 release manifest | 已验证基础运行；Grok opt-out 随本次 release 点验 |
| 外部平台 | 7 个技能已作为受管公司技能导入 Paperclip；负责人确认没有 Grok 订阅，因此 Grok 作为可选增强停用，不再要求购买会员或完成查询验收 | Paperclip 公司技能只读回读；Grok opt-out 契约 | 已确认边界 |
| 人工确认 | 没有读取任何真实微信聊天，也没有在飞书批准私聊范围 | 无真实私聊产物 | 待确认 |

## 3. 变更与决策

- 已完成：技能固定哈希和信任级别审计；岗位技能同步；Grok 专用 MCP 失败关闭；微信 30 分钟、最多 10 次、绑定会话/岗位/范围的可撤销授权；本机 `qwen3:14b` 分块分析与原文防回显。
- 关键文件或外部配置位置：`apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs`、`agents/`、`integrations/hermes/profiles/wechat-chat-retriever.profile.json`；Paperclip 受管技能目录由 Paperclip 自己维护。
- 已确定的边界与兼容性约束：技能不能获得通用终端或任意浏览器；Grok 只有显式声明 `subscribed` 且登录存在时才可用，`disabled` 时不调用且不影响小R其他研究能力；微信本机模型或 Vault 未就绪时不读、不扣授权、不云端降级。
- 不要重复创建的产物：第二套技能安装器、第二套微信数据库解析器、第二套 Grok 登录或查询实现。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | A君 `1099/1099`；岗位 Manifest `15/15`；Grok 专项 `7/7`；`git diff --check` | 无 |
| 运行时 | PARTIAL | Hermes 三岗位技能与 A君 撤销工具同步完成；Homebrew Ollama 只监听 `127.0.0.1:11434`，`qwen3:14b` health 为 ready，微信最终加固已在不可变 release 运行 | Grok opt-out 新 release 点验；真实微信摘要仍待主人给定会话 |
| 外部平台 | PASS WITH OPT-OUT | Paperclip 7 个公司技能已导入并回读信任级别；负责人确认未订阅 Grok，专项自动化证明停用时零 Grok 调用 | Grok 不属于当前验收范围 |
| 人工验收 | NOT CHECKED | 未读取真实微信聊天 | 原飞书会话授权、撤销和本机摘要可读性 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：真实微信验收涉及私密数据，不能由实现者自行选择联系人或群；Grok 登录文件仍可能存在，但未订阅状态必须覆盖登录存在，避免误显示可用。
- 不得复制或展示的信息：Grok 登录凭据、Cookie、微信数据库内容、联系人标识、聊天原文、授权链接和任何 secret。
- 需要谁确认：主人提供联系人或群名，并批准一次限定范围的微信验收。
- 关闭条件：新不可变 release 加载当前代码并显示 Grok 未启用；微信 Vault、本机模型、临时授权复用与撤销、脱敏摘要在一次主人批准的真实任务中通过。
- 关闭证据链接：完成后补到本交接的验证账本，不得用自动化测试代替外部或人工证据。
