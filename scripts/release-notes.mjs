/**
 * Release notes for one tag.
 *
 * A release owes two records: the package on the registry, and a GitHub Release
 * that says what that package was built and tested against. This script writes the
 * second one, from facts that can be re-read later rather than from a hand-written
 * summary.
 *
 * Where each fact comes from, and why:
 *
 * - The harness versions come from the `@deepseek-ai/dsh` packages pinned in
 *   `devDependencies`. That pin is what the compiler checks the source against and
 *   what the gate runs against, so it is the version a Release may claim.
 * - The Node.js lines come from the matrix of `.github/workflows/ci.yml` at the
 *   tag. A tag that carries no workflow gets no such line, rather than a claim the
 *   tag cannot support.
 * - The commit, the previous tag and the tarball integrity are handed in by the
 *   caller, because the workflow is the only place that can see the registry.
 *
 * The script reads a directory and writes Markdown to standard output, so the same
 * code writes every release: `--root` points at the tagged tree, which is where the
 * facts live.
 *
 * @module @dessera/dsh-ultracode/scripts/release-notes
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The runtime package every harness dependency name starts with. */
const RUNTIME_PREFIX = "@deepseek-ai/dsh";

/** The options the command line accepts, so that a typo is refused rather than ignored. */
const OPTIONS = new Set(["root", "tag", "sha", "previous", "integrity"]);

/** The usage text. */
const USAGE = `Usage: node scripts/release-notes.mjs --tag <tag> [options]

  --root <dir>        Tree to read the facts from (default: the working directory)
  --tag <tag>         Tag being released, for example v0.1.1 (required)
  --sha <sha>         Commit the tag points at; the notes link the tag when absent
  --previous <tag>    Previous release tag, for the compare link
  --integrity <s>     sha512 the registry serves for this version
  --help              Print this text

Exit codes: 0 the notes were written, 1 the facts could not be read,
2 the command line was wrong.`;

/**
 * Join items into an English list.
 * @param {string[]} items - the items, already formatted.
 * @returns {string} `a`, `a and b`, or `a, b and c`.
 */
function listOf(items) {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Read the identity of a tree.
 * @param {string} root - directory holding the manifest.
 * @returns {{ name: string, version: string, slug: string, url: string, fields: Record<string, unknown> }} the manifest facts.
 * @throws when the manifest is unusable or names no GitHub repository.
 */
function manifestOf(root) {
    const path = join(root, "package.json");
    let fields;
    try {
        fields = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(`${path} cannot be read as JSON (${String(error)})`);
    }
    if (typeof fields.name !== "string" || typeof fields.version !== "string")
        throw new Error(`${path} must carry a name and a version`);
    const url = String(fields.repository?.url ?? "");
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(url);
    if (match === null)
        throw new TypeError(
            `${path} must name a GitHub repository in repository.url, because the notes link to it; found ${JSON.stringify(url)}`,
        );
    const [, owner, name] = match;
    return {
        name: fields.name,
        version: fields.version,
        slug: `${owner}/${name}`,
        url: `https://github.com/${owner}/${name}`,
        fields,
    };
}

/**
 * Read the harness versions a tree was built and tested against.
 * @param {string} root - directory holding the tree.
 * @param {Record<string, unknown>} fields - the tree's manifest.
 * @returns {string[]} the pinned `@deepseek-ai/dsh` versions, sorted.
 * @throws when the manifest pins none of them.
 */
function runtimeVersionsOf(root, fields) {
    const dependencies = fields.devDependencies ?? {};
    const versions = [
        ...new Set(
            Object.entries(dependencies)
                .filter(
                    ([name]) =>
                        name === RUNTIME_PREFIX ||
                        name.startsWith(`${RUNTIME_PREFIX}-`),
                )
                .map(([, version]) => String(version)),
        ),
    ].sort();
    if (versions.length === 0)
        throw new Error(
            `${join(root, "package.json")} pins no ${RUNTIME_PREFIX} package, so the notes have no version to record`,
        );
    return versions;
}

/**
 * Read the Node.js lines a tree's workflow runs.
 * @param {string} root - directory holding the tree.
 * @returns {string[]} the versions of the first `node:` matrix found, or an empty list.
 */
function nodeLinesOf(root) {
    const path = join(root, ".github", "workflows", "ci.yml");
    if (!existsSync(path)) return [];
    const match = /node:\s*\[([^\]]*)\]/u.exec(readFileSync(path, "utf8"));
    if (match === null) return [];
    return [...match[1].matchAll(/"([^"]+)"/gu)].map((found) => found[1]);
}

