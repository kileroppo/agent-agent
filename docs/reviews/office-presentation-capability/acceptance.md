# 小办演示文稿能力验收

| 层级 | 结论 | 2026-08-06 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 代码与契约 | PASS | Manifest/Profile/适配器枚举、任务目录、A君/飞书路由、产物和外部处理门禁已有自动化覆盖 | 无 |
| 固定样例 offline | PASS | `npm run verify:office-presentation --workspace=ajun-runtime`；4 页中文、表格、图表、本地 SVG，结构与自包含检查通过 | 不含浏览器视觉效果 |
| fallback | PASS | 同一命令验证敏感数据在浏览器前拒绝，`autoInstall=false`；路径逃逸、伪造媒体、页数漂移、覆盖和未审批均有单测 | 无真实网络故障重试 |
| 本机运行 | NOT CHECKED | 本轮未重启不可变 release，未核对新 PID/端口/工作目录 | live `capabilities` 尚未加载新代码 |
| Kimi 外部 E2E | BLOCKED | 本机共享技能 `1.0.0` 源码校验通过；compose `ready` | Node 22 不是隔离 Node 24+；`agent-browser` 未安装且 npm 最新 `0.31.1 < 0.33.2`，故 visual QA/PPTX 为 `needs_capability` |
| Paperclip/Hermes/飞书 | NOT CHECKED | 路由和 Profile/MCP 契约有测试 | 尚未创建真实小办 PPT 指派和 Work Product 回传 |
| 人工质量 | NOT CHECKED | 无 | 尚未用 PowerPoint/WPS 检查中文字体、图表、图片、溢出、错位、动画和可编辑性 |

## 自动化命令

```bash
node --test apps/ajun-runtime/test/open-kimi-ppt-adapter.test.js apps/ajun-runtime/test/local-office-assistant.test.js apps/ajun-runtime/test/m5-role-tool-grant.test.js apps/ajun-runtime/test/m5-role-tool-adapters.test.js apps/ajun-runtime/test/skill-execution-registry.test.js apps/ajun-runtime/test/business-task-routing.test.js apps/ajun-runtime/test/feishu-commander.test.js apps/ajun-runtime/test/task-capability-catalog.test.js agents/test/agent-manifest.test.mjs
npm run verify:office-presentation --workspace=ajun-runtime
```

聚焦测试当前 `147/147` 通过。默认 smoke 输出 `compose=ready`、`visualQa=needs_capability`、`export=needs_capability`，没有启动浏览器、访问 Kimi、安装全局软件或修改用户 Vault。

`npm run test:affected` 已完成 A君受影响全量回归：`1141/1141` 通过。

## 完整验收剩余门禁

1. 准备版本锁定的隔离 Node 24+、Python 依赖、Chromium 和真实可用的 `agent-browser >= 0.33.2`；
2. 人工明确批准只含公开固定样例的外部处理，运行 `npm run verify:office-presentation --workspace=ajun-runtime -- --live`；
3. 以不可变 release 重启 A君并核对 PID、4321 端口、工作目录和 `capabilities`；
4. 从小办飞书入口创建真实任务，核对 Paperclip Run/Work Product 和 Hermes checkpoint 只含脱敏运行元数据；
5. 使用 PowerPoint/WPS 完成人工质量检查并回填本账本。
