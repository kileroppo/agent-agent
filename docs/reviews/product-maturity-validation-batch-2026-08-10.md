# 产品成熟度统一验证批次与 TypeScript 20% 门禁验收

| 字段 | 内容 |
| --- | --- |
| 状态 | 代码与本机测试通过，live 运行验收待本文后续补记 |
| 日期 | 2026-08-10 |
| 范围 | 产品成熟度固定批次、统一验收包、21 个 Workflow 模块迁移、TypeScript 比例门禁 |

## 已实现

- 本机固定创建与统一决定 API 均要求同源 JSON、短期 owner-action nonce 和 loopback 来源。
- 三个子任务由服务端固定，使用持久化 HMAC 密钥签名；普通多人任务上下文不能伪造授权，也不能替换岗位、任务类型或 item key。
- 技术专家仅在 `work/acceptance-runs/` 独立 worktree 使用受控夹具；小创仅引用现有确认稿和正式分析，不启动 Publisher、Campaign 或 Cron。
- 十岗位统一证据包保存 SHA-256 `evidenceHash`；证据变化后旧 hash 返回 409。决定只写新批次账本，明确记录 `historicalTaskStatusesChanged=false`。
- 21 个既有 Workflow / Policy / Reconciler / Role 文件完成真实 `.ts` 迁移，所有生产 import 与对应测试已同步。生产源码从 `18 TS / 181 JS / 1 MJS` 提升为 `41 TS / 160 JS / 1 MJS`，比例 `20.30%`。
- `typescript-ratio-baseline.json` 固定最低 41 个 TypeScript 生产文件和 20% 比例；`npm run check --workspace=ajun-runtime` 同时执行严格 `tsc` 与比例门禁。

## 自动验证

2026-08-10 在独立 clean worktree 执行：

```text
npm run check
PASS；architecture boundaries ok；typescript ratio 41/202 (20.30%)

npm test
PASS；全部 Workspace 与根脚本测试通过

四批直接 import smoke 与对应单元测试
PASS；迁移模块均可由 Node 22 直接加载
```

这些结果证明源码、类型、架构和本机测试通过；不等于三个真实验证子任务已经完成，也不等于负责人已经登记统一采用结论。

## 运行与外部边界

- 不在代码验收阶段调用模型、创建 live 批次、发送飞书消息或启动外部写入。
- 不修改历史任务终态，不读取或记录 secret、Cookie、token 或 `.env`。
- immutable release、4321 切换、真实 API 安全路径和动态服务身份必须在提交本文后重新验证并补记；Publisher 保持关闭。
