/**
 * Prettier configuration.
 *
 * Kept as `.mjs` on purpose. A config is loaded through Prettier's own
 * resolution, and an editor extension running Prettier inside its own runtime
 * cannot transform TypeScript: a `.ts` config there fails to load, which
 * Prettier reports nowhere and silently replaces with its defaults (two-space
 * indent), so every file still looks formatted while no rule applies. Plain ESM
 * needs no transform and therefore loads in the editor and on the command line
 * alike.
 *
 * @type {import("prettier").Config}
 */
export default {
    tabWidth: 4,
    useTabs: false,
    singleQuote: false,
    semi: true,
};
