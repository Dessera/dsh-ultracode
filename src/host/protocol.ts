/**
 * Vocabulary and wire protocol shared by the plugin's two halves.
 *
 * This module is the single home of everything both halves must agree on: the
 * plugin identity, the command name, the projection key, the level vocabulary
 * and its aliases, the rotation rule, the shape of the state that crosses the
 * process boundary, and the hand-written schemas that validate it.
 *
 * It deliberately depends on nothing — not on a host package, not on React —
 * because the bundler inlines one copy of it into each artifact. An import of a
 * host package here would be inlined into the browser bundle as well, which
 * would put host code (and its top-level side effects) into the browser.
 *
 * @module @dessera/dsh-ultracode/protocol
 */

import type { PendingCommand, ProjectionState } from "./reducer.ts";

/** Plugin id, matching the plugin name and the composer seat id. */
export const PLUGIN_ID = "dsh-ultracode";

/** Name of the slash command, without the leading slash. */
export const COMMAND_NAME = "ultracode";

/** Key of the session projection that publishes this plugin's state. */
export const ULTRACODE_KEY = "ultracode";

/** Version of the projection's persisted state shape. */
export const ULTRACODE_STATE_VERSION = 1;

/** Default path prefix of the plugin's own HTTP route. */
export const DEFAULT_ROUTE_PREFIX = "/dsh-ultracode";

/** The three orchestration levels, lowest first. */
export type UltracodeLevel = "off" | "high" | "ultra";

/** Every level, in the order the composer control cycles through them. */
export const LEVELS: readonly UltracodeLevel[] = ["off", "high", "ultra"];

/** The level words the command and the control accept, for usage strings. */
export const LEVEL_WORDS = "off | high | ultra";

/**
 * Test one untrusted value for being a known level.
 * @param value - candidate value, typically a command argument or wire field.
 * @returns whether the value is one of {@link LEVELS}.
 */
export function isUltracodeLevel(value: unknown): value is UltracodeLevel {
    return (
        typeof value === "string" &&
        (LEVELS as readonly string[]).includes(value)
    );
}

/**
 * Parse one user-typed level word, accepting a couple of spellings a person
 * plausibly types. Unknown words parse to `undefined` so the caller reports a
 * usage error instead of silently selecting a level.
 * @param word - the raw word, case-insensitive, without leading punctuation.
 * @returns the parsed level, or undefined when the word names no level.
 */
export function parseUltracodeLevel(word: string): UltracodeLevel | undefined {
    const normalized = word.trim().toLowerCase();
    if (
        normalized === "off" ||
        normalized === "none" ||
        normalized === "close" ||
        normalized === "关闭"
    ) {
        return "off";
    }
    if (normalized === "high" || normalized === "高阶") return "high";
    if (normalized === "ultra" || normalized === "极致") return "ultra";
    return undefined;
}

/**
 * The level reached by one forward step of the composer control, wrapping from
 * the strongest level back to `off`.
 *
 * Both the command's argument-less form and the composer control call this, so
 * the two cannot disagree about what "next" means.
 * @param level - the level in effect now.
 * @returns the next level in {@link LEVELS}.
 */
export function nextUltracodeLevel(level: UltracodeLevel): UltracodeLevel {
    const index = LEVELS.indexOf(level);
    return LEVELS[(index + 1) % LEVELS.length] as UltracodeLevel;
}

/**
 * Whether a level arms the turn it applies to. `off` never injects: a control
 * that reads "off" must mean the plugin stays out of the conversation.
 * @param level - the level in effect.
 * @returns whether the level arms turns and pins reasoning effort.
 */
export function isArmed(level: UltracodeLevel): boolean {
    return level !== "off";
}

/**
 * Describe one level for a user-facing string.
 * @param level - the level to name.
 * @param language - dictionary selector.
 * @returns the display name.
 */
export function levelLabel(
    level: UltracodeLevel,
    language: "zh" | "en",
): string {
    if (language === "zh") {
        if (level === "off") return "关闭";
        if (level === "high") return "高阶";
        return "极致";
    }
    return level;
}

