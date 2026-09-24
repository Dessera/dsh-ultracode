/**
 * The compatibility plan: which harness versions this package claims, and the
 * peer range those claims turn into.
 *
 * Everything downstream derives from `./versions.json`: the range the plugin
 * declares to the host, the versions a matrix run installs, and the table the
 * documentation shows. This module is pure and depends on nothing outside the
 * standard library, so a test can read the same facts a run reads and compare
 * them with what the manifest declares.
 *
 * @module @dessera/dsh-ultracode/compat/plan
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

/**
 * One harness series this package claims to support.
 * @typedef {object} CompatSeries
 * @property {string} name - series label, used in tables and documentation.
 * @property {readonly string[]} versions - verified versions, oldest first; the
 *   peer range takes its lower bound from the first entry, which is why the
 *   order is part of the contract rather than a presentation choice.
 * @property {boolean} blocking - whether a failure here turns a run red.
 */

/**
 * One npm dist-tag the scheduled run follows.
 * @typedef {object} CompatHead
 * @property {string} tag - dist-tag to resolve against the runtime package.
 * @property {boolean} blocking - whether a failure here turns a run red.
 */

/**
 * The whole fact source.
 * @typedef {object} CompatPlan
 * @property {readonly CompatSeries[]} series - supported series, oldest first.
 * @property {readonly CompatHead[]} heads - dist-tags a scheduled run follows.
 * @property {readonly string[]} packages - harness packages a run installs.
 */

/** The harness package a plugin's peer requirement names. */
export const RUNTIME_PEER = "@deepseek-ai/dsh";

/** Absolute path of the fact source. */
export const PLAN_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "versions.json",
);

/** Text of a series label or version prefix, as `major.minor.patch`. */
const BASE = /^(\d+)\.(\d+)\.(\d+)/u;

/** The numeric parts of a series label or version. */
function baseOf(value, describe) {
    const match = BASE.exec(value);
    if (match === null)
        throw new Error(
            `compatibility plan: ${describe} ${JSON.stringify(value)} does not start with a semantic version`,
        );
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}

/** The `major.minor.patch` text of a series label. */
function baseTextOf(value, describe) {
    const base = baseOf(value, describe);
    return `${base.major}.${base.minor}.${base.patch}`;
}

/**
 * The first version after this series, used to close the last branch.
 *
 * Series labels in this plan end in a patch number, so the wall after the newest
 * series is the next patch of the same minor rather than the next minor: a plan
 * whose newest series is `0.1.7-rc` supports `0.1.7` and refuses everything from
 * `0.1.8` on.
 */
function nextPatchOf(value, describe) {
    const base = baseOf(value, describe);
    return `${base.major}.${base.minor}.${base.patch + 1}`;
}

/** Read one field of a decoded record, or fail with the field's name. */
function fieldOf(record, key, describe) {
    const value = record[key];
    if (value === undefined)
        throw new Error(`compatibility plan: ${describe} has no ${key}`);
    return value;
}

