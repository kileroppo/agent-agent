# Boom Monitor（爆款雷达）

本应用只负责导入指标、冻结每条作品的历史基线并计算 R/M/Tier。命中配置等级后，它通过 A君正式入口建立“小D取证 → 小拆分析”军团任务；不再维护独立 L1/L2 模型管线。

## 启动

```bash
cd apps/boom-monitor
docker compose up -d --build
```

访问: http://localhost:8080

- API: `GET /api/health`
- 仪表: `GET /api/dashboard`
- 作品列表: `GET /api/works`
- 触发扫描入队: `POST /api/scan/run`
- 触发L1: `POST /api/analysis/run`
- 自动入队配置: 
  - `BOOM_ANALYSIS_AUTO_ENABLED`（默认 `false`，也可在页面用一个开关控制）
  - `BOOM_ANALYSIS_AUTO_GRADES`（默认 `T2,T3`）
  - `BOOM_ANALYSIS_DAILY_LIMIT`（默认每天最多派发 `5` 条；达到上限后留在队列次日再处理，设为 `0` 可停止派发）
  - `BOOM_ARMY_BASE_URL`（Compose 默认 `http://host.docker.internal:4321`）

自动拆解关闭时仍会正常导入和评分，但不会创建军团任务。设置保存在 SQLite，重启后不会丢失。

Compose 默认通过 `http://localhost:8081` 访问；可用 `BOOM_HTTP_PORT` 修改宿主机端口。

如果 Boom Monitor 运行在 Docker、A君运行在宿主机，需要给两边设置相同的随机 Token：

```bash
export BOOM_MONITOR_BEARER_TOKEN='请使用本机随机长字符串'
```

A君读取 `BOOM_MONITOR_BEARER_TOKEN`，Compose 将它注入 Boom Monitor。不要把真实 Token 写入仓库。

## 当前数据入口

首页可直接粘贴小红书或抖音作品链接。Boom Monitor 通过已有的 A君 Bearer 通道请求本机小D，小D再调用 Agent军团自己的 MediaCrawlerPro 适配器，依次读取作品详情、作者粉丝数和作者主页最多 20 条历史作品；Cookie 只在本机 CookieBridge 与 MediaCrawlerPro 之间流转，不进入 Boom Monitor。

这条链路不修改 MediaCrawlerPro 官方仓库，也不把观测时间伪装成发布时间。官方接口未返回发布时间时，评分器直接使用作者主页返回顺序中的历史指标计算中位数，并以 `url-history-v1` 冻结首次有效基线。

JSON/CSV 导入继续保留。批量导入会先完整入库，再按每条作品发布时间读取其之前最多 20 条作品，避免导入顺序改变评分。

评分规则：

- R：抖音/YouTube 使用点赞，小红书使用点赞+收藏；
- M：所有平台都使用点赞/首次评级时的粉丝快照；
- 少于 5 条历史样本时保持 `N0`，不自动派发；
- 当前指标或粉丝数拿不到时显示“没有爆款分级依据”，不会把缺失值猜成 0；
- 每条作品首次形成有效基线后单独冻结，后续只更新指标分子；
- `T3` 默认派发 `full`，其他命中等级派发 `fast`。

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
