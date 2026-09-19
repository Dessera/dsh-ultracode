# @dessera/dsh-ultracode

[English](README.md) | 中文

DeepSeek Harness（DSH）的 ultracode 会话模式。它在输入框（composer）里加了一个三档控件，每一档对应一个档位（level）：所选档位决定这个会话按哪一档运行；只要档位不是 `off`，后续回合就能看到 DSH 提供的 workflow 工具，并会收到一段指令块，告诉模型该怎样组织一次 workflow 编排。

- `off` 让会话回到 DSH 原本的样子：插件不再注入任何内容，也不再改动这个会话的任何状态。
- `high` 与 `ultra` 会在用户自己的消息之后紧接着注入一段开启提示（banner），让模型知道这一回合已获多智能体编排的授权，而不是被强制去编排。
- 档位属于单个会话；宿主重启后，插件从该会话自己的日志里把它恢复出来：先看 `/ultracode` 命令历史，当日志里没有任何档位命令时，再看插件自己注入的那段开启提示。`/ultracode` 用来切换档位，`/ultracode status` 打印当前档位以及该会话能否看到 workflow 工具。
- 插件不碰模型的推理强度（reasoning effort）：那个设置始终是你在输入框里选定的值。开启档位不会把它调高，档位回到 `off` 时也不会把它还原。

## 架构

插件是怎么拼起来的——两半的分工、状态模型、命令集合、两侧之间的通信格式——写在 [docs/architecture.zh.md](docs/architecture.zh.md) 里（英文原件为 [docs/architecture.md](docs/architecture.md)）。

## 安装

这个包是私有的，没有发布到 npm，所以 DSH 直接从它的 Git 仓库安装：

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

把 `web` 换成你实际使用的 profile 名称。仓库里只有源码，因此 pnpm 会在安装过程中构建这个插件。pnpm 默认拦下这个构建，直到你放行：如果命令报告某个构建脚本被忽略，就把它打印出来的那个键名原样加到该 profile 的 `pnpm-workspace.yaml`（通常位于 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`）里的 `allowBuilds` 下面，然后重新执行同一条命令。之后要重启 DSH 宿主，因为插件在启动时加载；控件会在下一个会话的输入框里出现。

## 构建

构建需要 Node.js 22.19 或更高的 22.x 版本，或者 Node.js 24 及更新版本，另外还需要 pnpm。确切的 pnpm 版本固定在 `packageManager` 字段里，所以用 `corepack pnpm` 就能运行这个指定版本，不需要全局安装。

```sh
pnpm install    # installs dependencies and builds, because the prepare script runs tsdown
pnpm build      # rebuilds after a source change
pnpm format     # rewrites the files Prettier reports
pnpm check      # the full gate: formatting, lint, typecheck, build, tests
```

构建产出两个文件：`lib/index.js` 是宿主部分，在 DSH 里以 Node 进程运行；`lib/client.js` 是浏览器部分，由 DSH 加载进它的 Web 客户端。`pnpm test` 可以单独跑这些测试套件；其中打包测试断言的对象是构建产物 `lib/client.js`，所以改动客户端部分后要先构建再测试。

## 持续集成

每次推送到 `main` 以及每个拉取请求都会运行 `.github/workflows/ci.yml`：它在 Node.js 22.x 与 24.x 上执行 `pnpm check`。运行器上本来没有 DSH 安装，所以这一趟还会按本仓库固定的版本，装好 `test/contract-probe.test.mjs` 所校验的那套宿主。

## 来源与致谢

这个包建立在两个上游项目之上，两者的 MIT 声明都收在 [LICENSE](LICENSE) 里。

- **`dsh-plugin-template`**（[kun2-5code/dsh-plugin-template](https://github.com/kun2-5code/dsh-plugin-template)）是本包骨架的来源：两个部分的划分方式、构建方式和测试脚手架都来自它。Copyright (c) 2026 dsh-plugin-template authors, MIT licensed.
- **`pi-dynamic-workflows`**（[QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)，npm 上的包名是 [`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)）是本插件所借鉴的设计的来源，`src/host/prompt.ts` 里开启提示与各档位指令的措辞也源自它。该项目延续了 Michael Livs 的原始 `pi-dynamic-workflows`（[Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)）。MIT 许可，含两行版权：Copyright (c) 2026 QuintinShaw，以及 Copyright (c) Michael Livs (original pi-dynamic-workflows)。
