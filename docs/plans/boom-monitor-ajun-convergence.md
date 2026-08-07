# Boom Monitor 收敛到 A君：数据切换与 Docker 退役

## 结论

Boom Monitor 的页面和业务入口可以收敛到 A君，但历史评分 SQLite 必须先做一致性迁移。迁移工具默认只读；只有显式传入 `--apply` 才会在 A君数据目录创建 `boom-monitor.sqlite`。Docker 生命周期脚本默认只显示状态；验收期间可用 `pause --apply` 暂停并保留容器，最终用 `retire --apply` 删除带有旧运行配置的容器和网络，同时保留数据卷。

本文只覆盖数据迁移、核验和 Docker 退役/恢复。A君读取该数据库、统一页面入口和真实 HTTP 验收由相应运行时改动负责；这些没有通过前，不得停止 Docker。

## 2026-08-07 只读盘点

- 当前运行容器：`boom-monitor-backend-1`、`boom-monitor-caddy-1`、`boom-monitor-backup-1`。
- 数据卷：`boom-monitor_boom_data`，容器内挂载为 `/data`；数据库为 `/data/boom-monitor.sqlite`。
- Docker Desktop 显示卷源为 `/var/lib/docker/volumes/boom-monitor_boom_data/_data`，这是 Linux VM 内路径，不应由 macOS 宿主机直接复制。
- 当前数据库共 9 张业务表：`creators=1`、`works=1`、`scores=1`、`shadow_scores=3`、`app_settings=1`，其余 4 张表均为 0。
- 正式评分版本为 `v2=1`；影子评分版本为 `legacy-v1=1`、`shadow-v2=1`、`v2=1`。
- 当前卷内数据库权限为 `0644`；迁移后的 A君数据库和源快照备份统一收紧为 `0600`。
- 盘点没有读取或输出容器环境变量、Token、Cookie 或业务记录内容，也没有停止、重建或修改当前容器。

## 迁移步骤

以下命令均在仓库根目录执行。先从运行中的 SQLite 生成一致性快照，不能直接复制 Docker Desktop VM 中可能同时存在 WAL 的文件：

```bash
ops/boom-monitor/docker-lifecycle.sh snapshot \
  --output /绝对路径/boom-monitor-live-snapshot.sqlite
```

先做默认只读检查：

```bash
NODE_NO_WARNINGS=1 node apps/ajun-runtime/scripts/migrate-boom-monitor-data.mjs \
  --source /绝对路径/boom-monitor-live-snapshot.sqlite \
  --data-dir /绝对路径/A君数据目录
```

确认目标路径与行数后显式执行：

```bash
NODE_NO_WARNINGS=1 node apps/ajun-runtime/scripts/migrate-boom-monitor-data.mjs \
  --source /绝对路径/boom-monitor-live-snapshot.sqlite \
  --data-dir /绝对路径/A君数据目录 \
  --apply
```

执行时会：

1. 对源库执行 `quick_check`、`foreign_key_check`，校验 9 张必需表和评分关键列；
2. 计算不输出任何记录值的逻辑指纹，并统计逐表行数、正式评分版本与影子评分版本；
3. 在 `<A君数据目录>/boom-monitor-backups/` 创建按逻辑指纹命名的 SQLite 一致性备份；
4. 原子安装 `<A君数据目录>/boom-monitor.sqlite`，备份和目标权限均为 `0600`；
5. 创建 `<A君数据目录>/boom-monitor-migration-manifest.json`，以 `0600` 记录源逻辑指纹、逐表行数、关键评分版本、每张表的主键身份摘要和对应备份文件名；单主键和复合主键都编码类型与长度后计算 SHA-256，记录中不保存作者、作品或 setting key 明文；已有记录只允许核验，不允许覆盖；
6. 再次核对表、行数、版本分布和完整逻辑指纹；
7. 如果目标已有不同数据，拒绝覆盖；如果目标已经完全一致，幂等返回且不重复写入。

工具不会读取环境变量或输出数据库记录内容，因此不会显示 Boom Monitor Token。源数据库始终保持不变。

## 退役门禁

先由 A君运行时完成以下真实验收：

