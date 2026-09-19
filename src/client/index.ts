/**
 * Client half of the ultracode plugin.
 *
 * It registers one entry in the composer's right-hand tool row. The entry reads
 * the host's published value through the session projection hook that the shell
 * injects into every session-scoped seat, and it writes by asking the host to run
 * the `/ultracode` command. Nothing in this half fetches, polls, caches, or
 * guesses: the host owns the level, the projection carries it to the browser, and
 * the command channel changes it.
 *
 * The context and the seat props are the two browser surfaces this plugin
 * declares for itself in `./contract.ts`, because the packages that
 * would type them are seed modules served to the tab and cannot be named from
 * here. This module declares no boundary type of its own.
 *
 * @module @dessera/dsh-ultracode/client
 */
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";

import type { UltracodeChipProps } from "./contract.ts";
import type { UltracodeLevel } from "../host/protocol.ts";
import { UltracodeControl } from "./UltracodeControl.tsx";
import { changeLevel } from "./service.ts";
import { en, NS, zh } from "./locales.ts";

/** Dictionary namespace owned by this plugin. */
const NAMESPACE = NS;

/** Order of the control inside the tool row; before the model selector. */
const ORDER = 20;

/**
 * Runtime services this client plugin reads.
 *
 * `remote.commands` is declared because the write path needs it, and it is
 * provided by the API-remotes client entry, which the module graph loads before
 * plugin entries. It is not the read path: the projection hook arrives as a prop
 * of the seat, so a session whose projection never arrives still gets a visible
 * control rather than a missing one.
 */
export const inject = ["slots", "locale", "remote", "remote.commands"];

/**
 * The dictionaries, in the shape the harness's locale registry accepts.
 *
 * The namespace this plugin registers is merged into the harness's
 * locale-namespace table by `./contract.ts`, so this type is the
 * harness's own: the key union is the plugin's, and the locale set is every
 * built-in the harness ships. A key that exists in one language only, or a
 * shipped locale left out, is therefore a compile error rather than a label that
 * falls back to raw key text at runtime.
 */
function dictionaries(): Record<
    BuiltInLocaleId,
    LocaleDictOf<typeof NAMESPACE>
> {
    return { zh, en };
}

/**
 * Client plugin body.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
    ctx.effect?.(
        () => ctx.locale.register(NAMESPACE, dictionaries()),
        "dsh-ultracode: dictionaries",
    );
    const commands = ctx.remote?.commands;
    ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
            {
                name: "conversation.input.right",
                id: "dsh-ultracode",
                order: ORDER,
                locale: NAMESPACE,
                inject: (sessionId: string | undefined) => ({
                    sessionId,
                    // The write channel is injected only when it actually exists, so the
                    // control can tell "this session cannot change the level" from "the
                    // host has not published a level yet" and render each honestly.
                    changeLevel:
                        commands === undefined
                            ? undefined
                            : (target: string, level: UltracodeLevel) =>
                                  changeLevel(commands, target, level),
                }),
            },
            (props: UltracodeChipProps) => UltracodeControl(props),
        ),
    );
}
