# 小办受控演示文稿能力设计

## 架构落点

`office.presentation-package` 继续走现有业务任务链：MCP/飞书创建任务，任务能力目录固定路由给小办，Paperclip 指派提供 execution workspace，Manifest 与 Hermes Profile 编译精确岗位授权，`OpenKimiPptAdapter` 完成受控写入和可选外部导出。

能力登记扩展现有 `SkillExecutionRegistry`，记录 owner、相对入口、版本/哈希、数据边界、外部副作用、恢复提示和 `compose`、`visualQa`、`export` 三阶段 readiness。它只提供能力真相，不拥有任务、审批或重试状态。

## 执行阶段

1. `compose`：规范化输入，校验页数、坐标、主题令牌、元素 ID 和媒体引用，写入新的自包含 PPTD 目录与结构 QA。
2. `visualQa`：仅在公开/脱敏、当次批准和隔离依赖就绪后，通过固定上游图片导出脚本生成页面预览。
3. `export`：通过固定上游 PPTX 脚本导出，不传 `--force`；解析其 ZIP CRC、页面数、每页 fade 转场、XML 顺序和字体部件摘要。
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
- 缺依赖或版本漂移统一返回 `needs_capability`，恢复提示列出缺失项；运行时不自动安装或升级；
- `verify-office-presentation.mjs` 默认只跑 `offline + fallback`，显式 `--live` 且设置当次批准变量才进入 Kimi 外部导出。