/** The state one session's composer control renders. */
export interface UltracodeWire {
    /** The level the host's log fold currently reports. */
    readonly level: UltracodeLevel;
    /** Whether the log already carries this turn's arming banner. */
    readonly armedTurn: boolean;
    /** Whether that banner was armed by a trigger word rather than by the level. */
    readonly keywordArmed: boolean;
    /** Monotone fold counter, bumped only when a visible field above changes. */
    readonly revision: number;
}

/**
 * Minimal structural view of a schema: the only method the projection registry
 * ever calls. Declaring it locally keeps the plugin free of a schema library
 * dependency while staying assignable to the registry's own schema type.
 */
export interface ParseSchema<T> {
    parse(value: unknown): T;
}

/** The wire object every session starts from. */
export function initialWire(): UltracodeWire {
    return { level: "off", armedTurn: false, keywordArmed: false, revision: 0 };
}

/**
 * Read one field of an untrusted object.
 * @param value - candidate object.
 * @param key - field to read.
 * @returns the field value, or undefined when the input is not an object.
 */
function fieldOf(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
}

/**
 * Validate a wire value, rebuilding it from known fields.
 *
 * The registry parses the view before every frame, and the browser stores what
 * it receives, so this must return a fresh plain object rather than the input:
 * that guarantees the value the registry clones and the value the browser holds
 * carry no reference back into host memory. A malformed level falls back to
 * `off` rather than throwing, because a control that renders "off" is honest
 * while a failed publication would take the whole projection down.
 */
export const UltracodeWireSchema: ParseSchema<UltracodeWire> = {
    parse(value: unknown): UltracodeWire {
        const level = fieldOf(value, "level");
        const revision = fieldOf(value, "revision");
        return {
            level: isUltracodeLevel(level) ? level : "off",
            armedTurn: fieldOf(value, "armedTurn") === true,
            keywordArmed: fieldOf(value, "keywordArmed") === true,
            revision:
                typeof revision === "number" && Number.isFinite(revision)
                    ? revision
                    : 0,
        };
    },
};

/**
 * Validate the projection's persisted state.
 *
 * The registry stores this value in checkpoints and restores it through
 * `structuredClone`, so every field must be plain JSON and the parse must
 * always succeed: a throw here would break the checkpoint of the whole
 * session, not just one frame. Malformed parts therefore degrade to the
 * defaults instead of raising.
 */
export const ProjectionStateSchema: ParseSchema<ProjectionState> = {
    parse(value: unknown): ProjectionState {
        const level = fieldOf(value, "level");
        const turn = fieldOf(value, "turn");
        const revision = fieldOf(value, "revision");
        const safeRevision =
            typeof revision === "number" && Number.isFinite(revision)
                ? revision
                : 0;
        const wire = UltracodeWireSchema.parse(fieldOf(value, "wire"));
        return {
            level: isUltracodeLevel(level) ? level : "off",
            fromCommand: fieldOf(value, "fromCommand") === true,
            pending: parsePending(fieldOf(value, "pending")),
            armed: fieldOf(value, "armed") === true,
            keywordArmed: fieldOf(value, "keywordArmed") === true,
            turn:
                typeof turn === "number" && Number.isFinite(turn) ? turn : null,
            revision: safeRevision,
            wire: {
                ...wire,
                revision: wire.revision === 0 ? safeRevision : wire.revision,
            },
        };
    },
};

/**
 * Validate one pending-command record.
 * @param value - the candidate value.
 * @returns the record, or null when it is absent or malformed.
 */
function parsePending(value: unknown): PendingCommand | null {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const commandId =
        typeof record.commandId === "string" ? record.commandId : null;
    if (commandId === null) return null;
    if (record.kind === "clear-turn") return { commandId, kind: "clear-turn" };
    if (record.kind === "set-level" && isUltracodeLevel(record.level)) {
        return { commandId, kind: "set-level", level: record.level };
    }
    return null;
}
