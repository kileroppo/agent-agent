# A君产品运行装配

本目录承载 A君模块化单体的产品装配 Module。公开进程 Interface 仍是
`runtime-composition-root.js#createRuntime()`；调用方不需要知道各领域内部使用哪些 Adapter。

| Module | 隐藏的实现知识 |
| --- | --- |
| `content-campaign-composition.js` | 活动生命周期、Paperclip Control Plane、Publisher、预算票据与视觉工具执行 |
| `role-execution-composition.js` | 岗位执行所需的研究、办公、内容生产、技术修复、提案与 TaskService 装配 |
| `feishu-command-composition.js` | 飞书指挥、官方入口、Hermes 原生交付监听及员工飞书连接 |
| `paperclip-system-control-composition.js` | heartbeat、daily/parallel Controller、Publisher、指标、复盘与学习 Controller |

新增能力时先判断它属于哪个领域 Module；只有跨领域运行顺序、HTTP 组合和后台生命周期可以进入
`runtime-composition-root.js`。根入口不得重新直接装配具体岗位、飞书或 M5 Adapter。

结构门禁限制产品装配根不超过 300 行和 35 个直接 import，并为本目录每个 Module 设置责任上限。
`npm run test:affected` 将本目录变更映射到领域测试和 `runtime-start.test.js`；未知跨领域变更继续运行
A君 Workspace 全量测试。
