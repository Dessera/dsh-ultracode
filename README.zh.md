# @dessera/dsh-ultracode

[English](README.md) | 中文

DeepSeek Harness（DSH）的 ultracode 会话模式。它在输入框（composer）里加了一个三档控件，每一档对应一个档位（level）：所选档位决定这个会话按哪一档运行；只要档位不是 `off`，后续回合就能看到 DSH 提供的 workflow 工具，并会收到一段指令块，告诉模型该怎样组织一次 workflow 编排。

- `off` 让会话回到 DSH 原本的样子：插件不再注入任何内容，也不再改动这个会话的任何状态。
- `high` 与 `ultra` 会在开启每个回合的那条消息之后紧接着注入一段开启提示（banner），让模型知道这一回合已获多智能体编排的授权，而不是被强制去编排。只要档位开着，每个回合都会拿到这段提示，无论消息多短、是不是提问。
- 每个档位第一次生效时注入的是完整指令块；此后同一档位的每个回合改为注入一行简短提醒，因此长会话不会每一轮都把整块文本再重复一遍。档位改变时会重新注入完整块，因为两档的差别正是那段文本。
- 档位属于单个会话；宿主重启后，插件从该会话自己的日志里把它恢复出来：先看 `/ultracode` 命令历史，当日志里没有任何档位命令时，再看插件自己注入的那段开启提示。`/ultracode` 用来切换档位，`/ultracode status` 打印当前档位以及该会话能否看到 workflow 工具。
- 插件不碰模型的推理强度（reasoning effort）：那个设置始终是你在输入框里选定的值。开启档位不会把它调高，档位回到 `off` 时也不会把它还原。

## 架构

插件是怎么拼起来的——两半的分工、状态模型、命令集合、两侧之间的通信格式——写在 [docs/architecture.zh.md](docs/architecture.zh.md) 里（英文原件为 [docs/architecture.md](docs/architecture.md)）。

## 支持的 DSH 版本

本包在 `peerDependencies` 里声明自己支持哪些 DSH 版本，落在范围之外的宿主会拒绝加载它。

| 序列          | 已验证版本                       | 说明                                               |
| ------------- | -------------------------------- | -------------------------------------------------- |
| `0.1.5-rc`    | `0.1.5-rc.3`                     | 支持范围里最旧的一档，类型引用也钉在这一档上。     |
| `0.1.6-alpha` | `0.1.6-alpha.1`、`0.1.6-alpha.2` | 这一序列已发布的全部版本；该档宿主不读 peer 要求。 |
| `0.1.7-rc`    | `0.1.7-rc.2`                     | 第一个其宿主真正执行 peer 检查的序列。             |

这行声明对每一档意味着什么、以及怎样加进一个新的版本，写在 [docs/compatibility.zh.md](docs/compatibility.zh.md) 里（英文原件为 [docs/compatibility.md](docs/compatibility.md)）。

## 安装

DSH 从 npm 安装这个插件：

```sh
dsh plugin --profile web add @dessera/dsh-ultracode
```

把 `web` 换成你实际使用的 profile 名称。发布出去的包已经带了构建产物，所以安装过程不执行构建脚本，也不会要求你放行任何东西。如果想停在某一个版本上，可以写明确切版本号，例如 `dsh plugin --profile web add @dessera/dsh-ultracode@0.1.0`，这样部署就一直用这个版本，而不是跟着最新的走。

想试某个还没有发布的提交，就改成从 Git 仓库安装：

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

