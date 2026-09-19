/**
 * Per-session ultracode state.
 *
 * The state lives in host process memory and is keyed by session identity. It
 * deliberately never reaches the session log: a third-party plugin cannot
 * register its own durable session event type, so anything it appended to the
 * log would be rejected wholesale when that session is read back. Session
 * memory also matches what ultracode means — a session-scoped setting that is
 * gone the moment the session ends, including across a resume.
 *
 * @module @dessera/dsh-ultracode/state
 */
import type { ArmReason } from "./reducer.ts";
import { type UltracodeLevel } from "./protocol.ts";

/** A reasoning effort captured before this plugin pinned one. */
export interface RememberedEffort {
    /** The effort id in force, or the empty string when none was explicitly requested. */
    readonly effort: string;
    /** Whether the adapter, rather than a caller, had materialized that effort. */
    readonly adapterDefault: boolean;
}

/** What one session remembers between turns. */
export interface SessionState {
    /** Level in effect for this session; `off` until the user selects one. */
    level: UltracodeLevel;
    /**
     * Whether this session's mirror has already been aligned with the log fold.
     *
     * The mirror is the synchronous read that banner injection and the effort pin
     * need. It starts at `off` for every session object, including a resumed one,
     * so the first time a session is touched the fold is consulted once and the
     * mirror is seeded from it. After that the mirror is written only through
     * {@link UltracodeStateStore.select}, which applies the same transition rules
     * the fold applies.
     */
    adopted: boolean;
    /**
     * Reasoning effort the deployment was running before this session's first
     * pin. Absent when the session never armed a level, and unknowable after a
     * host restart, in which case the model's own default applies again.
     */
    savedEffort?: RememberedEffort;
    /** Highest turn number already injected for this session. */
    injectedTurn?: number;
    /**
     * Whether the user cleared the armed marker of that turn.
     *
     * Clearing revokes the display, not the claim: the banner the turn injected is
     * already part of the conversation, and a second copy injected into a later
     * step of the same turn would duplicate it. The claim therefore stays until a
     * new turn claims its own injection, which is also what puts the marker back.
     */
    markerCleared: boolean;
    /** Whether the most recent injected turn was armed by a trigger word. */
    keywordArmedTurn: boolean;
    /** A divergence between the fold and the mirror, recorded once per level. */
    divergence?: {
        readonly folded: UltracodeLevel;
        readonly mirrored: UltracodeLevel;
    };
}

/** The state view served to the composer control. */
export interface UltracodeStateView {
    readonly level: UltracodeLevel;
    /** Whether the last injected turn was armed by a trigger word. */
    readonly keywordArmedTurn: boolean;
    /** Whether the current turn carries an injected banner whose marker stands. */
    readonly armedTurn: boolean;
    /** Whether the configured workflow tool resolves for this session's agent. */
    readonly available: boolean;
    /** Reasoning effort currently requested for this session, when readable. */
    readonly modelEffort: string | undefined;
    /** Front-door URL of the state and control route. */
    readonly route: string;
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
                keywordArmedTurn: false,
                markerCleared: false,
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
     * Record one divergence between the fold and the mirror.
     *
     * A divergence is not resolved silently: the mirror is what injection uses,
     * so it is a bug worth a log line rather than a value for this store to pick
     * a winner for. The first divergence per mirrored level is kept so a caller
     * or a test can read it.
     * @param session - the session being compared.
     * @param foldedLevel - the level the log fold reports.
     */
    reconcile(session: SessionLike, foldedLevel: UltracodeLevel): void {
        const state = this.stateOf(session);
        if (!state.adopted || state.level === foldedLevel) return;
        if (state.divergence?.mirrored === state.level) return;
        state.divergence = { folded: foldedLevel, mirrored: state.level };
    }

    /**
     * Read the last recorded divergence for one session.
     * @param session - the session to read.
     * @returns the recorded divergence, or undefined when none was recorded.
     */
    divergenceOf(session: SessionLike): SessionState["divergence"] {
        return this.states.get(session)?.divergence;
    }

