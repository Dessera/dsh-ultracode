/**
 * The version contract this package declares, checked against the harness's rule.
 *
 * The harness reads `peerDependencies` from the plugin manifest and matches the
 * running DSH version against those ranges, so the declaration is the one place
 * where "which versions does this plugin support" turns into something a host
 * acts on. That makes two things worth asserting: the manifest carries exactly
 * the range the compatibility plan generates, and that range admits the versions
 * the plan verifies while refusing the neighbours it does not.
 *
 * The verdicts below were captured by running the harness's own
 * `evaluatePluginCompatibility` (`@deepseek-ai/dsh-app-boot@0.1.7-rc.2`) over
 * exactly these versions, before that rule was reproduced in `compat/plan.mjs`:
 * importing the function needs five packages that only a full DSH installation
 * provides, so a plugin checkout cannot call it. The expectations are therefore
 * observed rather than assumed, and a change in the harness's rule would surface
 * here as a disagreement with a real release.
 *
 * Domain letters from the compatibility plan: P1 to P5 are the range cases, and
 * the two consistency cases are additions to that domain. A case name states the
 * behaviour rather than the plan's numbering, because a test name is a
 * deliverable of its own.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    acceptsManifest,
    matrixOf,
    peerRangeOf,
    readPlan,
    RUNTIME_PEER,
} from "../compat/plan.mjs";
import { harnessPackages } from "./support/harness-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The manifest a host reads when it decides whether to load this plugin. */
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The versions this package claims, and the ranges those claims generate. */
const plan = readPlan();

/** Every version the plan lists, blocking or not. */
const verified = plan.series.flatMap((entry) => entry.versions);

/** The range the plan generates for the runtime peer. */
const range = peerRangeOf(plan.series);

/**
 * Ask the harness's rule whether it would accept a manifest at a version.
 * @param runtimeVersion - the DSH version the host would be running.
 * @param candidate - the manifest to judge, defaulting to this package's own.
 * @returns whether the harness reports no incompatibility.
 */
function accepted(runtimeVersion, candidate = manifest) {
    return acceptsManifest(candidate, runtimeVersion);
}

test("the manifest carries the peer range the compatibility plan generates", () => {
    assert.equal(
        manifest.peerDependencies?.[RUNTIME_PEER],
        range,
        `package.json must declare ${RUNTIME_PEER} as ${JSON.stringify(range)}; ` +
            "rewrite it from compat/versions.json rather than by hand",
    );
});

test("every harness peer carries that same range, so no series is claimed twice", () => {
    const peers = Object.entries(manifest.peerDependencies ?? {}).filter(
        ([name]) =>
            name === RUNTIME_PEER || name.startsWith(`${RUNTIME_PEER}-`),
    );
    assert.ok(peers.length > 0, "the manifest must name the runtime peer");
    for (const [name, declared] of peers)
        assert.equal(
            declared,
            range,
            `${name} must carry the range the plan generates, because one fact source decides every series`,
        );
});

test("the range accepts every version the plan verifies", () => {
    const refused = verified.filter((version) => !accepted(version));
    assert.deepEqual(
        refused,
        [],
        "a version this package claims to support must be one the host accepts:\n" +
            refused.join("\n"),
    );
});

test("the range refuses a version below the oldest supported series", () => {
    for (const version of ["0.1.5-rc.0", "0.1.4-rc.1", "0.1.0-rc.6"]) {
        assert.equal(
            accepted(version),
            false,
            `${version} is not a version this package verifies, so the host must refuse it`,
        );
    }
});

test("the range refuses the next series' prereleases", () => {
    for (const version of ["0.1.8-alpha.1", "0.1.9-rc.1", "0.2.0-rc.1"]) {
        assert.equal(
            accepted(version),
            false,
            `${version} belongs to no verified series; an upper bound without the -0 sentinel would admit it`,
        );
    }
});

test("the range accepts later patches of a series it verifies", () => {
    for (const version of ["0.1.5-rc.9", "0.1.6-alpha.9", "0.1.7-rc.9"]) {
        assert.equal(
            accepted(version),
            true,
            `${version} is a later patch of a verified series, so the host must accept it`,
        );
    }
});

test("a manifest with no peer requirement is accepted by the same rule", () => {
    assert.equal(
        accepted("0.1.7-rc.2", {
            name: manifest.name,
            version: manifest.version,
        }),
        true,
        "the declaration is the protection: without peers the harness has nothing to check",
    );
});

test("the fact source and the probe agree about the harness packages", () => {
    assert.deepEqual(
        [...plan.packages].sort(),
        [...harnessPackages()],
        "compat/versions.json provisions a harness for the probe, so the two lists must be the same list",
    );
});

test("the matrix is exactly the versions the plan marks as blocking", () => {
    const blocking = plan.series
        .filter((entry) => entry.blocking)
        .flatMap((entry) => entry.versions);
    assert.deepEqual(matrixOf(plan), blocking);
    assert.ok(
        matrixOf(plan).length > 0,
        "a plan with nothing to run verifies nothing",
    );
});

test("every document that carries the supported-version table names what the plan lists", () => {
    // The READMEs answer "does my host match this plugin?", and the compatibility
    // documents explain the claim and how to move it, so all four carry the table.
    // One that falls behind the plan tells a reader something untrue.
    const documents = [
        "README.md",
        "README.zh.md",
        "docs/compatibility.md",
        "docs/compatibility.zh.md",
    ];
    for (const file of documents) {
        const text = readFileSync(join(root, file), "utf8");
        for (const entry of plan.series) {
            assert.ok(
                text.includes(entry.name),
                `${file} must name the ${entry.name} series, because the table a user reads is derived from the plan`,
            );
            for (const version of entry.versions)
                assert.ok(
                    text.includes(version),
                    `${file} must name the verified version ${version}`,
                );
        }
    }
});
