# 小D飞书媒体强制路由

## 目的

飞书的 `.mp3`、`.m4a`、`.mp4` 等附件，以及单独发送的受支持公开视频链接，都是小D业务任务，不允许先进入通用模型会话再由模型自行决定是否下载模型、运行命令或改用其他转写工具。

## 实现边界

- Hermes 飞书适配器在完成用户准入、文件下载与媒体批处理后，优先检查 `XIAOD_MEDIA_INGRESS_URL`。
- 仅接受 `http://127.0.0.1:<port>/...` 的本机入口；非本机地址拒绝路由。
- 音频/视频附件按 `messageId + attachmentIndex` 提交至小D `POST /api/internal/feishu-media`。
- 小D服务继续负责受信任缓存目录校验、复制、幂等、转录和产物状态；Hermes先回复“任务已创建”，随后轮询本机任务状态并在终态向原会话发送一次完成或失败通知。成功通知仅在文档已创建且权限已授予时附交付入口。
- 在小D会话中，“目前进行得如何”“任务进度呢”等简短状态询问只读取该会话最近的小D任务；不得交给通用模型会话，避免模型翻出旧上下文、建议下载模型或把任务状态编造为聊天回答。
- 失败通知必须携带明确恢复边界：仅当小D任务标记为可重试时，用户可在同一会话回复“重试小D任务”从安全断点继续；网关重启后可回复“重试小D任务 `<任务编号>`”定位原任务。无效媒体必须要求重新上传，已完成任务和非可重试失败均拒绝自动重试。重试不清空既有失败记录，也不得把已完成任务重新交付。
- 小D媒体事件必须在通用媒体批处理之前直接路由。否则用户紧接着发送状态询问时，任务尚未创建而文本会先落入旧模型会话，造成无关的历史回复。
- 小D HTTP 服务默认只绑定 `127.0.0.1`；该内部入口不作为局域网或公网 API 使用。
- 未设置该变量时，Hermes保持原有通用附件处理行为。这是避免影响其他 Hermes Profile 的显式开关。
- 小D专用飞书应用收到**纯** B站、YouTube 或抖音公开视频 URL 时，适配器只在 `AGENT_ARMY_FEISHU_AGENT_ID=xiaod` 且 `AGENT_ARMY_PROFILE_ID=xiaod` 时，把原消息的 `messageId` 作为 `sourceEventRef` 转发至本机 A君 `POST /api/feishu/commander`。A君以该事件引用去重；重复投递仍指向同一任务。混有文字、非公开视频链接、普通聊天和其他 Profile 一律不走此入口。
- URL 入口只接受精确的 `http://127.0.0.1:<port>/api/feishu/commander`；不会执行 shell，也不会把链接下载行为暴露为 HTTP API。入口不可用时会在原会话明确说明“未启动下载、转录或外部动作”，不会回退给通用模型假装已处理。

## 启动方式

只启动隔离的小D网关时使用：

```sh
XIAOD_MEDIA_INGRESS_URL=http://127.0.0.1:4318/api/internal/feishu-media \
AJUN_FEISHU_COMMANDER_INGRESS_URL=http://127.0.0.1:4321/api/feishu/commander \
AGENT_ARMY_FEISHU_AGENT_ID=xiaod \
AGENT_ARMY_PROFILE_ID=xiaod \
node integrations/hermes/scripts/start-hermes-gateway-guarded.mjs --agent xiaod
```

这个入口会先检查小D的 Manifest 技能白名单、已启用技能和
`.no-bundled-skills` 自动注入保护；任一项漂移就拒绝启动，不会带着新出现的
未声明技能继续运行。不要再直接执行 `hermes gateway run` 绕过该门禁。

该变量不是凭据，不写入仓库或模型提示词。Hermes 升级可能覆盖本机适配器补丁；升级后按本文核对强制路由是否仍存在，再恢复运行。
