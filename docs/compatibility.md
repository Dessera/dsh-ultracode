# DSH version compatibility

English | [中文](compatibility.zh.md)

`@dessera/dsh-ultracode` declares which DSH versions it supports. This document
lists those versions, explains what the declaration does, describes how to check a
version and how to add one, and states what the checks can and cannot tell you.

## The supported versions

| Series        | Verified versions                | Notes                                                                               |
| ------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `0.1.5-rc`    | `0.1.5-rc.3`                     | The oldest supported series, and the one the type references are pinned to.         |
| `0.1.6-alpha` | `0.1.6-alpha.1`, `0.1.6-alpha.2` | Every published version of the series; its host does not read the peer requirement. |
| `0.1.7-rc`    | `0.1.7-rc.2`                     | The first series whose host enforces the peer requirement.                          |

The declared range has one branch for each series, joined by `||`. A branch starts
at the oldest version of that series that has been tested, and it includes every
later release of the same series. A version older than a branch's start, and a
version of a series that the file does not list, are refused.

## What the declaration does

The range is declared in `package.json`:

```json
{
    "peerDependencies": {
        "@deepseek-ai/dsh": ">=0.1.5-rc.3 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-rc.2 <0.1.8-0"
    }
}
```

A DSH host reads this field before it loads the plugin, and it compares the version
it is running with every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` entry it finds
there. When the running version is outside the range, the host refuses the plugin:
an installation fails and reports the mismatch, and a host that already carries the
plugin refuses to load it at startup. If you have decided to accept the risk
anyway, the command `dsh plugin allow-version` records an exemption for that plugin
version and that host version, and the host then loads the plugin.

Two properties of version numbers decide how the range above is written.

- A prerelease number is lower than the final release of the same version.
  Therefore `^0.1.5` does not include `0.1.5-rc.3`, and a branch that should start
  at a prerelease has to name that prerelease, as `>=0.1.5-rc.3` does.
- A prerelease of a later version is lower than that later version. Therefore
  `<0.1.8` includes `0.1.8-alpha.1`, and an upper bound that should exclude the next
  series has to add `-0`, as `<0.1.8-0` does.

A host performs this check only from version `0.1.7-rc.1` onward. On `0.1.5-rc` and
`0.1.6-alpha` hosts the plugin is loaded whether or not the range matches, so the
declaration protects newer hosts only.

## Where the list comes from

`compat/versions.json` holds the supported series and the tested version of each
one. Three things are generated from that file, and none of them repeats a version
number:

| Generated from the file | Where it appears                     | Who reads it                         |
| ----------------------- | ------------------------------------ | ------------------------------------ |
| The declared range      | `peerDependencies` in `package.json` | The host, before it loads the plugin |
| The version list        | The continuous integration jobs      | One job for each supported version   |
| The supported table     | Both READMEs and this document       | A person deciding whether to install |

One test keeps the three in step. `test/peer-range.test.mjs` fails in four cases:
the declared range differs from the range generated from `compat/versions.json`;
the range refuses a version that the file lists; the range accepts a version that is
older than the oldest listed version of a supported series, or that belongs to a
series the file does not list; or a document that carries the table is missing a
version.

## Running the checks

```sh
pnpm compat            # run the test suite against every supported version
pnpm compat --type     # also check the types against the ends of the range
pnpm compat --offline  # use the cached copies only
```

The runner installs a copy of the harness for each version under a cache directory
(`DSH_COMPAT_CACHE`, by default `%LOCALAPPDATA%\dsh-compat` on Windows and
`~/.cache/dsh-compat` on other platforms), points `DSH_HOME` at that copy, and runs
this repository's test suite against it. No version has to be installed by hand.

Two details make the result trustworthy. The runner reports the version it actually
read, so a run cannot silently check a different version from the one it was asked
for. And it stops with an error if the harness was resolved from outside the
directory it installed, because Node resolves a package name by searching each
parent directory in turn, which would otherwise let a run read the DSH installation
on the machine and report success for a version that was never installed.

| Option          | Effect                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--version <v>` | Runs the checks against one version. A version that is not in `compat/versions.json` can be named here, which is how a candidate version is tested before it is added. |
| `--heads`       | Also resolves the `next` and `alpha` tags from npm and runs the checks against those versions. Their results are reported but never fail the run.                      |
| `--type`        | Also runs the type check against the versions at the two ends of the supported range.                                                                                  |
| `--offline`     | Uses only the cached copies, and fails if one is missing.                                                                                                              |
| `--json`        | Writes the report to standard output as JSON, and progress messages to standard error.                                                                                 |
| `--update`      | Writes the results of this run to `compat/matrix.json`.                                                                                                                |
| `--list`        | Writes the plan. Together with `--json` it also writes the version list and the versions at the two ends of the range, which the continuous integration jobs read.     |