/**
 * Read every fact the notes are built from.
 * @param {string} root - directory holding the tagged tree.
 * @param {{ tag: string, sha?: string, previous?: string, integrity?: string }} options - the values the workflow supplies.
 * @returns {object} the facts {@link buildReleaseNotes} takes.
 */
export function readReleaseFacts(root, options) {
    const { fields, ...identity } = manifestOf(root);
    if (options.tag !== `v${identity.version}`)
        throw new Error(
            `tag ${options.tag} does not name the version this tree carries (${identity.version}), so the notes would state two different versions`,
        );
    const peer = fields.peerDependencies?.[RUNTIME_PREFIX];
    return {
        ...identity,
        tag: options.tag,
        sha: options.sha ?? "",
        previous: options.previous ?? "",
        integrity: options.integrity ?? "",
        runtime: runtimeVersionsOf(root, fields),
        peerRange: typeof peer === "string" ? peer : "",
        nodeLines: nodeLinesOf(root),
    };
}

/**
 * Write the release notes for one set of facts.
 *
 * The facts are the only input, so the same facts always produce the same notes.
 * @param {object} facts - the facts {@link readReleaseFacts} returns.
 * @returns {string} the Markdown body, ending in one newline.
 */
export function buildReleaseNotes(facts) {
    const lines = [];
    const versions = facts.runtime.map((version) => `\`${version}\``);

    lines.push(`## ${facts.name} ${facts.tag}`, "");
    const built = facts.sha
        ? `[\`${facts.sha.slice(0, 7)}\`](${facts.url}/commit/${facts.sha})`
        : `[\`${facts.tag}\`](${facts.url}/releases/tag/${facts.tag})`;
    lines.push(`Built and tested from ${built}.`, "");

    lines.push("### Built and tested against", "");
    const pinned = facts.runtime.length > 1 ? "versions" : "version";
    lines.push(
        `- DSH ${listOf(versions)} — the ${pinned} this tree pins in \`devDependencies\`.`,
    );
    if (facts.peerRange !== "")
        lines.push(
            `- A DSH host outside that list refuses to load the plugin: the declared range is \`${facts.peerRange}\`.`,
        );
    if (facts.nodeLines.length > 0)
        lines.push(
            `- Node.js ${listOf(facts.nodeLines)} — the matrix \`.github/workflows/ci.yml\` runs at this tag.`,
        );
    lines.push("");

    lines.push(
        "### Install",
        "",
        "```sh",
        `dsh plugin --profile web add ${facts.name}@${facts.version}`,
        "```",
        "",
    );

    lines.push(
        "### npm",
        "",
        `- Package: https://www.npmjs.com/package/${facts.name}/v/${facts.version}`,
    );
    if (facts.integrity !== "")
        lines.push(`- Tarball integrity: \`${facts.integrity}\``);
    lines.push("");

    if (facts.previous !== "")
        lines.push(
            `**Full changelog**: ${facts.url}/compare/${facts.previous}...${facts.tag}`,
            "",
        );

    return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Read the command line.
 *
 * Exported because the parser is the one part of this script a test can hold: it
 * decides whether a mistyped option is refused or silently dropped, and a dropped
 * option would write a Release that is missing a fact.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string>} the options.
 * @throws on an unknown option or a flag with no value.
 */
export function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--help") {
            options.help = "true";
            continue;
        }
        if (!arg.startsWith("--"))
            throw new Error(`unexpected argument ${arg}`);
        const name = arg.slice(2);
        if (!OPTIONS.has(name)) throw new Error(`unknown option ${arg}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--"))
            throw new Error(`${arg} needs a value`);
        options[name] = value;
        index += 1;
    }
    return options;
}

/**
 * Run the command line.
 * @returns {number} the exit code.
 */
function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(
            `release-notes: ${String(error.message)}\n\n${USAGE}\n`,
        );
        return 2;
    }
    if (options.help === "true") {
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }
    if (options.tag === undefined) {
        process.stderr.write(`release-notes: --tag is required\n\n${USAGE}\n`);
        return 2;
    }
    try {
        const facts = readReleaseFacts(options.root ?? process.cwd(), options);
        process.stdout.write(buildReleaseNotes(facts));
        return 0;
    } catch (error) {
        process.stderr.write(`release-notes: ${String(error.message)}\n`);
        return 1;
    }
}

// The tests import this module, so the command line runs only when it is the entry
// point rather than whenever the module is loaded.
if (process.argv[1] === fileURLToPath(import.meta.url))
    process.exitCode = main();
