/**
 * The pure log reducer behind the ultracode projection.
 *
 * This module is the single derivation of a session's level. It reads nothing
 * but committed session events, so it can be folded for a session that has no
 * live agent, in a process that has no state store, and on the cold paths the
 * projection registry uses when it lists sessions. The state store keeps a
 * per-session mirror of the level for the two places that need a synchronous
 * read (banner injection and the effort pin); that mirror is seeded from this
 * reducer and written by the same transition rules, never by a second
 * derivation.
 *
 * Folding is faithful to what the host already accepts. The plugin never writes
 * a durable event of its own, so the level is recovered from the command
 * lifecycle DSH already records for `/ultracode`, and the arming state is
 * recovered from the banner message the plugin itself injected.
 *
 * @module @dessera/dsh-ultracode/reducer
 */
import {
    COMMAND_NAME,
    initialWire,
    nextUltracodeLevel,
    parseUltracodeLevel,
    PLUGIN_ID,
    type UltracodeLevel,
    type UltracodeWire,
} from "./protocol.ts";

/** One command the fold is waiting to see settle. */
export interface PendingCommand {
    readonly commandId: string;
    readonly level: UltracodeLevel;
}

/** The state one projection unit folds for one session. */
export interface ProjectionState {
    /** Level the log's command history currently reports. */
    readonly level: UltracodeLevel;
    /**
     * Whether a level command has been seen in this log at all.
     *
     * The fold needs this to decide where the level may come from. Once the log
     * carries a level command, that command history is the only authority, and a
     * banner is never allowed to move the level; while no command has been seen,
     * the last banner's own summary is the only record of the level a session was
     * running under, which is what carries a level across a host restart.
     */
    readonly fromCommand: boolean;
    /** A command that has been recorded as started but not yet as settled. */
    readonly pending: PendingCommand | null;
    /**
     * The value that leaves the host. It is reused by reference while no visible
     * field changed, because the registry gates publication on `Object.is` of the
     * view it computes.
     */
    readonly wire: UltracodeWire;
}

/** One session log event, as far as the fold needs to read it. */
export interface SessionEventShape {
    readonly type: string;
    readonly seq?: number;
    readonly data?: {
        readonly commandId?: unknown;
        readonly name?: unknown;
        readonly args?: unknown;
        readonly kind?: unknown;
        readonly source?: {
            readonly kind?: unknown;
            readonly plugin?: unknown;
            readonly form?: unknown;
            readonly summary?: unknown;
        };
    };
}

/** The state every session starts from. */
export function initialProjectionState(): ProjectionState {
    return {
        level: "off",
        fromCommand: false,
        pending: null,
        wire: initialWire(),
    };
}

/**
 * How one command invocation's arguments should be read.
 *
 * `rotate` is the argument-less form: it advances from whatever level the fold
 * currently reports, which is why the reducer needs the state rather than only
 * the argument text. `level` means the words named a level, and the caller
 * resolves which one with {@link parseUltracodeLevel}.
 */
export type CommandClassification =
    "status" | "rotate" | "level" | "unknown-level";

/**
 * Read the first word of one command's argument text.
 * @param args - the raw text after the command name.
 * @returns the lowercased first word, or the empty string when there is none.
 */
function firstWordOf(args: string): string {
    const words = args
        .trim()
        .split(/\s+/u)
        .filter((word) => word !== "");
    return (words[0] ?? "").toLowerCase();
}

/**
 * Classify the raw argument text of one `/ultracode` invocation.
 * @param args - the raw text after the command name.
 * @returns what the invocation asks for.
 */
export function classifyCommandArgs(args: string): CommandClassification {
    const head = firstWordOf(args);
    if (head === "") return "rotate";
    if (head === "status") return "status";
    if (parseUltracodeLevel(head) !== undefined) return "level";
    return "unknown-level";
}

/**
 * Read the level an invocation asks for, when it asks for one.
 * @param args - the raw text after the command name, already known to name a level.
 * @returns the requested level, or undefined when the words name none.
 */
