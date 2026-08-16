# A君自助版本发布架构

| 字段 | 内容 |
| --- | --- |
| 状态 | 生效 |
| 负责人 | A 君 |
| 版本 | v1.0 |
| 最后更新 | 2026-08-16 |

## 组件与真相

```text
本机负责人页面
  → A君 owner-only API
  → 0600 Unix Socket
  → 独立 Release Helper LaunchAgent
  → 不可变 release / A君 LaunchAgent
```

- 正式仓库当前 `main` HEAD 是候选版本真相；未提交内容不会进入候选。
- `release-manifest.json` 是冻结产物身份真相。
- A君 LaunchAgent 的实际 PID、工作目录和参数是运行版本真相。
- Release Helper 的 `status.json` 是当前发布阶段与最近结果真相。
- `history.json` 只保存最近一次成功切换的前后版本与 plist 备份引用，不保存凭据。

## 为什么必须独立 Helper

A君不能可靠地在自己的 HTTP 请求中卸载并重启自己。Release Helper 使用独立 LaunchAgent 运行，通过用户私有目录中的 Unix Socket 接收固定动作，因此 A君退出后仍能完成健康检查或回滚。它不是通用进程管理器，不开放命令、路径或服务名参数。

## 发布状态

`idle → checking → preparing_source → verifying → freezing → activating → verifying_live → succeeded`

任何阶段可进入 `failed`；若已经改动启动配置，则先进入 `rolling_back`，旧版验证成功后记为 `rolled_back`。页面只展示这些真实阶段和文字结果。

## 发布事务

1. 固定仓库必须是 `main` 且工作区干净，候选 HEAD 必须不同于 live Git HEAD。
2. 为候选提交创建独立 detached worktree，安装锁定依赖。
3. 复用 `manage-immutable-runtime-release.mjs freeze --verify` 完成完整测试、启动/恢复 smoke 和 payload 校验。
4. 将只读 release 复制到项目外部署目录并复核 manifest。
5. 以 `0600` 备份当前 plist，只替换 server 入口、工作目录和源码根。
6. `bootout` 后等待旧 job 与 4321 listener 消失，再 `bootstrap` 新 plist。
7. 核对 PID、工作目录、manifest、Git HEAD 和 `/api/overview`。
8. 任一失败恢复备份 plist，并验证旧版重新可达。

## 接口

- `GET /api/runtime-release/status`：本机只读状态。
- `POST /api/runtime-release/check`：本机、同源、owner nonce。
- `POST /api/runtime-release/publish`：同上，并要求 `confirm: "publish_current_commit"`。
- `POST /api/runtime-release/rollback`：同上，并要求 `confirm: "rollback_previous_release"`。

Helper 只监听私有 Unix Socket；A君对响应做字段白名单投影，不返回命令输出、绝对备份内容或环境变量。
