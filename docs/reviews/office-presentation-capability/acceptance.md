# 小办演示文稿能力验收

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 代码与契约 | PASS | Manifest/Profile/工具枚举、`OfficePresentationAdapter`、路径守卫、readiness 和任务概览测试 | 待全量 affected 回归 |
| offline/fallback | PASS | 公开固定样例生成 4 页自包含 PPTD；缺依赖、路径逃逸、符号链接、远程素材和覆盖稳定失败，无安装/网络调用 | 无 |
| 本地 PPTX | PASS | `verification-20260807T045722Z`：4 页、4 次回读渲染、4 个根级 fade、ZIP CRC/XML 顺序通过，SHA-256 `f82ed2ca9803d193d345081b77922221a11381969c94c82731e23bf330c511ff` | 字体未嵌入，依赖目标机器已有兼容字体 |
| 视觉 QA | PASS | Artifact Tool 逐页渲染、overview、layout JSON；`slides_test.py` 通过且无溢出 | 无 |
| WPS 人工质量 | PASS | WPS Office 实际打开并逐页检查 4 页；中文、表格、图表、本地图片、布局和可编辑对象正常；截图保存在 QA `wps/` | 未在 Microsoft PowerPoint 复核 |
| LibreOffice 兼容 | KNOWN LIMITATION | 同一 PPTX 能打开并转换 4 页，但隔离 `LibreOfficeDev 26.8.0.0.alpha0` 未加载 macOS CJK 字体，中文显示方框；WPS 同文件正常 | 不作为 PPTX 失败，也不宣称该 alpha 运行时中文兼容 |
| 本机运行 | NOT CHECKED | 尚未重启不可变 release | PID、4321、cwd 和 live `capabilities` |
| Paperclip/Hermes/飞书 | NOT CHECKED | 路由与 Profile/MCP 契约有测试 | 尚未创建真实小办 PPT 任务和回传 Work Product |

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

## 历史 Kimi 结论

历史 Playwright/Kimi 链路曾成功生成 4 张页面图与 overview，但两次 180 秒 PPTX 受控目录轮询均没有候选文件。该结果只证明 Kimi PPTX 下载链路不可用；现已由本地导出替代，不再继续重试，也不再把外部编辑器批准作为生产 PPTX 前提。

## 剩余门禁

1. 运行完整相关回归与架构检查；
2. 以不可变 release 重启 A君，核对 PID、4321、工作目录和 `capabilities`；
3. 从小办入口创建真实公开样例任务，核对 Paperclip/Hermes 的三类 Work Product 引用和脱敏记录。
