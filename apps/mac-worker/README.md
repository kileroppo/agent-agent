# Agent Army Mac Worker

私人云端 Hermes/Paperclip 与本机 Mac 工作区之间的出站工作桥。Worker 主动领取已授权任务，
只调用固定 A君/小D Interface，不开放远程入站命令执行口，也不保存第二套任务真相。

## 入口

```bash
cd apps/mac-worker
npm start
```

正式入口是 `src/worker.js`。配置由 `src/config.js` 校验；状态只保存领取和恢复所需的最小引用，
凭据不得进入任务正文、日志或测试快照。

## 验证

```bash
npm test
```

Mac Worker 不是常规业务 Agent、组织控制面或通用远程终端。
