# 自媒体内容方法与公众号草稿接入

## 结论

吸收 `self-media-content-workflow` 的内容方法，不复制它的任务卡、状态机和调度层。Agent军团继续以 Paperclip 作为唯一任务真相，以现有岗位执行创作、审核和复盘；公众号只增加一个独立批准、只建草稿、不群发的 Publisher Gateway 插槽。

参考来源：

- [`yanhua1010/self-media-content-workflow`](https://github.com/yanhua1010/self-media-content-workflow)：MIT License；仅吸收简报、平台适配、质量检查和指标复盘的方法结构。
- [`caol64/wenyan-cli`](https://github.com/caol64/wenyan-cli)：Apache-2.0；作为外部 CLI 依赖，通过受控 runner 调用，不复制其源码。

## 七项落位

| 项目 | 现有归属 | 已落地的最小缺口 |
| --- | --- | --- |
| 1. 创作简报与账号策略 | A君 | 结构化 `ContentBrief`，明确目标、受众、证据、假设、主渠道、延展渠道和唯一实验 |
| 2. 热点与竞品研究 | 小R | `ContentOpportunity` 区分公开信号、可原创角度和不能证明的结论；互动信号不冒充销量 |
| 3. 平台原生创作 | 小创 | 抖音、小红书、公众号、视频号各自使用平台 playbook；不是同文改标题 |
| 4. 视觉与短视频规范 | 小创 + M5 | 每版绑定视觉锚点，视觉与文字分工；现有 M5 素材血缘和媒体门禁继续生效 |
| 5. 内容质量审核 | 审核官 | 六项语义门：证据、账号声音、平台原生、视觉一致、合规、交付完整性 |
| 6. 指标复盘与学习 | 小办 + A君 | 缺失指标留空；同类样本使用中位数和 P75；至少五条真实 72h 样本才可提学习建议，每轮只试一个变量 |
| 7. 公众号草稿连接器 | Publisher Gateway | Paperclip 逐次授权、Secret Reference、不可变文件租约、独立幂等账本、Wenyan CLI 只建草稿和失败暂停 |

## 公众号草稿安全边界

```text
Paperclip 当前授权
  → 校验 accountRef / secretRef / authorizationId / 有效期
  → 校验 Markdown 与图片 SHA-256，创建不可变只读租约
  → 再次核验 Paperclip 授权
  → Wenyan CLI create draft
  → 保存 WechatDraftReceipt（externalPublished=false, groupSent=false）
```

- `WenyanCliRunner` 只允许 `--version` 和 `publish -f` 两种固定调用，不提供任意 Shell。
- 凭据只由受信任 resolver 在调用时解析到子进程环境；不写入请求、账本、日志或临时文件。
- 临时目录权限为 `0700`，文件使用独占创建；调用结束无论成功或失败都清理。
- 同一 `campaignId + contentVersionId` 只能建一次草稿。进入外部调用后若结果不确定，记录 `ambiguous`、暂停 Campaign/Cron，并拒绝自动重试。
- 草稿回执不等于发布回执。预览、修改、群发和公开发布仍需要人工在公众号后台确认，本连接器没有群发能力。
- 公众号能力不扩大现有 M5 七天活动的抖音/小红书双平台范围，也不向内容岗位开放发布工具。

## 验收边界

- 当前已完成源码和依赖注入假 CLI 测试。
- 当前未安装或调用真实 Wenyan CLI，未解析真实公众号 Secret，未访问公众号后台，也未生成真实 Media ID。
- 真实验收必须另行提供测试账号、Paperclip 批准快照、账号引用、Secret Reference、IP 白名单和明确的一次草稿写入授权；仍不得自动群发。
