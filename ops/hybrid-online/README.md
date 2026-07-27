# 私人云办公室 + Mac工作间

本目录把已确认的混合在线设计变成可部署边界，但不替代真实云主机、模型授权和最终关机验收。

## 复用边界

- Hermes 官方 Gateway 继续负责飞书长连接、Profile、Session、Memory 和模型工具调用，不复制聊天运行时；
- Paperclip 继续负责组织、预算、组织级审批和审计，不复制军团控制面；
- Google Cloud IAP SSH 隧道只把云端回环端口映射到老板 Mac 的回环端口；不增加第三方组网账号，不公开暴露运行台；
- 本项目只补现成产品没有提供的一个缺口：云端任务与老板 Mac 上本机能力之间的受限接力。

官方依据：

- [Hermes Gateway CLI](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)
- [Hermes Linux system gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md)
- [Google Cloud IAP TCP 转发](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding)
- [Shielded VM](https://docs.cloud.google.com/compute/shielded-vm/docs/shielded-vm)
- [E2 通用型 VM 定价](https://cloud.google.com/products/compute/pricing/general-purpose)
- [Persistent Disk 定价](https://cloud.google.com/compute/disks-image-pricing)
- [外部 IPv4 定价](https://cloud.google.com/vpc/pricing-announce-external-ips)
- [Google Cloud 免费层与结算要求](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [Cloud Run WebSocket 限制](https://docs.cloud.google.com/run/docs/triggering/websockets)

## 生产目标选择

当前机器已有 Google Cloud CLI 和已登录项目，但项目没有关联结算账号，Compute Engine 也未启用。首个真实目标选用该项目中的 `us-central1` Compute Engine `e2-medium`（2 个共享 vCPU、4 GB 内存）和 40 GB 标准持久盘；它满足首批三个 Hermes Gateway、A君运行时与 Paperclip 的常在线基线。按官方当前标价和每月 730 小时估算，VM 约 24.46 美元、40 GB 标准盘约 1.60 美元、运行中的临时外部 IPv4 约 3.65 美元，基础合计约 29.71 美元/月，另加少量出站流量和税费；35 美元是首月授权上限，不是 Google 自动硬停机保证。

不选 Cloud Run：官方明确说明 WebSocket 仍受最长 60 分钟请求超时约束，而且实例是自动伸缩、无状态的；它不适合把三个飞书长连接和本地持久任务真相作为首版常驻办公室。不选免费层 `e2-micro`：免费层虽可整月运行，但只有约 1 GB 内存，低于本项目已确认的 4 GB 基线。启用 Google Cloud 结算或创建付费 VM 前必须获得老板明确授权；预算提醒不能冒充硬费用上限。

## 当前可部署切片

```text
飞书
  │
  ▼
云端 Hermes Gateway ──loopback── 云端 A君运行时
                                   │
                                   ├─ 公开研究、轻量汇报：云端直接执行
                                   │
                                   └─ 音视频/本机任务：waiting_worker
                                                    │
                                     IAP SSH 回环隧道 + 独立令牌
                                                    │
                                                    ▼
                                             老板 Mac 工作间
                                                    │
                                                    ▼
                                           本机小D 127.0.0.1:4318
```

Mac 离线时，依赖本机的任务停在 `waiting_worker`，不会误报失败；Mac 上线后按原任务号领取。每次领取带短租约，旧租约不能覆盖新结果。Mac 只回传阶段、脱敏错误和飞书交付引用，不上传密码、Cookie、本机路径或原始文件。

## 首批三员工资源清单

| 资源 | 首版建议 | 当前状态 |
| --- | --- | --- |
| 私人 Linux 主机 | Google Cloud `us-central1` `e2-medium`，2 个共享 vCPU、4 GB 内存、40 GB 标准持久盘；A君端口不对公网开放 | 项目已登录但无结算账号，创建前需老板另行批准 |
| 私网连接 | Google IAP SSH；云端 `127.0.0.1:4321` 映射到 Mac `127.0.0.1:44321`，不需要公网域名；VM 使用临时外部 IPv4 出站访问飞书、模型与更新源，但入站防火墙只允许 IAP SSH，业务端口不开放 | 本机已有已登录的 Google Cloud CLI；真实隧道待主机创建 |
| 云端运行软件 | Node.js、Hermes、Paperclip、systemd | Ubuntu 24.04 隔离引导已完整安装成功；真实主机未安装 |
| 员工飞书入口 | 小R与小办各自独立应用、最小收发权限、独立长连接 | 已创建、发布并通过真实私聊闭环 |
| 员工模型身份 | A君、小R、小办各自 Hermes Profile，不复制其他 Profile 凭据 | 本机 Profile、真实模型调用和独立 Gateway 已验证；云端需在目标主机单独授权 |
| 私有数据 | 加密磁盘、`600` 配置权限、加密备份；应用凭据只经受控加密通道迁移 | 本机有受控存储；云端迁移未执行 |

## 部署顺序

1. 先运行 `node ops/hybrid-online/gcp/deploy.mjs` 查看只读计划；它不会创建资源；
2. 只有获得付费授权后，才同时提供命令确认词和独立环境门禁执行 `--apply`；未启用结算时程序会在创建任何资源前失败关闭；
3. 部署器建立独立 VPC、仅允许 Google IAP 来源访问 SSH，并创建启用 Secure Boot、vTPM、完整性监控和删除保护的 `e2-medium` 主机；A君端口不对公网开放；
4. 引导脚本以固定提交和 SHA-256 校验安装 Hermes，以固定版本安装 Paperclip；此阶段不迁移凭据、不接管飞书、不启动业务服务；
5. 在独立 Git 工作树形成 `codex/` 发布分支并通过全量检查；`mac/upload-release-bundle.sh` 只接受干净工作树的固定提交，经 IAP 发送 Git bundle，云端按提交号安装到只读发布目录并原子切换 `/opt/agent-army/current`；
6. 从 `cloud/cloud.env.example` 创建仅 root/服务用户可读的 `/etc/agent-army/cloud.env`，生成独立随机工作间令牌；
7. 在 Mac 运行 `mac/prepare-cutover-archive.sh` 的只读预览；真正切换时它会先停止本机写入，再归档 A君任务、默认 Hermes Profile、A君顾问 Profile、小R和小办的 Session/Memory，排除 PID、锁、日志、缓存、请求转储和本机程序代码；
8. Paperclip 不复制 macOS 的原始 PostgreSQL 数据目录：归档器调用官方 `db:backup` 生成唯一可移植 SQL 备份，并迁移配置、加密主密钥和附件；
9. 迁移归档使用一次性 AES-256 密码加密，密码只存 macOS 钥匙串；`mac/upload-cutover-archive.sh` 在隔离临时目录解密并逐文件核对 SHA-256，再经 IAP 上传。云端磁盘继续使用 Google 默认静态加密；
10. 把私有配置权限设为 `600`，运行 `node ops/hybrid-online/preflight.mjs cloud /etc/agent-army/cloud.env`；未通过不得继续；
11. `cloud/import-cutover-state.sh` 导入并恢复 Paperclip，`cloud/prepare-services.sh` 安装 A君与三套 Hermes system Gateway；两步均不提前启动飞书入口；
12. 在 Mac 从 `mac/mac-worker.env.example` 建立私有配置，权限设为 `600`，运行 Mac 预检；
13. `mac/activate-cloud-cutover.sh` 再次确认本机五项服务全部停止，才按“A君运行时 → 小R/小办 → A君 Gateway”顺序激活云端；失败时只有确认云端入口全部停止后才恢复本机，避免双端接管；
14. 先完成三个入口的真实私聊，再关闭 Mac，验证小R和小办继续轻量工作，小D任务进入 `waiting_worker`；Mac 恢复后再验证同任务领取与交付。

## 飞书入口唯一接管

`AGENT_ARMY_EMPLOYEE_FEISHU_OWNER` 只能是 `local` 或 `cloud`。运行环境与归属不一致时，员工应用显示 `standby`，不会读取密钥或建立长连接。默认本机为 `local`；云端预检要求正式配置为 `cloud`。

正式切换由脚本固化以下状态机：

1. 本机 A君、Paperclip、A君 Gateway、小R Gateway、小办 Gateway 必须全部处于已知运行态，归档器才允许开始；
2. 先停 A君和三套 Gateway，再做 Paperclip 官方 SQL 备份，最后停止 Paperclip；失败会恢复本机；
3. 云端上传、导入和服务准备分别独立校验，任一步都不启动员工入口；
4. 激活前必须同时持有“本机五项服务已停止”证明和“云端导入完成”证明；
5. 云端启动失败会停止全部云端员工入口；只有 Mac 能再次确认云端确实停止时，才自动恢复本机；
6. 首次激活失败可执行 `mac/rollback-cutover-to-local.sh` 即时回退；云端已经产生新任务后不得直接回退，必须先做反向状态同步。

## 生产门禁

- 启用云结算、创建付费云主机或其他费用必须由老板批准；
- 后续飞书权限变化和模型授权必须由老板批准；
- 云端只部署已提交的明确版本，不从当前脏工作树直接复制；
- `/etc/agent-army/cloud.env`、Mac 私有 env、Hermes `.env` 不进入 Git、文档、日志或备份明文；
- 防火墙只允许 Google IAP 网段访问带指定标签的 SSH；A君和 Paperclip 均保持回环监听；
- `AJUN_HOST` 保持 `127.0.0.1`，不得直接监听公网；
- Mac 只通过 IAP SSH 将云端回环端口映射到本机回环端口；
- 本机迁移归档必须加密，密码只进 macOS 钥匙串；云端归档位于磁盘加密且权限受控的目录；
- 必须逐文件验证任务事实、Hermes Profile/Session/Memory、飞书私有配置和 Paperclip SQL 备份，缺项或哈希变化均拒绝导入。

## 当前未证明

- 当前没有可用的常在线云主机；现有 Google Cloud 项目未启用结算，任何启用结算或购买资源的动作仍需老板明确授权；
- 尚未创建真实云主机，因此尚未做真实 IAP 跨设备接力；
- 尚未证明 Mac 真关机期间飞书能持续接单；
- 小R和小办的独立飞书应用、模型调用、各自 Hermes Gateway 与真实私聊连续追问已在本机验证；云端目标主机上的模型授权仍未验证。
