# A君产品运行装配

本目录承载 A君模块化单体的产品装配 Module。公开进程 Interface 仍是
`runtime-composition-root.ts#createRuntime()`；调用方不需要知道各领域内部使用哪些 Adapter。

| Module | 隐藏的实现知识 |
| --- | --- |
| `runtime-configuration.ts` | `createRuntime()` 使用的仓库根、数据/私有目录、端口、部署模式与功能开关解析 |
| `runtime-state-composition.ts` | Task Store、运行事件 SQLite、Timeline、保留策略定时器与关闭清理 |
| `local-execution-composition.ts` | 岗位 Registry、本机/云端小D选择、本机 AI 与授权连接装配 |
| `background-lifecycle-composition.ts` | 中断恢复、交付质量、Paperclip、小D、Mission 与 Boom 后台 Module 的组合 |
| `content-campaign-composition.ts` | 活动生命周期、Paperclip Control Plane、Publisher、预算票据与视觉工具执行 |
| `role-execution-composition.ts` | 岗位执行总装、提案、TaskService 与失败恢复连接，不直接认识各能力实现 |
| `role-research-execution-composition.ts` | 公开网页、动态网页、PDF、GitHub、Hermes 研究 Advisor 与研究岗位装配 |
| `role-content-execution-composition.ts` | 办公、演示文稿、内容生产、本机视觉和岗位工具装配 |
| `role-technical-execution-composition.ts` | 隔离修理房、诊断、推广、技术专家和停滞 watchdog 装配 |
| `feishu-command-composition.ts` | 飞书指挥、官方入口、Hermes 原生交付监听及员工飞书连接 |
| `paperclip-system-control-composition.ts` | heartbeat、daily/parallel Controller、Publisher、指标、复盘与学习 Controller |

新增能力时先判断它属于哪个领域 Module；只有跨领域创建顺序、HTTP 组合和公开进程返回值可以进入
`runtime-composition-root.ts`。路径/环境解析、定时器所有权、具体 reconciler、本机执行、岗位、飞书或
M5 Adapter 必须留在所属 Module 的 Implementation 内。

`createRuntime({ environment, logger })` 的 Interface 保持稳定：端口、host、数据目录默认值和后台服务
启动顺序不因内部拆分改变；`runtime-start.ts` 仍在 HTTP 监听成功后按原顺序启动 `services`。

结构门禁限制产品装配根不超过 220 行和 20 个直接 import，并为本目录每个 Module 设置责任上限。
`npm run test:affected` 将本目录变更映射到领域测试和 `runtime-start.test.js`；未知跨领域变更继续运行
A君 Workspace 全量测试。装配 Module 的责任上限和受影响测试统一声明在相邻的
`apps/ajun-runtime/module-policy.json`；架构检查与受影响测试选择器读取同一份策略，不再维护两套中央路径表。
