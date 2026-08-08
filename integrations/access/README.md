# Common Access Adapters

账号连接、内容获取和本机私密只读能力的 Adapter 集合。业务 Agent 通过稳定 Interface 使用这些
能力，不直接依赖 CookieBridge、MediaCrawlerPro、yt-dlp、微信 Vault 或平台响应结构。

公开 exports 以 `package.json` 为准，包括连接 Broker、内容获取中心、B站字幕、通用媒体、
MediaCrawlerPro 和微信本机 Vault Adapter。

```bash
cd integrations/access
npm test
```

本 Module 不保存组织、任务、审批或预算真相；Cookie、Token 和聊天原文不得进入日志、文档或测试。
