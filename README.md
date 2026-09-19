# @dessera/dsh-ultracode

English | [中文](README.zh.md)

Ultracode session mode for DeepSeek Harness (DSH). It adds a three-position control to the composer, where each position selects one level the session runs at. A level other than `off` makes the workflow tool DSH provides available to the turns that follow, and injects an instruction block that tells the model how to shape a workflow run.

- `off` leaves a session exactly as DSH ships it: nothing is injected, and the plugin stops changing anything about the session.
- `high` and `ultra` inject an arming banner directly after the user's own message, so the model learns that the turn is authorised for multi-agent orchestration rather than being forced into it.
- The level belongs to one session and is recovered after a host restart from that session's own log: from its `/ultracode` command history, or, while that log carries no level command, from the banner message the plugin itself injected. `/ultracode` advances the level, and `/ultracode status` prints the level and whether the workflow tool is visible to the session.
- The plugin never touches the model's reasoning effort. That setting stays whatever you chose in the composer: arming a level neither raises it, nor restores it when the level goes back to `off`.

## Architecture

How the plugin is put together — the two parts, the state model, the command set, and the format the two
sides exchange — is described in [docs/architecture.md](docs/architecture.md).

## Install

The package is private and is not published to npm, so DSH installs it straight from its Git repository:

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

Replace `web` with the name of the profile you run. The repository carries sources only, so pnpm builds the plugin while installing it. pnpm blocks that build until it is allowed: if the command reports an ignored build script, add the exact key it printed under `allowBuilds` in the profile's `pnpm-workspace.yaml` (normally `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`) and run the same command again. Restart the DSH host afterwards, because plugins are loaded at startup, and the control then appears in the composer of the next session.

## Build

A checkout builds with Node.js 22.19 or newer on the 22.x line, or with Node.js 24 and newer, and with pnpm. The exact pnpm version is fixed in `packageManager`, so `corepack pnpm` runs that version without a global install.

```sh
pnpm install    # installs dependencies and builds, because the prepare script runs tsdown
pnpm build      # rebuilds after a source change
pnpm check      # the full gate: lint, typecheck, build, tests
```

The build writes two artifacts: `lib/index.js` is the host part, which runs in Node inside DSH, and `lib/client.js` is the browser part, which DSH loads into its web client. `pnpm test` runs the suites on their own, and the bundle tests assert against the built `lib/client.js`, so build before testing a change to the client part.

## Sources and acknowledgements

This package is written from two upstream projects, and the MIT notice of each one is carried in [LICENSE](LICENSE).

- **`dsh-plugin-template`** ([kun2-5code/dsh-plugin-template](https://github.com/kun2-5code/dsh-plugin-template)) is the template this package's skeleton derives from: the two-part layout, the build and the test scaffolding. Copyright (c) 2026 dsh-plugin-template authors, MIT licensed.
- **`pi-dynamic-workflows`** ([QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows), published as [`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)) is the source of the design this plugin adapts, and the phrasing of the arming banner and the level instructions in `src/host/prompt.ts` derives from it. That project continues the original `pi-dynamic-workflows` by Michael Livs ([Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)). MIT licensed, under two copyright lines: Copyright (c) 2026 QuintinShaw, and Copyright (c) Michael Livs (original pi-dynamic-workflows).