The exit code is `0` when every supported version passed, `1` when a supported
version or a type check failed, and `2` when the runner could not start.

## Adding a newer version

1. **Test the candidate before changing anything.** The runner installs and tests a
   version that `compat/versions.json` does not list, and reports it as `unlisted`:

    ```sh
    pnpm compat --version 0.1.8-rc.1
    ```

    A passing result means that the plugin's contracts and its own test suite hold
    on that version. A failing result means that something changed upstream; see
    "When a check fails" below.

2. **Check that every harness package exists at that version.** The copy is
   installed at exact versions, so one package that was never published at that
   version prevents the whole installation. The runner names the package that is
   missing when this happens.

3. **Add the version to `compat/versions.json`.** A version of a series that is
   already listed goes into that series' `versions` array, oldest first. A new
   series becomes another entry in `series`, named after its numeric part:

    ```json
    { "name": "0.1.8-rc", "versions": ["0.1.8-rc.1"], "blocking": true }
    ```

    The name and the versions in the entry have to share that numeric part; an
    entry where they do not is refused when the file is read.

4. **Rewrite the declared range in `package.json`.** The generator prints exactly
   the string to write:

    ```sh
    node -e "import('./compat/plan.mjs').then(m=>console.log(m.peerRangeOf(m.readPlan().series)))"
    ```

    Step 6 finds the same string if this step is skipped: `pnpm check` fails and
    reports the expected range.

5. **Add the version to the tables** in both READMEs and in this document.

6. **Run `pnpm compat`, then `pnpm check`.** The continuous integration jobs, the
   type checks and the version the main gate runs against all follow
   `compat/versions.json`, so none of them needs to be edited.

7. **Publish a release.** A host acts on the declaration in the installed package,
   so the supported range only changes for users once a new version of this package
   is published.

## Raising the oldest supported version

The type references in `devDependencies` are pinned at the oldest supported
version, which is what makes the compiler reject any API that this version does not
publish. Dropping that version therefore means moving the references as well:

1. Point every `@deepseek-ai/dsh*` entry in `devDependencies` at the new oldest
   version, and run `pnpm install`.
2. Run `pnpm compat --type`. If it fails, the source code names an API that the new
   oldest version does not publish. Change the code so that it works with both
   versions, or keep the supported range as it is.
3. Follow the steps in the previous section, because the list of series changed too.

## Upgrading DSH on one machine

This is an action on the machine rather than in this repository. Upgrade the DSH
installation and restart the host; the declaration is checked while the plugin
loads. A host whose version is outside the range refuses the plugin, and
`dsh plugin allow-version` records an exemption for that machine. The alternative
is to support that version here and publish a release, which is the procedure in
"Adding a newer version".

## When a check fails

- **The contract probe reports a missing name.** A service key, seat name, seat
  property, log event or browser name that the plugin uses no longer exists under
  that name. Either change the plugin so that it works with both the old and the
  new name, or stop claiming that version.
- **The type check fails.** A type declaration changed between the oldest and the
  newest supported version. If the source code can be written in a way that suits
  both, the range can stay as it is; if it cannot, the range has to be narrowed.
- **A documentation test fails.** A table was not updated, or the declared range was
  edited by hand instead of being generated.
- **The copy of a version cannot be installed.** Either that version does not
  publish every package that the probe reads, or npm refuses the peer requirements
  of the packages it is asked to install. The runner reports which of the two
  happened.

## What the checks establish

The checks establish two things. Every service, seat, event and browser name that
the plugin uses still exists under that name in every supported version; and the
source code still compiles against the type declarations of both the oldest and the
newest supported version.

The checks do not establish that a name still refers to the same behaviour. If a
future host keeps the service name but changes what one of its methods does, every
check in this repository passes, and the plugin can still behave incorrectly while a
session runs. Finding that kind of change requires using the plugin in a session.
The type check verifies more than names do, because it also compares the plugin's
code with the declared types, but it covers only the two versions at the ends of the
range.
