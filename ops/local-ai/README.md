# 本地 AI 插件运行时

本目录只保存插件源码、安装器和运维入口。Python 环境、模型、日志、索引与产物全部安装在项目目录外；A君只通过 `127.0.0.1:18082` 的能力 Interface 调用，不依赖仓库位置或当前发布包。

## 一台新 Mac 如何安装

要求：Apple Silicon macOS、Node.js 22+、`uv`、Homebrew FFmpeg 和 `jq`。模型只有在明确传入 `--download-models` 时才会下载。

```bash
git clone <项目仓库地址>
cd agent-agent
npm install
brew install uv ffmpeg jq
ops/local-ai/install-plugin.sh --bootstrap --download-models
npm run local-ai:plugin:status
npm run local-ai:status
npm run local-ai:smoke
```

如果固定版本模型已经存在于 Hugging Face 缓存，可省略 `--download-models`。ASR 还需要 `mlx-whisper==0.4.3`；可安装到插件的 gateway 环境，或在外置 `config.json` 中声明可执行文件。未安装时 ASR 会如实显示未配置，不影响文本、Embedding 等其他能力启动。

## 安装后的目录

```text
~/Library/Application Support/AgentArmy/
├── plugins/local-ai/
│   ├── releases/<内容哈希>/   插件代码与固定依赖清单
│   └── current -> releases/<内容哈希>
└── local-ai/
    ├── venvs/                 Python 环境
    ├── logs/                  运行日志
    ├── indexes/               本地知识索引
    ├── artifacts/             本地产物
    ├── mac-pairing.json       可选的 4070 配对文件，权限必须为 0600
    └── config.json            可选的机器专属路径配置
```

`~/Library/LaunchAgents/com.agent-army.local-ai.*.plist` 由安装器按本机目录动态生成，里面不含仓库路径。插件发布按内容哈希保存，升级只切换 `current` 符号链接；运行数据不会跟着项目 Git、A君发布包或插件代码滚版。

## 升级、查看和回滚

```bash
# 从当前 checkout 构建一个新内容哈希版本并重启轻量网关
ops/local-ai/install-plugin.sh

# 查看当前版本和外置目录
npm run local-ai:plugin:status

# 查看所有可回滚版本
ls "$HOME/Library/Application Support/AgentArmy/plugins/local-ai/releases"

# 回滚代码；<完整哈希> 必须来自上一条命令
node ops/local-ai/plugin-manager.mjs activate --release <完整哈希>
launchctl kickstart -k "gui/$(id -u)/com.agent-army.local-ai.gateway"
npm run local-ai:status
npm run local-ai:smoke
```

回滚只切换插件代码，不覆盖模型、索引、产物、配对文件或 Python 环境。更换电脑时重新克隆项目并执行新机安装命令；需要带走私有索引或模型缓存时再单独复制对应外置目录，不要把它们提交进仓库。

## 运行拓扑与安全边界

- `18082`：轻量统一能力控制面，由 LaunchAgent 常驻。
- `18081`：Qwen3.5-9B MLX-VLM，真实请求到来时按需启动，空闲后释放。
- `18080`：可选的 Qwen3.6 35B 候选，默认禁用；机器专属 server/model 路径放在外置 `config.json`。
- `18083`：可选的 Windows 4070 增强节点，说明位于 [`desktop/`](./desktop/)。

A君 `账号与接入 → AI 能力中心` 是日常管理入口。统一调用入口是 `POST http://127.0.0.1:18082/v1/invoke`；控制入口是 `GET /v1/control`、`POST /v1/control/services/{serviceId}/{action}` 和 `PUT /v1/control/services/{serviceId}/policy`。本插件不创建业务任务、审批、预算或审计真相，这些仍由 A君和 Paperclip 负责。

配对 token 不得进入仓库、日志或聊天。只有请求带 `approved=true` 才会跨设备发送输入；附件与产物均校验大小和 SHA-256。未配置或断线时默认继续走 Mac；显式指定离线节点则保留真实失败。`video.generate` 仍需网络与单独授权，未安装的声音克隆能力保持失败关闭。
