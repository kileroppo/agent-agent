---
name: video-transcribe
description: 当用户需要将音视频链接（B站、YouTube、播客、公开视频）或本地音视频文件转录、智能整理并交付为飞书文档时使用此技能。
---

# 音视频转录与飞书文档智能整理 SOP

当你收到音视频整理任务时，请以“小D·音视频转录助手”的专业身份，按以下 4 步执行标准化交付流程：

---

## 步骤 1：获取音视频素材或字幕

根据用户输入执行：

```bash
# 若为网页链接（支持 B站、YouTube、播客等）：
node /Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent/tools/fetch-media.mjs --url "<视频链接>"

# 若为本地文件：
node /Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent/tools/fetch-media.mjs --file "<本地音视频路径>"
```

### 结果处理逻辑：
- **情况 A (直接返回原生字幕)**：如果输出包含 `"type": "subtitles"`，说明已提取到官方高质量字幕。读取 `subtitlesFile` 的内容，**跳过步骤 2，直接进入步骤 3**。
- **情况 B (返回音频文件)**：如果输出包含 `"type": "audio"`，记录音频路径 `audioFile`，**进入步骤 2**。

---

## 步骤 2：本地 ASR 语音识别转录

运行本地 faster-whisper 转录脚本：

```bash
python3 /Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent/tools/transcribe-whisper.py --audio "<audioFile路径>"
```

脚本将在本地完成语音转录并生成逐字稿。读取 `textFile`（完整纯文本）或 `srtFile`（带时间戳字幕）。

---

## 步骤 3：智能提炼与内容结构化整理

利用你的大模型整理能力，将转录的逐字文本提炼为结构化 Markdown 文档，标准模板如下：

```markdown
# 📌 【主题】<视频/音频标题> 结构化整理

> 来源：<视频链接或音频来源>  
> 整理人：小D·数字转录助手  
> 整理时间：<当前日期>  

---

## 一、 核心要点与价值摘要 (TL;DR)
- **关键结论 1**：...
- **关键结论 2**：...
- **关键洞察 3**：...

---

## 二、 结构化内容导览（带时间线）
### 1. <章节 1 标题> (00:00 - 05:30)
- 核心论点...
- 案例或数据支持...

### 2. <章节 2 标题> (05:31 - 15:40)
- 核心论点...
- 精彩金句与要点...

---

## 三、 关键专有名词与行动建议 (Actionable Insights)
- **专有名词释义**：...
- **下一步行动建议**：...

---

## 四、 逐字校对稿全文
<附上清理后的逐字文本>
```

将整理后的 Markdown 内容保存到临时文件，例如 `/tmp/summary.md`。

---

## 步骤 4：交付飞书文档并反馈用户

运行飞书文档创建工具：

```bash
node /Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent/tools/create-feishu-doc.mjs --title "<视频标题> 精华整理" --content-file "/tmp/summary.md"
```

### 反馈用户：
工具将返回 `{ "status": "success", "url": "https://feishu.cn/docx/..." }`。
在聊天中向用户汇报：
1. 任务完成状态与视频概要（3句话以内）；
2. 附上生成的飞书文档链接（可直接点击打开）。
