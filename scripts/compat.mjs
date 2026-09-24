#!/usr/bin/env node
/**
 * Cross-version compatibility runner.
 *
 * One command provisions a harness per supported DSH version and runs the whole
 * suite against each of them, so the question "does this plugin still work on
 * the other version series?" is answered by a machine rather than by somebody
 * installing a host by hand. The continuous integration workflow calls this same
 * script, which is what keeps a local verdict and a runner verdict comparable.
 *
 * Each version gets its own `DSH_HOME`-shaped directory under a cache root, and
 * the suite inside that directory runs with `DSH_EXPECT_HARNESS_VERSION` set, so
 * the contract probe reports the harness it read and refuses one it was not
 * asked for.
 *
 * Options: `--version`, `--heads`, `--type`, `--offline`, `--json`, `--update`,
 * `--list`, `--help`. Exit codes: 0 every blocking version passed, 1 a blocking
 * version or type leg failed, 2 the runner itself could not proceed.
 *
 * @module @dessera/dsh-ultracode/scripts/compat
 */
import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    boundariesOf,
    entryOf,
    matrixOf,
    PLAN_PATH,
    readPlan,
} from "../compat/plan.mjs";
import {
    harnessPackages,
    SENTINEL,
} from "../test/support/harness-contract.mjs";
import { findPackageWithin } from "../test/support/host-loader.mjs";

/** Repository root, one level above this script. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Suite pattern every leg runs. */
const SUITE = "test/*.test.mjs";

/** Where a run records what it verified, written only under `--update`. */
const MATRIX_PATH = join(ROOT, "compat", "matrix.json");

/** The npm and pnpm executables, as this platform spells them. */
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/** A failure of the runner itself, as opposed to a failing version. */
class RunnerError extends Error {}

