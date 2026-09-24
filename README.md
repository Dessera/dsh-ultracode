# @dessera/dsh-ultracode

English | [中文](README.zh.md)

Ultracode session mode for DeepSeek Harness (DSH). It adds a three-position control to the composer, where each position selects one level the session runs at. A level other than `off` makes the workflow tool DSH provides available to the turns that follow, and injects an instruction block that tells the model how to shape a workflow run.

- `off` leaves a session exactly as DSH ships it: nothing is injected, and the plugin stops changing anything about the session.
- `high` and `ultra` inject an arming banner directly after the message that opens each turn, so the model learns that the turn is authorised for multi-agent orchestration rather than being forced into it. Every armed turn carries the banner, however short its message is and whether or not it is a question.
- The first turn of a level carries the complete instruction block; every turn after that carries a one-line reminder instead, so a long session does not repeat the whole block on every request. Changing the level states the block again, because the block is exactly what differs between the two levels.
- The level belongs to one session and is recovered after a host restart from that session's own log: from its `/ultracode` command history, or, while that log carries no level command, from the banner message the plugin itself injected. `/ultracode` advances the level, and `/ultracode status` prints the level and whether the workflow tool is visible to the session.
- The plugin never touches the model's reasoning effort. That setting stays whatever you chose in the composer: arming a level neither raises it, nor restores it when the level goes back to `off`.

## Architecture

How the plugin is put together — the two parts, the state model, the command set, and the format the two
sides exchange — is described in [docs/architecture.md](docs/architecture.md).

## Supported DSH versions

The package declares the DSH versions it supports in `peerDependencies`, and a
host refuses to load it on a version outside that range.

| Series        | Verified versions                | Notes                                                                               |
| ------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `0.1.5-rc`    | `0.1.5-rc.3`                     | The oldest supported series, and the one the type references are pinned to.         |
| `0.1.6-alpha` | `0.1.6-alpha.1`, `0.1.6-alpha.2` | Every published version of the series; its host does not read the peer requirement. |
| `0.1.7-rc`    | `0.1.7-rc.2`                     | The first series whose host enforces the peer requirement.                          |

[docs/compatibility.md](docs/compatibility.md) explains what the declaration means
for each series, and describes how to add support for another version.

## Install

DSH installs the plugin from npm:

```sh
dsh plugin --profile web add @dessera/dsh-ultracode
```

Replace `web` with the name of the profile you run. The published package carries the built artifacts, so installing it runs no build script and asks for no permission. Naming an exact version, as in `dsh plugin --profile web add @dessera/dsh-ultracode@0.1.0`, holds a deployment at one release instead of following whatever is newest.

To try a commit that has not been released yet, install from the Git repository instead:

```sh
dsh plugin --profile web add github:Dessera/dsh-ultracode
```

That checkout carries sources only, so pnpm builds the plugin while installing it, and pnpm blocks that build until it is allowed: if the command reports an ignored build script, add the exact key it printed under `allowBuilds` in the profile's `pnpm-workspace.yaml` (normally `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`) and run the same command again.

Restart the DSH host after either install, because plugins are loaded at startup; the control then appears in the composer of the next session.

## Build

A checkout builds with Node.js 22.19 or newer on the 22.x line, or with Node.js 24 and newer, and with pnpm. The exact pnpm version is fixed in `packageManager`, so `corepack pnpm` runs that version without a global install.

```sh
pnpm install    # installs dependencies and builds, because the prepare script runs tsdown
pnpm build      # rebuilds after a source change
pnpm format     # rewrites the files Prettier reports
pnpm check      # the full gate: formatting, lint, typecheck, build, tests
pnpm compat     # runs the suite against every supported DSH version
```

`pnpm compat` installs a copy of each supported DSH version and runs the test
suite against that copy, so no version has to be installed by hand.

The build writes two artifacts: `lib/index.js` is the host part, which runs in Node inside DSH, and `lib/client.js` is the browser part, which DSH loads into its web client. `pnpm test` runs the suites on their own, and the bundle tests assert against the built `lib/client.js`, so build before testing a change to the client part.

## Continuous integration

Every push to `main` and every pull request runs `.github/workflows/ci.yml`. The
workflow reads the supported versions from `compat/versions.json`, so no job
restates a version number. The gate runs `pnpm check` on Node.js 22.x and 24.x
against the oldest supported version, the compatibility jobs run the test suite
once for each supported version, the type check runs against the oldest and the
newest supported versions, and one job per day follows the `next` and `alpha`
releases without failing the run.

## Release

The version published to npm is the anchor a deployment resolves, and npm never lets a published version be replaced, so every release takes a new number and a tag on the commit it was built from. A release runs in this order:

```sh
pnpm check                     # lint, format check, typecheck, build, tests
pnpm version patch             # bumps the version, commits it, tags vX.Y.Z
git push --follow-tags         # the commit and its tag travel together
pnpm publish                   # publishes the tree that was committed
```

`pnpm version` accepts `patch`, `minor`, `major`, or an explicit version, and puts an annotated tag named `vX.Y.Z` on the commit it creates. `--no-git-tag-version` skips both the commit and the tag, for a release assembled by other means. `pnpm publish` refuses to run unless the working tree is clean, the checkout is on the publish branch, and it is level with its remote; that check is what keeps the tagged commit and the published tarball the same tree. The first release needs no bump, because `package.json` already carries its version: tagging that commit and publishing it is the whole release.

A prerelease goes to the `next` dist-tag rather than `latest`:

```sh
pnpm version prerelease --preid beta   # 0.2.0 becomes 0.2.0-beta.0
pnpm publish --tag next
```

Each release records the DSH version it was built and tested against, in the notes of its GitHub Release. The version that release supports is whatever `compat/versions.json` said at the tagged commit, and the DSH packages in `devDependencies` are pinned at the oldest series in it, so the compiler only accepts the API that the oldest supported host already has. Widening support is an edit to that one file plus a green `pnpm compat` run: the peer range, the continuous integration matrix and the table above all derive from it, and `test/peer-range.test.mjs` fails if the range is written by hand instead.

Those notes are not written by hand. `.github/workflows/release.yml` writes them, run from the Actions tab with the tag as its input: it reads the supported DSH versions out of the tagged tree — `compat/versions.json` when the tag carries one, and the harness version that tree pins for a tag older than that file — reads the published tarball's integrity back from the registry, and writes the Release. `test/release-notes.test.mjs` pins what the notes say. Run it once per tag.

Publishing itself is still the hand step above. The workflow carries a publishing path of its own — it runs the gate, publishes the tarball it built, and attaches that tarball and the compatibility report to the Release — and that path is not enabled yet.

## Sources and acknowledgements

This package is written from two upstream projects, and the MIT notice of each one is carried in [LICENSE](LICENSE).

- **`dsh-plugin-template`** ([kun2-5code/dsh-plugin-template](https://github.com/kun2-5code/dsh-plugin-template)) is the template this package's skeleton derives from: the two-part layout, the build and the test scaffolding. Copyright (c) 2026 dsh-plugin-template authors, MIT licensed.
- **`pi-dynamic-workflows`** ([QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows), published as [`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)) is the source of the design this plugin adapts, and the phrasing of the arming banner and the level instructions in `src/host/prompt.ts` derives from it. That project continues the original `pi-dynamic-workflows` by Michael Livs ([Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)). MIT licensed, under two copyright lines: Copyright (c) 2026 QuintinShaw, and Copyright (c) Michael Livs (original pi-dynamic-workflows).
