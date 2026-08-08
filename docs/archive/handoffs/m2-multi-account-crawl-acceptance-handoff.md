# M2 多账号与三平台只读增量验收交接

> 2026-08-08 已归档：该事项已经完成或被后续运行事实与验收记录替代，不再作为当前唯一下一步。

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-07-30 21:20（Asia/Shanghai） |
| 关闭时间 | 2026-07-30 21:34（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | A君维护者 / 负责人 |
| 关联任务 | [M2 授权连接 PRD](../../../tasks/prd-m2-authorization-connectors.md)、[验收记录](../../reviews/m2-authorization-connectors/acceptance.md) |
| 截止条件 | 已满足：小红书默认账号对发现页当前公开笔记完成真实只读，运行台显示最近真实读取成功 |

## 1. 接手目标

- 目标：关闭多账号管理和小红书、抖音、哔哩哔哩三平台当前只读验收。
- 用户约束与不可做事项：只读；不得发布、评论、关注、私信、付费、扩权或读取/展示凭据。
- 做完的定义：已满足；小红书当前真实读取成功，内容包标明 `authorized_read` 和实际账号，连接最近验证为成功，相关验收记录已同步。
- 唯一下一步：无；新增平台或动作时另开验收。
- 允许继续的前提：本交接已关闭；如重开，仍须保持只读授权并使用页面自然生成的完整链接。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 默认账号、任务账号绑定、真实读取证据和控制台展示已实现 | `integrations/access/`、`apps/xiaod-media-transcriber/`、`apps/ajun-runtime/` | 已验证 |
| 本地运行时 | 小D监听 `127.0.0.1:4318`；内容中心和三个适配器健康；A君运行台可读取最新连接状态 | `/api/health`、`/api/connections`、A君运行台 | 已验证 |
| 外部平台 | 抖音、哔哩哔哩真实只读成功；小红书发现页当前公开笔记也通过默认账号完成真实只读 | [验收记录](../../reviews/m2-authorization-connectors/acceptance.md) | 已验证 |
| 人工确认 | 桌面与 390 像素页面层级、主操作、溢出和控制台已检查 | A君运行台真实浏览器检查 | 已确认 |

## 3. 变更与决策

- 已完成：平台唯一默认账号；显式账号优先；无默认多账号拒绝猜测；任务与内容包保留安全账号证据；控制台展示默认账号和最近真实读取。
- 关键文件或外部配置位置：`integrations/access/connection-store.js`、`integrations/access/content-acquisition-center.js`、`apps/xiaod-media-transcriber/src/content-runtime.js`、`apps/ajun-runtime/public/app.js`。
- 已确定的边界与兼容性约束：连接健康和登录状态不是读取成功；授权读取失败后即使公开降级成功，也不能把账号记为成功。
- 不要重复创建的产物：不要新建账号控制面、任务队列或爬虫；继续复用 Connection Store、Content Acquisition Center 和 MediaCrawlerPro 适配器。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `apps/xiaod-media-transcriber npm test`：42/42；`apps/ajun-runtime npm test`：828/828 | 无全仓回归结论 |
| 运行时 | PASS | 正式 launchd 服务重启；小D健康接口与连接安全字段已核对 | 不代表外部平台成功 |
| 外部平台 | PASS | 抖音、哔哩哔哩及小红书发现页当前公开笔记均真实只读成功 | 不代表任意笔记均可访问 |
| 人工验收 | PASS | 1440 像素与 390 像素真实浏览器检查，无控制台错误 | 长期日常使用反馈 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：无关闭阻塞；具体笔记仍可能因分享上下文、可见范围或平台风控失败。
- 不得复制或展示的信息：Cookie、token、密码、授权链接、浏览器会话和内部凭据引用。
- 需要谁确认：无需额外确认。
- 关闭条件：已满足；当前小红书笔记真实读取成功，运行台显示最近真实读取成功，验收记录已更新。
- 关闭证据链接：[M2 授权连接与内容获取验收](../../reviews/m2-authorization-connectors/acceptance.md)。
