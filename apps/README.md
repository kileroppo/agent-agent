# Apps

这里存放可运行产品、业务 Agent 和受控配套工具。历史资产只有在仍承担已验证回滚协议时才允许
暂留，并必须在根 [`repository-catalog.json`](../repository-catalog.json) 中标记为
`legacy-rollback`，不得重新进入 Workspace。

每个应用应拥有自己的依赖、配置示例、启动方式、测试和 README。只有形成明确业务闭环的能力才进入这里；岗位说明和权限策略放在 `agents/`，跨应用共享代码放在 `packages/`。

当前应用：

- [A君运行台](./ajun-runtime/README.md)：正式产品运行时；本机能力网关、Paperclip 执行适配、诊断与恢复，不承担军团总控。
- [小D](./xiaod-media-transcriber/README.md)：正式业务 Agent；音视频获取、转录、整理与飞书文档交付。
- [Mac Worker](./mac-worker/README.md)：受控运行桥；私人云向 Mac 发起出站领取，不暴露入站控制口。
- [项目进度看板](./project-progress-board/README.md)：按需内部工具，不保存军团任务真相。
- [M5 Remotion 渲染](./animated-chart/README.md)：按需交付工具，只接受受控内容工作区输入。
- [旧 Boom Monitor](./boom-monitor/README.md)：仅保留迁移和回滚，不是正式产品或 Workspace。

完整分类、生命周期和入口见 [仓库产品地图](../docs/product/repository-map.md)。