function requestedLevel(args: string): UltracodeLevel | undefined {
    return parseUltracodeLevel(firstWordOf(args));
}

/**
 * Read the level out of one banner summary.
 * @param summary - the banner's summary text.
 * @returns the level the banner announced, or undefined when unreadable.
 */
function levelOfSummary(summary: unknown): UltracodeLevel | undefined {
    if (typeof summary !== "string") return undefined;
    if (/\bultra\b/u.test(summary)) return "ultra";
    if (/\bhigh\b/u.test(summary)) return "high";
    if (/\boff\b/u.test(summary)) return "off";
    return undefined;
}

/**
 * Whether one message is the banner this plugin injected.
 *
 * Identification goes through the message source rather than through its text:
 * a plugin-injected notice is the only kind of message that carries this
 * plugin's id, and matching on words would also match a human quoting it.
 * @param source - the message's source descriptor.
 * @returns whether the message is this plugin's arming banner.
 */
function isBannerSource(source: unknown): boolean {
    if (typeof source !== "object" || source === null) return false;
    const record = source as Record<string, unknown>;
    return (
        record.kind === "plugin" &&
        record.plugin === PLUGIN_ID &&
        record.form === "notice" &&
        typeof record.summary === "string"
    );
}

/**
 * Rebuild the client-visible part of the state.
 *
 * The returned state keeps the previous `wire` reference when nothing visible
 * changed, so the registry's `Object.is` gate suppresses a frame; only a real
 * change costs a publication. The top-level fields are written here too, and
 * they are the fold's own record: `wire` is derived from them at this one
 * place, so the two can never disagree.
 * @param state - the state before the event.
 * @param level - the level the fold now reports.
 * @returns the state to carry forward.
 */
function withVisible(
    state: ProjectionState,
    level: UltracodeLevel,
): ProjectionState {
    if (state.wire.level === level) return state;
    return { ...state, level, wire: { level } };
}

/**
 * Fold one session event into the projection state.
 *
 * An event this unit does not care about returns the very same state reference.
 * That is not an optimization: the registry compares the state by `Object.is`
 * before it recomputes the view, so returning a fresh object for an unrelated
 * event would cost a view computation on every event of every session.
 * @param state - the state before the event.
 * @param event - the committed event to fold.
 * @returns the state after the event.
 */
export function applyProjectionEvent(
    state: ProjectionState,
    event: SessionEventShape,
): ProjectionState {
    const data = event.data;

    if (
        event.type === "command/run" &&
        data !== undefined &&
        data.name === COMMAND_NAME
    ) {
        const commandId =
            typeof data.commandId === "string" ? data.commandId : null;
        const args = typeof data.args === "string" ? data.args : "";
        if (commandId === null) return state;
        const classification = classifyCommandArgs(args);
        const level =
            classification === "rotate"
                ? nextUltracodeLevel(state.level)
                : requestedLevel(args);
        if (level === undefined) return state;
        return { ...state, pending: { commandId, level } };
    }

    if (event.type === "command/done" && data !== undefined) {
        const commandId =
            typeof data.commandId === "string" ? data.commandId : null;
        const pending = state.pending;
        if (
            commandId === null ||
            pending === null ||
            pending.commandId !== commandId
        )
            return state;
        const settled: ProjectionState = { ...state, pending: null };
        if (data.kind !== "success") return settled;
        return withVisible({ ...settled, fromCommand: true }, pending.level);
    }

    if (event.type === "user/message" && isBannerSource(data?.source)) {
        const summary = data?.source?.summary;
        // The banner reports the level it was built for. It may move the fold only
        // while the log carries no level command: after that, the command history
        // is the authority and a stale banner must not roll the level back.
        const level = state.fromCommand
            ? state.level
            : (levelOfSummary(summary) ?? state.level);
        return withVisible(state, level);
    }

    return state;
}
