# 小办受控演示文稿能力设计

## 架构落点

`office.presentation-package` 继续走现有业务任务链：MCP/飞书创建任务，任务能力目录固定路由给小办，Paperclip 指派提供 execution workspace，Manifest 与 Hermes Profile 编译精确岗位授权，`OpenKimiPptAdapter` 完成受控写入和可选外部导出。

能力登记扩展现有 `SkillExecutionRegistry`，记录 owner、相对入口、版本/哈希、数据边界、外部副作用、恢复提示和 `compose`、`visualQa`、`export` 三阶段 readiness。它只提供能力真相，不拥有任务、审批或重试状态。

## 执行阶段

1. `compose`：规范化输入，校验页数、坐标、主题令牌、元素 ID 和媒体引用，写入新的自包含 PPTD 目录与结构 QA。
2. `visualQa`：仅在公开/脱敏、当次批准和隔离依赖就绪后，通过固定上游图片导出脚本生成页面预览。适配器用锁定版本和入口哈希的 `playwright-core` 驱动现有 Chromium，在一个非持久 BrowserContext 内完成打开、等待、跨域编辑器定位、导出选项和下载；浏览器下载目录固定到适配器临时工作区的 `downloads/`，桥接器在 RPC 前解析 macOS 临时目录真实路径，显式 `saveAs` 与上游兜底轮询看到同一受控范围，且兜底轮询不得覆盖首次下载失败的脱敏 checkpoint。不继承用户 Profile、Cookie、插件或浏览器登录态。Service Worker 被禁用，HTTP(S) 与 WebSocket 在 BrowserContext 层只放行带端口的本机桥接地址以及 `www.kimi.com`、`statics.moonshot.cn`，WebRTC 被关闭。任何白名单、版本或源码校验和漂移都失败关闭。
3. `export`：通过固定上游 PPTX 脚本导出，不传 `--force`；解析其 ZIP CRC、页面数、每页 fade 转场、XML 顺序和字体部件摘要。依赖就绪只代表可以进入人工触发的 live 测试；只有同一技能哈希和依赖版本完成真实公开样例导出并留下脱敏验证记录后，生产 readiness 才切为 `ready`。
4. `humanReview`：PowerPoint/WPS 人工检查仍是独立门禁，自动 ZIP/XML 校验不能替代。

任一外部门禁失败时保留 `office_presentation_source` 和 `office_presentation_qa`，返回明确错误分类，不生成 `office_pptx_document`，也不把 PPTD 冒充完整 PPTX 交付。

## 数据与文件边界

- 任务读取只使用受信 `sourceTaskIds` 或同一父任务的已验证产物摘要；
- 媒体由调用方以内嵌 base64 提供，单文件不超过 5 MiB、总量不超过 20 MiB；SVG 拒绝脚本、外部引用和可执行节点；
- 所有最终文件使用 no-overwrite 写入；路径守卫逐级拒绝符号链接和工作区逃逸；
- 外部处理只接收 PPTD 工程，不复制 Vault、Cookie、私人聊天或凭据；
- 任务产物只记录阶段、依赖/技能版本、脱敏错误分类、时长、校验和与验收状态，不记录页面正文或完整命令输出。

## 失败与恢复

- 权限、分类、审批、路径、内容结构和版本错误不重试；
- 临时浏览器或网络错误最多允许执行编排层的一次安全重试，不覆盖原产物；
- 隔离子进程清除浏览器 Profile、自动连接、调试端口和代理覆盖变量；外部命令失败只上报脱敏分类，不传播完整命令、正文或 stdout；
- 每次导出在适配器自建临时目录中原子写入最后一个阶段 checkpoint，只允许固定的 mode、stage、status、时间和错误码；外层命令即使强制超时，也必须在清理前读取 checkpoint 并把阶段附到脱敏错误，随后删除临时记录；
- 上游 `main()` 非零返回不得把细粒度失败阶段覆盖成整体完成；没有细粒度失败时必须写稳定整体失败。图片导出无论返回独立 PNG/JPEG/GIF/WebP 还是原始 ZIP，都只能在同一临时目录完整读取校验、按确定名称重新封装，并让上游优先选择该归档；解包和 overview 分别记录 checkpoint，不得写入用户目录或接受其他格式；
- 图片下载继续使用 Playwright 下载事件捕获，RPC 上限固定为 120 秒；PPTX 不再依赖可能缺失的页面下载事件，而是普通点击官方“下载”按钮后，只在当前非持久 Context 的受控 `downloads/` 目录轮询合法 PPTX，文件等待上限为 180 秒、外层命令为 270 秒。两种模式都不访问用户默认下载目录，且仍受适配器一次安全重试约束；
- 缺依赖或版本漂移统一返回 `needs_capability`，恢复提示列出缺失项；运行时不自动安装或升级；
- `verify-office-presentation.mjs` 默认只跑 `offline + fallback`，显式 `--live` 且设置当次批准变量才进入 Kimi 外部导出；live 通过后只写技能/依赖版本、产物哈希和结构验收状态，不写页面正文。
