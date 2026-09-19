import { defineConfig } from "tsdown";

// tsdown transpiles and bundles; it never type-checks. `pnpm typecheck` owns
// that. `prepare` runs after a git install, so the build has to be
// self-contained and must not assume a monorepo checkout.
// fixedExtension: false keeps .js/.d.ts extensions, which is what the
// package's `exports` map points at and what `"type": "module"` implies.

/**
 * Host half: a Node library emitted into `lib/`, loaded by the loader row's
 * module specifier. The harness packages it names are type-only imports, so
 * they are erased; the one runtime dependency, the schema builder, is bundled
 * rather than externalized because a locally linked plugin resolves bare
 * specifiers from its own real path, which sits outside the profile.
 */
const lib = {
    entry: ["src/host/index.ts"],
    outDir: "lib",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    dts: true,
    clean: true,
    fixedExtension: false,
};

// Client half: a browser bundle handed to dsh's client-modules. The artifact has
// to be the `__ModuleLoader__.load` handshake form in CJS, because the factory
// resolves its externals through the injected `require`.
// Externals may only name packages the browser platform module table answers:
// react and its JSX runtime are seeded there, and inlining a second copy of
// either would break hooks. Everything else is bundled (noExternal), which keeps
// a `require` the module table cannot answer out of the artifact.
const CLIENT_EXTERNALS = ["react", "react-dom", "react/jsx-runtime"];

/** Client half: the composer control bundle, emitted as `lib/client.js`. */
const client = {
    name: "@dessera/dsh-ultracode/client",
    entry: { client: "src/client/index.ts" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    dts: false,
    clean: false,
    sourcemap: true,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) =>
        CLIENT_EXTERNALS.includes(id) ? undefined : true,
    define: {
        "process.env.NODE_ENV": JSON.stringify(
            process.env.NODE_ENV ?? "production",
        ),
    },
    outputOptions: {
        // The artifact name is fixed because package.json's `exports["./client"]`
        // is what names the file the loader reads; the loader's id is the package
        // name the module registers under, not a file name.
        entryFileNames: "client.js",
        banner: 'window.__ModuleLoader__.load({ id: "@dessera/dsh-ultracode", factory: (require) => {',
        footer: "return module.exports; } });",
        intro: "var module = { exports: {} }; var exports = module.exports;",
    },
};

// Array form: the Node library first (it owns `clean`), the client bundle
// second (clean off, so the two do not erase each other).
export default defineConfig([lib, client]);
