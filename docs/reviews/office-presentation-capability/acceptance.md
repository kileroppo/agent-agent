# 小办演示文稿能力验收

| 层级 | 结论 | 2026-08-06 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 代码与契约 | PASS | Manifest/Profile/适配器枚举、任务目录、A君/飞书路由、产物和外部处理门禁已有自动化覆盖；Playwright 控制层覆盖单一 BrowserContext、路径守卫、版本/哈希门禁和网络白名单 | 无 |
| 固定样例 offline | PASS | `npm run verify:office-presentation --workspace=ajun-runtime`；4 页中文、表格、图表、本地 SVG，结构与自包含检查通过 | 不含浏览器视觉效果 |
| fallback | PASS | 同一命令验证敏感数据在浏览器前拒绝，`autoInstall=false`；路径逃逸、伪造媒体、页数漂移、覆盖和未审批均有单测 | 无真实网络故障重试 |
| 隔离工具链 | PASS | `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/toolchain.json`；Node `25.9.0`、Python `3.14.6`、Playwright Core `1.62.1`、Chrome `150.0.7871.187` 精确锁定；真实 localhost Chromium 在同一 BrowserContext 完成 open/wait/viewport，并证明越界请求被拦截 | localhost 通过不能替代 Kimi 跨域路径 |
| 本机运行 | NOT CHECKED | 本轮未重启不可变 release，未核对新 PID/端口/工作目录 | live `capabilities` 尚未加载新代码 |
| Kimi 外部 E2E | FAILED / NEEDS_CAPABILITY | 负责人当次批准后，Playwright 方案使用仓库公开固定样例运行 live；图片阶段在唯一一次安全重试后返回脱敏 `ETIMEDOUT` | 未生成页面图片、PPTX 或 v2 live 通过记录；visual QA/PPTX 继续为 `needs_capability` |
| Paperclip/Hermes/飞书 | NOT CHECKED | 路由和 Profile/MCP 契约有测试 | 尚未创建真实小办 PPT 指派和 Work Product 回传 |
| 人工质量 | NOT CHECKED | 无 | 尚未用 PowerPoint/WPS 检查中文字体、图表、图片、溢出、错位、动画和可编辑性 |

## 自动化命令

```bash
node --test apps/ajun-runtime/test/open-kimi-ppt-adapter.test.js apps/ajun-runtime/test/open-kimi-playwright-driver.test.js apps/ajun-runtime/test/local-office-assistant.test.js apps/ajun-runtime/test/m5-role-tool-grant.test.js apps/ajun-runtime/test/m5-role-tool-adapters.test.js apps/ajun-runtime/test/skill-execution-registry.test.js apps/ajun-runtime/test/business-task-routing.test.js apps/ajun-runtime/test/feishu-commander.test.js apps/ajun-runtime/test/task-capability-catalog.test.js agents/test/agent-manifest.test.mjs
npm run verify:office-presentation --workspace=ajun-runtime
```

聚焦测试当前 `156/156` 通过，其中真实 localhost Chromium 测试在同一非持久 BrowserContext 完成 open、wait 和 viewport，并确认不带端口的越界请求被拦截；Python 桥接联测证明 checkpoint 会随 `browser.launch → browser.navigation → deck.ready → browser.viewport` 推进。模拟外层超时可在清理前返回最后阶段、状态和尝试次数，记录只含六个固定字段、权限为 `0600`，清理后不残留；小办会把临时失败投影为 `office_presentation_waiting_test`，并只在 QA Work Product 中保留固定诊断阶段和尝试次数。使用 `1.1.0` 锁定工具链的默认 smoke 输出 `dependencies=ready`、`compose=ready`、`visualQa=needs_capability`、`export=needs_capability`；后两项仍没有 v2 live 通过记录。默认 smoke 没有启动外部浏览器、访问 Kimi、安装全局软件或修改用户 Vault。架构检查通过。

第一次批准后的失败证据继续保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.0.0/live-evidence-20260806T081501Z/`。第二次批准后的独立失败证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.0.0/live-evidence-20260806T091345Z/`：PPTD、4 个页面、本地 SVG 和结构 QA 已写入；`.qa-images/`、PPTX 与 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.0.0/live-verification.json` 均不存在，证明旧方案失败停在图片阶段、没有进入 PPTX 交付。两个目录均未覆盖或删除，也不作为 Playwright 验证结果。新适配器清除 Profile、自动连接和调试环境；临时浏览器错误只允许在适配器层重试整段一次，最终错误只保留脱敏分类，不保留完整命令或 stdout。

Playwright 方案的本次失败证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-20260806T110419Z/`。该目录包含完整 PPTD、4 个页面、本地 SVG、结构 QA 和脱敏 `failure-summary.json`；不含页面图片或 PPTX。进程退出后临时浏览器和临时监听均已清理，`live-verification-v2.json` 不存在。本次只运行一个 live 编排，适配器按既定策略最多执行一次安全重试；最终分类为 `visualQa.images / ETIMEDOUT`，当前证据不足以继续细分为导航、deck-ready、编辑器控件或下载超时。

此前 `npm run test:affected` 运行到无本次改动的 `@agent-army/m5-publisher-gateway` 时失败：该包 `217/221`，4 项 `cua-driver-runner` 用例的固定 lease 均在 `2026-08-06T00:00:00.000Z` 到期，当前时钟下先返回 `cua_profile_lease_invalid`。对应 Publisher 源码和测试无本轮 diff；本次 PPT 聚焦测试 `152/152`、默认 smoke、真实 localhost Chromium 验证和架构检查均通过。不能把受影响全量写成通过。

## 完整验收剩余门禁

1. **已完成**：版本与源码哈希锁定的隔离 Node、Python、Playwright Core 和 Chromium，默认 smoke 的依赖探针通过；
2. **已完成本地门禁**：Playwright 替代层在真实 localhost Chromium 中完成单生命周期操作与网络拦截；
3. **已完成诊断门禁**：阶段级脱敏 checkpoint 和 localhost 真浏览器联测通过；下一次获批 live 将能区分导航、deck-ready、编辑器控件、图片下载和下载落盘等待；
4. 以不可变 release 重启 A君并核对 PID、4321 端口、工作目录和 `capabilities`；
5. 从小办飞书入口创建真实任务，核对 Paperclip Run/Work Product 和 Hermes checkpoint 只含脱敏运行元数据；
6. 使用 PowerPoint/WPS 完成人工质量检查并回填本账本。