/** Quote one argument for the shell this platform uses. */
function quoteArg(value) {
    return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/**
 * Run one program.
 *
 * A package manager on Windows is a `.cmd` shim, which this Node refuses to spawn
 * without a shell, so the command goes through one by default. A program invoked
 * by absolute path is spawned directly instead: a command string that begins with
 * a quoted path loses its leading quote on the way through `cmd.exe`.
 * @param program - executable name or path.
 * @param args - arguments, quoted as needed when a shell parses them.
 * @param options - `spawnSync` options, plus `shell` to override the default.
 * @returns the finished child process.
 */
function runProgram(program, args, options = {}) {
    const { shell = process.platform === "win32", ...rest } = options;
    if (!shell)
        return spawnSync(program, args, {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            ...rest,
        });
    const command = [program, ...args.map(quoteArg)].join(" ");
    return spawnSync(command, {
        shell: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        ...rest,
    });
}

/**
 * The cache root holding one directory per provisioned version.
 * @returns an absolute path, from `DSH_COMPAT_CACHE` when it is set.
 */
function cacheRoot() {
    if (process.env.DSH_COMPAT_CACHE)
        return resolve(process.env.DSH_COMPAT_CACHE);
    if (process.platform === "win32" && process.env.LOCALAPPDATA)
        return join(process.env.LOCALAPPDATA, "dsh-compat");
    return join(
        process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
        "dsh-compat",
    );
}

/** The `DSH_HOME` a leg for one version runs under. */
function homeOf(version) {
    return join(cacheRoot(), version);
}

/** The profile directory a leg for one version runs under. */
function anchorOf(version) {
    return join(homeOf(version), "profiles", "web");
}

/**
 * Read the version of one installed harness package, without resolving it.
 * @param version - the provisioned version whose tree to read.
 * @param pkg - the harness package.
 * @returns the installed version, or undefined when it is not there.
 */
function installedVersion(version, pkg) {
    const manifest = join(
        anchorOf(version),
        "node_modules",
        pkg,
        "package.json",
    );
    if (!existsSync(manifest)) return undefined;
    try {
        const decoded = JSON.parse(readFileSync(manifest, "utf8"));
        return typeof decoded.version === "string"
            ? decoded.version
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Whether a version's tree is complete.
 *
 * A directory that exists is not a hit: an interrupted install leaves one behind,
 * and treating it as provisioned would report on a half-installed harness.
 * @param version - the version to check.
 * @param packages - the packages a run needs.
 * @returns true when every package is present at the requested version.
 */
function isCached(version, packages) {
    return packages.every((pkg) => installedVersion(version, pkg) === version);
}

/** Whether the registry publishes one package at one version. */
function publishes(pkg, version) {
    const result = runProgram(NPM, ["view", `${pkg}@${version}`, "version"], {
        stdio: "pipe",
    });
    return result.status === 0 && (result.stdout ?? "").trim() !== "";
}

/**
 * Install one version's harness into its cache directory.
 * @param version - the version to install.
 * @param packages - the packages to install.
 * @param options - the parsed command line.
 * @throws {RunnerError} when the version is missing, offline, or incomplete.
 */
function provision(version, packages, options) {
    if (isCached(version, packages)) {
        console.error(`compat: ${version} is cached under ${homeOf(version)}`);
        return;
    }
    if (options.offline)
        throw new RunnerError(
            `the cache holds no complete ${version} harness; run once without --offline to install it`,
        );
    mkdirSync(anchorOf(version), { recursive: true });
    console.error(
        `compat: installing the ${version} harness into ${homeOf(version)}`,
    );
    const result = runProgram(
        NPM,
        [
            "install",
            "--prefix",
            anchorOf(version),
            "--no-save",
            "--no-audit",
            "--no-fund",
            // The anchor is a fixture, not a deployment: it exists to hold the
            // exact versions the probe reads. Peer resolution would be free to
            // pick other versions of the packages around them (it refuses to
            // install `0.1.6-alpha.1` at all over one such conflict), and a tree
            // that depends on registry state is the opposite of what a
            // compatibility run wants. The profiles that matter get their tree
            // from the runtime's own lockfile.
            "--legacy-peer-deps",
            ...packages.map((pkg) => `${pkg}@${version}`),
        ],
        { stdio: "inherit" },
    );
    if (result.status !== 0) {
        const unpublished = packages.filter((pkg) => !publishes(pkg, version));
        throw new RunnerError(
            unpublished.length > 0
                ? `the registry does not publish ${version} for ${unpublished.join(", ")}`
                : `installing the ${version} harness failed`,
        );
    }
    const missing = packages.filter(
        (pkg) => installedVersion(version, pkg) !== version,
    );
    if (missing.length > 0)
        throw new RunnerError(
            `the ${version} harness is incomplete after installing it: ${missing.join(", ")}`,
        );
}

/**
 * Resolve the version one dist-tag currently points at.
 * @param tag - the dist-tag to read.
 * @returns the version text.
 * @throws {RunnerError} when the tag cannot be resolved.
 */
function resolveHead(tag) {
    const result = runProgram(
        NPM,
        ["view", `@deepseek-ai/dsh@${tag}`, "version"],
        { stdio: "pipe" },
    );
    const version = (result.stdout ?? "").trim();
    if (result.status !== 0 || version === "")
        throw new RunnerError(`the ${tag} dist-tag could not be resolved`);
    return version;
}

/**
 * Resolve one version's sentinel entry from that version's own home.
 *
 * The ambient `DSH_HOME` names the installation this machine runs, which is not
 * the one a leg is about to test. Resolution reads the variable at call time, so
 * the leg's home is installed for the call and the ambient value is restored
 * afterwards even when the resolution refuses the result.
 * @param version - the provisioned version to resolve from.
 * @returns the absolute entry path of the sentinel inside that version's tree.
 * @throws when the sentinel is missing or resolves outside the version's anchor.
 */
function sentinelOf(version) {
    const ambient = process.env.DSH_HOME;
    process.env.DSH_HOME = homeOf(version);
    try {
        return findPackageWithin(SENTINEL, anchorOf(version));
    } finally {
        if (ambient === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = ambient;
    }
}

/**
 * Run the suite against one provisioned version.
 * @param version - the version to test.
 * @param options - the parsed command line.
 * @returns whether it passed, and the failing test names when captured.
 */
function runSuite(version, options) {
    const env = {
        ...process.env,
        DSH_HOME: homeOf(version),
        DSH_EXPECT_HARNESS_VERSION: version,
    };
    const stdio = options.json ? "pipe" : "inherit";
    const result = runProgram(process.execPath, ["--test", SUITE], {
        cwd: ROOT,
        env,
        stdio,
        shell: false,
    });
    if (options.json) {
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        const failing = [...output.matchAll(/^\u2716 .*$/gmu)].map((match) =>
            match[0].trim(),
        );
        return {
            passed: result.status === 0,
            failures:
                result.status === 0
                    ? []
                    : failing.length > 0
                      ? failing
                      : [`the suite exited with code ${String(result.status)}`],
        };
    }
    return {
        passed: result.status === 0,
        failures:
            result.status === 0
                ? []
                : [`the suite exited with code ${String(result.status)}`],
    };
}

/** Copy the repository into a scratch directory, without dependencies or output. */
function copyTree(from, to) {
    const skipped = new Set(["node_modules", "lib", ".git"]);
    cpSync(from, to, {
        recursive: true,
        filter: (source) => {
            const name = source.slice(from.length).replace(/^[\\/]/u, "");
            if (name === "") return true;
            const [head] = name.split(/[\\/]/u);
            return !skipped.has(head);
        },
    });
}

/**
 * Rewrite the type references of one scratch manifest to a version.
 *
 * Only the packages whose version tracks the runtime are rewritten. `cordis` and
 * `schemastery` are versioned on their own line, so they keep the version the
 * manifest pins and the scratch install still resolves.
 * @param manifestPath - the scratch `package.json`.
 * @param version - the version to pin the lockstep packages to.
 */
function rewriteTypePins(manifestPath, version) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const dev = manifest.devDependencies ?? {};
    for (const name of Object.keys(dev)) {
        if (!name.startsWith("@deepseek-ai/dsh")) continue;
        dev[name] = version;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
}

/**
 * Check the type references against one version, in a throwaway copy.
 *
 * The version of a type reference is what decides which API the compiler lets the
 * source use, so this is the leg that answers "can the plugin still be written
 * against the oldest supported series". It runs in a copy because rewriting the
 * manifest is the only way to install another set of declarations, and the
 * working tree must stay exactly as it was.
 * @param version - the version to check against.
 * @returns whether the type check passed.
 */
function runTypeLeg(version) {
    const scratch = mkdtempSync(join(tmpdir(), "dsh-compat-type-"));
    console.error(
        `compat: checking the type references against ${version} in ${scratch}`,
    );
    try {
        copyTree(ROOT, scratch);
        rewriteTypePins(join(scratch, "package.json"), version);
        const install = runProgram(
            PNPM,
            ["install", "--ignore-scripts", "--no-frozen-lockfile"],
            { cwd: scratch, stdio: "inherit" },
        );
        if (install.status !== 0)
            return {
                passed: false,
                failures: ["installing the scratch tree failed"],
            };
        const check = runProgram(PNPM, ["typecheck"], {
            cwd: scratch,
            stdio: "inherit",
        });
        return {
            passed: check.status === 0,
            failures:
                check.status === 0
                    ? []
                    : [`pnpm typecheck failed against ${version}`],
        };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

/** Parse the command line. */
function parseArgs(argv) {
    const options = {
        version: undefined,
        heads: false,
        type: false,
        offline: false,
        json: false,
        update: false,
        list: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--version") {
            index += 1;
            const value = argv[index];
            if (value === undefined || value.startsWith("--"))
                throw new RunnerError("--version needs a version");
            options.version = value;
        } else if (arg === "--heads") options.heads = true;
        else if (arg === "--type") options.type = true;
        else if (arg === "--offline") options.offline = true;
        else if (arg === "--json") options.json = true;
        else if (arg === "--update") options.update = true;
        else if (arg === "--list") options.list = true;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new RunnerError(`unknown option ${arg}`);
    }
    return options;
}

/**
 * Fail when the fact source and the probe disagree about the harness packages.
 *
 * The plan carries the package list so that a run can provision a harness without
 * loading test code, and the probe carries the surfaces that name those packages.
 * A disagreement means one of the two was edited alone, and a run under it would
 * provision a harness the probe cannot fully read.
 * @param plan - the compatibility plan.
 * @throws {RunnerError} when the two lists differ.
 */
function checkPackageList(plan) {
    const declared = [...plan.packages].sort();
    const needed = harnessPackages();
    const missing = needed.filter((pkg) => !declared.includes(pkg));
    const extra = declared.filter((pkg) => !needed.includes(pkg));
    if (missing.length > 0 || extra.length > 0)
        throw new RunnerError(
            `compat/versions.json and the probe disagree about the harness packages: ` +
                `missing ${missing.join(", ") || "none"}; unexpected ${extra.join(", ") || "none"}`,
        );
}

/**
 * Decide which versions this run covers.
 * @param plan - the compatibility plan.
 * @param options - the parsed command line.
 * @returns one target per version, with its series and blocking flag.
 */
function selectTargets(plan, options) {
    if (options.version !== undefined) {
        const entry = entryOf(plan, options.version);
        return [
            {
                version: options.version,
                series: entry?.series ?? "unlisted",
                blocking: entry?.blocking ?? true,
            },
        ];
    }
    const targets = plan.series.flatMap((entry) =>
        entry.versions.map((version) => ({
            version,
            series: entry.name,
            blocking: entry.blocking,
        })),
    );
    if (!options.heads) return targets;
    return [
        ...targets,
        ...plan.heads.map((head) => ({
            version: resolveHead(head.tag),
            series: `dist-tag ${head.tag}`,
            blocking: head.blocking,
        })),
    ];
}

/** Print one aligned table of results. */
function printTable(results, typeLegs) {
    const rows = [
        ["version", "series", "blocking", "result", "harness"],
        ...results.map((result) => [
            result.version,
            result.series,
            result.blocking ? "yes" : "no",
            result.passed ? "pass" : "FAIL",
            result.resolvedFrom,
        ]),
    ];
    const widths = rows[0].map((_, column) =>
        Math.max(...rows.map((row) => row[column].length)),
    );
    for (const row of rows)
        console.log(
            row.map((cell, column) => cell.padEnd(widths[column])).join("  "),
        );
    for (const result of results)
        for (const failure of result.failures)
            console.log(`compat: ${result.version}: ${failure}`);
    for (const leg of typeLegs)
        for (const failure of leg.failures)
            console.log(
                `compat: type references at ${leg.version}: ${failure}`,
            );
}

/** Print what a run would do, and the facts it would use. */
function printPlan(plan, options) {
    const versions = matrixOf(plan);
    if (options.json) {
        console.log(
            JSON.stringify(
                {
                    series: plan.series,
                    heads: plan.heads,
                    packages: plan.packages,
                    versions: plan.series.flatMap((entry) => entry.versions),
                    matrix: versions,
                    boundaries: boundariesOf(plan),
                },
                null,
                4,
            ),
        );
        return;
    }
    console.log(`compat: plan ${PLAN_PATH}`);
    console.log(`compat: cache root ${cacheRoot()}`);
    for (const entry of plan.series)
        console.log(
            `compat: ${entry.name}: ${entry.versions.join(", ")}${entry.blocking ? "" : " (not blocking)"}`,
        );
    for (const head of plan.heads)
        console.log(
            `compat: follows the ${head.tag} dist-tag${head.blocking ? "" : " (not blocking)"}`,
        );
    console.log(`compat: would run ${versions.join(", ")}`);
}

/**
 * Append a markdown table to the continuous integration job summary.
 *
 * A run already prints its table to the terminal, but a runner's terminal is a
 * log nobody reads from the outside. When the runner names a summary file, the
 * table goes there too, which is where a reviewer looks first.
 * @param report - the report this run produced.
 */
function writeSummary(report) {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file === undefined || file === "") return;
    const lines = [
        "| version | series | blocking | result | harness |",
        "| --- | --- | --- | --- | --- |",
    ];
    for (const result of report.results)
        lines.push(
            `| ${result.version} | ${result.series} | ${result.blocking ? "yes" : "no"} | ${result.passed ? "pass" : "**FAIL**"} | \`${result.resolvedFrom === "" ? "-" : result.resolvedFrom}\` |`,
        );
    for (const leg of report.typeLegs)
        lines.push(
            `| ${leg.version} (type references) | - | yes | ${leg.passed ? "pass" : "**FAIL**"} | - |`,
        );
    for (const result of report.results)
        for (const failure of result.failures)
            lines.push(`| | | | ${failure} | |`);
    appendFileSync(file, `${lines.join("\n")}\n`);
}

/** The usage text. */
const USAGE = `Usage: node scripts/compat.mjs [options]

Runs the test suite against one provisioned harness per supported DSH version.

  --version <v>   run only this version
  --heads         also resolve and run the next and alpha dist-tags (not blocking)
  --type          also type check the oldest and newest blocking versions
  --offline       use the cache only, and fail instead of installing
  --json          print the report as JSON instead of a table
  --update        write compat/matrix.json with this run's results
  --list          print the plan and exit
  --help          print this text`;

/** Run the runner. */
function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(USAGE);
        return 0;
    }
    const plan = readPlan();
    checkPackageList(plan);
    if (options.list) {
        printPlan(plan, options);
        return 0;
    }
    const targets = selectTargets(plan, options);
    if (targets.length === 0) throw new RunnerError("no version to run");
    const results = [];
    for (const target of targets) {
        provision(target.version, plan.packages, options);
        let resolvedFrom = "";
        try {
            resolvedFrom = sentinelOf(target.version);
        } catch (error) {
            results.push({
                ...target,
                passed: false,
                resolvedFrom: "",
                failures: [
                    error instanceof Error ? error.message : String(error),
                ],
            });
            continue;
        }
        const suite = runSuite(target.version, options);
        results.push({
            ...target,
            passed: suite.passed,
            resolvedFrom,
            failures: suite.failures,
        });
    }
    const typeLegs = [];
    if (options.type) {
        const blocking = results.filter((result) => result.blocking);
        // A run that covers one or two versions type checks exactly those; a run
        // that covers more type checks the ends of the range, which is where the
        // compile-time question actually changes.
        const wanted =
            blocking.length <= 2
                ? blocking.map((result) => result.version)
                : boundariesOf(plan);
        for (const target of blocking)
            if (wanted.includes(target.version))
                typeLegs.push({
                    version: target.version,
                    ...runTypeLeg(target.version),
                });
    }
    const report = { results, typeLegs };
    if (options.update) {
        writeFileSync(MATRIX_PATH, `${JSON.stringify(report, null, 4)}\n`);
        console.error(`compat: wrote ${MATRIX_PATH}`);
    }
    writeSummary(report);
    if (options.json) console.log(JSON.stringify(report, null, 4));
    else printTable(results, typeLegs);
    const failed = results.filter((result) => !result.passed);
    const blockingFailures = failed.filter((result) => result.blocking);
    const passedBlocking = results.filter(
        (result) => result.blocking && result.passed,
    ).length;
    const blockingTotal = results.filter((result) => result.blocking).length;
    const typeFailures = typeLegs.filter((leg) => !leg.passed);
    if (!options.json) {
        console.log(
            `compat: ${String(passedBlocking)} of ${String(blockingTotal)} blocking versions passed`,
        );
        for (const result of failed)
            if (!result.blocking)
                console.log(
                    `compat: warning: ${result.version} (${result.series}) failed but does not block`,
                );
    }
    return blockingFailures.length > 0 || typeFailures.length > 0 ? 1 : 0;
}

try {
    process.exitCode = main();
} catch (error) {
    if (error instanceof RunnerError) {
        console.error(`compat: ${error.message}`);
        process.exitCode = 2;
    } else {
        console.error(error);
        process.exitCode = 2;
    }
}
