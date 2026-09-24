/**
 * The harness contract this plugin binds to, as data.
 *
 * The contract probe asserts each surface below against the harness that is
 * installed on the machine; the compatibility runner installs a harness per
 * version and needs the same package list to provision one. Both read this
 * module, so the set of packages a run installs and the set of packages a run
 * asserts against cannot drift apart.
 *
 * @module test/support/harness-contract
 */

/** The harness package the probe uses to decide whether a harness is present. */
export const SENTINEL = "@deepseek-ai/dsh-tools";

/**
 * One host service the plugin resolves by name.
 *
 * A service is registered by its class constructor calling `super(ctx, '<name>')`,
 * so that call is the marker.
 */
export const HOST_SERVICES = [
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
        key: "sessionProjections",
        provider: "@deepseek-ai/dsh-session-projection",
        entry: "lib/index.js",
        marker: 'super(ctx, "sessionProjections")',
    },
];

/**
 * One client-side name the browser half binds to.
 *
 * What remains here is what the compiler does not cover. The seat key, the
 * standard props and the projection tables are all imported types now, so a
 * rename of those fails the build. These entries are the rest: runtime names
 * whose definitions live in the packages that publish them — the seat the
 * composer creates, the slot service the renderer provides, the locale runtime
 * the locale package creates, and the `slots`, `locale`, `remote` and
 * `remote.commands` services the client's inject list is answered by — plus the
 * runtime shape the composer gives that seat, and
 * the one derivation rule the value depends on: the prop name a projection key
 * turns into is computed at runtime, so a change to that rule is invisible to the
 * type system.
 */
export const CLIENT_NAMES = [
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
export const LOG_EVENTS = [
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
        name: "user/message",
        provider: "@deepseek-ai/dsh-agent-loop",
        entry: "lib/index.js",
    },
];

/** One session accessor the host half reads from a live agent. */
export const SESSION_ACCESSORS = [
    {
        what: "the immutable session header the plugin reads for delegation depth",
        provider: "@deepseek-ai/dsh-session",
        entry: "lib/types/types.d.ts",
        marker: "interface SessionHeader",
    },
];

/**
 * Every harness package the probe reads a surface from.
 *
 * A run that wants the probe to assert anything has to install all of these: a
 * missing package is reported as a coverage gap, and a package that is present
 * but renamed is reported as a broken contract.
 * @returns the package specifiers, deduplicated and sorted.
 */
export function harnessPackages() {
    const providers = [
        ...HOST_SERVICES,
        ...CLIENT_NAMES,
        ...LOG_EVENTS,
        ...SESSION_ACCESSORS,
    ].map((surface) => surface.provider);
    return [...new Set(providers)].sort();
}
