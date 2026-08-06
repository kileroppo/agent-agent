# Paperclip 内容自治插件

这个目录只补 Paperclip/Hermes 尚未提供的业务工具，不实现任务状态机、Cron、预算或审批。

当前工具：

- StepFun 视觉、生图、单图编辑和官方音色 TTS；
- FFprobe/FFmpeg 规格、黑帧、响度和受控最终编码；
- 复用 `apps/animated-chart` 三个固定 Composition 的受控 Remotion 渲染；
- 字幕时间、重叠、行数、宽度和成片范围门禁；
- 从可信三份成片和真实画面素材生成固定内容产物包，并核验双平台文案、
  来源/版权、审核结论及血缘；
- 新产物若引用 StepFun 素材，写入器直接读取受控工作区内已确认的 Provider ledger，
  原生写出图像、视觉、TTS action/费用事件、Prompt/产物哈希和 Provider 父引用；
  `lineage:migrate-rendered-stepfun` 只用于补齐历史成片；
- 活动和发布前确定性门禁。

当前仓库目标版本为 `0.4.9`、14 个 Agent 工具，另有不进入岗位授权表的负责人只读 Provider 核验动作；插件自动化以本次实际测试结果为准。源码、测试和本地
产物通过不代表 live 已安装或启用；升级安装前必须重新核对 Paperclip 插件版本、
公司配置、Secret 引用、8 岗 UUID 绑定和原子预算预留能力。`ready` 只证明 worker
已加载，不能证明真实 StepFun 调用或内容活动已经完成。

历史 `0.3.0` 源码已从 Git tree
`79c4fb4c1893bda0b2da3a6639ef8548121083ad` 恢复并固定为
`refs/m5-recovery/content-autonomy-0.3.0`。独立归档位于
`work/m5-content-autonomy/plugin-packages/content-autonomy-0.3.0-recovered-src.tar.gz`，
固定 mtime 后 SHA-256 为
`957c18e15c42d9295b0ebf4d90dbb8b74ac3a7ca9fdc9f713a20c89396c5b49a`；
隔离解包、`npm ci --ignore-scripts`、`npm test`（34/34）和 `npm run check`
均通过。它只用于维护窗口回滚，不能使当前 v2 获得 0.4 新增工具。

M5 目标源码的控制面另有 daily、parallel、publisher、metrics、retrospective 5 个
无模型控制器和 15 阶段/17 Routine 声明；它们不属于插件内部状态机。publisher 将可信
发布结果写为 `PublishReceipt` Work Product，metrics 写 `MetricSnapshot`，
retrospective 写版本化复盘 Work Product；少于5条同类型真实72h指标只记录样本
不足，达到门槛也只生成待审核 `LearningProposal`。当前 live 已对账为
15阶段/17 Routine/5 个控制器，活动仍为未批准 `0/14` 草案、Cron 关闭，本插件
保持 `disabled`。

安全默认值：

- 仓库目标版为 `0.4.9`；`0.4.8` 仅为历史候选，live 仍是 `0.4.7`，必须在维护窗口重新读取，不能从源码版本反推；
  公司配置不完整时所有受控执行仍失败关闭；
- 8 个 M5 岗位使用版本内置的精确工具 bundle；额外工具、未知工具、额外 Agent
  UUID 和 UUID/岗位错配全部拒绝，未登记岗位默认拒绝；
- 插件外 11 个正式 Hermes Profile 的岗位技能白名单已在 live 对账为无额外、
  无缺失；`xiaod` 原有 78 个额外技能已禁用并保留可恢复路径。该 Hermes 白名单
  不替代插件内的 8 岗工具门禁；
- 只读写 Paperclip 显式绑定的 `content-workspace`；
- StepFun Key 只接受 Paperclip `{ type: "secret_ref", secretId, version? }`
  对象引用并在调用时解析；旧字符串 UUID、占位符和明文一律失败关闭；
- 调用记录只保留字符数等允许字段和哈希，不保存自由文本摘要；
- 视觉工具在预算、Secret 和 Provider 前核验图片魔数与扩展名，不能把工作区内
  任意文件伪装为 JPEG 外发；
