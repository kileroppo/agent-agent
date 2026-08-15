# 文档索引

本目录是 `agent-army` 仓库的产品、架构、契约、治理和验收事实集合。对应 `repository-catalog.json` 中 `docs` area。

## 入口

- **项目总览** → [`overview/`](./overview/) — 项目说明、全景指南
- **当前交接** → [`handoffs/`](./handoffs/README.md) — 负责人需参与的唯一下一步
- **验收记录** → [`reviews/`](./reviews/README.md) — 里程碑与高风险变更的验收证据
- **历史归档** → [`archive/`](./archive/README.md) — 被基线吸收的中间版本，仅供追溯

## 子目录

| 目录 | 用途 |
| --- | --- |
| `overview/` | 项目说明、全景指南等总览文档 |
| `architecture/` | 系统架构、能力路由、可靠性契约等设计 |
| `adr/` | 架构决策记录 |
| `contracts/` | 跨组件契约定义 |
| `standards/` | 仓库协作、测试验收、推测内容评估等规范 |
| `governance/` | 文档迭代与治理规范 |
| `guides/` | 可复用操作教程（Hermes 接线、Paperclip 速成等） |
| `product/` | 产品级说明 |
| `plans/` | 实施计划 |
| `research/` | 调研记录 |
| `design/` | 设计稿与设计说明 |
| `reviews/` | 里程碑与高风险变更验收证据 |
| `handoffs/` | 项目交接单（含 `current/` 当前活跃交接） |
| `acceptance-fixtures/` | 验收测试夹具 |
| `assets/` | 文档配图等静态资源 |
| `archive/` | 历史审核稿与被吸收的中间版本 |

## 规则

- 当前建设依据只取 `overview/`、`architecture/`、`standards/`、`reviews/`、`handoffs/current/`，不取 `archive/`。
- 新增文档请落入对应子目录；跨里程碑的验收记录见 `reviews/` 规范。