- A君实际从其数据目录的 `boom-monitor.sqlite` 读取仪表盘和作品列表；
- 页面显示的作者、作品、正式评分和版本化评分数量与迁移账本一致；
- 导入一条受控测试数据后，A君写入的新库可查询且重启后仍存在；
- A君 `/api/overview` 和 Boom Monitor 新入口返回 200；
- 自动派发仍保持关闭，未触发 Provider、发布、投流或外部消息。

验收过程中如果需要可逆暂停，执行：

```bash
ops/boom-monitor/docker-lifecycle.sh pause \
  --apply \
  --data-dir /绝对路径/A君数据目录
```

`pause` 会在停止前做一次退役核验，执行 `docker compose stop` 后再从只读挂载的数据卷生成快照并复核，消除“核验后、停机前”又有新写入的时间窗口。核验要求 Docker 快照仍等于不可变迁移记录和源备份；A君目标库允许新增 `analysis_daily_limit` 等设置或合法业务写入，但必须通过完整性/结构检查，逐表行数和每个关键评分版本不得少于迁移源，而且迁移源每张表的全部主键身份必须仍存在。普通表按主键，`shadow_scores` 按 `work_id + version`，`app_settings` 按 `key`；因此删掉源行后补一条等量新行也会被阻止。容器、网络和卷均保留。确认 A君稳定接管后执行最终退役：

```bash
ops/boom-monitor/docker-lifecycle.sh retire \
  --apply \
  --data-dir /绝对路径/A君数据目录
```

`retire` 会在停机前后各创建一次临时一致性快照，并以 `--verify-retirement` 证明 Docker 数据自迁移后没有变化、源备份和迁移记录仍一致，以及 A君目标没有丢失源身份、行数或关键评分版本。A君自己的新增设置和后续合法写入不会造成误拦截；Docker 端任何迁移后新写入仍会阻止退役。验证通过后执行 `docker compose down --remove-orphans`，删除可能携带旧运行环境或旧 Token 注入的容器和网络；随后再次核对 `boom-monitor_boom_data` 仍存在。命令绝不带 `--volumes`，也不会执行 `down -v`。

默认命令始终是只读状态检查：

```bash
ops/boom-monitor/docker-lifecycle.sh
```

## 回滚

回滚不能直接启动 Docker，否则 A君 native writer 和旧 Docker 会同时写两个 SQLite，形成双重真相。必须先通过正式运行配置把当前 launchd plist 的 `EnvironmentVariables.AJUN_BOOM_MONITOR_ENABLED` 设置为 `false`，重启 A君使已经打开的 SQLite/WAL writer 真正关闭，然后同时确认：

```bash
/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:AJUN_BOOM_MONITOR_ENABLED' \
  /当前用户主目录/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:4321/api/boom-monitor/health
```

第一条必须输出 `false`，第二条必须输出禁用态 `503`。仅修改 plist 或把新库 `chmod 0400` 都不能关闭已经打开的 SQLite 文件描述符，因此必须完成 A君重启和真实接口核验。随后从受控凭据存储向当前 shell 注入新的 `BOOM_MONITOR_BEARER_TOKEN`；不要把值写入命令历史、文档、测试或聊天，再执行：

```bash
ops/boom-monitor/docker-lifecycle.sh restore \
  --apply \
  --data-dir /绝对路径/A君数据目录
```

该命令会独立复核当前 launchd 配置为 `false` 且 live 接口为 `503`，再从停机的 `boom-monitor_boom_data` 生成一致性快照，以不可变迁移记录重新核对旧卷的源逻辑指纹、逐表主键身份和评分版本。旧卷损坏、被替换或在迁移后有新写入都会在启动前被拒绝。

随后脚本通过标准输入把当前 shell 的同一 Token 原子写入当前 A君 launchd plist，文件保持 `0600`；Token 不进入子进程参数、不打印，也不写入仓库、文档或测试。脚本重载 A君，再次要求 native health 为 `503`，并从一次性 Docker 网络环境访问无副作用的 `GET /api/integrations/boom-monitor/health`：由当前 Token 在内存中派生的同长度无效 Bearer 必须返回 `401`，同一有效 Bearer 必须返回 `200`。探针子进程会移除继承的 Token 环境变量，只通过标准输入传递认证值。这证明旧 Docker 使用的非 loopback 兼容入口已接受 constant-time Bearer，而不是因为宿主 loopback 被放行。