- Provider 图片、TTS 输出必须分别通过图片魔数/扩展名和 MP3 魔数/体积门禁；
  Secret 解析异常只返回固定错误，不回显底层文本；
- props、生成文件和固定产物使用唯一临时文件原子替换，末级软链不会被跟随写出
  工作区；Remotion 旁白路径必须同时绑定 StepFun TTS 产物哈希；
- 真实调用必须配置负责人确认过的保守计费率。
- 每个付费工具必须提供稳定 `actionId`；调用前写入持久状态，未决、歧义或待记账状态都禁止自动重放。
- 每个 StepFun 付费工具在读取 Secret 或调用 Provider 前，必须由宿主注入可信
  `reservePaidToolBudget`，按公司、岗位、Project 和 Run 精确匹配并返回覆盖最大
  费用的原子预留；缺少检查器、任一作用域不匹配或预留不足时均失败关闭，Provider
  调用数为 0。Paperclip `2026.722.0` 公共插件 SDK 尚不提供该预算客户端，因此
  live 宿主未注入前付费工具保持不可用。
- Remotion 只允许 `M5Master`、`M5Douyin`、`M5Xiaohongshu`，只能执行仓库内固定
  `render-m5-controlled.mjs`，输入、素材和输出都必须位于 `content-workspace`。
  固定脚本不可用时返回 `remotion_renderer_unavailable`，不会复制渲染器或退回任意命令。

活动批准和恢复还会先做只读元数据预检：公司级插件配置、active Secret、
Secret Provider、插件绑定记录、8 岗精确 UUID/工具授权、非零费率、官方音色和
`content-workspace` 读写健康必须同时成立。预检不会调用 Secret resolve，也不会
把 Secret 值带入 A君日志、错误或活动数据。

负责人创建 Paperclip Secret 后，可用只读生成器输出公司配置草案：

```bash
npm run --silent config:draft -- \
  --company-id 0d4ac7ac-3655-41f9-8957-2e36ef7ad751 \
  --secret-id <Paperclip Secret UUID>
```

生成器只读取本机 Paperclip 的插件元数据、8 岗 Agent UUID、现有官方音色和费率，
不会读取 Secret 列表或 Secret 值，也不会写入 live。它只向标准输出打印对象形
`secret_ref`、岗位绑定和版本内最小工具白名单，仍需负责人核对后在 Paperclip 保存。

兼容性说明：

- 插件的 `@paperclipai/plugin-sdk` 与 `@paperclipai/shared` 精确锁定为
  `2026.722.0`，并使用该版本要求的对象形 `secret_ref` 配置契约。
- Paperclip `2026.722.0` 的独立运行入口仍没有把自身版本传给插件加载器，
  `/api/health` 显示 `2026.722.0` 时加载器仍会误报宿主为 `0.0.0`。因此本地
  插件清单暂不声明 `minimumPaperclipVersion`，安装前必须使用
  `paperclipai plugin target` 核验目标实例版本；上游修复后恢复清单门禁。

当前 Paperclip live 有 13 条 M5 Budget 策略，分别覆盖公司、Project 和 11 个正式
岗位；每条都是 625 美分的同一分层硬上限，不能相加为总预算，当前实际费用为 0。
该 live 策略存在不等于插件已获得上述原子预留接口，也不代表发生过付费调用。

Paperclip Plugin SDK 当前只向插件开放 `metrics.write`，没有直接创建核心
`cost_event` 的写接口。因此付费动作采用可恢复的两段提交：

1. 插件以稳定 `actionId` 保存 provider 结果、费用草稿和 `pending` 状态；
2. A君负责人执行面领取一次性 `submitting` 租约，向
   `/api/companies/:id/cost-events` 写入真实费用；
3. 只有核心费用事件 ID、Run、Project 和提交租约全部匹配时才确认 `confirmed`。

网络结果不确定时提交租约保持占用，自动重试会被拒绝；在核心费用事件确认前不得
进入下一阶段，也不得为了补记费用而重放已经完成的付费调用。
