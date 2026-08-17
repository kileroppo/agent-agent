# A君自助版本发布架构

| 字段 | 内容 |
| --- | --- |
| 状态 | 生效 |
| 负责人 | A 君 |
| 版本 | v1.1 |
| 最后更新 | 2026-08-17 |

## 组件与真相

```text
本机负责人页面
  → A君 owner-only API
  → 0600 Unix Socket
  → 独立 Release Helper LaunchAgent
  → 不可变 release / A君 LaunchAgent
```

- 正式仓库当前 `main` HEAD 是候选版本真相；候选页明确分开显示“已提交、验证状态、可发布、尚未部署”。未提交内容不会进入候选，也会阻止发布。
- `release-manifest.json` 是冻结产物身份真相。
- A君 LaunchAgent 的实际 PID、工作目录和参数是运行版本真相。
- Release Helper 的 `status.json` 是当前发布阶段与最近结果真相；它只保存脱敏的核对结论，不保存 cwd、argv、命令输出或环境变量。
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
7. 核对实际 PID、cwd、argv、release hash、payload hash、Git HEAD 和 `/api/console-overview`；只有全部通过才记为“运行身份已核对”。
8. 写入上一版可回滚记录；任一失败恢复备份 plist，并验证旧版重新可达。

## 接口

- `GET /api/runtime-release/status`：本机只读状态。
- `POST /api/runtime-release/check`：本机、同源、owner nonce。
- `POST /api/runtime-release/publish`：同上，并要求 `confirm: "publish_current_commit"`。
- `POST /api/runtime-release/rollback`：同上，并要求 `confirm: "rollback_previous_release"`。

Helper 只监听私有 Unix Socket；A君对响应做字段白名单投影，不返回命令输出、绝对备份内容或环境变量。

## 页面状态语义

- **线上版本**：只能在 PID/cwd/argv、release/payload/Git 和控制台 API 都实际核对后显示“运行身份已核对”。
- **候选版本**：`main` 的已提交 HEAD；“已提交”不等于已测试，也不等于已经上线。
- **候选验证**：初始为“未验证”；发布事务完成不可变 release 验证后才是“已通过验证”。中断或失败只显示“验证未完成”。
- **可发布 / 尚未部署**：分别表示当前候选符合发布门禁，以及候选 Git HEAD 与 live Git HEAD 不同。两者必须同时满足，才可点击发布。
- **回滚版本**：只显示最近一次已经通过运行身份核对的旧版；发布成功的证明包含该回滚入口可用。
