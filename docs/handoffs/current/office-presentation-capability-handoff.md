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
- 唯一下一步：取得负责人新的当次批准后，使用同一仓库公开固定样例复验“普通点击 + 当前非持久 Context 受控下载目录轮询”的 PPTX 链路；不得无批准再次访问 Kimi。
- 允许继续的前提：不得记录正文、原始命令或 stdout，不得移除白名单、引入 Profile/Cookie/自动安装或修改 A君 Node 22；下一次访问 Kimi 仍需要新的当次批准。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 新任务、两受控工具、适配器、分阶段 readiness、路由、样例和 Playwright 受控替代层已落地 | [验收记录](../../reviews/office-presentation-capability/acceptance.md) | 已验证 |
| 本地运行时 | `1.1.0` 隔离依赖探针 ready、compose ready；真实 localhost Chromium 完成单 Context、网络拦截和图片 ZIP 下载，上游 `is_image_zip` 接受显式与兜底目录文件；因尚无通过的 Playwright live 记录，visual QA/PPTX 保持 needs_capability；未切换不可变 release | 隔离环境 smoke、聚焦测试与私有工具链清单 | 部分验证 |
| 外部平台 | 2026-08-07 最新获批 live 已生成 4 张 1920×1080 页面图和 overview，视觉检查通过；两次 PPTX 下载事件均完整等待 180 秒仍超时，没有 PPTX 或成功记录 | 验收记录与 `1.1.0/live-evidence-pptx-180s-20260807T024633Z` | 图片已验证，PPTX 失败 |
| 人工确认 | 未用 PowerPoint/WPS 打开 | 验收记录 | 待确认 |

## 3. 变更与决策

