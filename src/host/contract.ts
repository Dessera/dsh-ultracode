/**
 * Host-side contract: the harness types the host half names, and the one place
 * this plugin registers a key of its own.
 *
 * Nothing here restates a harness shape. Every host surface the plugin touches
 * has a published type, so this file imports those types and adds exactly one
 * thing of its own: the `ultracode` key in each of the two merge tables the
 * session projection registry is generic over. A renamed harness member then
 * becomes a compile error in the module that uses it, and the plugin keeps no
 * second copy of a shape it does not own.
 *
 * The two tables are declared in `@deepseek-ai/dsh-session-projection/types`, a
 * pure-type outlet that re-exports them without the package root's Cordis
 * context merges. That outlet is the augmentation target below, so the
 * augmentation carries no host-side merges of its own. The unit contract itself
 * — `ProjectionDefinition`, which is generic over those tables — is published
 * only from the package root, and that is where it is imported from.
 *
 * The module scope is load-bearing, not stylistic. A `declare module` written in
 * a file with no imports or exports is an ambient module declaration, which
 * replaces the named module instead of extending it; only a module-scoped file
 * augments. The empty type imports below therefore do double duty: they are what
 * brings each service's context merge into the program, and they are what keeps
 * this file a module so the registration above lands on the harness's own table.
 *
 * Only the host half imports this file. The browser half's contract lives beside
 * it in `src/client/contract.ts`.
 *
 * @module @dessera/dsh-ultracode/contract
 */
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";

/**
 * The empty type imports that bring each host package's context merge into this
 * program.
 *
 * A Cordis service declares itself by merging into the framework's `Context`
 * interface, so a package that is installed but never imported contributes
 * nothing: `ctx.tools` would not exist as far as the compiler is concerned.
 * These edges are type-only and empty, which is the form the harness itself
 * uses, and they erase completely at build time — the plugin still declares its
 * services through `inject` and reads them off the context at runtime.
 *
 * The last one is named here even though the plugin treats it as optional.
 * The merge is what types the guarded read, and the optionality lives in the
 * runtime guard rather than in the type.
 */
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";

import type { UltracodeWire } from "./protocol.ts";
import type { ProjectionState } from "./reducer.ts";

declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        /**
         * The state this plugin's fold keeps for one session.
         *
         * The value is the plugin's own `ProjectionState`, so the registry checks
         * every registration and every read against the shape the reducer actually
         * builds rather than against a copy of it. Host-only keys appear in this
         * table alone.
         */
        ultracode: ProjectionState;
    }
    interface SessionProjectionMap {
        /**
         * The value this plugin publishes to the browser.
         *
         * `UltracodeWire` is the same object the fold stores, reused by reference
         * while no visible field changes, which is what lets the registry's
         * `Object.is` check suppress unchanged frames.
         */
        ultracode: UltracodeWire;
    }
}

/**
 * The projection unit contract, with this plugin's key applied.
 *
 * The registry's own `ProjectionDefinition` is generic over the two merge tables
 * above. Naming the key here — and the state type beside it, which is how the
 * registry's `register` overloads take it — is what makes `init`, `apply` and
 * `wire.view` check against the plugin's types instead of the empty tables'
 * `never`. Because the key is in both tables, `wire` is present rather than
 * `never`, which is the form a publishing unit registers.
 */
export type UltracodeProjectionUnit = ProjectionDefinition<
    "ultracode",
    ProjectionState
>;
