# 小办演示文稿能力交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已暂停；候选与失败证据保留，不进入当前 M5 release |
| 创建时间 | 2026-08-06（Asia/Shanghai） |
| 交出者 | Codex 工作台 |
| 接手者 | 技术负责人 / 验收负责人 |
| 关联任务 | [PRD](../../../tasks/prd-office-presentation-capability.md)、[验收记录](../../reviews/office-presentation-capability/acceptance.md) |
| 截止条件 | 隔离依赖、外部 E2E、live 切换、真实任务和人工 Office/WPS 质量验收全部完成 |

## 1. 接手目标

- 目标：把当前 `PPTD ready + PPTX needs_capability` 安全推进到可验证的 PPTX 能力。
- 用户约束与不可做事项：不升级 A君 Node 22；不自动全局安装；不发送内部/敏感材料；不复制 Cookie/Vault；不新建第二套控制面。
- 做完的定义：公开固定样例完成 Kimi 图片/PPTX 导出，live 能力投影、真实小办任务、三类产物引用和人工质量均有证据。
- 唯一下一步：当前无执行动作。待 M5 收口后，如负责人重新明确批准，再使用同一仓库公开固定样例运行带阶段 checkpoint 的 Playwright live。
- 允许继续的前提：不得记录正文、原始命令或 stdout，不得移除白名单、引入 Profile/Cookie/自动安装或修改 A君 Node 22；旧批准已消费，下一次访问 Kimi 需要新的当次批准。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 新任务、两受控工具、适配器、分阶段 readiness、路由、样例和 Playwright 受控替代层已落地 | [验收记录](../../reviews/office-presentation-capability/acceptance.md) | 已验证 |
| 本地运行时 | `1.1.0` 隔离依赖探针 ready、compose ready；真实 localhost Chromium 完成单 Context 操作与网络拦截；因尚无 Playwright live 记录，visual QA/PPTX 保持 needs_capability；未切换不可变 release | 默认 smoke、聚焦测试与私有工具链清单 | 部分验证 |
| 外部平台 | Playwright 方案已获当次批准并运行仓库公开固定样例；图片阶段在唯一安全重试后返回 `ETIMEDOUT`，未进入 PPTX | 验收记录与 `1.1.0/live-evidence-20260806T110419Z` | 已验证失败 |
| 人工确认 | 未用 PowerPoint/WPS 打开 | 验收记录 | 待确认 |

## 3. 变更与决策

- 已完成：PPTD 自包含工程、结构 QA、PPTX 受控导出边界、外部数据分类门禁、技能版本/哈希门禁、offline/fallback/live-opt-in 命令，以及精确版本隔离工具链。
- 已完成：浏览器运行时只放行本机桥接地址、`www.kimi.com` 和 `statics.moonshot.cn`，并清空 Profile、Cookie 恢复、插件、自动连接和自定义启动参数。
- 已修正：`AGENT_BROWSER_AUTO_CONNECT` 必须从子进程环境中移除，字符串 `false` 会被 CLI 按“存在即启用”处理；外部命令失败现在只返回脱敏错误分类。
- 已替换：移除自有 `agent-browser batch` 兼容入口，改为锁定 `playwright-core 1.62.1` 的非持久 BrowserContext；HTTP(S)、WebSocket、Service Worker、WebRTC、下载路径和编辑器操作均由窄适配层约束。
- 已新增：适配器临时目录中的阶段 checkpoint 只允许固定枚举和六个脱敏字段；外层超时会在删除临时目录前读取最后阶段、状态和尝试次数。localhost 真浏览器已验证导航、deck-ready 与 viewport 推进，模拟下载超时已验证 `visualQa.download / started / attempt=2` 回传。
- 关键文件：`apps/ajun-runtime/src/open-kimi-ppt-adapter.js`、小办 Manifest/Profile、任务路由和聚焦测试。
- 已确定的边界：PPTX 只对公开/脱敏且当次批准开放；依赖不满足时保留 PPTD，不冒充完整成功。
- 不要重复创建的产物：不要另建 SkillBundle、队列、审批、控制台、运行账本或常驻 PPT 服务。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | LOCAL PASS / RELEASE EXCLUDED | PPT 聚焦测试 `157/157` 通过；Publisher 的 4 个到期 lease 用例已改为固定时钟，affected 信号恢复。PPT 候选保存在独立分支，未合入当前 M5 release | 不证明 PPTX、live 或人工 Office 质量 |
| 运行时 | PARTIAL | 锁定依赖探针 ready，live 能力仍因缺验证记录闭锁 | 不可变 release/PID/端口未核对 |
| 外部平台 | FAILED / NEEDS_CAPABILITY | Playwright live 已执行一次；图片阶段最终为 `ETIMEDOUT`，脱敏失败摘要已落盘 | Kimi 图片和 PPTX 均未生成，v2 live 记录不存在 |
| 人工验收 | NOT CHECKED | 无 | PowerPoint/WPS 质量与可编辑性 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：旧 live 发生在阶段 checkpoint 落地前，不能回溯细分；新诊断已完成本地验证，但尚未在 Kimi live 中产生真实阶段证据。不得沿用旧批准、移除白名单或伪造通过记录。
- 不得复制或展示的信息：Cookie、token、私人聊天、未脱敏业务数据、Vault 内容、完整页面正文和原始命令/stdout。
- 需要谁确认：下一次 Kimi live 由负责人重新批准；导出后再进行人工质量验收。
- 关闭条件：验收记录五项剩余门禁全部 PASS，相关 PRD 和 live 能力状态同步。
- 关闭证据链接：关闭时补入验收记录与不可变 release 证据。
