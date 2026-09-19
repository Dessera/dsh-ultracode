# @dessera/dsh-ultracode

Ultracode session mode for DeepSeek Harness (DSH). It adds a three-position control to the composer: the position selects the level a session runs at, and an armed level makes the workflow tool DSH provides available to the turns that follow while pinning the session's requests to the strongest reasoning effort the model reports when the level is armed.

- `off` leaves a session exactly as DSH ships it, and restores the effort the session was running before the first arming; when a host restart has discarded that baseline, the release clears the effort field instead, so the request falls back to the model's own default.
- `high` and `ultra` inject an arming banner directly after the user's own message, so the model learns that the turn is authorised for multi-agent orchestration rather than being forced into it.
- The level belongs to one session and is recovered after a host restart from that session's own log: from its `/ultracode` command history, or, while that log carries no level command, from the banner message the plugin itself injected. `/ultracode` advances the level, and `/ultracode status` prints the level and whether the workflow tool is visible to the session.

## Architecture

How the plugin is put together — the two halves, the state model, the command surface, the wire
contract, the effort pin and its limits — is described in [docs/architecture.md](docs/architecture.md).

## Install

The package is private and is not published to npm, so DSH installs it straight from its Git repository:

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

Replace `web` with the name of the profile you run. The repository carries sources only, so pnpm builds the plugin while installing it. pnpm blocks that build until it is allowed: if the command reports an ignored build script, add the exact key it printed under `allowBuilds` in the profile's `pnpm-workspace.yaml` (normally `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`) and run the same command again. Restart the DSH host afterwards, because plugins are loaded at startup, and the control then appears in the composer of the next session.

## Build

A checkout builds with Node.js 22.19 or newer within the 22 line, or with Node.js 24 and newer, and with pnpm. The exact pnpm version is pinned in `packageManager`, so `corepack pnpm` runs the pinned one without a global install.

```sh
pnpm install    # installs dependencies and builds, because the prepare script runs tsdown
pnpm build      # rebuilds after a source change
pnpm check      # the full gate: lint, typecheck, build, tests
```

The build writes two artifacts: `lib/index.js` is the host half, which runs in Node inside DSH, and `lib/client.js` is the browser half, which DSH loads into its web client. `pnpm test` runs the suites on their own, and the bundle tests assert against the built `lib/client.js`, so build before testing a change to the client half.
