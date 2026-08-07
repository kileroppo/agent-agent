# 小办演示文稿能力交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 本地能力与不可变运行时已完成，待真实任务验收 |
| 创建时间 | 2026-08-06（Asia/Shanghai） |
| 最后更新 | 2026-08-07（Asia/Shanghai） |
| 关联任务 | [PRD](../../../tasks/prd-office-presentation-capability.md)、[验收记录](../../reviews/office-presentation-capability/acceptance.md) |
| 唯一下一步 | 从小办入口创建一条公开样例任务，核对 Paperclip/Hermes 的三类 Work Product 回传 |

## 当前事实

- `office.presentation-package` 已固定路由给小办；生产工具为 `office.pptd.write → open-kimi-pptd` 和 `office.pptx.export → local-pptx`。
- 本地 PPTX 工具链无网络、无 Cookie/Vault、无自动安装；Node/Artifact Tool/JSZip/Sharp 版本和源码哈希均锁定。
- 公开固定样例已真实生成 PPTD、PPTX 与 QA。PPTX 通过 ZIP CRC、4 页、4 个根级 fade、XML 顺序、字体声明、回读渲染和溢出检查。
- WPS Office 已逐页打开 4 页，中文、表格、图表、图片、布局和可编辑对象正常；证据见验收记录。
- 隔离 LibreOffice alpha 能打开文件，但未加载 macOS CJK 字体，中文显示方框；该已知限制与 WPS 成功分开记录。
- Kimi PPTX 下载链路已停止重试，不再是生产 readiness 或恢复步骤。
- `main@8d69073` 已冻结为不可变 release `41bc73a8506b…`，主启动和只读恢复 smoke 通过；切换后 PID `9309`、4321 HTTP 200、源码/live `same_git_head`，`office-presentation=ready`。

## 继续条件与边界

- 不升级 A君主 Node，不自动全局安装，不新建队列/控制台/常驻服务；
- 不发送内部或敏感材料到公共编辑器，不复制 Cookie/Vault，不记录正文或完整命令输出；
- 保留当前脏工作树中与本功能无关的修改，发布时只携带确认的 PPT 能力路径；
- 真实任务只能使用仓库公开固定样例，Paperclip/Hermes 只保存产物引用、哈希和脱敏运行状态。

## 验证账本

| 层级 | 结论 | 证据 |
| --- | --- | --- |
| 本地适配器与样例 | PASS | `verification-20260807T045722Z.json` 与对应 PPTD/PPTX/QA |
| WPS | PASS | QA `wps/slide-1.png` 至 `slide-4.png` |
| 不可变运行时 | PASS | release `41bc73a8506b…`、payload `339233ce287b…`、PID `9309`、4321 HTTP 200、`office-presentation=ready` |
| 真实任务 | 待验收 | 需回传 `office_presentation_source`、`office_presentation_qa`、`office_pptx_document` |

## 关闭条件

不可变运行时与真实公开样例任务均通过，验收记录、PRD、任务索引和本交接单同步后关闭。
