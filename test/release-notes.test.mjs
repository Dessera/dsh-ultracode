/**
 * Tests for the release notes generator.
 *
 * The generator is the only thing that writes a GitHub Release, and a Release is
 * the record a person reads to decide whether a version fits their host. That makes
 * two properties worth pinning here. The version list must come from the tree
 * being released rather than from a list someone maintains beside it, and the
 * sentence about it must say which source it used, because a tag that shipped
 * before the compatibility plan existed was tested against the version it pinned
 * and must not be described as if the plan had covered it.
 *
 * Every case builds a small tree in a temporary directory, so the facts are the
 * ones the test wrote and nothing depends on this repository's own state.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
    buildReleaseNotes,
    parseArgs,
    readReleaseFacts,
} from "../scripts/release-notes.mjs";

/** A compatibility plan that lists two blocking series and one that is not. */
const PLAN = {
    series: [
        { name: "0.1.5-rc", versions: ["0.1.5-rc.3"], blocking: true },
        {
            name: "0.1.6-alpha",
            versions: ["0.1.6-alpha.1", "0.1.6-alpha.2"],
            blocking: true,
        },
        { name: "0.1.7-rc", versions: ["0.1.7-rc.2"], blocking: false },
    ],
    heads: [{ tag: "next", blocking: false }],
    packages: ["@deepseek-ai/dsh-tools"],
};

/**
 * Write a tree in a temporary directory and hand it to a test.
 * @param {Record<string, unknown>} files - relative path to content; objects are written as JSON.
 * @param fn - the test body, called with the tree's path.
 */
function withTree(files, fn) {
    const root = mkdtempSync(join(tmpdir(), "dsh-ultracode-notes-"));
    try {
        for (const [relative, content] of Object.entries(files)) {
            const path = join(root, relative);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(
                path,
                typeof content === "string"
                    ? content
                    : JSON.stringify(content, null, 4),
            );
        }
        fn(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

/**
 * A manifest that resolves, with the fields a case wants to change.
 * @param fields - the fields to override.
 * @returns the manifest object.
 */
function manifestOf(fields = {}) {
    return {
        name: "@dessera/dsh-ultracode",
        version: "0.1.1",
        repository: {
            type: "git",
            url: "git+https://github.com/Dessera/dsh-ultracode.git",
        },
        devDependencies: {
            "@deepseek-ai/dsh-agent": "0.1.6-alpha.2",
            "@deepseek-ai/dsh-tools": "0.1.6-alpha.2",
            typescript: "^6.0.3",
        },
        ...fields,
    };
}

/** The workflow matrix a tree carries, as `ci.yml` spells it. */
const CI = `jobs:
    check:
        strategy:
            matrix:
                node: ["22.x", "24.x"]
`;

test("the compatibility plan decides the version list when the tag carries one", () => {
    withTree(
        {
            "package.json": manifestOf(),
            "compat/versions.json": PLAN,
        },
        (root) => {
            const body = buildReleaseNotes(
                readReleaseFacts(root, { tag: "v0.1.1" }),
            );

            assert.match(
                body,
                /every version `compat\/versions\.json` lists at this tag/u,
            );
            assert.ok(
                body.indexOf("`0.1.5-rc.3`") < body.indexOf("`0.1.6-alpha.1`"),
                "the plan's order is kept",
            );
            assert.ok(
                body.indexOf("`0.1.6-alpha.1`") <
                    body.indexOf("`0.1.6-alpha.2`"),
                "a series lists its versions oldest first",
            );
            assert.doesNotMatch(
                body,
                /0\.1\.7-rc\.2/u,
                "a series the plan does not block is not a version the release claims",
            );
        },
    );
});

test("a tag without a compatibility plan records the version it pins", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const body = buildReleaseNotes(
            readReleaseFacts(root, { tag: "v0.1.1" }),
        );

        assert.match(
            body,
            /- DSH `0\.1\.6-alpha\.2` — the version this tree pins in `devDependencies`\./u,
        );
        assert.doesNotMatch(body, /compat\/versions\.json/u);
    });
});

