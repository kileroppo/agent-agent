# M3 Hermes 内容岗位运行证据

| 字段 | 内容 |
| --- | --- |
| 时间 | 2026-07-27（Asia/Shanghai） |
| 范围 | 小拆与小创隔离 Hermes Profile 的真实模型执行 |
| 输入 | 明确标记为非真实视频听审的本机安全确认稿 |
| 外部副作用 | 0；未抓取、未登录、未发送、未发布 |
| 结论 | PASS |

## 运行结果

执行命令：

```bash
cd apps/ajun-runtime
npm run acceptance:m3-hermes-content-growth
```

小拆：

- Profile：`video-content-analyst`
- Provider / Model：`openai-codex / gpt-5.6-terra`
- API 调用：1
- Token：输入 16065，输出 5049
- 执行器报告费用：0 USD
- 结果：13 个完整模块通过逐项来源片段校验，`advisorApplied=true`
- 产物 SHA-256：`c98377274f051bbd68095adc2a38ac86c07903aa6c44182b9894a5cb7cc5fbbb`

小创：

- Profile：`content-creator`
- Provider / Model：`openai-codex / gpt-5.6-terra`
- API 调用：1
- Token：输入 20599，输出 1889
- 执行器报告费用：0 USD
- 结果：生成抖音、小红书两个待审版本，`advisorApplied=true`，`externalSideEffects=0`
- 产物 SHA-256：`7c1d89c1e5b24517a49011a3162309bf55b97026a7aaacf3a3a25ff204d7535d`

## 固化产物

产物位于本机受控目录 `apps/ajun-runtime/data/m3-acceptance-evidence/hermes-20260727-1844/`，文件权限均为 `0600`：

- `confirmed-transcript-v2.md`
- `video_content_analysis_report.md`
- `platform_content_draft.md`
- `knowledge_summary_note.md`

## 证据边界

本记录证明两个隔离 Profile 的 OAuth 模型通道、A君内容执行器、模型用量记录、证据校验和无发布副作用。Paperclip heartbeat 已另见 [独立证据单](./paperclip-heartbeat-evidence-2026-07-27.md)；本记录本身不证明真实视频完整听审、飞书原会话交付或人工内容质量。
