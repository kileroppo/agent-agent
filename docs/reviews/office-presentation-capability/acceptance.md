# 小办演示文稿能力验收

| 层级 | 结论 | 截至 2026-08-07 的证据 | 未证明部分 |
| --- | --- | --- | --- |
| 代码与契约 | PASS | Manifest/Profile/适配器枚举、任务目录、A君/飞书路由、产物和外部处理门禁已有自动化覆盖；Playwright 控制层覆盖单一 BrowserContext、路径守卫、版本/哈希门禁和网络白名单 | 无 |
| 固定样例 offline | PASS | `npm run verify:office-presentation --workspace=ajun-runtime`；4 页中文、表格、图表、本地 SVG，结构与自包含检查通过 | 不含浏览器视觉效果 |
| fallback | PASS | 同一命令验证敏感数据在浏览器前拒绝，`autoInstall=false`；路径逃逸、伪造媒体、页数漂移、覆盖和未审批均有单测 | 无真实网络故障重试 |
| 隔离工具链 | PASS | `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/toolchain.json`；Node `25.9.0`、Python `3.14.6`、Playwright Core `1.62.1`、Chrome `151.0.7922.76` 锁定；真实 localhost Chromium 在同一 BrowserContext 完成 open/wait/viewport、越界请求拦截和图片 ZIP 下载 | localhost 通过不能替代 Kimi 跨域路径 |
| 本机运行 | NOT CHECKED | 本轮未重启不可变 release，未核对新 PID/端口/工作目录 | live `capabilities` 尚未加载新代码 |
| Kimi 外部 E2E | PARTIAL / NEEDS_CAPABILITY | 2026-08-07 最新当次批准后运行一次 live 编排和唯一安全重试；两次均生成 4 张 1920×1080 页面图与 overview，视觉检查通过，随后进入 PPTX；两次完整等待 180 秒后仍为 `pptx.download / playwright_download_event_timeout` | PPTX 和 v2 live 通过记录不存在；已证明继续加长下载事件等待无效，改用受控目录轮询后的链路尚未外部复验，visual QA/export readiness 继续为 `needs_capability` |
| Paperclip/Hermes/飞书 | NOT CHECKED | 路由和 Profile/MCP 契约有测试 | 尚未创建真实小办 PPT 指派和 Work Product 回传 |
| 人工质量 | NOT CHECKED | 无 | 尚未用 PowerPoint/WPS 检查中文字体、图表、图片、溢出、错位、动画和可编辑性 |

## 自动化命令

```bash
node --test apps/ajun-runtime/test/open-kimi-ppt-adapter.test.js apps/ajun-runtime/test/open-kimi-playwright-driver.test.js apps/ajun-runtime/test/open-kimi-playwright-export.test.js apps/ajun-runtime/test/local-office-assistant.test.js apps/ajun-runtime/test/m5-role-tool-grant.test.js apps/ajun-runtime/test/m5-role-tool-adapters.test.js apps/ajun-runtime/test/skill-execution-registry.test.js apps/ajun-runtime/test/business-task-routing.test.js apps/ajun-runtime/test/feishu-commander.test.js apps/ajun-runtime/test/task-capability-catalog.test.js apps/ajun-runtime/test/task-service.test.js
node --test agents/test/agent-manifest.test.mjs
npm run verify:office-presentation --workspace=ajun-runtime
```

PPT/路由聚焦测试当前 `276/276`、Manifest `17/17` 通过。其中真实 localhost Chromium 测试在同一非持久 BrowserContext 完成 open、wait、viewport、图片 ZIP 事件捕获和普通点击后的受控目录文件发现，并确认不带端口的越界请求被拦截；显式输出与浏览器下载目录中的候选 ZIP 均被上游原生 `is_image_zip` 接受。Python 桥接联测证明 checkpoint 会随 `browser.launch → browser.navigation → deck.ready → browser.viewport` 推进，且图片兜底轮询不再覆盖首次下载失败的脱敏错误码；PPTX 普通点击后只进入当前 Context 的受控目录轮询，180 秒文件等待及稳定失败 checkpoint 也有覆盖。独立图片或图片 ZIP 都会在受控临时目录完整读取、确定命名并重新封装，上游优先选择该归档，macOS 临时目录路径别名也会在 RPC 前规范化。使用 `1.1.0` 锁定工具链的隔离环境 smoke 输出 `dependencies=ready`、`compose=ready`、`visualQa=needs_capability`、`export=needs_capability`；后两项仍没有 v2 live 通过记录。smoke 没有启动外部浏览器、访问 Kimi、安装全局软件或修改用户 Vault。