test("a tree that pins more than one version records every one of them", () => {
    withTree(
        {
            "package.json": manifestOf({
                devDependencies: {
                    "@deepseek-ai/dsh-agent": "0.1.6-alpha.2",
                    "@deepseek-ai/dsh-tools": "0.1.7-rc.2",
                },
            }),
        },
        (root) => {
            const body = buildReleaseNotes(
                readReleaseFacts(root, { tag: "v0.1.1" }),
            );

            assert.match(body, /`0\.1\.6-alpha\.2` and `0\.1\.7-rc\.2`/u);
            assert.match(body, /the versions this tree pins/u);
        },
    );
});

test("a plan that cannot be read is refused rather than passed over", () => {
    withTree(
        {
            "package.json": manifestOf(),
            "compat/versions.json": "{ not json",
        },
        (root) => {
            assert.throws(
                () => readReleaseFacts(root, { tag: "v0.1.1" }),
                /cannot be read as JSON/u,
            );
        },
    );
});

test("a tag that names a different version than the tree is refused", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        assert.throws(
            () => readReleaseFacts(root, { tag: "v0.1.2" }),
            /v0\.1\.2 does not name the version this tree carries \(0\.1\.1\)/u,
        );
    });
});

test("a tree that names no GitHub repository is refused", () => {
    withTree(
        { "package.json": manifestOf({ repository: undefined }) },
        (root) => {
            assert.throws(
                () => readReleaseFacts(root, { tag: "v0.1.1" }),
                /must name a GitHub repository/u,
            );
        },
    );
});

test("the Node.js lines come from the workflow the tag carries", () => {
    withTree(
        { "package.json": manifestOf(), ".github/workflows/ci.yml": CI },
        (root) => {
            const body = buildReleaseNotes(
                readReleaseFacts(root, { tag: "v0.1.1" }),
            );

            assert.match(
                body,
                /- Node\.js 22\.x and 24\.x — the matrix `\.github\/workflows\/ci\.yml` runs at this tag\./u,
            );
        },
    );
});

test("a tag with no workflow claims no Node.js lines", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const body = buildReleaseNotes(
            readReleaseFacts(root, { tag: "v0.1.1" }),
        );

        assert.doesNotMatch(body, /Node\.js/u);
    });
});

test("the peer range is quoted when the tree declares one", () => {
    withTree(
        {
            "package.json": manifestOf({
                peerDependencies: {
                    "@deepseek-ai/dsh": ">=0.1.5-rc.3 <0.1.6-0",
                },
            }),
        },
        (root) => {
            const body = buildReleaseNotes(
                readReleaseFacts(root, { tag: "v0.1.1" }),
            );

            assert.match(
                body,
                /the declared range is `>=0\.1\.5-rc\.3 <0\.1\.6-0`/u,
            );
        },
    );
});

test("a tree with no peer requirement claims no range", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const body = buildReleaseNotes(
            readReleaseFacts(root, { tag: "v0.1.1" }),
        );

        assert.doesNotMatch(body, /declared range/u);
    });
});

test("the tarball integrity is recorded only when the registry reported one", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const facts = readReleaseFacts(root, { tag: "v0.1.1" });

        assert.doesNotMatch(buildReleaseNotes(facts), /Tarball integrity/u);
        assert.match(
            buildReleaseNotes({ ...facts, integrity: "sha512-abc" }),
            /- Tarball integrity: `sha512-abc`/u,
        );
    });
});

