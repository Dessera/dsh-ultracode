/**
 * Construction of the one message this plugin injects.
 *
 * The banner is built here rather than through the harness's message factory
 * because a locally linked plugin resolves its imports from its own real path,
 * which is outside the profile: bundling the harness's factory would work but
 * would also inline the harness's identity read (its own package version),
 * which a plugin has no business shadowing. What the harness actually requires
 * of a message is small and stable — a fresh string id, a role, model-facing
 * content, a producer source, and deep immutability — and this module provides
 * exactly that, with a comment for each field so the contract stays visible.
 *
 * @module @dessera/dsh-ultracode/message
 */
import { randomUUID } from "node:crypto";

import { PLUGIN_SOURCE_KIND } from "./protocol.ts";

/** One model-facing content block. */
export interface TextBlock {
    readonly type: "text";
    readonly text: string;
}

/**
 * Producer-declared context form. `notice` is the harness's own value for a
 * one-off account of something that just happened, which is what an injected
 * banner is, and it gives the transcript a collapsed row with a summary line.
 * The kind is this plugin's own producer kind, so the message names its writer
 * without a second field repeating it.
 */
export interface NoticeSource {
    readonly kind: typeof PLUGIN_SOURCE_KIND;
    readonly form: "notice";
    readonly summary: string;
}

/** A frozen, identified user-role message. */
export interface BannerMessage {
    readonly id: string;
    readonly role: "user";
    readonly content: TextBlock[];
    readonly source: NoticeSource;
}

/**
 * Recursively freeze a plain value.
 *
 * The harness freezes every message before publication so a later holder
 * cannot mutate a message other components already read. Doing the same here
 * keeps an injected banner indistinguishable from a harness-built one in that
 * respect.
 * @param value - the value to freeze in place.
 * @returns the same value.
 */
function deepFreeze<T>(value: T): T {
    if (
        value !== null &&
        typeof value === "object" &&
        !Object.isFrozen(value)
    ) {
        Object.freeze(value);
        for (const key of Object.getOwnPropertyNames(value)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
    }
    return value;
}

/**
 * Build the banner message.
 * @param text - the complete injected text.
 * @param summary - one-line account shown on the collapsed transcript row.
 * @returns the frozen message to insert into the entering batch.
 */
export function createBannerMessage(
    text: string,
    summary: string,
): BannerMessage {
    return deepFreeze({
        id: randomUUID(),
        role: "user" as const,
        content: [{ type: "text" as const, text }],
        source: {
            kind: PLUGIN_SOURCE_KIND,
            form: "notice" as const,
            summary,
        },
    });
}