第一次批准后的失败证据继续保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.0.0/live-evidence-20260806T081501Z/`。第二次批准后的独立失败证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.0.0/live-evidence-20260806T091345Z/`：PPTD、4 个页面、本地 SVG 和结构 QA 已写入；`.qa-images/`、PPTX 与 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.0.0/live-verification.json` 均不存在，证明旧方案失败停在图片阶段、没有进入 PPTX 交付。两个目录均未覆盖或删除，也不作为 Playwright 验证结果。新适配器清除 Profile、自动连接和调试环境；临时浏览器错误只允许在适配器层重试整段一次，最终错误只保留脱敏分类，不保留完整命令或 stdout。

Playwright 方案的本次失败证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-20260806T110419Z/`。该目录包含完整 PPTD、4 个页面、本地 SVG、结构 QA 和脱敏 `failure-summary.json`；不含页面图片或 PPTX。进程退出后临时浏览器和临时监听均已清理，`live-verification-v2.json` 不存在。本次只运行一个 live 编排，适配器按既定策略最多执行一次安全重试；最终分类为 `visualQa.images / ETIMEDOUT`，当前证据不足以继续细分为导航、deck-ready、编辑器控件或下载超时。

带 checkpoint 的后续获批 live 证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-checkpoint-20260806T152553Z/`。第一次和唯一安全重试均在数秒内推进到 `visualQa.download_wait / started`；对应临时目录只有导出 host 与 payload，没有 `browser-output.zip`，最终证据目录也没有图片、ZIP 或 PPTX。退出后浏览器、Python 和临时监听均已清理，`live-verification-v2-checkpoint.json` 不存在。该证据把阻塞从笼统图片阶段收敛到 Playwright 下载捕获、落盘或图片 ZIP 识别边界，不能再归因于浏览器启动、Kimi 导航、PPTD deck-ready 或编辑器控件。

2026-08-07 已完成下载边界本地修复：Chromium 的受控 `downloadsPath` 绑定到上游实际轮询目录，显式输出拒绝覆盖已有目标并在落盘后校验非空文件；下载事件、触发和保存阶段返回固定脱敏错误码。真实 localhost 夹具下载了一个含 `1.png` 的 ZIP，显式 `browser-output.zip` 和浏览器下载目录中的候选文件均被上游原生 `is_image_zip` 接受。若下载 RPC 失败，上游 `find_download` 兜底轮询不再覆盖首次错误 checkpoint，且 RPC/兜底等待被限制在适配器总超时内。该修复尚未访问 Kimi，不得据此宣称外部图片或 PPTX 导出通过。

负责人随后批准了新的当次 live，证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-download-fix-20260807T011835Z/`。本次只运行一次编排，适配器执行初次尝试和唯一安全重试，最终 `ETIMEDOUT`；没有留下 `.qa-images/`、PPTX 或 v2 成功记录，浏览器与导出进程均已退出。最终 checkpoint 为 `visualQa.images / completed`，但目录没有图片；代码复核确认桥接器错误地把上游 `main()` 的非零返回也写成整体完成，因此该状态不能当作图片成功证据。随后已在不访问 Kimi 的前提下修复：非零返回保留细粒度失败 checkpoint；若外部编辑器返回独立图片文件，则只在适配器临时目录校验签名并重新封装为 ZIP。两项本地测试通过，但需要新的当次批准才能再次外部验证。

最新当次批准的 live 证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-normalization-fix-20260807T014805Z/`。一次编排和唯一安全重试均止于 `visualQa.download / playwright_output_denied`，没有生成 `.qa-images/`、PPTX 或 v2 成功记录，退出后无残留浏览器或导出进程。根因是 macOS 临时目录以 `/var` 创建、以 `/private/var` 解析，Playwright 安全边界把同一目录误判为越界。桥接器现已在下载 RPC 前解析真实目标路径，并新增路径别名回归测试；bridge/driver 局部测试 `9/9` 通过，锁定 bridge 哈希更新为 `0e16189946b887e926784a232df286a84a7a1c8e468efb52f5d2fc901cc4a335`。该修复后没有再次访问 Kimi，仍需新的当次批准才能外部复验。

路径别名修复后的获批 live 证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-path-alias-fix-20260807T015545Z/`。本次第 1 次尝试已越过下载路径守卫并完成 `visualQa.download_wait`，随后上游图片后处理返回非零；错误分类不可安全重试，因此没有执行第 2 次尝试，也没有进入 PPTX。证据目录存在空的 `.qa-images/pages/`，不存在 overview、PPTX 或 v2 成功记录，退出后无残留浏览器或导出进程。随后仅在本地修复：任何图片 ZIP 都先完整读取校验并以确定命名重新封装，上游只接收该归档；解包、overview 和无细粒度错误的整体非零均有稳定 checkpoint。bridge/driver 局部测试 `12/12` 通过，锁定 bridge 哈希为 `e29096db42271ca1bc4ea4bb607455349e16664d727423501247e667f1166473`。修复后未再次访问 Kimi。

