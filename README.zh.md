# @dessera/dsh-ultracode

[English](README.md) | 中文

DeepSeek Harness（DSH）的 ultracode 会话模式。插件在输入框（composer）中加入一个三档控件，分别是 `off`、`high` 与 `ultra`。

## 功能

- `off` 不注入任何内容，会话按 DSH 原本的方式运行。从已开启的档位切回 `off` 之后，该回合会改为携带一段关闭通知。
- `high` 与 `ultra` 在 workflow 工具对该会话可见时开启档位，开启期间每个回合都携带一段开启提示，让模型知道这一回合已获多智能体编排的授权。
- 每个档位第一次生效时携带完整指令块；此后同一档位的每个回合改为携带一行简短提醒。把档位关掉再重新开启时，会重新携带完整块。

dsh-ultracode 提供的命令如下：

| 命令                | 含义                                             |
| ------------------- | ------------------------------------------------ |
| `/ultracode`        | 切换档位                                         |
| `/ultracode status` | 打印当前档位，以及 workflow 工具对该会话是否可见 |

> 插件不改动模型的推理强度（reasoning effort）。

## 架构

插件的整体架构位于 [docs/architecture.zh.md](docs/architecture.zh.md)（英文原件为 [docs/architecture.md](docs/architecture.md)）。

## 安装

从 npm 安装：

```sh
dsh plugin --profile web add @dessera/dsh-ultracode
```

把示例中的 `web` 换成正在运行的 profile 名称。

从 Git 安装：

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

如果 pnpm 报告某个构建脚本被忽略，就把命令打印出来的键名原样加到该 profile 的 `pnpm-workspace.yaml`（通常位于 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`）中的 `allowBuilds` 下面，然后重新执行同一条命令。

## 构建

构建需要：

- Node.js 22.19 及以上的 22.x 版本，或者 Node.js 24 及以上版本
- pnpm

```sh
corepack pnpm install   # 用 corepack 运行 packageManager 中固定的 pnpm 版本，安装依赖并构建
corepack pnpm build     # 源码改动后重新构建
corepack pnpm format    # 按 Prettier 的报告重写文件
corepack pnpm check     # 完整门禁：格式、lint、类型检查、构建、测试
```

构建产出两个文件：`lib/index.js` 是宿主部分，在 DSH 中以 Node 进程运行；`lib/client.js` 是浏览器部分，由 DSH 加载进 Web 客户端。`corepack pnpm test` 单独运行测试；打包测试断言的对象是构建产物 `lib/client.js`，所以改动客户端部分后要先构建再测试。

## 发布

```sh
corepack pnpm check              # 输出：格式、lint、类型检查、构建、测试全部通过
corepack pnpm version patch      # 输出：版本号递增，生成提交与对应的 vX.Y.Z 注解 tag
git push --follow-tags           # 输出：提交与 tag 一起推送到远程
```

执行后，包进入 staged 阶段等待批准。

## 来源与致谢

两个上游项目要求保留的声明都位于 [NOTICE](NOTICE)。

- **`dsh-plugin-template`**（[kun2-5code/dsh-plugin-template](https://github.com/kun2-5code/dsh-plugin-template)）是本包骨架的来源。
- **`pi-dynamic-workflows`**（[QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)）是本插件所借鉴的项目，`src/host/prompt.ts` 中开启提示与各档位指令的措辞取自该项目。