    /**
     * Select one session's level.
     *
     * Selecting the level already in effect reports `unchanged` so the caller can
     * settle a command without producing a spurious notice, and so the
     * reasoning-effort pin is not applied twice.
     * @param session - the session whose level changes.
     * @param level - the level to put in effect.
     * @returns whether the level actually changed.
     */
    select(session: SessionLike, level: UltracodeLevel): LevelChange {
        const state = this.stateOf(session);
        if (state.level === level) return { kind: "unchanged", level };
        state.level = level;
        return { kind: "changed", level };
    }

    /**
     * Claim the right to inject one banner into one turn.
     *
     * Injection happens inside a waterfall that also runs for later steps of the
     * same turn, so the claim is what keeps one turn to one banner. The reason is
     * recorded with the claim so the control can report which path armed the
     * turn. A new claim also restores the marker, because the marker then belongs
     * to the turn that just claimed.
     * @param session - the session being injected.
     * @param turn - the turn number the injection would belong to.
     * @param reason - why this turn is armed.
     * @returns whether this call owns the injection for that turn.
     */
    claimInjection(
        session: SessionLike,
        turn: number,
        reason: ArmReason,
    ): boolean {
        const state = this.stateOf(session);
        if (state.injectedTurn === turn) return false;
        state.injectedTurn = turn;
        state.keywordArmedTurn = reason === "keyword";
        state.markerCleared = false;
        return true;
    }

    /**
     * Forget the turn currently marked as armed.
     *
     * The marker is what the control shows as "this turn is armed"; clearing it
     * is a revocation the user can perform during a turn. It stops at the display
     * and at the badge's own reason: the turn's injection claim is left in place,
     * because the banner the turn already carries cannot be taken out of the
     * conversation, and releasing the claim would inject a second copy of it into
     * the next step of the very turn the user just cleared.
     * @param session - the session whose marker is cleared.
     */
    clearTurn(session: SessionLike): void {
        const state = this.states.get(session);
        if (state === undefined) return;
        state.markerCleared = true;
        state.keywordArmedTurn = false;
    }

    /**
     * Read whether one session's armed marker is currently standing.
     *
     * This is the display question, not the injection gate: a turn whose marker
     * the user cleared is no longer reported as armed, while its claim still
     * keeps a second banner out of that same turn.
     * @param session - the session to read.
     * @returns whether an injected turn still carries an uncleared marker.
     */
    armedTurn(session: SessionLike): boolean {
        const state = this.states.get(session);
        return (
            state !== undefined &&
            state.injectedTurn !== undefined &&
            !state.markerCleared
        );
    }

    /**
     * Record the reasoning effort to restore when the level returns to `off`.
     * A later call never overwrites the first, because the first is the value the
     * deployment was running before this plugin touched anything.
     * @param session - the session being pinned.
     * @param effort - the effort in effect before pinning.
     */
    rememberEffort(session: SessionLike, effort: RememberedEffort): void {
        const state = this.stateOf(session);
        if (state.savedEffort !== undefined) return;
        state.savedEffort = effort;
    }

    /**
     * Read the effort remembered for restoration.
     * @param session - the pinned session.
     * @returns the remembered effort, or undefined when none was recorded.
     */
    rememberedEffort(session: SessionLike): RememberedEffort | undefined {
        return this.states.get(session)?.savedEffort;
    }

    /**
     * Forget the remembered effort, so a later arming captures a fresh one.
     * @param session - the session being released.
     */
    forgetEffort(session: SessionLike): void {
        const state = this.states.get(session);
        if (state !== undefined) delete state.savedEffort;
    }

    /**
     * Build the view the composer control renders.
     * @param session - the session being viewed.
     * @param available - whether the workflow tool resolves for this session.
     * @param modelEffort - the effort currently requested, when readable.
     * @param route - front-door URL of the state route.
     * @param folded - the log fold's own answer, when it was readable.
     * @returns the serializable state view.
     */
    viewOf(
        session: SessionLike,
        available: boolean,
        modelEffort: string | undefined,
        route: string,
        folded?: {
            readonly level: UltracodeLevel;
            readonly armedTurn: boolean;
            readonly keywordArmed: boolean;
        },
    ): UltracodeStateView {
        const state = this.stateOf(session);
        return {
            level: folded?.level ?? state.level,
            keywordArmedTurn: folded?.keywordArmed ?? state.keywordArmedTurn,
            armedTurn: folded?.armedTurn ?? this.armedTurn(session),
            available,
            modelEffort,
            route,
        };
    }
}
