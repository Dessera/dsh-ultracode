# @dessera/dsh-ultracode

English | [中文](README.zh.md)

Ultracode session mode for DeepSeek Harness (DSH). The plugin adds a three-position control to the composer: `off`, `high`, and `ultra`.

## Features

- `off` injects nothing, and the session keeps running as DSH ships it. The turn after a level is turned off carries one notice instead.
- `high` and `ultra` arm the session while the workflow tool DSH provides resolves for that session, and every turn the session opens then carries an arming banner that tells the model the turn is authorised for multi-agent orchestration.
- The first turn of a level carries the complete instruction block; every turn after that carries a one-line reminder instead. Turning the level off and arming it again states the block again.

The plugin provides these commands:

| Command             | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `/ultracode`        | Advances the level                                                               |
| `/ultracode status` | Prints the current level and whether the workflow tool is visible to the session |

> The plugin never changes the model's reasoning effort.

## Architecture

The overall architecture of the plugin is in [docs/architecture.md](docs/architecture.md).

## Supported DSH versions

| Series        | Verified versions                |
| ------------- | -------------------------------- |
| `0.1.5-rc`    | `0.1.5-rc.3`                     |
| `0.1.6-alpha` | `0.1.6-alpha.1`, `0.1.6-alpha.2` |
| `0.1.7-rc`    | `0.1.7-rc.2`                     |

## Install

Install from npm:

```sh
dsh plugin --profile web add @dessera/dsh-ultracode
```

Replace `web` with the name of the profile in use.

Install from Git:

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

If pnpm reports an ignored build script, add the exact key it printed under `allowBuilds` in the profile's `pnpm-workspace.yaml` (normally `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`) and run the same command again.

## Build

A build needs:

- Node.js 22.19 or newer within the 22.x line, or Node.js 24 or newer
- pnpm

```sh
corepack pnpm install   # runs the pnpm version pinned in packageManager, installs dependencies and builds
corepack pnpm build     # rebuilds after a source change
corepack pnpm format    # rewrites the files Prettier reports
corepack pnpm check     # the full gate: formatting, lint, typecheck, build, tests
corepack pnpm compat    # runs the suite against every supported DSH version
```

The build writes two artifacts: `lib/index.js` is the host part, which runs in Node inside DSH, and `lib/client.js` is the browser part, which DSH loads into the web client. `corepack pnpm test` runs the tests on their own, and the bundle tests assert against the built `lib/client.js`, so build before testing a change to the client part.

## Release

```sh
corepack pnpm check              # the gate passes: formatting, lint, typecheck, build, tests
corepack pnpm version patch      # the version is bumped, and a commit carrying the annotated tag vX.Y.Z is created
git push --follow-tags           # the commit and its tag are pushed to the remote
```

After the run, the package is staged and waits for approval.

## Sources and acknowledgements

The notices the two upstream projects require are in [NOTICE](NOTICE).

- **`dsh-plugin-template`** ([kun2-5code/dsh-plugin-template](https://github.com/kun2-5code/dsh-plugin-template)) is the template this package's skeleton comes from.
- **`pi-dynamic-workflows`** ([QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)) is the project whose phrasing of the arming banner and the level instructions in `src/host/prompt.ts` this plugin adapts.
