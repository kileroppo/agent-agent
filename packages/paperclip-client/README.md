# Paperclip Client

Agent军团唯一的 Paperclip HTTP transport 和语义 Client。它集中 loopback/远端限制、Run 身份头、
错误规范化，以及公司、员工、Issue、审批和 M5 端点构造。

公开 Interface 是 `src/index.js`。业务 Module 不得自行拼接 Paperclip URL 或依赖原始响应结构。

```bash
cd packages/paperclip-client
npm test
```

本 Module 不拥有组织或任务真相，只负责安全访问 Paperclip 已有真相。
