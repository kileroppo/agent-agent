# M5 Contracts

跨 A君、M5 Kernel、Paperclip 内容插件和 Publisher 使用的纯领域契约与稳定标识。这里只放两个以上
真实消费者共同依赖的不变量，不放平台 SDK、网络、文件、进程或凭据读取能力。

公开 Interface 是 `src/index.ts`。

```bash
cd packages/m5-contracts
npm test
npm run check
```

若规则只属于一个 Adapter，应留在该 Adapter 的 Implementation 中，不得为了目录整齐提前共享。
