/**
 * ESLint flat configuration.
 *
 * The linted surface is split by how much type information each family of files
 * can offer. The TypeScript sources under `src/` are covered by the project's own
 * tsconfig, so they run the type-aware rule set that catches discarded promises
 * and misused `any`. The build configuration at the repository root and the test
 * suite are outside that program, so they run the syntax-only set: asking the
 * parser for type information it cannot produce would fail rather than report.
 *
 * Formatting belongs to Prettier. `eslint-config-prettier` is applied last in
 * every block, so a rule that merely restates a formatting decision stays
 * switched off here instead of being reported twice.
 */
// ESLint core supplies `defineConfig`; the `typescript-eslint` root export
// carries the shared configs and the parser. Both are imported by name, because
// a binding missing here stops the whole configuration from loading rather than
// reporting on one file.
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/** Build artifacts and dependencies are never linted. */
const IGNORED = ["node_modules/**", "lib/**"];

/**
 * Rules shared by every linted file.
 *
 * None of these need type information, so they hold for the TypeScript sources
 * and the plain JavaScript files alike.
 */
const SHARED_RULES = {
    eqeqeq: ["error", "always", { null: "ignore" }],
    "no-debugger": "error",
    "no-duplicate-imports": "error",
    "no-else-return": "error",
    "no-implicit-coercion": "error",
    "no-throw-literal": "error",
    "no-unneeded-ternary": "error",
    "no-var": "error",
    "object-shorthand": "error",
    "prefer-const": "error",
};

/**
 * Rules that catch mistakes the compiler cannot see.
 *
 * Each entry here earns its place by reporting something that would otherwise
 * reach a running session: a promise nothing awaits, a callback that returns one
 * where a `void` was expected, or an `any` that silently switches checking off
 * across everything it touches.
 */
const TYPE_AWARE_RULES = {
    "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
    ],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
    ],
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/no-unused-vars": [
        "error",
        {
            args: "all",
            argsIgnorePattern: "^_",
            caughtErrors: "all",
            caughtErrorsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
        },
    ],
    "@typescript-eslint/only-throw-error": "error",
    "@typescript-eslint/require-await": "error",
};

/**
 * Rules deliberately switched off, and why.
 *
 * The two "unnecessary" rules assume strictly typed call sites. This plugin
 * instead reads host-owned props and event payloads through their published
 * shapes and then re-tests them, so an optional chain that the types call
 * needless is often the guard that keeps a loosely typed host value from
 * throwing during a render. Reporting those would push the code toward deleting
 * guards that exist on purpose.
 *
 * The `no-unsafe-*` family fires on the same boundary: the seats, event payloads
 * and layout props this plugin receives are declared `any` by the packages that
 * publish them, so every read of them counts as unsafe. The plugin answers with
 * local narrowing of its own, which is what the source already does; enabling the
 * family would demand an untyped-import shim rather than a safer program.
 *
 * `no-unnecessary-type-assertion` is off for the same reason: at the boundary the
 * assertion is what states the shape the plugin expects.
 */
const BOUNDARY_RULES = {
    "@typescript-eslint/no-unnecessary-condition": "off",
    "@typescript-eslint/no-unnecessary-type-assertion": "off",
    "@typescript-eslint/no-unsafe-argument": "off",
    "@typescript-eslint/no-unsafe-assignment": "off",
    "@typescript-eslint/no-unsafe-call": "off",
    "@typescript-eslint/no-unsafe-member-access": "off",
    "@typescript-eslint/no-unsafe-return": "off",
};

export default defineConfig(
    { ignores: IGNORED },
    {
        // A suppression comment that no longer suppresses anything is a defect of
        // its own, so stale `eslint-disable` directives are reported everywhere.
        linterOptions: { reportUnusedDisableDirectives: "error" },
    },
    {
        files: ["src/**/*.ts", "src/**/*.tsx"],
        extends: [
            tseslint.configs.recommendedTypeChecked,
            eslintConfigPrettier,
        ],
        languageOptions: {
            parserOptions: {
                // Every file in this block is inside the project's tsconfig, which
                // the service locates by walking up from the file, so the rule set
                // can rely on real types instead of guessing them.
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            ...SHARED_RULES,
            ...TYPE_AWARE_RULES,
            ...BOUNDARY_RULES,
            "no-console": "error",
        },
    },
    {
        // The build configuration is TypeScript at the repository root, and the
        // project's tsconfig program does not include it, so it gets the
        // syntax-only set rather than no linting at all.
        files: ["tsdown.config.ts"],
        extends: [tseslint.configs.recommended, eslintConfigPrettier],
        rules: SHARED_RULES,
    },
    {
        files: ["**/*.mjs", "**/*.js", "**/*.cjs"],
        extends: [tseslint.configs.recommended, eslintConfigPrettier],
        rules: SHARED_RULES,
    },
);