test("the commit is linked when it is known and the tag is linked otherwise", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const facts = readReleaseFacts(root, {
            tag: "v0.1.1",
            sha: "8383b973120103852fae75a771a7139b8f9579ad",
        });

        assert.match(
            buildReleaseNotes(facts),
            /Built and tested from \[`8383b97`\]\(https:\/\/github\.com\/Dessera\/dsh-ultracode\/commit\/8383b973120103852fae75a771a7139b8f9579ad\)\./u,
        );
        assert.match(
            buildReleaseNotes({ ...facts, sha: "" }),
            /Built and tested from \[`v0\.1\.1`\]\(https:\/\/github\.com\/Dessera\/dsh-ultracode\/releases\/tag\/v0\.1\.1\)\./u,
        );
    });
});

test("the compare link appears only when the previous release is known", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const facts = readReleaseFacts(root, { tag: "v0.1.1" });

        assert.doesNotMatch(buildReleaseNotes(facts), /Full changelog/u);
        assert.match(
            buildReleaseNotes({ ...facts, previous: "v0.1.0" }),
            /\*\*Full changelog\*\*: https:\/\/github\.com\/Dessera\/dsh-ultracode\/compare\/v0\.1\.0\.\.\.v0\.1\.1/u,
        );
    });
});

test("the notes name the package, the version and how to install it", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const body = buildReleaseNotes(
            readReleaseFacts(root, { tag: "v0.1.1" }),
        );

        assert.match(body, /^## @dessera\/dsh-ultracode v0\.1\.1$/mu);
        assert.match(
            body,
            /dsh plugin --profile web add @dessera\/dsh-ultracode@0\.1\.1/u,
        );
        assert.match(
            body,
            /https:\/\/www\.npmjs\.com\/package\/@dessera\/dsh-ultracode\/v\/0\.1\.1/u,
        );
    });
});

test("the same facts always produce the same notes", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const facts = readReleaseFacts(root, {
            tag: "v0.1.1",
            sha: "8383b97",
            previous: "v0.1.0",
            integrity: "sha512-abc",
        });

        assert.equal(buildReleaseNotes(facts), buildReleaseNotes(facts));
    });
});

test("the notes are written in English, because a Release is read outside this repository", () => {
    withTree(
        {
            "package.json": manifestOf({
                peerDependencies: { "@deepseek-ai/dsh": ">=0.1.5-rc.3" },
            }),
            "compat/versions.json": PLAN,
            ".github/workflows/ci.yml": CI,
        },
        (root) => {
            const body = buildReleaseNotes(
                readReleaseFacts(root, {
                    tag: "v0.1.1",
                    sha: "8383b97",
                    previous: "v0.1.0",
                    integrity: "sha512-abc",
                }),
            );

            assert.doesNotMatch(body, /[\u3400-\u9fff\uf900-\ufaff]/u);
        },
    );
});

test("an unknown option is refused rather than ignored", () => {
    assert.throws(
        () => parseArgs(["--tag", "v0.1.1", "--intergrity", "sha512-abc"]),
        /unknown option --intergrity/u,
    );
});

test("an option with no value is refused", () => {
    assert.throws(() => parseArgs(["--tag"]), /--tag needs a value/u);
    assert.throws(
        () => parseArgs(["--root", "--tag", "v0.1.1"]),
        /--root needs a value/u,
    );
});

test("an argument that is not an option is refused", () => {
    assert.throws(() => parseArgs(["v0.1.1"]), /unexpected argument v0\.1\.1/u);
});

test("the options the workflow passes are read", () => {
    assert.deepEqual(
        parseArgs([
            "--root",
            "tree",
            "--tag",
            "v0.1.1",
            "--sha",
            "8383b97",
            "--previous",
            "v0.1.0",
            "--integrity",
            "sha512-abc",
        ]),
        {
            root: "tree",
            tag: "v0.1.1",
            sha: "8383b97",
            previous: "v0.1.0",
            integrity: "sha512-abc",
        },
    );
});

test("an empty previous tag is read as no previous release", () => {
    withTree({ "package.json": manifestOf() }, (root) => {
        const facts = readReleaseFacts(root, { tag: "v0.1.1", previous: "" });

        assert.doesNotMatch(buildReleaseNotes(facts), /Full changelog/u);
    });
});
