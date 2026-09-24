/**
 * Client-side contract: the harness surfaces this plugin's client half registers
 * into, plus the two things it adds there of its own.
 *
 * Everything else about this half comes from types the harness publishes. The
 * seat the control occupies is declared by the composer package, and its props
 * are composed by the slot registry from that declaration plus the session
 * standard kit — so the props type here is derived, not copied. What this file
 * adds is the plugin's own namespace and its own injected member:
 *
 * - the locale namespace `ultracode`, with the dictionary key union the plugin
 *   owns, which is what makes `locale.register` and the seat's `t` narrow to
 *   real keys;
 * - the `changeLevel` callback the registration injects into the seat.
 *
 * The empty type imports below are the mechanism, not decoration. A
 * `declare module` contributes only from a module-scoped file, and these
 * packages describe themselves that way: the slot table, the session standard
 * kit and the composer's seat are each merged in from the package that owns
 * them. Without these edges the slot table is empty, `conversation.input.right`
 * is not a key, and `ctx.slots` does not exist.
 *
 * Only the client half imports this file. The host half's contract lives in the
 * sibling tree at `src/host/contract.ts`.
 *
 * @module @dessera/dsh-ultracode/client/contract
 */
import type {
    PropsLocale,
    PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";

/**
 * The type-only edges that bring the client packages into this program.
 *
 * `dsh-client-ui-renderer/client` is what provides `ctx.slots`; the composer
 * package is what declares the seat this plugin registers into; the session
 * package is what merges the session identity, the session hook and the
 * projection hook into every session-scoped seat's props; the locale package is
 * what provides `ctx.locale`; the commands remote entry is what merges the
 * command executor onto `ctx.remote`; and the gateway client entry is what
 * declares `ctx.remote` itself.
 *
 * The gateway entry is imported even though nothing here names a type from it.
 * That service used to arrive in the program only because another package's
 * declarations referenced it, and the oldest supported series does not, so
 * without this edge the write path reads a `ctx.remote` the compiler cannot see.
 */
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-commands/remote";

import type { UltracodeLevel } from "../host/protocol.ts";
import type { ChangeOutcome } from "./service.ts";

/**
 * The dictionary keys this plugin's namespace owns.
 *
 * Imported rather than restated: `./locales.ts` derives the union from the
 * Chinese dictionary, which is the key set's source of truth.
 */
import type { UltracodeKey } from "./locales.ts";

declare module "@deepseek-ai/dsh-client-ui-slots" {
    interface LocaleNamespaceMap {
        /**
         * The composer control's own copy.
         *
         * Registering a namespace here is what puts the typed `t` seat on a seat
         * whose registration declares `locale: 'ultracode'`, and it is what makes
         * `LocaleRuntime.register` check the dictionaries against this key union
         * instead of accepting any string-keyed record.
         */
        ultracode: UltracodeKey;
    }
}

/**
 * Props the harness composes for one entry of the composer's right-hand row.
 *
 * `PropsRuntime` is the harness's own composition for the seat: its owner share
 * (empty — the composer passes nothing to this seat), the session standard kit
 * that `dsh-client-ui-session` merges in, and the global standard props.
 * `PropsLocale` adds the `t` seat, because the registration in `index.ts`
 * declares this namespace. `changeLevel` is the one member this plugin injects.
 *
 * The seat's kind and scope are the harness's too: it is a `list` slot, so the
 * registration carries an `id` and an `order` rather than shadowing anything.
 */
export type UltracodeChipProps = PropsRuntime<"conversation.input.right"> &
    PropsLocale<"ultracode"> & {
        /** Run one level change through the host's command; absent when no writer is available. */
        readonly changeLevel?: (
            sessionId: string,
            level: UltracodeLevel,
        ) => Promise<ChangeOutcome>;
    };
