# 小办演示文稿能力交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-08-06（Asia/Shanghai） |
| 最后更新 | 2026-08-07（Asia/Shanghai） |
| 关联任务 | [PRD](../../../tasks/prd-office-presentation-capability.md)、[验收记录](../../reviews/office-presentation-capability/acceptance.md) |
| 唯一下一步 | 无；后续收到真实业务内容时按 `office.presentation-package` 正常下单，并对具体稿件做 WPS/PowerPoint 人工复核 |

## 当前事实

- `office.presentation-package` 已固定路由给小办；生产工具为 `office.pptd.write → open-kimi-pptd` 和 `office.pptx.export → local-pptx`。
- 本地 PPTX 工具链无网络、无 Cookie/Vault、无自动安装；Node/Artifact Tool/JSZip/Sharp 版本和源码哈希均锁定。
- 公开固定样例已真实生成 PPTD、PPTX 与 QA。PPTX 通过 ZIP CRC、4 页、4 个根级 fade、XML 顺序、字体声明、回读渲染和溢出检查。
- WPS Office 已逐页打开 4 页，中文、表格、图表、图片、布局和可编辑对象正常；证据见验收记录。
- 隔离 LibreOffice alpha 能打开文件，但未加载 macOS CJK 字体，中文显示方框；该已知限制与 WPS 成功分开记录。
- Kimi PPTX 下载链路已停止重试，不再是生产 readiness 或恢复步骤。
- A君已从 clean commit `9204a92a057c7ed52a552c9f93b9a748cfa6e9a6` 冻结不可变 release `811d3c471c4e3ab48d3f67fe8b586a3d6941eba8e7f41c38a29c2133f510593b` 并在 PID `56917`、端口 `4321` 运行；live capability 为 ready。
- 真实公开样例任务 `ca1c34a8-f58f-48ff-a86b-c1a1e06ea5a8` 已成功，Paperclip `AGE-1036` 为 done，三类 Work Product 已写入。执行采用 A君受控本地工作区和确定性适配器，不依赖模型或外部编辑器。

## 继续条件与边界

- 不升级 A君主 Node，不自动全局安装，不新建队列/控制台/常驻服务；
- 不发送内部或敏感材料到公共编辑器，不复制 Cookie/Vault，不记录正文或完整命令输出；
- 保留当前脏工作树中与本功能无关的修改，发布时只携带确认的 PPT 能力路径；
- 本次真实验收只使用仓库公开固定样例；Paperclip 只保存产物引用、哈希和脱敏运行状态，不保存正文。

## 验证账本

| 层级 | 结论 | 证据 |
| --- | --- | --- |
| 本地适配器与样例 | PASS | `verification-20260807T045722Z.json` 与对应 PPTD/PPTX/QA |
| WPS | PASS | QA `wps/slide-1.png` 至 `slide-4.png` |
| 不可变运行时 | PASS | PID `56917`、4321、release `811d3c47…`、source `9204a92…`、capability ready |
| 真实任务 | PASS | A君任务 `ca1c34a8…`、Paperclip `AGE-1036`、三类 healthy Work Product；PPTX SHA-256 `6421ce3a…` |

## 关闭条件

2026-08-07 已满足关闭条件：不可变运行时、真实公开样例任务、三类 Work Product、自动视觉 QA、固定样例 WPS 人工复核及关联文档同步均完成。真实飞书消息和具体业务稿件的人工作品验收保留为后续按任务授权的可选项。
