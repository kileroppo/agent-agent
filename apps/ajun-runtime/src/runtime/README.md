# A君产品运行装配

本目录承载 A君模块化单体的产品装配 Module。公开进程 Interface 仍是
`runtime-composition-root.js#createRuntime()`；调用方不需要知道各领域内部使用哪些 Adapter。

| Module | 隐藏的实现知识 |
| --- | --- |
| `runtime-configuration.js` | `createRuntime()` 使用的仓库根、数据/私有目录、端口、部署模式与功能开关解析 |
| `runtime-state-composition.js` | Task Store、运行事件 SQLite、Timeline、保留策略定时器与关闭清理 |
| `local-execution-composition.js` | 岗位 Registry、本机/云端小D选择、本机 AI 与授权连接装配 |
| `background-lifecycle-composition.js` | 中断恢复、交付质量、Paperclip、小D、Mission 与 Boom 后台 Module 的组合 |
| `content-campaign-composition.js` | 活动生命周期、Paperclip Control Plane、Publisher、预算票据与视觉工具执行 |
| `role-execution-composition.js` | 岗位执行所需的研究、办公、内容生产、技术修复、提案与 TaskService 装配 |
| `feishu-command-composition.js` | 飞书指挥、官方入口、Hermes 原生交付监听及员工飞书连接 |
| `paperclip-system-control-composition.js` | heartbeat、daily/parallel Controller、Publisher、指标、复盘与学习 Controller |

新增能力时先判断它属于哪个领域 Module；只有跨领域创建顺序、HTTP 组合和公开进程返回值可以进入
`runtime-composition-root.js`。路径/环境解析、定时器所有权、具体 reconciler、本机执行、岗位、飞书或
M5 Adapter 必须留在所属 Module 的 Implementation 内。

`createRuntime({ environment, logger })` 的 Interface 保持稳定：端口、host、数据目录默认值和后台服务
启动顺序不因内部拆分改变；`runtime-start.js` 仍在 HTTP 监听成功后按原顺序启动 `services`。

结构门禁限制产品装配根不超过 220 行和 20 个直接 import，并为本目录每个 Module 设置责任上限。
`npm run test:affected` 将本目录变更映射到领域测试和 `runtime-start.test.js`；未知跨领域变更继续运行
A君 Workspace 全量测试。
