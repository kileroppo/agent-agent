# ADR-0014：本地 AI 使用独立插件运行时

| 字段 | 内容 |
| --- | --- |
| 状态 | 已接受并切入本机 live |
| 日期 | 2026-08-16 |
| 决策者 | A君 |

## 决策

Mac 本地 AI 作为独立的**本地 AI 插件运行时**安装，不再把 Python 虚拟环境、日志、索引、产物和 LaunchAgent 绑在项目 checkout 的 `work/local-ai`。

A君与业务 Agent 继续只消费 `127.0.0.1:18082` 的能力 Interface；`apps/ajun-runtime` 中的 CapabilityAdapter 不感知插件代码版本、模型路径或运行目录。插件代码按内容哈希安装到：

```text
~/Library/Application Support/AgentArmy/plugins/local-ai/releases/<releaseHash>
~/Library/Application Support/AgentArmy/plugins/local-ai/current -> releases/<releaseHash>
```

运行数据和依赖稳定放在：

```text
~/Library/Application Support/AgentArmy/local-ai/
├── venvs/gateway
├── venvs/mflux
├── logs
├── indexes
├── artifacts
├── config.json（可选）
└── mac-pairing.json（可选，0600）
```

LaunchAgent 由安装器按当前用户目录动态生成，ProgramArguments、cwd 和日志路径只指向上述外置目录。重新运行安装器会创建新的内容哈希 release 并原子切换 `current`；旧 release 可在验证前保留为代码级回滚点，运行数据不随代码版本复制。

## 可移植安装

- Apple Silicon Mac 从仓库执行 `ops/local-ai/install-plugin.sh --bootstrap --download-models`，用锁定的 Python 3.12 依赖与固定 revision 模型建立运行环境；模型下载是显式动作。
- 已有仓库内运行物使用 `--migrate-existing` 原子迁移；冲突目标非空时失败关闭，切换失败按迁移记录回搬并恢复原 LaunchAgent。
- 4070 Windows/Linux 增强节点继续使用 `ops/local-ai/desktop` 独立 bundle，不复制 Mac 插件运行根。
- `mac-pairing.json` 不进入插件 release、仓库、日志或迁移清单；安装器只保留现有 0600 文件。

## 后果

- 移动、重命名或删除项目 checkout 不影响已安装插件；A君 release 也不复制本地 AI venv 与模型。
- `gateway` 与 Qwen3.5 共用已验证的 MLX 环境，删除重复 `mlx-vlm` venv；MFLUX 因依赖版本不同保留独立环境。
- 插件代码可以热切换和回滚，但模型/依赖升级仍必须经过固定清单、自动化与真实能力 smoke；“current 已切换”不等于所有能力已验收。
- 默认安装只建立代码和依赖；大模型下载、4070 配对、付费或外部 Provider 不被静默触发。

## 2026-08-16 live 证据

- live 插件 release `5472861d…` 首次切入后，后续源码修正由新的内容哈希 release 接管；精确当前值以 `npm run local-ai:plugin:status` 为准。
- LaunchAgent 的 program、cwd、stdout/stderr 均指向 `~/Library/Application Support/AgentArmy/`，不含项目 checkout。
- 18082 与 A君 `/api/local-ai/control` 均返回 `ready`；外置合并环境完成本机文本和 Embedding smoke。
- 项目目录由迁移前约 2.60 GiB 降至约 462 MiB；运行物外置后约 1.6 GiB，重复 MLX-VLM 环境约 566 MiB 已删除。
