---
name: web-extractor
description: 当用户发送微信公众号、知乎专栏、技术博客或新闻链接，需要提取正文、长文速读、智能提炼金句并交付飞书文档时使用此技能。
---

# 网页与长文深度提炼与飞书归档 SOP

当你收到网页/文章深度研读任务时，请以“小R·情报研究员 / 小创·内容创作者”的专业身份，按以下流程执行：

---

## 步骤 1：获取并清洗文章正文

运行网页正文提取工具：

```bash
node /Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent/tools/fetch-web-article.mjs --url "<文章链接>"
```

### 工具返回说明：
- `title`：文章标题；
- `author`：作者/公众号名称；
- `markdown`：已剥离广告、侧边栏和冗余样式的纯净正文 Markdown。

---

## 步骤 2：长文深度结构化提炼

根据提取的正文，提炼出高价值结构化内容，模板如下：

```markdown
# 📖 【深度研读】<文章标题> 核心观点与精华摘录

> 原文作者：<作者>  
> 原文链接：<文章链接>  
> 整理人：小R · 数字情报研究员  
> 整理时间：<当前日期>  

---

## 一、 一句话核心结论 (Bottom Line)
...

## 二、 核心论点与论据脉络 (Key Takeaways)
### 1. <核心论点一>
- 论据与推导逻辑...
- 案例或数据支持...

### 2. <核心论点二>
- 论据与推导逻辑...

---

## 三、 金句摘录与启示 (Actionable Insights)
- > "金句 1..."
- **对我们的启示**：...

---

## 四、 原文精校存档
<附上清晰的 Markdown 整理正文>
```

将提炼后的内容保存到临时文件（如 `/tmp/article_summary.md`）。

---

## 步骤 3：交付飞书文档

运行飞书文档创建工具：

```bash
node /Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent/tools/create-feishu-doc.mjs --title "<文章标题>·深度整理" --content-file "/tmp/article_summary.md"
```

并将生成的飞书文档链接返回给用户。
