# 项目进度看板

局域网使用的多项目进度 H5。项目、阶段和任务保存在本机 SQLite，项目看板是主要维护入口，文档和 Git 可作为关联信息补充。

## 运行

```bash
cd apps/project-progress-board
npm run dev
```

默认访问 `http://127.0.0.1:4320`。局域网其他设备访问运行机器的局域网 IP 和 `4320` 端口。

数据文件默认在 `data/progress-board.sqlite`，可通过 `PROGRESS_BOARD_DB` 指定测试或其他本地位置。服务默认监听 `0.0.0.0`，不包含登录和公网部署能力。

## 检查

```bash
npm test
```
