# Boom Monitor 收敛到 A君验收账本

## 结论

2026-08-07，Boom Monitor 已从独立 Docker 服务收敛为 A君原生模块和同源“爆款雷达”页面。A君是唯一活动 writer；旧容器和网络已删除，旧 Docker 数据卷、迁移前一致性快照和受控回滚凭据保留。没有触发 Provider、内容发布、投流或外部消息。

## 验收结果

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| 源码与契约 | PASS | Node 原生 SQLite 服务接管旧 9 表 schema、正式 v2/历史评分、冻结基线和 Python half-even 舍入；同源 API 为 `/api/boom-monitor/*` |
| 自动化 | PASS | 根 `npm run check` 与 `npm test` 通过；发布冻结再次执行 A君、M5 内核、内容插件、Publisher 与共享契约测试并通过 |
| 数据迁移 | PASS | `creators=1`、`works=1`、`scores=1`、`shadow_scores=3` 完整迁入；正式 `v2=1`，历史 `legacy-v1/shadow-v2/v2` 各 1；源逻辑指纹一致，目标和源备份均为 `0600` |
| 运行时 | PASS | launchd 运行新的不可变 release，4321 `/api/overview=200`；任务保持 776，Agent 11，能力 12；`/api/boom-monitor/health` 返回 `runtime=ajun-native` |
| 页面 | PASS | 真实 Google Chrome 在 1440px 与 390px 下验证同源页面、作品、v2/v1 评分详情、队列/导入/设置入口；无横向溢出、console error 或失败请求 |
| 安全派发 | PASS | 自动派发为关闭；每日上限 5；服务端只接受 `T1/T2/T3`，N0、陈旧队列和失败的部分设置更新均不能触发派发 |
| 备份与退役 | PASS | A君启动后创建 `0600` 在线一致性备份；旧 Docker 停机前后均通过源指纹、备份、版本和主键身份门禁；旧容器/网络删除，数据卷保留 |
| 凭据 | PASS | 正常 native 运行的 launchd 不再保存 `BOOM_MONITOR_BEARER_TOKEN`；旧 plist 备份中的该字段已删除；Keychain 只保留受控回滚凭据 |

## 运行边界

- 链接采集只读取指标并评分，不直接发布内容。
- 自动派发默认关闭；单作品人工派发要求明确确认，且不会顺带处理其他队列项。
- 旧 Docker 只允许在 `AJUN_BOOM_MONITOR_ENABLED=false`、A君 native health 为 503、停机卷通过迁移门禁且新回滚 Token 的 Docker 网络探针通过后恢复。
- 恢复 native 前必须先停止 Docker、显式处理两边差异，再恢复 A君数据库写权限；不做自动双向合并。

详细操作见 [数据切换与 Docker 退役说明](../../plans/boom-monitor-ajun-convergence.md)。

## 2026-08-15 稳定性加固候选源码

本节记录的是尚未切换到 `4321` live 的候选源码，不能覆盖上面的历史运行验收，也不能据此声称真实平台采集、飞书回告或 Provider 调用已经通过。

| 批次 | 已完成候选行为 | 自动化证据 |
| --- | --- | --- |
| 第一批 | 审批恢复可找到 manager；岗位或执行器缺失时显式失败；雷达持续对账总任务与子任务，并把规划卡死投影为“需要处理” | `task-service.test.js`、`boom-monitor-native-service.test.js` |
| 第二批 | 内容获取改为动态传输探测；请求/整段采集/下载均有超时；同适配器最多重试一次并有限回退；产物保存不含凭据的路由证据 | `common-access.test.js`、`media-transcriber-agent check` |
| 第三批 | 页面显示真实的规划、取证、分析、等待确认和需处理阶段；业务依赖只有 `succeeded` 才放行；爆款信号经过 A君规划后仍保留在小拆上下文 | `boom-monitor-console.test.js`、`cross-agent-mission-service.test.js`、`local-ajun-coordinator.test.js` |
| 全链路 | 真实 `AgentRegistry`、`TaskStore`、`TaskService`、Mission、Boom SQLite 串联；确定性本地替身完成“链接 → 评分 → 小D → 两次质量复核 → 小拆 → 总任务汇总”，没有访问平台或执行外部写入 | `boom-monitor-end-to-end.test.js` |

上线仍需单独授权：构建不可变 release、切换/重启 `4321`、核对 PID/端口/cwd/argv 和真实 API 回读。真实登录态采集、Provider、飞书、发布与外部写入不在本轮候选验收范围内。
