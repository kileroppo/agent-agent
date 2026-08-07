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
