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
 * import that comes back would not resolve from here, and the guard names it
 * instead of leaving an unresolved-module error to guess at.
 *
 * `findPackage` and `harnessRoots` stay exported because the contract probe uses
 * them to read the harness that is installed on this machine.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Candidate roots that may hold an installed harness. */
export function harnessRoots() {
    const home =
        process.env.DSH_HOME ??
        join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
    const roots = [join(home, "profiles", "web")];
    if (process.env.APPDATA !== undefined)
        roots.push(join(process.env.APPDATA, "npm", "node_modules"));
    return roots;
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

/** Absolute path of the package root. */
export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Find the first top-level import of a package that would not resolve from here.
 *
 * Only a line that begins with `import` is read. The bundle's inlined code is
 * indented, so a top-level import declaration is the one shape that can start at
 * column zero, while the same word inside inlined text cannot reach it.
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
            `the host bundle imports ${JSON.stringify(bare)} by name, which resolves only inside an installed profile; ` +
                "inline that module into the bundle, or restore the specifier rewriting this loader used to do",
        );
    }
    return import(pathToFileURL(bundlePath).href);
}
