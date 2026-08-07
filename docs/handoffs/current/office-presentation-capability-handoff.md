# 小办演示文稿能力交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-06（Asia/Shanghai） |
| 交出者 | Codex 工作台 |
| 接手者 | 技术负责人 / 验收负责人 |
| 关联任务 | [PRD](../../../tasks/prd-office-presentation-capability.md)、[验收记录](../../reviews/office-presentation-capability/acceptance.md) |
| 截止条件 | 隔离依赖、外部 E2E、live 切换、真实任务和人工 Office/WPS 质量验收全部完成 |

## 1. 接手目标

- 目标：把当前 `PPTD ready + PPTX needs_capability` 安全推进到可验证的 PPTX 能力。
- 用户约束与不可做事项：不升级 A君 Node 22；不自动全局安装；不发送内部/敏感材料；不复制 Cookie/Vault；不新建第二套控制面。
- 做完的定义：公开固定样例完成 Kimi 图片/PPTX 导出，live 能力投影、真实小办任务、三类产物引用和人工质量均有证据。
- 唯一下一步：准备并锁定隔离 Node 24+、Python 依赖、Chromium 和真实 `agent-browser >= 0.33.2`，先重新运行默认 smoke，确认 export readiness 变为 `ready`。
- 允许继续的前提：隔离工具链版本和路径可审计，技能仍为允许版本/哈希，且不会触发 npm/pip 自动安装；运行 `--live` 前另获公开固定样例的当次外部处理批准。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 新任务、两受控工具、适配器、分阶段 readiness、路由、样例和测试已落地 | [验收记录](../../reviews/office-presentation-capability/acceptance.md) | 已验证 |
| 本地运行时 | 源码环境 compose ready；未切换不可变 release | 默认 smoke 输出 | 部分验证 |
| 外部平台 | 未访问 Kimi，未生成真实 PPTX | 验收记录 | 未验证 |
| 人工确认 | 未用 PowerPoint/WPS 打开 | 验收记录 | 待确认 |

## 3. 变更与决策

- 已完成：PPTD 自包含工程、结构 QA、PPTX 受控导出边界、外部数据分类门禁、技能版本/哈希门禁、offline/fallback/live-opt-in 命令。
- 关键文件：`apps/ajun-runtime/src/open-kimi-ppt-adapter.js`、小办 Manifest/Profile、任务路由和聚焦测试。
- 已确定的边界：PPTX 只对公开/脱敏且当次批准开放；依赖不满足时保留 PPTD，不冒充完整成功。
- 不要重复创建的产物：不要另建 SkillBundle、队列、审批、控制台、运行账本或常驻 PPT 服务。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 聚焦测试 `147/147`、A君受影响全量 `1141/1141` 与默认 smoke，见验收记录 | 外部和人工验收不在自动化结论内 |
| 运行时 | PARTIAL | 源码依赖探针为 partial | 不可变 release/PID/端口未核对 |
| 外部平台 | NOT CHECKED | 未运行 `--live` | Kimi 图片和 PPTX 导出 |
| 人工验收 | NOT CHECKED | 无 | PowerPoint/WPS 质量与可编辑性 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：npm 当前 `agent-browser 0.31.1` 低于上游要求 `0.33.2`，且要求 Node 24；强行绕过会使外部导出结论失真。
- 不得复制或展示的信息：Cookie、token、私人聊天、未脱敏业务数据、Vault 内容、完整页面正文和原始命令/stdout。
- 需要谁确认：技术负责人确认隔离工具链；负责人批准公开固定样例外部处理并完成人工质量验收。
- 关闭条件：验收记录五项剩余门禁全部 PASS，相关 PRD 和 live 能力状态同步。
- 关闭证据链接：关闭时补入验收记录与不可变 release 证据。
