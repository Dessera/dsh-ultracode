/**
 * Write path of the composer control.
 *
 * The control never writes state itself. It asks the host to run the same
 * command a person would type, so the level change is recorded in the session
 * log like any other command and the session's own command lifecycle publishes
 * it back to every open tab. That round trip is what makes the control and the
 * `/ultracode` command incapable of disagreeing: there is one writer, and it is
 * the host.
 *
 * @module @dessera/dsh-ultracode/client/service
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

import { COMMAND_NAME, type UltracodeLevel } from "../host/protocol.ts";

/** What the caller learns about one attempted change. */
export interface ChangeOutcome {
    /** Whether the host accepted the change. */
    readonly ok: boolean;
    /** The host's own message, when it refused or reported something. */
    readonly message?: string | undefined;
}

/**
 * The slice of the client remote the write path uses.
 *
 * The harness's command client entry types `ctx.remote.commands.execute`, so
 * this names that member's own shape rather than restating it. Only the settled
 * value's payload is read, and the comment on {@link readOutcome} explains why
 * that payload is narrowed by hand.
 */
export type CommandExecutor = Context["remote"]["commands"];

/**
 * Read one field of an untrusted reply object.
 * @param value - candidate object.
 * @param key - field to read.
 * @returns the field value, or undefined when the input is not an object.
 */
function fieldOf(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
}

/**
 * Turn one remote reply into an outcome.
 *
 * The reply is narrowed with local guards rather than trusted structurally:
 * `result.kind` and `result.text` belong to the `CommandExecution` the channel
 * declares, and the `{ matched }` value the session controller's client half
 * reduces that reply to carries no `result` field at all, so no field is read
 * without a guard.
 * @param reply - the value the remote call resolved to.
 * @returns whether the change was accepted, with the host's message when not.
 */
export function readOutcome(reply: unknown): ChangeOutcome {
    if (fieldOf(reply, "ok") === true) {
        const value = fieldOf(reply, "value");
        const result = fieldOf(value, "result");
        if (
            fieldOf(result, "kind") === "error" &&
            typeof fieldOf(result, "text") === "string"
        ) {
            return { ok: false, message: fieldOf(result, "text") as string };
        }
        return { ok: true };
    }
    const error = fieldOf(reply, "error");
    const message = fieldOf(error, "message");
    if (typeof message === "string") return { ok: false, message };
    const code = fieldOf(error, "code");
    return { ok: false, message: typeof code === "string" ? code : undefined };
}

/**
 * Ask the host to apply one level to one session.
 * @param commands - the command executor the client half injected.
 * @param sessionId - the session being changed.
 * @param level - the level to apply, sent as the command's argument word;
 *   rotating to the next level is the caller's own computation.
 * @returns whether the host accepted the change, with its message when it did not.
 */
export async function changeLevel(
    commands: CommandExecutor | undefined,
    sessionId: string,
    level: UltracodeLevel,
): Promise<ChangeOutcome> {
    if (commands === undefined) {
        return {
            ok: false,
            message: `The ${COMMAND_NAME} command channel is unavailable in this session.`,
        };
    }
    const line = `/${COMMAND_NAME} ${level}`;
    try {
        // The harness addresses sessions by a branded id, while this half's own
        // `changeLevel` signature widens it to a plain string, so the brand is
        // reapplied here, at the one boundary that crosses between them, rather
        // than by importing the session package's runtime brander: that brander is
        // an identity function reached through the types subpath, and a value
        // import would add a runtime module to the browser artifact to do what this
        // cast already does at no runtime cost.
        const target = sessionId as SessionId;
        return readOutcome(await commands.execute(target, line, []));
    } catch (reason) {
        return {
            ok: false,
            message: reason instanceof Error ? reason.message : String(reason),
        };
    }
}
