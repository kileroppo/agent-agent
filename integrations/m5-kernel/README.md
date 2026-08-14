# M5 Campaign Kernel

M5 Campaign/Case 的领域编排内核。它集中活动生命周期、阶段执行、恢复、Work Product 血缘和交付
证据规则，通过 Control Plane Interface 使用 Paperclip，不保存第二份活动状态。

公开 exports 以 `package.json` 与 `src/index.ts` 为准。A君只能通过这些 Interface 使用内核，不能
重新引入一行转发门面或直接读取 Paperclip 原始响应。

```bash
cd integrations/m5-kernel
npm test
npm run check
```

本 Module 是领域内核，不是独立进程、Publisher 或平台控制面。
