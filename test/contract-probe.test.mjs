/**
 * Runtime contract probe against the installed harness.
 *
 * This file covers exactly what the compiler cannot. The host-half types are
 * owned by the harness and imported, so a renamed service member, seat prop or
 * projection contract fails the type check. Three things stay outside that
 * reach: the string keys the plugin resolves services under, because the
 * harness types its context permissively; the browser seed words and runtime
 * derivations the client half binds to, because those names are computed and
 * most of the packages that own them are never installed as packages at all;
 * and the durable session event names the fold branches on, which are data
 * rather than API.
 *
 * It reads the harness that is actually installed on this machine and asserts
 * that every one of those names still exists under the name the plugin uses.
 * The surfaces themselves live in `./support/harness-contract.mjs`, because the
 * compatibility runner installs one harness per supported version and needs the
 * same list to provision one.
 *
 * Each probe skips itself when no harness installation is reachable, so a
 * checkout that has only this plugin reports the checks it cannot run as skips
 * rather than as failures. The one test in this file that never skips is the
 * guard before them: it reads no harness file, it asserts that an installation is
 * reachable, and it is therefore what turns a missing harness into a visible
 * failure instead of a green run that checked nothing.
 *
 * One test reports which harness answered. A compatibility run also names the
 * version it provisioned through `DSH_EXPECT_HARNESS_VERSION`, and that test
 * then refuses a run whose resolution landed somewhere else.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    CLIENT_NAMES,
    HOST_SERVICES,
    LOG_EVENTS,
    SENTINEL,
    SESSION_ACCESSORS,
} from "./support/harness-contract.mjs";
import {
    findPackage,
    findPackageWithin,
    harnessRoots,
} from "./support/host-loader.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Whether a harness installation is reachable from this checkout. */
const available = findPackage(SENTINEL) !== undefined;

/** The version of the harness this run read, when one is reachable. */
const harnessVersion = readHarnessVersion(SENTINEL);

/** The version a compatibility run provisioned, when it named one. */
const expectedVersion = process.env.DSH_EXPECT_HARNESS_VERSION ?? "";

/**
 * The `node_modules` directories Node itself would consult, nearest first.
 *
 * A package is found the way a bare specifier would be: by walking up from the
 * anchor. The asset-only browser shell has no entry point to resolve, so this
 * walk is the only thing that finds it, and it finds the copy the profile runs
 * rather than a sibling installation.
 * @param start - absolute directory to start from.
 * @returns the candidate package directories, nearest first.
 */
function nodeModulesDirs(start) {
    const dirs = [];
    let dir = resolve(start);
    for (;;) {
        dirs.push(join(dir, "node_modules"));
        const parent = dirname(dir);
        if (parent === dir) return dirs;
        dir = parent;
    }
}

/**
 * Locate one harness package's directory.
 *
 * `findPackage` resolves a package through its entry point, which an asset-only
 * package such as the browser shell does not have: its manifest exposes only
 * `./dist/*`. This searches the directories a resolution would search instead,
 * so a package with no entry point is still readable.
 * @param provider - the package specifier to locate.
 * @returns the package directory, or undefined when it is absent.
 */
function findHarnessDir(provider) {
    const resolved = findPackage(provider);
    if (resolved !== undefined) {
        let dir = dirname(resolved);
        while (dir !== dirname(dir) && !existsSync(join(dir, "package.json")))
            dir = dirname(dir);
        return dir;
    }
    for (const anchor of harnessRoots()) {
        for (const modules of nodeModulesDirs(anchor)) {
            const candidate = join(modules, provider);
            if (existsSync(join(candidate, "package.json"))) return candidate;
        }
    }
    return undefined;
}

/**
 * Read one harness package's version.
 * @param provider - the package specifier to read.
 * @returns the version it declares, or undefined when it cannot be read.
 */
