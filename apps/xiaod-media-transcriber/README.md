# 小D - 音视频转录整理 Agent

本地优先的最小可用实现：公开链接或本地媒体文件 → 字幕优先 / 音频下载 → `mlx_whisper` 转录 → 清洗与分享稿整理 → 本地 Markdown 交付；配置自己的飞书 App 后可创建飞书文档。B站先尝试受控原生字幕接口，只有字幕条数、文本量和覆盖率合格才直接复用，否则自动回退到独立音轨和本机 ASR。

## 启动

```bash
cp .env.example .env
npm install
npm run dev
```

打开 `http://127.0.0.1:4318`。

Mac Apple Silicon 推荐把 `ASR_MODEL` 改为本机可访问的 `mlx-community` 模型。首次使用一个新模型可能需要下载模型权重。

## 交付真实性

- 没有 `TEXT_REFINER_*` 配置时，服务只做机械清洗，任务会明确标记“需要人工校对”；不会谎称已经完成语义提纯。
- 没有 `LARK_APP_ID` 和 `LARK_APP_SECRET` 时，服务只给出本地 Markdown；不会谎称飞书已交付。
- 配置 `LARK_USER_OPEN_ID` 后，服务会尝试把创建的文档授予该用户完全权限；失败会显示为警告。
- 只处理公开 HTTP(S) 链接和用户上传文件，不尝试绕过平台登录、Cookie 或访问控制。

## 环境变量

见 [`.env.example`](.env.example)。凭据只放在本应用目录的本机 `.env`，不要提交、发到聊天或写进交付文档。

小D与A君共用任务运行事件库时，路径按以下顺序解析：

1. `AGENT_ARMY_TASK_RUN_EVENT_DB`：显式指定同一个 SQLite 文件；
2. `AGENT_ARMY_DATA_DIR/task-run-events.sqlite`：复用A君数据目录；
3. 未配置时使用源码开发目录下的 `apps/ajun-runtime/data/task-run-events.sqlite`。

launchd 环境应优先设置与A君一致的 `AGENT_ARMY_DATA_DIR`；只有需要单独覆盖数据库文件时才设置 `AGENT_ARMY_TASK_RUN_EVENT_DB`。启动时小D会创建事件库父目录并收紧为 `0700`，已有数据库收紧为 `0600`；符号链接父目录或数据库会被拒绝。正式 LaunchAgent plist 由受控发布流程维护，不应手工直接修改。

## 验证

```bash
npm test
curl http://127.0.0.1:4318/api/health
```

本机 A君还可通过 `POST /api/metrics/collect` 请求小红书/抖音只读指标包。该接口只负责调用 Agent军团适配器并返回脱敏结果，不保存或返回 Cookie；正常业务从 A君的受保护入口调用，不应把小D端口暴露到局域网或公网。
