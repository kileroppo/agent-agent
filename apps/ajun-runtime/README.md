# A君运行台

本机能力网关与执行适配：从所有 `agents/*/manifest.json` 读取岗位，为连接授权、内容获取、组件健康、恢复和脱敏诊断提供本机边界，并承接受限的 Paperclip 执行请求。飞书是日常派活与交付入口；军团组织、任务、heartbeat、预算、审批和审计由 Paperclip 承担。

```bash
cd apps/ajun-runtime
npm test
npm run dev
```

`npm run dev` 使用 `http://127.0.0.1:4322` 启动开发热更新：`src/`、`public/`、岗位定义及运行时 Workspace 依赖变化会自动重启开发进程，已打开的浏览器页面会在新进程就绪后自动刷新。开发实例关闭 Paperclip、飞书、小D等后台协调服务，避免与正式 `4321` 重复执行；如需换端口可在命令前设置 `PORT`。正式 `4321` 继续使用已验证的不可变 release，不会自动加载共享工作树里的未验证修改。

## 产品结构

- `src/server.js`：进程入口；
- `src/runtime-start.js`：监听和后台生命周期；
- `src/runtime-composition-root.js`：跨领域产品壳，只组合深层 Module；
- [`src/runtime/`](./src/runtime/README.md)：活动生命周期、岗位执行、飞书指挥和 Paperclip 系统控制装配；
- `src/task-service.js`：稳定任务 Interface，只负责装配与少量跨模块协调；
- `src/task-overview.js`：运行总览、能力状态和用量账单 Module；
- `src/task-approval-coordinator.js`：本机/Paperclip 审批、任务控制和幂等恢复 Module；
- `src/boom-monitor/`：A君进程内的爆款雷达业务 Module；
- `public/`：本机授权、健康、恢复与脱敏诊断界面；
- `test/`：通过公开 Interface 和领域 Seam 验证行为。

新增岗位或平台能力不得继续把具体 Adapter 堆回 `runtime-composition-root.js`；应进入所属领域装配
Module，并补充该 Seam 的 affected-test 映射。
`TaskService` 已委托给执行、审批或总览 Module 的方法不得重新保留影子实现；架构检查会阻止
同名实现回流，并将该 Interface 限制在 350 行内。

默认地址为 `http://127.0.0.1:4321`。页面应收口为连接授权、组件健康、恢复操作与脱敏诊断；现有本地任务视图只作迁移期调试/应急用途，不能成为与飞书或 Paperclip 并列的日常控制台。`POST /api/paperclip/heartbeat` 只接受本机 Paperclip 的 HTTP Adapter 回调；首个切片仅执行低风险本机健康检查并将结果回报同一张 Paperclip 任务单。不会调用飞书、浏览器或外部账号。

业务 Agent 失败时，恢复协调器会创建运维官任务；满足安全条件时只自动重试一次，再失败或不可重试时建立技术专家修复任务。技术专家已完成一次“实际改代码、跑测试、恢复检查、把结果安全交回 A君”的受控演练。专家不能直接联网；它只在允许工作区留下完整回执，由 A君核对后代为登记到 Paperclip。实际验证发现 Paperclip 的独立副本分配不可靠，因此 A君 已改为按任务编号自己建立并核验独立副本；在真实修改、测试和恢复检查出现前，任务必须保持处理中，不能把“已接单”当作故障已经解决。
