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

## 验证

```bash
npm test
curl http://127.0.0.1:4318/api/health
```
