# 小办演示文稿能力 PRD

| 字段 | 内容 |
| --- | --- |
| 状态 | 首版 PPTD 与真实 Kimi 图片视觉 QA 完成；PPTX 在 120 秒和 180 秒下载事件等待下均失败，已按上游 1.1.3 的成熟方式改为受控下载目录轮询但尚未外部复验，PPTX 保持 needs_capability |
| 负责人 | 小办 / A君 |
| 最后更新 | 2026-08-07 |
| 关联设计 | [受控 OpenKimi PPT 适配设计](../docs/design/office-presentation-capability.md) |
| 验收记录 | [小办演示文稿能力验收](../docs/reviews/office-presentation-capability/acceptance.md) |

## 1. 目标

新增 `office.presentation-package`，固定由 `office-assistant` 承接。首版必须先真实交付可编辑、自包含、可追溯的 PPTD 工程；只有数据分类、当次批准和隔离依赖同时通过时，才允许使用 Kimi 公共编辑器生成图片质检与 PPTX。

本能力复用现有 Manifest、Hermes Profile、Paperclip Run/Work Product、A君 MCP 和岗位工具授权，不新增任务队列、审批系统、控制台或常驻服务。

## 2. 输入与输出

输入：

- `title` 必填；`purpose`/`description`、`audience` 可选；
- `slideCount` 或 `slides`/`outline`，最多 30 页；
- `designMode` 为 `self_directed`、`design_system`、`template` 或 `style_transfer`；后三者使用受控 `designTokens`，模板/风格迁移还必须提供当前任务允许的设计来源产物引用，不读取任意模板路径；
- `sourceTaskIds` 只能引用当前任务信封允许的任务；
- `media` 首版只接受内嵌的 PNG/JPEG/GIF/SVG，拒绝远程 URL；
- `outputs` 默认 `pptd`、`pptx`；
- `dataClassification` 为 `public`、`redacted`、`internal` 或 `sensitive`；
- `externalProcessingApproved=true` 只对本次公开或脱敏任务有效。

固定产物：

- `office_presentation_source`：`.pptd`、`pages/`、`media/` 和结构校验；
- `office_presentation_qa`：结构状态、预览引用、问题清单和视觉质检状态；
- `office_pptx_document`：仅在真实导出成功后生成，记录哈希、页数、转场、字体和人工复核要求。

## 3. 安全与兼容门禁

- 只有 `office.pptd.write → open-kimi-pptd` 和 `office.pptx.export → open-kimi-pptx` 两个受控工具；小办不获得 Bash、通用浏览器或任意文件访问。
- 所有路径必须是当前 Paperclip execution workspace 内的安全相对路径；拒绝绝对路径、`..`、符号链接和已有目标覆盖。重复执行必须使用新版本目录。
- `external-data-processing` 只允许 `open-kimi-pptx`，只放行 `www.kimi.com` 与 `statics.moonshot.cn`；`internal`/`sensitive` 或未批准任务在浏览器启动前拒绝。
- 运行时不得执行全局 npm/pip 安装、自动升级或上游 `--force`。
- 共享技能固定为相对入口 `open-kimi-ppt-skill/skills/open-kimi-ppt/SKILL.md`，首版允许版本 `1.0.0`，技能入口、两份导出脚本和导出页面的组合源码 SHA-256 为 `672358d16ef70aa907b8181d451e649465aded3ed1a9cf613b2de5771a70cb10`；漂移时失败关闭。
- A君主运行时不升级。PPTX 使用独立锁定工具链：Node 24+、Python 依赖、`playwright-core 1.62.1`（版本与入口哈希双校验）和现有 Chromium；只有公开固定样例 live 图片/PPTX 均通过后才可用。

## 4. 完成定义

首版完成：Manifest/Profile/工具枚举一致，MCP、A君和飞书路由可识别任务；固定样例能生成自包含 PPTD；路径、媒体、分类、审批和缺依赖失败稳定；`capabilities` 明确显示 `compose=ready`、`visualQa/export=needs_capability`。

完整能力完成还要求：公开固定样例完成一次 Kimi 图片与 PPTX 导出；Paperclip/Hermes/飞书真实任务回传三类 Work Product 引用；负责人用 PowerPoint 或 WPS 完成中文字体、图表、图片、溢出、错位、动画和可编辑性人工验收。

## 5. 明确不做

- 不接入 chubbyskills 的第二套队列、审批、控制台或完整运行账本；
- 不复制 Cookie/Vault，不记录正文、完整命令或 stdout；
- 不默认外发内部或敏感材料；
- 不升级 A君主运行时，不在兼容性未验证前宣称 PPTX 已就绪。
