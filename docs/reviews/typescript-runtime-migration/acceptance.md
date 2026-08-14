# TypeScript 生产运行时迁移验收

| 字段 | 结果 |
| --- | --- |
| 日期 | 2026-08-14（Asia/Shanghai） |
| 范围 | 业务生产源码、浏览器源、共享契约、A君 4321、小D 4318 |
| 结论 | PASS（本地代码、自动化、性能与运行时）；外部平台和人工内容质量不在本轮范围 |

## 代码与架构

- `apps/`、`agents/`、`integrations/`、`packages/` 的非测试、非脚本、非生成业务源码为
  `442 TS / 0 JS`；A君 TypeScript 门禁为 `287/287 = 100%`。
- 浏览器源码统一位于 `frontend/src/*.ts`，运行产物位于 `public/*.js` 或
  `frontend/generated/*.js`，不再维护平行手写 JavaScript 源。
- `AgentRegistrySnapshotCache` 是可注入、可删除的缓存 Adapter；`TaskDefinitionRegistry` 使用
  预计算直接任务类型索引并拒绝重复默认映射。删除测试证明关闭缓存不改变注册表行为。
- 不可变 release validator 同时验证历史 `server.js` 清单与当前 `server.ts` 清单，旧发布可继续
  作为受控历史参考，新发布不放宽 manifest、payload、ABI 或只读门禁。

## 验证账本

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 严格检查 | PASS | 根 `npm run check`；架构边界、全部 Workspace、浏览器构建、Paperclip compat 均通过 | 无 |
| 自动化 | PASS | 根 `npm test`；A君 `1657/1657`，其余 Workspace 与仓库级测试全部 0 失败 | 不替代外部平台验收 |
| 性能 | PASS | 100 次岗位列表 `119.356ms → 24.353ms`（约 `-79.6%`）；50 万次直接任务路由 `81.848ms → 5.538ms`（约 `-93.2%`）；5% 回退门禁通过 | 仅覆盖已识别的两个热点 |
| 数据兼容 | PASS | SQLite 五项迁移回归、历史任务读取和切换前后 A君 833 条任务回读一致 | 未执行破坏性回滚 |
| 不可变发布 | PASS | release `5ceb5069…`、payload `49872add…`、7302 entries、clean Git `ee27aed…`；主启动和只读恢复 smoke 均通过 | 降级恢复不冒充精确旧内存状态 |
| 本地运行时 | PASS | A君 PID 98404、`src/server.ts`、4321=200；小D PID 99347、`src/server.ts`、4318=200；Paperclip 3100=200 | PID 会随后续重启漂移，以实时指纹为准 |
| 外部平台 | NOT RUN | Publisher、Campaign、Cron 保持关闭；未发送飞书消息，未调用外部 Provider | 真实外部业务闭环不属于本轮授权 |

## 恢复边界

- A君切换前 plist 保存在本机受限备份目录；历史 release `8fbe710c…` 保留。新 release 的独立
  只读 recovery entrypoint 已验证 GET 白名单、未知 GET 404 和写请求 503。
- 小D 切换前 plist 与 clean JS rollback worktree 均保留。私有文件迁移到权限 `0700` 的独立目录，
  文件权限保持 `0600`，原文件未删除；切换过程未读取或输出文件内容。
