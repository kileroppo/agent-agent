# Boom Monitor Compatibility Adapter

旧 Boom Monitor 与 A君原生爆款雷达之间的兼容 intake。公开 Interface 只负责规范化和派发
`BoomSignal`，正式评分、SQLite、扫描和任务派发均位于 `apps/ajun-runtime/src/boom-monitor`。

本 Module 是 A君不可变 release 的显式依赖，但不是独立产品或控制面。旧 Python/Docker 回滚资产
位于 `apps/boom-monitor`，只能通过 `ops/boom-monitor/docker-lifecycle.sh` 操作。

相关验证由 A君的 `boom-monitor-intake.test.js`、原生 Boom Monitor 测试和不可变 release 测试覆盖。
