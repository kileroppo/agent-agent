# A君运行台

本机能力网关与执行适配：从所有 `agents/*/manifest.json` 读取岗位，为连接授权、内容获取、组件健康、恢复和脱敏诊断提供本机边界，并承接受限的 Paperclip 执行请求。飞书是日常派活与交付入口；军团组织、任务、heartbeat、预算、审批和审计由 Paperclip 承担。

```bash
cd apps/ajun-runtime
npm test
npm run dev
```

默认地址为 `http://127.0.0.1:4321`。页面应收口为连接授权、组件健康、恢复操作与脱敏诊断；现有本地任务视图只作迁移期调试/应急用途，不能成为与飞书或 Paperclip 并列的日常控制台。`POST /api/paperclip/heartbeat` 只接受本机 Paperclip 的 HTTP Adapter 回调；首个切片仅执行低风险本机健康检查并将结果回报同一张 Paperclip 任务单。不会调用飞书、浏览器或外部账号。
