# 小办受控演示文稿能力设计

## 架构落点

`office.presentation-package` 沿用 MCP/飞书 → 任务目录 → 小办 → Paperclip execution workspace → Hermes checkpoint/Work Product 的现有链路。`OfficePresentationAdapter` 组合两个窄适配器：

- `OpenKimiPptAdapter` 只承担 PPTD 结构化创作；
- `LocalPptxAdapter` 使用锁定的 Artifact Tool 和 OOXML 后处理离线完成逐页渲染与 PPTX 导出。

生产默认链不启动浏览器、不访问 Kimi、不要求 `external-data-processing`。旧 Kimi 浏览器适配代码只保留为历史兼容和诊断证据，不参与生产岗位授权。

## 执行阶段

1. `compose`：规范化标题、用途、受众、提纲、页数、坐标、主题令牌、元素 ID 和媒体引用，写入新的自包含 PPTD 目录。
2. `visualQa`：Artifact Tool 在本地回读 PPTD，先渲染源页面，再回读最终 PPTX 并逐页渲染，生成 `pages/`、layout JSON 和两列 overview。
3. `export`：导出到适配器临时目录，补齐 Office 兼容字体声明与每页唯一根级 fade 转场，验证 OOXML 顺序和 ZIP CRC 后，以 no-overwrite 方式写入 execution workspace。
4. `humanReview`：WPS/PowerPoint 打开检查仍是独立门禁，不由 ZIP/XML 或自家渲染结果替代。

`SkillExecutionRegistry` 只记录 owner、入口、版本/哈希、边界、恢复提示及 `compose`、`visualQa`、`export` readiness，不拥有任务、审批或重试状态。

## 数据与文件边界

- 只读取任务允许的 `sourceTaskIds` 与当前 execution workspace；
- 路径守卫拒绝绝对路径、`..`、符号链接、工作区外真实路径和已有目标覆盖；
- 首版媒体仅为本地 PNG/JPEG/GIF/SVG；SVG 拒绝脚本、外部引用和可执行节点；
- 子进程环境关闭代理、网络包安装和更新提示，固定 `PATH=/usr/bin:/bin`；
- 运行记录只保存阶段、尝试次数、依赖版本、脱敏错误分类、产物哈希与验收状态，不保存页面正文或完整命令输出。

## 依赖与失败恢复

- 工具链锁定 Node `24.14.0`、Artifact Tool `2.8.39`、JSZip `3.10.1`、Sharp `0.34.5` 以及工作区初始化脚本和导出器源码 SHA-256；任一漂移都返回 `needs_capability`；
- 运行时禁止自动安装和自动升级；缺依赖只给出缺失项和恢复提示；
- 权限、路径、内容、结构和版本错误不重试；本地导出也不执行浏览器/网络重试；
- 失败时清理适配器自建临时目录和不完整目标，保留已完成的 PPTD；
- `verify-office-presentation.mjs` 默认运行 `offline + fallback + local-export`，不接触网络、Cookie、Vault 或全局软件。

## PPTX 结构与字体策略

- PPTD 页面数必须等于 PPTX slide 数、回读渲染数和 fade 转场数；
- 每页只有一个根级 `<p:transition><p:fade/></p:transition>`，位置早于 timing/extLst；
- 幻灯片、表格、图表和主题的 `latin/ea/cs` 字体声明统一为已安装的 `Arial Unicode MS`；记录嵌入字体部件数量，但不把“未嵌入”冒充失败；
- 固定样例必须额外通过 WPS 实际打开和逐页截图，证明中文和可编辑对象在真实办公应用中可用。

## Kimi 分支处置

历史 Playwright/Kimi 图片导出曾成功，但 PPTX 下载事件和受控目录轮询均没有产生文件。该分支已停止恢复性重试，不再决定 `office.pptx.export` readiness。任何新的 Kimi 外部访问仍需新的明确授权和新的诊断依据。