function readHarnessVersion(provider) {
    const dir = findHarnessDir(provider);
    if (dir === undefined) return undefined;
    try {
        const manifest = JSON.parse(
            readFileSync(join(dir, "package.json"), "utf8"),
        );
        return typeof manifest.version === "string"
            ? manifest.version
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Read one file from an installed harness package.
 *
 * The entry may be a glob, because the browser shell ships under a content-hashed
 * file name that changes between builds and the module table it holds is the only
 * place the browser seed words are answered from.
 * @param provider - the package specifier to resolve.
 * @param entry - the path inside the package, optionally with `*` in the basename.
 * @returns the concatenated text of the matching files, or undefined when none match.
 */
function readHarnessFile(provider, entry) {
    const dir = findHarnessDir(provider);
    if (dir === undefined) return undefined;
    if (!entry.includes("*")) {
        const path = join(dir, entry);
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }
    const separator = entry.lastIndexOf("/");
    const folder = join(dir, separator < 0 ? "" : entry.slice(0, separator));
    if (!existsSync(folder)) return undefined;
    const pattern = entry.slice(separator + 1);
    const matches = readdirSync(folder).filter((name) => {
        const parts = pattern.split("*");
        return parts.every((part) => part === "" || name.includes(part));
    });
    if (matches.length === 0) return undefined;
    return matches
        .map((name) => readFileSync(join(folder, name), "utf8"))
        .join("\n");
}

/**
 * Check one named surface against the installed harness.
 * @param surfaces - the surfaces to check.
 * @param describe - how to name one surface in a failure message.
 * @returns the list of failures; empty means every surface is present.
 */
function checkMarkers(surfaces, describe) {
    const missing = [];
    for (const surface of surfaces) {
        const text = readHarnessFile(surface.provider, surface.entry);
        if (text === undefined) {
            // A surface marked optional lives in a package that some compositions do
            // not install, so its absence is a gap in coverage rather than a break.
            if (surface.optionalPackage === true) continue;
            missing.push(
                `${describe(surface)}: ${surface.provider}/${surface.entry} is not installed`,
            );
            continue;
        }
        if (!text.includes(surface.marker)) {
            missing.push(
                `${describe(surface)}: ${surface.provider}/${surface.entry} no longer contains it`,
            );
        }
    }
    return missing;
}

/**
 * Fail loudly when the harness is missing.
 *
 * Every assertion below is meaningless without an installation to read, and a
 * skipped test exits zero. This guard is what turns "could not check" into a
 * visible failure instead of a green suite.
 */
test("a harness installation is reachable, because every probe below reads one", () => {
    assert.ok(
        available,
        `no harness installation is reachable: ${SENTINEL} could not be resolved.\n` +
            "Install or link a DSH profile, or set DSH_HOME, before running this suite.",
    );
});

/**
 * Say which harness answered, and hold a compatibility run to the one it provisioned.
 *
 * The version this reads sits in the title, so a run's log states the harness it
 * checked even when every probe passes. A run that names an expected version is
 * additionally held to it: a resolution that walked up into another installation
 * would otherwise report a green suite for a harness nobody asked about.
 */
test(
    `the harness under test is ${SENTINEL}@${harnessVersion ?? "unreadable"}`,
    { skip: !available },
    (t) => {
        const entry = findPackage(SENTINEL);
        t.diagnostic(`resolved from ${entry}`);
        if (expectedVersion === "") return;
        assert.equal(
            harnessVersion,
            expectedVersion,
            `this run provisioned ${SENTINEL}@${expectedVersion} but read @${harnessVersion} from ${entry}`,
        );
        try {
            findPackageWithin(SENTINEL, harnessRoots()[0]);
        } catch (error) {
            assert.fail(error instanceof Error ? error.message : String(error));
        }
    },
);

test(
    "every host service the plugin resolves by name is still registered under that name",
    { skip: !available },
    () => {
        const missing = checkMarkers(
            HOST_SERVICES,
            (s) => `${s.key} (${s.marker})`,
        );
        assert.deepEqual(
            missing,
            [],
            "the plugin reads these through ctx.reflect.get, which the type system cannot check:\n" +
                missing.join("\n"),
        );
    },
);

test(
    "every client name the browser half binds to is still produced upstream",
    { skip: !available },
    () => {
        const missing = checkMarkers(CLIENT_NAMES, (s) => s.what);
        assert.deepEqual(
            missing,
            [],
            "the browser half has no compiler covering these names:\n" +
                missing.join("\n"),
        );
    },
);

test(
    "every session log event the fold branches on still exists",
    { skip: !available },
    () => {
        const missing = checkMarkers(
            LOG_EVENTS.map((event) => ({ ...event, marker: event.name })),
            (s) => s.name,
        );
        assert.deepEqual(
            missing,
            [],
            "the fold would silently stop recognising a level change:\n" +
                missing.join("\n"),
        );
    },
);

test(
    "every session accessor the host half reads still exists",
    { skip: !available },
    () => {
        const missing = checkMarkers(SESSION_ACCESSORS, (s) => s.what);
        assert.deepEqual(
            missing,
            [],
            "the host half reads these off a live agent:\n" +
                missing.join("\n"),
        );
    },
);

/**
 * The type-reference pins are exact, so the compiler checks the version the
 * plugin claims to support rather than whatever a range happens to resolve to.
 *
 * This is the probe for the one thing the probe's own contracts file cannot
 * state about itself: a range in `devDependencies` would silently move the types
 * under the whole program.
 */
test(
    "the type reference packages are pinned exactly, or absent entirely",
    { skip: !available },
    () => {
        const manifest = JSON.parse(
            readFileSync(join(root, "package.json"), "utf8"),
        );
        const dev = manifest.devDependencies ?? {};
        const ranged = Object.entries(dev)
            .filter(
                ([name, version]) =>
                    name.startsWith("@deepseek-ai/") &&
                    !/^\d+\.\d+\.\d+/.test(version),
            )
            .map(([name, version]) => `${name}: ${version}`);
        assert.deepEqual(
            ranged,
            [],
            "a type reference must be pinned exactly: a range would let the compiler check against a version the plugin does not claim to support",
        );
    },
);
