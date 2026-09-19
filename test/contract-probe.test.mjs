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
 *
 * Each probe skips itself when no harness installation is reachable, so a
 * checkout that has only this plugin reports the checks it cannot run as skips
 * rather than as failures. The one test in this file that never skips is the
 * guard before them: it reads no harness file, it asserts that an installation is
 * reachable, and it is therefore what turns a missing harness into a visible
 * failure instead of a green run that checked nothing.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findPackage, harnessRoots } from "./support/host-loader.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The harness package the probe uses to decide whether a harness is present. */
const SENTINEL = "@deepseek-ai/dsh-tools";

/** Whether a harness installation is reachable from this checkout. */
const available = findPackage(SENTINEL) !== undefined;

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
 * One host service the plugin resolves by name.
 *
 * A service is registered by its class constructor calling `super(ctx, '<name>')`,
 * so that call is the marker.
 */
const HOST_SERVICES = [
    {
        key: "tools",
        provider: "@deepseek-ai/dsh-tools",
        entry: "lib/index.js",
        marker: 'super(ctx, "tools")',
    },
    {
        key: "commands",
        provider: "@deepseek-ai/dsh-commands",
        entry: "lib/index.js",
        marker: 'super(ctx, "commands")',
    },
    {
        key: "llm",
        provider: "@deepseek-ai/dsh-llm",
        entry: "lib/index.js",
        marker: 'super(ctx, "llm")',
    },
    {
        key: "agents",
        provider: "@deepseek-ai/dsh-agent",
        entry: "lib/index.js",
        marker: 'super(ctx, "agents")',
    },
    {
        key: "webServer",
        provider: "@deepseek-ai/dsh-host-webserver",
        entry: "lib/index.js",
        marker: 'super(ctx, "webServer")',
    },
    {
        key: "sessionProjections",
        provider: "@deepseek-ai/dsh-session-projection",
        entry: "lib/index.js",
        marker: 'super(ctx, "sessionProjections")',
    },
    {
        key: "agentDefaultModel",
        provider: "@deepseek-ai/dsh-agent-default-model",
        entry: "lib/index.js",
        marker: 'super(ctx, "agentDefaultModel")',
    },
];

/**
 * One client-side name the browser half binds to.
 *
 * What remains here is what the compiler does not cover. The seat key, the
 * standard props and the projection tables are all imported types now, so a
 * rename of those fails the build. These entries are the rest: names the plugin
 * never writes in code — the seat the composer creates, the slot service the
 * renderer provides, the locale runtime the locale package creates, and the
 * `slots`, `locale`, `remote` and `remote.commands` services the client's inject
 * list is answered by — plus the runtime shape the composer gives that seat, and
 * the one derivation rule the value depends on: the prop name a projection key
 * turns into is computed at runtime, so a change to that rule is invisible to the
 * type system.
 */
const CLIENT_NAMES = [
    {
        what: "the keyed hook map the seat receives, from which the projection hooks derive",
        provider: "@deepseek-ai/dsh-client-ui-session",
        entry: "lib/client.js",
        marker: 'keyedHooks: ["projection"]',
    },
    {
        what: "the seat registration in the composer, at its runtime shape",
        provider: "@deepseek-ai/dsh-client-ui-conversation",
        entry: "lib/client.js",
        marker: '"conversation.input.right":',
    },
    {
        what: "the kind and scope of that seat",
        provider: "@deepseek-ai/dsh-client-ui-conversation",
        entry: "lib/client.js",
        marker: '"conversation.input.right": {\n\t\t\t\t\t\tkind: "list",\n\t\t\t\t\t\tscope: "session"',
    },
    {
        what: 'the browser seed word that answers require("@deepseek-ai/dsh-client-ui-slots")',
        provider: "@deepseek-ai/dsh-web-frontend",
        entry: "dist/assets/index-*.js",
        marker: '"@deepseek-ai/dsh-client-ui-slots":',
    },
    {
        what: "the runtime derivation from a projection key to its hook prop name",
        provider: "@deepseek-ai/dsh-web-frontend",
        entry: "dist/assets/index-*.js",
        marker: "standardHookPropName",
    },
    {
        what: "the locale registry the plugin registers its dictionaries through",
        provider: "@deepseek-ai/dsh-client-locale",
        entry: "lib/client.js",
        marker: "new LocaleRuntime(ctx",
    },
    {
        what: "the command channel the write path calls",
        provider: "@deepseek-ai/dsh-api-gateway",
        entry: "lib/client.js",
        marker: "remote.<namespace>",
    },
    {
        what: "the seed module that provides the slots service the client injects",
        provider: "@deepseek-ai/dsh-client-ui-renderer",
        entry: "lib/client.js",
        marker: 'super(ctx, "slots")',
    },
    {
        what: "the seed module that provides the locale service the client injects",
        provider: "@deepseek-ai/dsh-client-locale",
        entry: "lib/client.js",
        marker: 'ctx.provide("locale", locale)',
    },
    {
        what: "the seed module that provides the remote service the client injects",
        provider: "@deepseek-ai/dsh-api-gateway",
        entry: "lib/client.js",
        marker: 'super(ctx, "remote")',
    },
    {
        what: "the remote namespace the injected remote.commands service is composed from",
        provider: "@deepseek-ai/dsh-commands",
        entry: "lib/typert.remote-client.js",
        marker: "namespace: 'commands'",
    },
];

/**
 * One session log event the fold branches on.
 *
 * These are durable event names the plugin reads rather than services it calls,
 * so a rename would silently stop the fold from recognising a level change.
 */
const LOG_EVENTS = [
    {
        name: "command/run",
        provider: "@deepseek-ai/dsh-commands",
        entry: "lib/index.js",
    },
    {
        name: "command/done",
        provider: "@deepseek-ai/dsh-commands",
        entry: "lib/index.js",
    },
    {
        name: "turn/start",
        provider: "@deepseek-ai/dsh-agent-loop",
        entry: "lib/index.js",
    },
    {
        name: "turn/end",
        provider: "@deepseek-ai/dsh-agent-loop",
        entry: "lib/index.js",
    },
    {
        name: "user/message",
        provider: "@deepseek-ai/dsh-agent-loop",
        entry: "lib/index.js",
    },
];

/** One session accessor the host half reads from a live agent. */
const SESSION_ACCESSORS = [
    {
        what: "the request header accessor the plugin reads for the effort and route",
        provider: "@deepseek-ai/dsh-session",
        entry: "lib/types/index.d.ts",
        marker: "requestHeader()",
    },
    {
        what: "the immutable session header the plugin reads for delegation depth",
        provider: "@deepseek-ai/dsh-session",
        entry: "lib/types/types.d.ts",
        marker: "interface SessionHeader",
    },
];

/**
 * Locate one harness package's directory.
 *
 * `findPackage` resolves a package through its entry point, which an asset-only
 * package such as the browser shell does not have: its manifest exposes only
 * `./dist/*`. This searches the harness roots for the directory instead, so a
 * package with no entry point is still readable.
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
        // Three shapes are worth trying: the root itself, the root's scoped folder,
        // and the installed harness's own dependency tree, which is where the packages
        // the running host loads actually live.
        const candidates = [
            join(anchor, provider),
            join(anchor, provider, "node_modules"),
        ];
        const installed = join(anchor, "@deepseek-ai", "dsh", "node_modules");
        if (existsSync(installed)) candidates.push(join(installed, provider));
        for (const candidate of candidates) {
            if (existsSync(join(candidate, "package.json"))) return candidate;
        }
    }
    return undefined;
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