受控归档重封装后的获批 live 证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-archive-repack-fix-20260807T022944Z/`。一次编排和唯一安全重试均成功生成 4 张 1920×1080 页面图与 overview；多模态检查未发现图片变形、内容遮挡、越界、低对比、对齐或文字溢出问题，视觉 QA 记录为 PASS。两次随后均进入 PPTX 下载，最终 checkpoint 为 `pptx.download / failed / playwright_download_event_timeout / attempt=2`；没有 PPTX 或 v2 成功记录，退出后无残留浏览器或导出进程。本地复核发现图片与 PPTX 共用 120 秒 RPC 上限，而上游 PPTX 明确请求 180 秒；现已把 PPTX 专用等待恢复为 180 秒、外层命令放宽到 270 秒，图片仍为 120 秒。bridge/driver/adapter 局部测试 `25/25` 通过，锁定 bridge 哈希为 `911d460946f11f0c982369827b10b1f05de90a84148c46ad027e8fed2cbd9c71`；调整后未再次访问 Kimi。

PPTX 180 秒专用等待后的获批 live 证据保留在 `/Users/pengaro/.agent-army/toolchains/open-kimi-ppt/1.1.0/live-evidence-pptx-180s-20260807T024633Z/`。本次一次编排和唯一安全重试均再次生成相同的 4 张 1920×1080 页面图与 overview，视觉检查 PASS；两次 PPTX 下载事件都完整等待 180 秒并在准确上限写入 `pptx.download / failed / playwright_download_event_timeout`，最终没有 PPTX 或 v2 成功记录。该结果排除了“旧 120 秒过短”这一假设。本机已安装的上游 `open-kimi-ppt-skills 1.1.3` 也已改为普通点击后轮询下载目录，明确避开下载事件/自定义下载路径兼容问题；本项目据此在不访问 Kimi 的前提下改为只轮询当前非持久 Context 的受控 `downloads/`，不访问用户默认下载目录。真实 localhost Chrome 已验证普通点击会在该目录生成可校验文件，bridge/driver/adapter 局部测试 `27/27` 通过；新 driver 哈希为 `1d7b2e039fab0299237b25bebe236b9acba4239acf4baee57dc64fe753928881`，bridge 哈希为 `9ee80f60f7587ac3fcfc198f87d6af953d03feff5e1cbbbd3a8ed15881b26b7a`。该替代链路尚未外部复验。

此前 `npm run test:affected` 运行到无本次改动的 `@agent-army/m5-publisher-gateway` 时失败：该包 `217/221`，4 项 `cua-driver-runner` 用例的固定 lease 均在 `2026-08-06T00:00:00.000Z` 到期，当前时钟下先返回 `cua_profile_lease_invalid`。对应 Publisher 源码和测试无本轮 diff；本次 PPT 聚焦测试 `152/152`、默认 smoke、真实 localhost Chromium 验证和架构检查均通过。不能把受影响全量写成通过。

## 完整验收剩余门禁

1. **已完成**：版本与源码哈希锁定的隔离 Node、Python、Playwright Core 和 Chromium，隔离环境 smoke 的依赖探针通过；
2. **已完成本地门禁**：Playwright 替代层在真实 localhost Chromium 中完成单生命周期操作、网络拦截和图片 ZIP 下载；
3. **已完成本地下载修复**：显式输出与浏览器下载目录均受控，macOS 路径别名在 RPC 前规范化；独立图片或原始图片 ZIP 均先完整校验、确定命名并重新封装，上游只选择该归档，解包与 overview 有独立 checkpoint；
4. **图片 E2E 已完成，PPTX 待外部复验**：取得负责人新的当次批准后，用同一公开固定样例验证“普通点击 + 当前 Context 受控下载目录轮询”并写入 v2 live 记录；
5. 以不可变 release 重启 A君并核对 PID、4321 端口、工作目录和 `capabilities`；
6. 从小办飞书入口创建真实任务，核对 Paperclip Run/Work Product 和 Hermes checkpoint 只含脱敏运行元数据；
7. 使用 PowerPoint/WPS 完成人工质量检查并回填本账本。
