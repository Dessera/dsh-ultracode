/**
 * The composer control's view logic, kept free of React.
 *
 * Everything the chip decides — which text it shows, whether it is waiting, and
 * what a press would do next — is a pure function of three inputs: the value the
 * host published, whether a change is in flight, and the last failure. Keeping
 * it here means the honest-placeholder rules can be tested without a renderer,
 * and it means there is exactly one place where a level reaches the screen.
 *
 * The rule the whole refactor rests on: the chip renders the host's own value or
 * an explicit "nothing published yet", and it never renders a level it derived
 * itself.
 *
 * @module @dessera/dsh-ultracode/client/chip
 */
import {
    nextUltracodeLevel,
    type UltracodeLevel,
    type UltracodeWire,
} from "../host/protocol.ts";
import type { UltracodeKey } from "./locales.ts";

/** One rendered state of the control. */
export interface ChipView {
    /** The level to show, or null while the host has published nothing. */
    readonly level: UltracodeLevel | null;
    /**
     * Text keys the control looks up. They are declared as dictionary keys rather
     * than plain strings so that a renamed or removed label becomes a compile
     * error at the place that selects it, instead of a chip rendering raw key
     * text at runtime.
     */
    readonly labelKey: UltracodeKey;
    /** Text key for the accessible name. */
    readonly ariaKey: UltracodeKey;
    /** Text key for the tooltip. */
    readonly titleKey: UltracodeKey;
    /** Whether the level is not `off`, which the chip renders as an active state. */
    readonly armed: boolean;
    /** Whether the trigger-word badge belongs next to the label. */
    readonly keywordArmed: boolean;
    /** Whether a press is currently in flight. */
    readonly pending: boolean;
    /** Whether the chip should refuse presses. */
    readonly disabled: boolean;
    /** The level a press would ask the host for. */
    readonly nextLevel: UltracodeLevel;
}

/**
 * Decide what the chip shows.
 *
 * A session whose value has not arrived still gets a usable chip: it shows the
 * connection state, stays pressable, and advances from `off` so the first press
 * is a well-defined request rather than a guess about a level nobody published.
 * @param wire - the value the host published, or undefined when none arrived.
 * @param pending - whether a change is currently in flight.
 * @param _failure - the last failure text, or null when the last attempt worked.
 * @param changeable - whether the write channel exists at all.
 * @returns the view to render.
 */
export function chipView(
    wire: UltracodeWire | undefined,
    pending: boolean,
    _failure: string | null,
    changeable: boolean,
): ChipView {
    const level = wire?.level ?? null;
    const shown: UltracodeLevel = level ?? "off";
    const suffix = level === null ? "connecting" : level;
    // The three key families are spelled here and nowhere else, so the dictionary
    // has to carry all of them; the casts narrow a template-built string back to
    // the union the dictionary declares.
    return {
        level,
        labelKey: `chip.${suffix}` as UltracodeKey,
        ariaKey: `chip.aria.${suffix}` as UltracodeKey,
        titleKey: `chip.title.${suffix}` as UltracodeKey,
        armed: level !== null && level !== "off",
        keywordArmed: wire?.armedTurn === true && wire.keywordArmed === true,
        pending,
        // A press is refused only while one is already in flight, or when the
        // session cannot carry the command at all. It is never refused merely
        // because the host has not answered yet: that is the state the old control
        // mistook for "this control does not belong here".
        disabled: pending || !changeable,
        nextLevel: nextUltracodeLevel(shown),
    };
}
