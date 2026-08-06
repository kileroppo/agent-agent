# M3 Paperclip 内容岗位 heartbeat 运行证据

| 字段 | 内容 |
| --- | --- |
| 时间 | 2026-07-27（Asia/Shanghai） |
| 范围 | Paperclip 以小拆、小创真实岗位身份唤醒 Hermes 并完成回写 |
| 输入 | 明确标记 `realVideoReview=false` 的受控合成确认稿 |
| 外部副作用 | 0；未抓取、未登录、未发送、未发布 |
| 结论 | PASS |

## 运行结果

执行命令：

```bash
cd apps/ajun-runtime
npm run acceptance:m3-paperclip-heartbeat
```

小拆：

- A君任务：`7e85c700-b1d2-487d-9cbd-bd442554cb79`
- Paperclip：`AGE-433`
- Provider / Model：`openai-codex / gpt-5.6-terra`
- API 调用：1
- Token：输入 16001，输出 4252
- 结果：`full_analysis_ready`，随后由 Paperclip 以 `paperclip_hermes_completed` 完成
- 产物 SHA-256：`842fbb46b47fe4156a5990300e997bf3767bb5c192dc5f985b359d0da560f169`

小创：

- A君任务：`20ceca32-62a5-49d1-8eda-7af4385f20e6`
- Paperclip：`AGE-434`
- Provider / Model：`openai-codex / gpt-5.6-terra`
- API 调用：1
- Token：输入 19726，输出 1692
- 结果：`platform_draft_ready`，随后由 Paperclip 以 `paperclip_hermes_completed` 完成
- 外部副作用：`externalSideEffects=0`
- 产物 SHA-256：`b3638d43b939b733fd3437117874a301fd56c272697883ba604246b4c5d78b2c`

## 配置修复与失败保留

首次真实 heartbeat 任务 `AGE-431` 因 Paperclip Hermes 适配器把缺省模型解析为 `auto` 而失败。该失败记录保留为失败，没有覆盖或改写。修复后，两个岗位的 Manifest 和 Paperclip adapterConfig 均显式使用 `openai-codex / gpt-5.6-terra`；花名册同步会把受管岗位从配置错误后的 `error` 恢复到 `idle`。`AGE-433` 和 `AGE-434` 是修复后的新任务与通过证据。

## 固化产物

证据位于本机受控目录 `apps/ajun-runtime/data/m3-acceptance-evidence/paperclip-20260727110024/`。持久化内容产物权限为 `0600`。

## 证据边界

本记录证明 Paperclip 能以两个新增岗位的真实身份唤醒 Hermes、调用受控 A君工具、记录模型用量并完成同一任务回写。它不证明真实视频完整听审、飞书原会话交付或人工内容质量；这些仍须由负责人使用真实公开视频完成。