- 已完成：PPTD 自包含工程、结构 QA、PPTX 受控导出边界、外部数据分类门禁、技能版本/哈希门禁、offline/fallback/live-opt-in 命令，以及精确版本隔离工具链。
- 已完成：浏览器运行时只放行本机桥接地址、`www.kimi.com` 和 `statics.moonshot.cn`，并清空 Profile、Cookie 恢复、插件、自动连接和自定义启动参数。
- 已修正：`AGENT_BROWSER_AUTO_CONNECT` 必须从子进程环境中移除，字符串 `false` 会被 CLI 按“存在即启用”处理；外部命令失败现在只返回脱敏错误分类。
- 已替换：移除自有 `agent-browser batch` 兼容入口，改为锁定 `playwright-core 1.62.1` 的非持久 BrowserContext；HTTP(S)、WebSocket、Service Worker、WebRTC、下载路径和编辑器操作均由窄适配层约束。
- 已新增：适配器临时目录中的阶段 checkpoint 只允许固定枚举和六个脱敏字段；外层超时会在删除临时目录前读取最后阶段、状态和尝试次数。localhost 真浏览器已验证导航、deck-ready 与 viewport 推进，模拟下载超时已验证 `visualQa.download / started / attempt=2` 回传。
- 已修复：Playwright 浏览器下载目录绑定到上游轮询的临时 `downloads/`；显式输出拒绝覆盖并校验非空，真实 localhost 图片 ZIP 在显式路径和兜底目录均通过上游 `is_image_zip`。下载 RPC 失败后，兜底轮询不再覆盖首次脱敏错误码。
- 已修复：上游图片导出 `main()` 返回非零时不再把详细失败 checkpoint 覆盖成整体完成；若 Kimi 返回独立 PNG/JPEG/GIF/WebP 文件，桥接器只在受控临时目录内校验签名并重新封装为上游可接受 ZIP。该兼容分支已通过 localhost 测试，尚未重新访问 Kimi。
- 已修复：最新 live 暴露 macOS 临时目录 `/var` 与 `/private/var` 指向同一位置但字符串不同，Playwright 路径守卫误判下载目标越界；桥接器现在在 RPC 前解析真实路径，新增路径别名回归测试并将锁定 bridge 哈希更新为 `0e16189946b887e926784a232df286a84a7a1c8e468efb52f5d2fc901cc4a335`。修复后未再次访问 Kimi。
- 已修复：路径别名复验已越过下载守卫，但原始归档候选在后处理阶段失败。桥接器现在完整读取并校验图片归档、以确定命名重新封装，只把该受控归档交给上游；解包和 overview 各有独立 checkpoint，整体非零也会写稳定失败。局部测试 `12/12` 通过，锁定 bridge 哈希更新为 `e29096db42271ca1bc4ea4bb607455349e16664d727423501247e667f1166473`，修复后未再次访问 Kimi。
- 已验证并调整：最新 live 证明受控图片归档重封装、解包和 overview 均成功；PPTX 两次在共用的 120 秒下载 RPC 上限超时。本地已将 PPTX 专用上限恢复为上游请求的 180 秒，并把外层 PPTX 命令上限调为 270 秒，图片仍保持 120 秒；25 项 bridge/driver/adapter 回归通过，锁定 bridge 哈希更新为 `911d460946f11f0c982369827b10b1f05de90a84148c46ad027e8fed2cbd9c71`。调整后未再次访问 Kimi。
- 已否定并替换：PPTX 专用 180 秒 live 的两次尝试仍在准确上限收敛为 `playwright_download_event_timeout`，证明继续延长页面下载事件无效。本机上游 `open-kimi-ppt-skills 1.1.3` 已采用普通点击后轮询下载目录的兼容方案；本项目只吸收该机制，并将轮询范围收紧到当前非持久 Context 的受控 `downloads/`，不访问用户默认下载目录。localhost 真 Chrome 与局部测试 `27/27` 通过；driver 哈希更新为 `1d7b2e039fab0299237b25bebe236b9acba4239acf4baee57dc64fe753928881`，bridge 哈希更新为 `9ee80f60f7587ac3fcfc198f87d6af953d03feff5e1cbbbd3a8ed15881b26b7a`。替代链路尚未访问 Kimi。
- 关键文件：`apps/ajun-runtime/src/open-kimi-ppt-adapter.js`、小办 Manifest/Profile、任务路由和聚焦测试。
- 已确定的边界：PPTX 只对公开/脱敏且当次批准开放；依赖不满足时保留 PPTD，不冒充完整成功。
- 不要重复创建的产物：不要另建 SkillBundle、队列、审批、控制台、运行账本或常驻 PPT 服务。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PARTIAL | PPT/路由聚焦测试 `276/276`、Manifest `17/17`、隔离环境 offline+fallback smoke 和架构检查通过；最新 bridge/driver/adapter 局部回归 `27/27`，覆盖普通点击、受控目录文件发现、PPTX 180 秒目录轮询和稳定 checkpoint；`test:affected` 此前被无本轮 diff 的 Publisher 4 个到期 lease 用例阻断 | 不能宣称受影响全量通过 |
| 运行时 | PARTIAL | 锁定依赖探针 ready，live 能力仍因缺验证记录闭锁 | 不可变 release/PID/端口未核对 |
| 外部平台 | PARTIAL / NEEDS_CAPABILITY | 2026-08-07 最新批准已执行一次 live 编排和唯一安全重试；4 页图片与 overview 已生成并通过视觉检查，两次 PPTX 事件等待完整 180 秒仍超时，脱敏失败摘要已落盘 | PPTX 和 v2 live 记录不存在；受控下载目录轮询替代链路尚未外部复验 |
| 人工验收 | NOT CHECKED | 无 | PowerPoint/WPS 质量与可编辑性 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：图片导出与视觉 QA 已有真实外部证据，但 PPTX 在 120 秒和 180 秒下载事件等待下均失败，说明事件捕获模型不兼容而非单纯等待不足。受控目录轮询替代方案本地已通过，尚未外部复验；只能宣称图片 QA 通过，不能宣称 PPTX 可用。
- 不得复制或展示的信息：Cookie、token、私人聊天、未脱敏业务数据、Vault 内容、完整页面正文和原始命令/stdout。
- 需要谁确认：本地下载 fixture 修复通过后，下一次 Kimi live 仍由负责人重新批准；导出后再进行人工质量验收。
- 关闭条件：验收记录五项剩余门禁全部 PASS，相关 PRD 和 live 能力状态同步。
- 关闭证据链接：关闭时补入验收记录与不可变 release 证据。
