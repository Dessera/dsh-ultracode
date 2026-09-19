# @dessera/dsh-ultracode

Ultracode session mode for DeepSeek Harness (DSH). It adds a three-position control to the composer: the position selects the level a session runs at, and an armed level makes the workflow tool DSH provides available to the turns that follow while pinning the session to the strongest reasoning effort the current model reports.

- `off` leaves a session exactly as DSH ships it, and restores the effort the session was running before the first arming.
- `high` and `ultra` inject an arming banner ahead of the user's own message, so the model learns that the turn is authorised for multi-agent orchestration rather than being forced into it.
- The level belongs to one session and is recovered from that session's own command history after a host restart. `/ultracode` advances the level, `/ultracode status` prints the level and whether the current turn is armed, and `/ultracode clear` drops the armed marker of the current turn.

## Install

The package is private and is not published to npm, so DSH installs it straight from its Git repository:

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

Replace `web` with the name of the profile you run. The repository carries sources only, so pnpm builds the plugin while installing it. pnpm blocks that build until it is allowed: if the command reports an ignored build script, add the exact key it printed under `allowBuilds` in the profile's `pnpm-workspace.yaml` (normally `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`) and run the same command again. Restart the DSH host afterwards, because plugins are loaded at startup, and the control then appears in the composer of the next session.

## Build

A checkout builds with Node.js 22.19 or newer, or Node.js 24 and newer, and with pnpm. The exact pnpm version is pinned in `packageManager`, so `corepack pnpm` runs the pinned one without a global install.

```sh
pnpm install    # installs dependencies and builds, because the prepare script runs tsdown
pnpm build      # rebuilds after a source change
pnpm check      # the full gate: lint, typecheck, build, tests
```

The build writes two artifacts: `lib/index.js` is the host half, which runs in Node inside DSH, and `lib/client.js` is the browser half, which DSH loads into its web client. `pnpm test` runs the suites on their own, and the bundle tests assert against the built `lib/client.js`, so build before testing a change to the client half.