全部通过后，脚本才校验 A君新库并将它收紧为 `0400` 留作只读证据，最后把当前 shell 的同一 Token 自动交给 Compose 并执行 `docker compose up -d`，随后在 30 秒内核验旧服务健康接口。操作者只向当前 shell 提供一次 Token，不需要、也不允许再手工配置第二份：脚本负责 stdin 原子写 launchd、重启 A君、Docker 网络 invalid=`401`/valid=`200` 探针和 Compose 注入的完整顺序。命令拒绝在 Token 未显式注入当前 shell 时重建，且不会输出 Token。随后再核验：

```bash
curl --fail --silent --show-error http://127.0.0.1:8081/api/health
ops/boom-monitor/docker-lifecycle.sh status
```

恢复旧页面入口后，再定位 A君读写问题。A君新库保持 `0400`，不得删除或反向覆盖旧卷；Docker 恢复后产生的新数据也不得自动写回 A君新库，更不得自动双向合并。

如果以后再次切回 A君 native，顺序必须是：先停止 Docker writer并分别生成两个库的一致性快照；人工审查差异，走单向、显式、可回滚的合并或选定唯一真相。完成后执行：

```bash
ops/boom-monitor/docker-lifecycle.sh resume-native \
  --apply \
  --data-dir /绝对路径/A君数据目录 \
  --reconciled
```

`--reconciled` 是已完成人工差异处理的显式声明。该命令要求 Docker writer 已停止，依次校验 A君库、恢复权限为 `0600`、从 launchd plist 删除 `BOOM_MONITOR_BEARER_TOKEN`、设置 `AJUN_BOOM_MONITOR_ENABLED=true`、重载 A君，最后要求 native health 返回 `200` 并复核 plist 已无 Token。native 正常运行期间不得保留回滚 Token。不能一边运行两个 writer 一边合并。确定长期稳定并另行完成可恢复归档前，旧数据卷、A君只读库和迁移备份都继续保留。

## 验收账本

| 门禁 | 当前结果 | 证据 |
| --- | --- | --- |
| Docker/卷/数据库位置只读盘点 | 通过 | 3 个容器运行；`boom-monitor_boom_data:/data` |
| 表与行数盘点 | 通过 | 9 张表；业务有效行数见上文 |
| 评分版本盘点 | 通过 | `scores v2=1`；3 个影子版本各 1 |
| 迁移默认只读 | 通过 | 自动测试证明不创建数据目录或目标库 |
| 显式迁移、备份、不可变记录、0600 | 通过 | 自动测试证明目标、指纹备份和迁移记录均核验且权限正确 |
| 非空冲突目标拒绝覆盖 | 通过 | 自动测试证明目标字节不变且未创建备份目录 |
| 重复执行幂等 | 通过 | 自动测试证明第二次不新增备份、不重写目标 |
| A君新增设置后的退役核验 | 通过 | 新增 `analysis_daily_limit` 后通过；Docker 源漂移或目标评分丢失均被拒绝 |
| 源身份集合门禁 | 通过 | 等量替换 `scores`、`shadow_scores` 或 `app_settings` 身份均被拒绝，manifest 只存 SHA-256 |
| Docker restore 单 writer 与认证门禁 | 自动与静态测试通过，live 未执行 | flag=false、native 503、同 Token 原子注入、invalid=401/valid=200、A君库0400均先于 compose up |
| 恢复 native 认证清理 | 自动与静态测试通过，live 未执行 | Docker 停止后 chmod0600、删除 plist Token、flag=true、重启并要求 native 200 |
| Docker 退役 | 未执行 | 等待 A君真实读写与 HTTP 验收 |
| Docker 暂停、最终退役与恢复 | 脚本已提供，未执行 | `pause=stop`；`retire=down` 但保留卷；恢复需重新注入新 Token |