仓库里只有源码，因此 pnpm 会在安装过程中构建这个插件，并默认拦下这个构建，直到你放行：如果命令报告某个构建脚本被忽略，就把它打印出来的那个键名原样加到该 profile 的 `pnpm-workspace.yaml`（通常位于 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`）里的 `allowBuilds` 下面，然后重新执行同一条命令。

两种装法之后都要重启 DSH 宿主，因为插件在启动时加载；控件会在下一个会话的输入框里出现。

## 构建

构建需要 Node.js 22.19 或更高的 22.x 版本，或者 Node.js 24 及更新版本，另外还需要 pnpm。确切的 pnpm 版本固定在 `packageManager` 字段里，所以用 `corepack pnpm` 就能运行这个指定版本，不需要全局安装。

```sh
pnpm install    # installs dependencies and builds, because the prepare script runs tsdown
pnpm build      # rebuilds after a source change
pnpm format     # rewrites the files Prettier reports
pnpm check      # the full gate: formatting, lint, typecheck, build, tests
pnpm compat     # runs the suite against every supported DSH version
```

`pnpm compat` 会为每一个受支持的 DSH 版本装一份副本，并对着这份副本跑测试套件，因此不需要有人手工安装任何一个版本。

构建产出两个文件：`lib/index.js` 是宿主部分，在 DSH 里以 Node 进程运行；`lib/client.js` 是浏览器部分，由 DSH 加载进它的 Web 客户端。`pnpm test` 可以单独跑这些测试套件；其中打包测试断言的对象是构建产物 `lib/client.js`，所以改动客户端部分后要先构建再测试。

## 持续集成

每次推送到 `main` 以及每个拉取请求都会运行 `.github/workflows/ci.yml`。这个工作流从 `compat/versions.json` 读取受支持的版本，因此没有任何一个任务会把版本号再写一遍。门禁在 Node.js 22.x 与 24.x 上对着最旧的受支持版本执行 `pnpm check`，兼容性任务为每一个受支持版本各跑一遍测试套件，类型检查对着最旧与最新的受支持版本各做一次，另外还有一个任务每天跟随 `next` 与 `alpha`，它不会让整次运行失败。

## 发布

发布到 npm 的版本号是部署端解析的锚点。npm 上的版本一经发布就不能被替换，所以每次发布都要用一个新版本号，并在它所对应的那个提交上打一个 tag。一次发布按下面的顺序进行：

```sh
pnpm check                     # lint、格式检查、类型检查、构建、测试
pnpm version patch             # 升版本号、生成提交、打 vX.Y.Z 注解 tag
git push --follow-tags         # 提交与 tag 一起推上去
pnpm publish                   # 发布的就是已提交的那棵树
```

`pnpm version` 接受 `patch`、`minor`、`major`，也可以直接给一个版本号；它会在自己生成的提交上打一个名为 `vX.Y.Z` 的注解 tag。如果发布流程由别的工具组装，用 `--no-git-tag-version` 把自动提交与自动打 tag 都关掉。`pnpm publish` 要求工作区干净、当前分支是发布分支、并且与远程同步，否则会直接拒绝执行；这条检查保证被 tag 的提交与发布出去的压缩包是同一棵树。首次发布不需要升版本号，因为 `package.json` 里已经写好了版本号：给那个提交打上 tag 再发布，这一次发布就完成了。

预发布版本发布到 `next` 这个 dist-tag，而不是 `latest`：

```sh
pnpm version prerelease --preid beta   # 0.2.0 变成 0.2.0-beta.0
pnpm publish --tag next
```

每次发布都在对应的 GitHub Release 说明里记下它是针对哪一版 DSH 构建和测试的。那次发布支持的版本，就是打 tag 那个提交上的 `compat/versions.json` 所写的内容；`devDependencies` 里的 DSH 包钉在这个文件里最旧的序列上，因此编译器只接受最旧的受支持宿主已经具备的 API。放宽支持范围就是改这一个文件，再加一次跑绿的 `pnpm compat`：peer 范围、持续集成的版本矩阵与上面那张表都由它派生，而如果谁绕过它手写范围，`test/peer-range.test.mjs` 会失败。

## 来源与致谢

这个包建立在两个上游项目之上，两者的 MIT 声明都收在 [LICENSE](LICENSE) 里。

- **`dsh-plugin-template`**（[kun2-5code/dsh-plugin-template](https://github.com/kun2-5code/dsh-plugin-template)）是本包骨架的来源：两个部分的划分方式、构建方式和测试脚手架都来自它。Copyright (c) 2026 dsh-plugin-template authors, MIT licensed.
- **`pi-dynamic-workflows`**（[QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)，npm 上的包名是 [`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)）是本插件所借鉴的设计的来源，`src/host/prompt.ts` 里开启提示与各档位指令的措辞也源自它。该项目延续了 Michael Livs 的原始 `pi-dynamic-workflows`（[Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)）。MIT 许可，含两行版权：Copyright (c) 2026 QuintinShaw，以及 Copyright (c) Michael Livs (original pi-dynamic-workflows)。
