# Remotion video

<p align="center">
  <a href="https://github.com/remotion-dev/logo">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-dark.apng">
      <img alt="Animated Remotion Logo" src="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-light.gif">
    </picture>
  </a>
</p>

Welcome to your Remotion project!

## Commands

**Install Dependencies**

```console
npm i
```

**Start Preview**

```console
npm run dev
```

**Render video**

```console
npx remotion render
```

**M5 controlled render**

M5 内容插件只通过 `scripts/render-m5-controlled.mjs` 调用现有
`M5Master`、`M5Douyin`、`M5Xiaohongshu` Composition。脚本只接受固定参数，
要求 props、素材和输出都位于同一个 Paperclip `content-workspace`，并拒绝任意
Composition、命令或越界路径。日常调用应通过内容插件的 `remotion-render` 工具，
不要直接把该脚本开放给岗位。

真实 7 主题 StepFun 账本在渲染前可做零渲染预检；恢复成功账本允许
`totalProviderCalls + confirmedReplay = 35`，但必须保留 35 个逻辑 action、
35 个零调用幂等 replay 回执：

```console
npm run preflight:m5-stepfun -- /absolute/path/to/ledger.json
```

**Upgrade Remotion**

```console
npx remotion upgrade
```

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## Help

We provide help on our [Discord server](https://discord.gg/6VzzNDwUwV).

## Issues

Found an issue with Remotion? [File an issue here](https://github.com/remotion-dev/remotion/issues/new).

## License

Note that for some entities a company license is needed. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
