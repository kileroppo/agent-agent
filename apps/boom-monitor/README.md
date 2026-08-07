# Boom Monitor（爆款雷达）

爆款雷达已并入 A君模块化单体。日常只访问 [A君运行台](http://127.0.0.1:4321/#boom-monitor)；评分、SQLite、扫描和派发均在 A君进程内完成，不再依赖 Docker、Caddy、独立端口或跨进程 Token。

`apps/boom-monitor/` 保留旧 Python/Docker 实现作为迁移依据和受控回滚资产，不是当前正式启动入口。原生实现位于 `apps/ajun-runtime/src/boom-monitor/`，数据位于 A君 `AGENT_ARMY_DATA_DIR/boom-monitor.sqlite`。

## 当前入口

- API: `GET /api/boom-monitor/health`
- 仪表: `GET /api/boom-monitor/dashboard`
- 作品列表: `GET /api/boom-monitor/works`
- 版本化评分记录: `GET /api/boom-monitor/versioned-scores?version=v2&limit=100`
- 触发扫描入队: `POST /api/boom-monitor/scan/run`
- 显式派发: `POST /api/boom-monitor/analysis/run`
- 自动入队配置: 
  - 默认关闭，可在页面显式开启；
  - 默认等级 `T2,T3`；
  - 默认每天最多派发 `5` 条，设为 `0` 可停止派发；
  - 设置保存在同一 SQLite，重启后保留。

自动拆解关闭时仍会正常导入和评分，但不会创建军团任务。设置保存在 SQLite，重启后不会丢失。

旧 Docker 的迁移、退役和恢复只能使用 `ops/boom-monitor/docker-lifecycle.sh`，不得直接删除 volume。恢复前必须先用 `AJUN_BOOM_MONITOR_ENABLED=false` 停住 A君原生 writer，避免两个数据库同时写入。

## 当前数据入口

首页可直接粘贴小红书或抖音作品链接。A君在进程内请求本机小D，小D再调用 Agent军团自己的 MediaCrawlerPro 适配器，依次读取作品详情、作者粉丝数和作者主页最多 20 条历史作品；Cookie 只在本机 CookieBridge 与 MediaCrawlerPro 之间流转，不进入爆款雷达数据库。

这条链路不修改 MediaCrawlerPro 官方仓库，也不把观测时间伪装成发布时间。官方接口未返回发布时间时，评分器直接使用作者主页返回顺序中的历史指标计算中位数，并以 `url-history-v1` 冻结首次有效基线。

JSON/CSV 导入继续保留。批量导入会先完整入库，再按每条作品发布时间读取其之前最多 20 条作品，避免导入顺序改变评分。

旧评分 v1（只保留作回滚对照，不再控制链接评分派发）：

- R：抖音/YouTube 使用点赞，小红书使用点赞+收藏；
- M：所有平台都使用点赞/首次评级时的粉丝快照；
- 少于 5 条历史样本时保持 `N0`，不自动派发；
- 当前指标或粉丝数拿不到时显示“没有爆款分级依据”，不会把缺失值猜成 0；
- 每条作品首次形成有效基线后单独冻结，后续只更新指标分子；
- 结果继续版本化保存，便于核对 v2 切换前后的差异。

正式评分 v2（当前链接评分与派发依据）：

- 同时看四组证据：相对历史提升 `R`、点赞/粉丝 `M`、绝对互动量、收藏/分享/评论质量；
- `T1`：`R >= 2`，且触达、绝对互动或质量至少有一项支持；
- `T2`：`R >= 3`，同时达到触达规模（`M` 或绝对互动）和质量门槛；
- `T3`：`R >= 8`，同时达到触达规模（`M` 或绝对互动）和质量门槛；
- 小红书绝对互动使用点赞+收藏，初始 `T1/T2/T3` 门槛为 `100/500/5000`；抖音使用点赞，门槛为 `500/3000/10000`；
- 小红书收藏/点赞达到 20%、分享/点赞达到 5%，抖音分享/点赞达到 2%，或评论/点赞达到 3%，可形成质量信号；如果某项达到作者历史中位数的 1.5 倍，也可形成质量信号；
- 低于平台 `T1` 绝对互动门槛时最高只记 `T1`，防止极小历史基数把几次互动放大成虚假 `T2/T3`；
- 首次有效 v2 基线单独冻结为 `url-history-v2`，和 v1 互不覆盖；
- 平台拿不到发布时间时，v2 明确标记为“累计表现、作品年龄未知”，不能据此声称作品正在爆发。
- v2 命中自动分析配置中的等级后，`T3` 派发 `full`，`T1/T2` 派发 `fast`；派发信号携带 `scoreVersion: v2`。

这些绝对量与质量门槛仍属于首版参数。通过 `GET /api/versioned-scores` 持续检查不同平台、粉丝层级和内容类型的误报/漏报；规则调整必须继续版本化，不能静默改写既有证据。

## 导入样例

```json
{
  "platform": "douyin",
  "creator_id": "u-123",
  "creator_name": "测试作者",
  "follower_count": 120000,
  "works": [
    {
      "work_id": "w1",
      "title": "标题",
      "likes": 123,
      "favorites": 10,
      "plays": 1000,
      "source_url": "https://example.com/video/123",
      "publish_at": "2026-07-30T20:00:00+08:00"
    }
  ]
}
```

提交到前端“导入”页。

没有 `source_url` 的命中作品会保留为 `waiting_source`，不会伪造小D或小拆已经执行。