/** Decode and validate one series entry. */
function seriesOf(raw, index) {
    const describe = `series[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new Error(`compatibility plan: ${describe} must be an object`);
    const name = fieldOf(raw, "name", describe);
    if (typeof name !== "string")
        throw new Error(
            `compatibility plan: ${describe}.name must be a string`,
        );
    baseTextOf(name, `${describe}.name`);
    const versions = fieldOf(raw, "versions", describe);
    if (!Array.isArray(versions) || versions.length === 0)
        throw new Error(
            `compatibility plan: ${describe}.versions must list at least one version`,
        );
    for (const version of versions) {
        if (typeof version !== "string")
            throw new Error(
                `compatibility plan: ${describe}.versions must contain strings`,
            );
        if (!version.startsWith(name))
            throw new Error(
                `compatibility plan: ${describe}.versions contains ${JSON.stringify(version)}, which is not a ${name} version`,
            );
    }
    const blocking = fieldOf(raw, "blocking", describe);
    if (typeof blocking !== "boolean")
        throw new Error(
            `compatibility plan: ${describe}.blocking must be a boolean`,
        );
    return { name, versions, blocking };
}

/** Decode and validate one head entry. */
function headOf(raw, index) {
    const describe = `heads[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new Error(`compatibility plan: ${describe} must be an object`);
    const tag = fieldOf(raw, "tag", describe);
    if (typeof tag !== "string" || tag.trim() === "")
        throw new Error(
            `compatibility plan: ${describe}.tag must be a non-empty string`,
        );
    const blocking = fieldOf(raw, "blocking", describe);
    if (typeof blocking !== "boolean")
        throw new Error(
            `compatibility plan: ${describe}.blocking must be a boolean`,
        );
    return { tag, blocking };
}

/**
 * Read the compatibility plan.
 * @param path - path of the fact source, defaulting to this module's sibling.
 * @returns {CompatPlan} the validated plan.
 * @throws when the file cannot be read or does not describe a usable plan.
 */
export function readPlan(path = PLAN_PATH) {
    let decoded;
    try {
        decoded = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(
            `compatibility plan: ${path} cannot be read as JSON (${String(error)})`,
        );
    }
    if (
        typeof decoded !== "object" ||
        decoded === null ||
        Array.isArray(decoded)
    )
        throw new Error(`compatibility plan: ${path} must hold an object`);
    const series = fieldOf(decoded, "series", "the plan");
    if (!Array.isArray(series) || series.length === 0)
        throw new Error(
            "compatibility plan: series must list at least one series",
        );
    const heads = decoded.heads ?? [];
    if (!Array.isArray(heads))
        throw new Error("compatibility plan: heads must be a list");
    const packages = fieldOf(decoded, "packages", "the plan");
    if (!Array.isArray(packages) || packages.length === 0)
        throw new Error(
            "compatibility plan: packages must list at least one package",
        );
    for (const pkg of packages)
        if (typeof pkg !== "string" || pkg.trim() === "")
            throw new Error(
                "compatibility plan: packages must contain non-empty strings",
            );
    return { series: series.map(seriesOf), heads: heads.map(headOf), packages };
}

/**
 * Build the peer range that claims exactly the series in a plan.
 *
 * Each series contributes one branch. The lower bound is the oldest verified
 * version of that series and is spelled with its prerelease, because a range
 * that starts at the release excludes the prerelease that precedes it: `^0.1.5`
 * does not admit `0.1.5-rc.3`. The upper bound is the start of the next series
 * with a `-0` suffix, because a bare upper bound admits the next series'
 * prereleases: `0.2.0-rc.1` satisfies `<0.2.0`. The last branch closes on the
 * next minor of its own series.
 * @param {readonly CompatSeries[]} series - supported series, oldest first.
 * @returns {string} the semver range, with one `||` branch per series.
 */
export function peerRangeOf(series) {
    return series
        .map((entry, index) => {
            const next = series[index + 1];
            const upper =
                next === undefined
                    ? nextPatchOf(entry.name, "series name")
                    : baseTextOf(next.name, "series name");
            return `>=${entry.versions[0]} <${upper}-0`;
        })
        .join(" || ");
}

/**
 * List the versions a run must pass.
 * @param {CompatPlan} plan - the compatibility plan.
 * @returns {string[]} every blocking version, in the order the plan lists them.
 */
export function matrixOf(plan) {
    return plan.series
        .filter((entry) => entry.blocking)
        .flatMap((entry) => entry.versions);
}

/**
 * List the versions at the ends of the supported range.
 *
 * The type references can only be pinned at one version, so the compile-time
 * question has two ends rather than one per series: the oldest version decides
 * which API the source may use, and the newest decides whether anything the
 * source still names has been removed.
 * @param {CompatPlan} plan - the compatibility plan.
 * @returns {string[]} the oldest and newest blocking version, deduplicated.
 */
export function boundariesOf(plan) {
    const versions = matrixOf(plan);
    if (versions.length === 0) return [];
    const first = versions[0];
    const last = versions[versions.length - 1];
    return first === last ? [first] : [first, last];
}

/**
 * Describe one version's place in the plan.
 * @param {CompatPlan} plan - the compatibility plan.
 * @param {string} version - the version to describe.
 * @returns {{ series: string, blocking: boolean } | undefined} its series label
 *   and blocking flag, or undefined when the plan does not list it.
 */
export function entryOf(plan, version) {
    for (const entry of plan.series)
        if (entry.versions.includes(version))
            return { series: entry.name, blocking: entry.blocking };
    return undefined;
}

/**
 * Whether a host would accept a peer range at a running version.
 *
 * This reproduces the harness's own rule, quoted from
 * `@deepseek-ai/dsh-app-boot@0.1.7-rc.2` `lib/index.js:289-300`: peers whose name
 * is neither `@deepseek-ai/dsh` nor a `@deepseek-ai/dsh-*` package are skipped,
 * the three `workspace:` ranges stand for the running version, and a peer is
 * incompatible when `semver.satisfies(version, range, { includePrerelease: true })`
 * is false. Prereleases participate in the comparison, which is why the range
 * this package declares spells its lower bounds with prereleases and closes its
 * upper bounds with the `-0` sentinel.
 *
 * The harness's function cannot be called from here: its bundle imports five
 * packages that a DSH installation provides but that its manifest does not
 * declare (`cordis-plugin-loader`, `cordis-plugin-group`, `dsh-atomic-write`,
 * `dsh-home-paths`, `dsh-launch-environment`), so loading it outside a full
 * installation fails. The rule is four lines of `semver`, so it is reproduced
 * with the same library the harness calls, and the expectations in
 * `test/peer-range.test.mjs` were captured by running the harness's own function
 * over exactly those versions.
 * @param {string} version - the DSH version a host would be running.
 * @param {string | undefined} range - the declared peer range.
 * @returns {boolean} whether the host would find no incompatibility.
 */
export function acceptsVersion(version, range) {
    if (range === undefined || range.trim() === "") return true;
    const requirement = ["workspace:^", "workspace:~", "workspace:*"].includes(
        range,
    )
        ? version
        : range;
    return semver.satisfies(version, requirement, { includePrerelease: true });
}

/**
 * Whether a host would accept a manifest at a running version.
 * @param {object} manifest - a decoded plugin manifest.
 * @param {string} version - the DSH version a host would be running.
 * @returns {boolean} whether every harness peer this manifest names accepts it.
 */
export function acceptsManifest(manifest, version) {
    const peers = Object.entries(manifest.peerDependencies ?? {}).filter(
        ([name]) =>
            name === RUNTIME_PEER || name.startsWith(`${RUNTIME_PEER}-`),
    );
    return peers.every(([, range]) => acceptsVersion(version, range));
}
