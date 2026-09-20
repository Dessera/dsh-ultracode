/**
 * Per-session ultracode state.
 *
 * The mirror lives in host process memory and is keyed by session identity, and
 * the level it mirrors is durable: the projection unit derives that level from
 * the session log, so a resumed session or a restarted host recovers it by
 * folding the log the session already carries. The plugin appends nothing of its
 * own — a third-party plugin cannot register a durable session event type, so
 * anything it appended would be rejected wholesale when that session is read
 * back — and the mirror exists only so that the banner decision can read the
 * level without waiting for a fold.
 *
 * @module @dessera/dsh-ultracode/state
 */
import { type UltracodeLevel } from "./protocol.ts";

/** What one session remembers between turns. */
export interface SessionState {
    /** Level in effect for this session; `off` until the user selects one. */
    level: UltracodeLevel;
    /**
     * Whether this session's mirror has already been aligned with the log fold.
     *
     * The mirror is the synchronous read that banner injection needs. It starts
     * at `off` for every session object, including a resumed one, so the first
     * time a session is touched the fold is consulted once and the mirror is
     * seeded from it. After that the mirror is written only through
     * {@link UltracodeStateStore.select}, which applies the same transition rules
     * the fold applies.
     */
    adopted: boolean;
    /**
     * Identity of the message this session's most recent banner was attached to,
     * if any.
     *
     * The banner is anchored on the message that opened the turn, so that message
     * identifies the one injection it owns. Identity is the right key because it
     * is what tells a new prompt apart from the same prompt seen again: a steer
     * the user types while the agent is already working joins the running turn
     * instead of opening a new one, and it is a different message, so it carries a
     * banner of its own.
     */
    injectedAnchor?: string;
    /**
     * The level whose full instruction block this session has already been told,
     * if any.
     *
     * Injection states the block once per level and a one-line reminder after
     * that, so this is what tells the two apart. It is deliberately not durable:
     * it lives in host memory beside the mirror, and a resumed session or a
     * restarted host starts without it, which is what makes the level's block be
     * stated again rather than assumed to still be somewhere in the history.
     */
    announcedLevel?: UltracodeLevel;
}

/**
 * The session registry. One instance serves one host process.
 *
 * A session handle is only required to carry an `id`, which keeps this module
 * independent of the session package and trivially testable.
 */
export interface SessionLike {
    readonly id: string;
}

/** Outcome of one level selection. */
export type LevelChange =
    | { readonly kind: "changed"; readonly level: UltracodeLevel }
    | { readonly kind: "unchanged"; readonly level: UltracodeLevel };

/** The registry of per-session ultracode states. */
export class UltracodeStateStore {
    private readonly states = new WeakMap<object, SessionState>();

    /**
     * Read one session's state, creating the default state on first touch.
     * @param session - the session handle; only its identity is used.
     * @returns the live state record for that session.
     */
    stateOf(session: SessionLike): SessionState {
        let state = this.states.get(session);
        if (state === undefined) {
            state = {
                level: "off",
                adopted: false,
            };
            this.states.set(session, state);
        }
        return state;
    }

    /**
     * Whether this session's mirror has already been aligned with the log fold.
     * @param session - the session handle.
     * @returns whether the mirror was seeded from the fold.
     */
    adopted(session: SessionLike): boolean {
        return this.states.get(session)?.adopted === true;
    }

    /**
     * Seed one unseen session's mirror from the level the log fold reports.
     *
     * Adoption runs once per session object. A resumed session gets a fresh
     * session object, so it is adopted again and recovers whatever the fold can
     * still read out of its log; a session that never chose a level folds to
     * `off` and therefore keeps today's behaviour.
     *
     * The mirror only moves while nothing has written it yet in this process,
     * which is what keeps the two authorities from overwriting each other: after
     * adoption the mirror follows the user's own transitions, and the fold is
     * read for display and for `status` rather than written back.
     * @param session - the session being adopted.
     * @param foldedLevel - the level the log fold reports for this session.
     */
    adopt(session: SessionLike, foldedLevel: UltracodeLevel): void {
        const state = this.stateOf(session);
        if (state.adopted) return;
        state.adopted = true;
        if (state.level === foldedLevel) return;
        // The mirror can only have held the default until now, because every real
        // transition happens after adoption, so moving it to the fold's value is a
        // correction rather than a loss.
        state.level = foldedLevel;
    }

    /**
     * Select one session's level.
     *
     * Selecting the level already in effect reports `unchanged` so the caller can
     * settle a command without producing a spurious notice.
     *
     * Leaving for `off` forgets which level's block was announced, so a session
     * that is armed again later states the block rather than reminding. The turns
     * between the two arming points can be arbitrarily many, and compaction may
     * have removed the block from the history in the meantime; a reminder whose
     * instruction is no longer readable would be worse than stating it again.
     * @param session - the session whose level changes.
     * @param level - the level to put in effect.
     * @returns whether the level actually changed.
     */
    select(session: SessionLike, level: UltracodeLevel): LevelChange {
        const state = this.stateOf(session);
        if (state.level === level) return { kind: "unchanged", level };
        state.level = level;
        if (level === "off") delete state.announcedLevel;
        return { kind: "changed", level };
    }

    /**
     * Claim the right to inject one banner for one anchor message.
     *
     * Injection happens inside a waterfall that also runs for later steps of the
     * same turn, so the claim is what keeps one message to one banner. The anchor
     * is the message the banner would follow, which is stable across those later
     * steps while the batch itself is not: a later step claims only the tool
     * results of this turn, and those are not anchors at all.
     * @param session - the session being injected.
     * @param anchor - identity of the message the banner would follow.
     * @returns whether this call owns the injection for that message.
     */
    claimInjection(session: SessionLike, anchor: string): boolean {
        const state = this.stateOf(session);
        if (state.injectedAnchor === anchor) return false;
        state.injectedAnchor = anchor;
        return true;
    }

    /**
     * Decide how one armed turn should be stated, and record the decision.
     *
     * The first turn of a level, and the first turn after the level changes,
     * states the whole block; every turn after that carries the one-line
     * reminder. Recording the level here rather than at the call site keeps the
     * decision and the memory of it in one place, so a caller cannot state a
     * block twice by forgetting to write the field back.
     * @param session - the session being injected.
     * @param level - the level this turn is armed at.
     * @returns whether this turn must state the level's full block.
     */
    announce(session: SessionLike, level: UltracodeLevel): boolean {
        const state = this.stateOf(session);
        if (state.announcedLevel === level) return false;
        state.announcedLevel = level;
        return true;
    }
}
