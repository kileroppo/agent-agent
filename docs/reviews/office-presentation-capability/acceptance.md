# 小办演示文稿能力验收

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 代码与契约 | PASS | Manifest `17/17`；最终 Task/Projector 回归 `131/131`；此前 PPT 聚焦回归 `145/145`；架构检查、不可变 release 全量验证、main/recovery smoke 和 payload 绑定均通过 | 无 |
| offline/fallback | PASS | 公开固定样例生成 4 页自包含 PPTD；缺依赖、路径逃逸、符号链接、远程素材和覆盖稳定失败，无安装/网络调用 | 无 |
| 本地 PPTX | PASS | `verification-20260807T045722Z`：4 页、4 次回读渲染、4 个根级 fade、ZIP CRC/XML 顺序通过，SHA-256 `f82ed2ca9803d193d345081b77922221a11381969c94c82731e23bf330c511ff` | 字体未嵌入，依赖目标机器已有兼容字体 |
| 视觉 QA | PASS | Artifact Tool 逐页渲染、overview、layout JSON；`slides_test.py` 通过且无溢出 | 无 |
| WPS 人工质量 | PASS | WPS Office 实际打开并逐页检查 4 页；中文、表格、图表、本地图片、布局和可编辑对象正常；截图保存在 QA `wps/` | 未在 Microsoft PowerPoint 复核 |
| LibreOffice 兼容 | KNOWN LIMITATION | 同一 PPTX 能打开并转换 4 页，但隔离 `LibreOfficeDev 26.8.0.0.alpha0` 未加载 macOS CJK 字体，中文显示方框；WPS 同文件正常 | 不作为 PPTX 失败，也不宣称该 alpha 运行时中文兼容 |
| 本机运行 | PASS | PID `56917`；`releaseHash=811d3c471c4e3ab48d3f67fe8b586a3d6941eba8e7f41c38a29c2133f510593b`；clean source `9204a92a057c7ed52a552c9f93b9a748cfa6e9a6`；`/api/overview=200`，能力显示“PPTD 可用；PPTX 可用” | 无 |
| A君/Paperclip 真实任务 | PASS | 任务 `ca1c34a8-f58f-48ff-a86b-c1a1e06ea5a8` 成功进入 `office_presentation_ready`；Paperclip `AGE-1036` 为 `done`；三类 Work Product 均为 healthy；Paperclip run 数在完成 5 秒后仍为 0 | 未从真实飞书会话发送该公开样例；飞书/MCP 路由仅有自动化契约证据 |

## 本地验证命令

```bash
node --test apps/ajun-runtime/test/local-pptx-adapter.test.js apps/ajun-runtime/test/open-kimi-ppt-adapter.test.js
node --test agents/test/agent-manifest.test.mjs
npm run verify:office-presentation --workspace=ajun-runtime
```

## 固定样例证据

- 验证记录：`/Users/pengaro/.agent-army/toolchains/local-pptx/1.0.0/verification-20260807T045722Z.json`
- PPTD：`/Users/pengaro/.agent-army/toolchains/local-pptx/1.0.0/verification-20260807T045722Z/work-products/smoke/presentation/deck.pptd`
- PPTX：`/Users/pengaro/.agent-army/toolchains/local-pptx/1.0.0/verification-20260807T045722Z/work-products/smoke/presentation/deck.pptx`
- overview：`/Users/pengaro/.agent-army/toolchains/local-pptx/1.0.0/verification-20260807T045722Z/work-products/smoke/presentation/qa/local-pptx/overview.jpg`
- WPS 逐页截图：`/Users/pengaro/.agent-army/toolchains/local-pptx/1.0.0/verification-20260807T045722Z/work-products/smoke/presentation/qa/wps/`

## 真实任务证据

- A君任务：`ca1c34a8-f58f-48ff-a86b-c1a1e06ea5a8`，执行所有者 `ajun-controlled-local`，状态 `succeeded`
- Paperclip：Issue `AGE-1036`，三条 Work Product ID 分别为 `6a505c73-f922-4e12-ae4-09524fa12ef8`、`5890188b-0c54-47f3-aac9-204db4d364a8`、`9a18a0fa-30f0-4feb-b415-4339d29eff9f`
- PPTX：`apps/ajun-runtime/data/office-presentation-workspaces/ca1c34a8-f58f-48ff-a86b-c1a1e06ea5a8/work-products/ca1c34a8-f58f-48ff-a86b-c1a1e06ea5a8/presentation/deck.pptx`，SHA-256 `6421ce3a3783bb04d0ced836b5f1a6b3b7dbf8f6ca3b9167f873b51e89a82b38`
- QA：4 页回读渲染、4 个根级 fade、ZIP 完整性与 XML 顺序通过；`slides_test.py` 通过且无溢出；overview 位于同目录 `qa/local-pptx/overview.jpg`
- 任务输入、PPT 正文和原始命令未复制到 Paperclip；Issue 故意不分配执行 Agent，避免确定性本地任务再触发 Hermes/模型。A君任务本身仍固定指派 `office-assistant`。

## 历史 Kimi 结论

历史 Playwright/Kimi 链路曾成功生成 4 张页面图与 overview，但两次 180 秒 PPTX 受控目录轮询均没有候选文件。该结果只证明 Kimi PPTX 下载链路不可用；现已由本地导出替代，不再继续重试，也不再把外部编辑器批准作为生产 PPTX 前提。

## 后续可选验收

- 如需验证具体业务稿，在 WPS 或 PowerPoint 打开对应任务 PPTX 做人工视觉确认；当前真实任务已有自动结构/渲染证据，固定样例已有 WPS 逐页证据。
- 如需验证真实飞书消息回传，必须由负责人指定会话并单独授权发送；这不阻塞本地 PPT 能力关闭。
