/**
 * Loader for the built host bundle, for tests only.
 *
 * The bundle is self-contained: every harness module it once imported by name is
 * inlined, so the artifact can be imported straight from this checkout. That is
 * why there is no rewriting left here — an earlier version turned each bare
 * specifier into a dynamic import of the absolute path an installed profile
 * provides and staged the result in a temp file, and that machinery went away
 * with the last bare import. What remains of it is the guard in
 * {@link loadHostBundle}, which is the case the rewriting existed for: a bare
 * import that comes back would load whichever copy of the harness package the
 * reader resolves, which is not the copy the installed profile runs, and the guard
 * names the specifier instead of letting the suite test a different copy of the
 * code.
 *
 * `findPackage`, `findPackageWithin` and `harnessRoots` stay exported because the
 * contract probe and the compatibility runner use them to read, and to refuse a
 * harness other than, the one this machine or a matrix leg installed.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Candidate roots that may hold an installed harness. */
export function harnessRoots() {
    const home =
        process.env.DSH_HOME ??
        join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
    // The profile is the only root. An ambient global installation used to be
    // appended here, and it never resolved anything the profile did not: the
    // packages the running host loads sit in the profile's own dependency tree.
    // Keeping it would mean a run could report on a harness the caller never
    // asked for, which is exactly the drift a compatibility run must not have.
    return [join(home, "profiles", "web")];
}

/**
 * Locate one harness package.
 * @param name - the package specifier to resolve.
 * @returns the absolute entry path, or undefined when nothing on this machine provides it.
 */
export function findPackage(name) {
    for (const anchor of harnessRoots()) {
        try {
            return createRequire(join(anchor, "package.json")).resolve(name);
        } catch {
            /* try the next root */
        }
    }
    return undefined;
}

/**
 * Locate one harness package and refuse a result that sits outside a root.
 *
 * Node resolves a bare specifier by walking up from the anchor, so a successful
 * resolution says nothing about which installation answered it. A run that names
 * one harness has to know it read that harness: this is the check that turns
 * "resolved somehow" into "resolved from here".
 * @param name - the package specifier to resolve.
 * @param within - absolute directory the resolved path must sit under.
 * @returns the absolute entry path.
 * @throws when the package is missing or resolves outside `within`.
 */
export function findPackageWithin(name, within) {
    const resolved = findPackage(name);
    if (resolved === undefined)
        throw new Error(
            `${name} is not installed under ${within}; provision this harness before reading it`,
        );
    const walk = relative(resolve(within), resolved);
    if (walk.startsWith("..") || isAbsolute(walk))
        throw new Error(
            `${name} resolved to ${resolved}, which is outside ${within}; the run would have read a different installation`,
        );
    return resolved;
}

/** Absolute path of the package root. */
export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Find the first top-level import of a package that would not resolve from here.
 *
 * Only a line that begins with `import` is read. The host artifact is flat ESM,
 * so its own statements and the code bundled into it both start at column zero and
 * indentation tells them apart nowhere; what makes this test exact is that the
 * only line of the built artifact beginning with that word is the artifact's own
 * external import.
 * @param source - the bundle's text.
 * @returns the offending specifier, or undefined when every import is local.
 */
function bareImportOf(source) {
    for (const match of source.matchAll(
        /^import\s*(?:[^"']*?\bfrom\s*)?["']([^"']+)["']/gmu,
    )) {
        const specifier = match[1];
        if (!/^(?:node:|\.{0,2}\/|file:|data:|https?:)/u.test(specifier))
            return specifier;
    }
    return undefined;
}

/**
 * Import the built host bundle.
 * @param bundlePath - path of the built host bundle.
 * @returns the plugin module's exports.
 */
export async function loadHostBundle(bundlePath = join(root, "lib/index.js")) {
    const bare = bareImportOf(readFileSync(bundlePath, "utf8"));
    if (bare !== undefined) {
        throw new Error(
            `the host bundle imports ${JSON.stringify(bare)} by name, so it would load whichever copy the reader resolves rather than the one the profile runs; ` +
                "inline that module into the bundle, or restore the specifier rewriting this loader used to do",
        );
    }
    return import(pathToFileURL(bundlePath).href);
}
