# 小办演示文稿能力 PRD

| 字段 | 内容 |
| --- | --- |
| 状态 | 本地 PPTD/PPTX、固定样例与不可变运行时验收通过；待真实任务验收 |
| 负责人 | 小办 / A君 |
| 最后更新 | 2026-08-07 |
| 关联设计 | [小办受控演示文稿能力设计](../docs/design/office-presentation-capability.md) |
| 验收记录 | [小办演示文稿能力验收](../docs/reviews/office-presentation-capability/acceptance.md) |

## 1. 目标

新增 `office.presentation-package`，固定由 `office-assistant` 承接，并交付可编辑、自包含、可追溯的 PPTD、PPTX 与逐页视觉 QA。能力复用现有 Manifest、Hermes Profile、Paperclip Run/Work Product、A君 MCP 和岗位授权，不新增队列、审批系统、控制台或常驻服务。

默认交付链已改为全本地：PPTD 由受控共享技能生成，PPTX 由锁定的 Artifact Tool/OOXML 工具链离线导出。Kimi 公共编辑器不再是 PPTX 成功依赖，也不是默认恢复路径。

## 2. 输入与输出

输入：

- `title` 必填；`purpose`/`description`、`audience` 可选；
- `slideCount` 或 `slides`/`outline`，最多 30 页；
- `designMode` 为 `self_directed`、`design_system`、`template` 或 `style_transfer`；模板和风格迁移只能引用当前任务允许的来源产物；
- `sourceTaskIds` 只能引用任务信封允许的任务；
- `media` 只接受当前工作区内的 PNG/JPEG/GIF/SVG，拒绝远程 URL；
- `outputs` 默认 `pptd`、`pptx`；
- `dataClassification` 为 `public`、`redacted`、`internal` 或 `sensitive`。本地导出不要求外部处理批准。

固定产物：

- `office_presentation_source`：`.pptd`、`pages/`、本地 `media/` 和结构校验；
- `office_presentation_qa`：逐页预览、overview、问题清单和结构/视觉状态；
- `office_pptx_document`：PPTX、SHA-256、页数、ZIP CRC、根级 fade 转场、字体策略和人工复核状态。

## 3. 安全与兼容门禁

- 仅开放 `office.pptd.write → open-kimi-pptd` 与 `office.pptx.export → local-pptx`；小办不获得 Bash、通用浏览器或任意文件访问。
- 所有路径必须位于当前 Paperclip execution workspace，且为安全相对路径；拒绝绝对路径、`..`、符号链接、工作区外素材和已有目标覆盖。
- `local-pptx` 不访问网络，不读取 Cookie/Vault，不执行全局 npm/pip 安装或自动升级；内部和敏感材料也只在本地处理。
- 共享 PPTD 技能入口固定为 `open-kimi-ppt-skill/skills/open-kimi-ppt/SKILL.md`，允许版本与源码哈希漂移时失败关闭。
- A君主运行时不升级。PPTX 使用隔离 Node `24.14.0`、Artifact Tool `2.8.39`、JSZip `3.10.1`、Sharp `0.34.5`，版本与入口 SHA-256 全部锁定；生产导出器位于 `apps/ajun-runtime/src/`，随不可变 release 静态闭包封装。
- 导出必须回读 PPTX、渲染每页、生成 overview，并通过 ZIP CRC、页数、每页唯一根级 fade、XML 顺序和 `Arial Unicode MS` 兼容字体声明检查。

## 4. 完成定义

- 代码/契约：Manifest、Profile、工具枚举、任务路由、能力登记和适配器测试一致；
- 本地样例：4 页公开固定样例覆盖中文、表格、图表、本地图片并完成 PPTD/PPTX/QA；
- 应用验收：WPS 逐页打开，确认中文、表格、图表、图片、布局和可编辑对象正常；
- 运行时：不可变 release 重启后核对 PID、4321、工作目录和 `capabilities`；
- 真实任务：从小办入口创建一条公开样例任务，Paperclip/Hermes 只回传脱敏运行元数据和三类 Work Product 引用。

## 5. 明确不做

- 不接入 chubbyskills 的第二套队列、审批、控制台或完整运行账本；
- 不复制 Cookie/Vault，不记录正文、完整命令或完整 stdout；
- 不把内部或敏感材料发送到公共编辑器；
- 不继续把 Kimi 下载重试当作 PPTX 恢复方案；
- 不升级 A君主运行时，不静默安装或覆盖软件。
