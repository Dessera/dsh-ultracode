/**
 * Composer control for the ultracode level.
 *
 * The control is a read-only mirror of what the host publishes through the
 * session projection, plus one write action that asks the host to run the
 * `/ultracode` command. It holds no level of its own, keeps no cache, fetches
 * nothing, and listens for no window event: when the host's value changes, the
 * projection hook re-renders this component, and there is no second path by
 * which a level could reach the screen.
 *
 * That is what makes the two failure modes of the earlier design impossible.
 * The control cannot go missing because it never renders nothing: a session
 * whose value has not arrived yet shows an explicit connecting state. And it
 * cannot drift from the command, because the command is the only writer and the
 * projection is the only reader.
 *
 * @module @dessera/dsh-ultracode/client/UltracodeControl
 */
import {
    useCallback,
    useState,
    type CSSProperties,
    type ReactElement,
} from "react";

import type { UltracodeChipProps } from "./contract.ts";
import { ULTRACODE_KEY, type UltracodeWire } from "../host/protocol.ts";
import { chipView } from "./chip.ts";
import type { UltracodeKey } from "./locales.ts";

/**
 * Props of this control.
 *
 * The composed seat props, the injected write callback and the locale seat are
 * declared together in `./contract.ts`; aliasing them here keeps
 * the component's signature readable without restating any of it.
 */
export type UltracodeControlProps = UltracodeChipProps;

/** Fallback text used when the locale registry has no entry for a key. */
const FALLBACK: Record<string, string> = {
    "chip.off": "Ultracode off",
    "chip.high": "Ultracode high",
    "chip.ultra": "Ultracode ultra",
    "chip.connecting": "Ultracode connecting",
    "chip.aria.off": "Ultracode level off, press to switch to high",
    "chip.aria.high": "Ultracode level high, press to switch to ultra",
    "chip.aria.ultra": "Ultracode level ultra, press to turn off",
    "chip.aria.connecting":
        "No host state received yet; pressing advances from the current level",
    "chip.title.off": "Ultracode level: off — click for high",
    "chip.title.high": "Ultracode level: high — click for ultra",
    "chip.title.ultra": "Ultracode level: ultra — click to turn off",
    "chip.title.connecting":
        "The host has not published a level yet; a click runs one /ultracode command",
    "chip.busy": "Applying…",
    "chip.armed": "trigger word",
    "error.action": "Could not change the Ultracode level",
};

const STYLES: Record<string, CSSProperties> = {
    wrap: { display: "inline-flex", alignItems: "center", gap: 6 },
    chip: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        minWidth: 34,
        border: "none",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 500,
        lineHeight: "20px",
        cursor: "pointer",
        background:
            "var(--dsw-alias-state-info-tertiary, rgba(120, 140, 255, 0.16))",
        color: "var(--dsw-alias-state-info-label, inherit)",
    },
    chipArmed: {
        background:
            "var(--dsw-alias-state-warn-tertiary, rgba(255, 190, 90, 0.2))",
        color: "var(--dsw-alias-state-warn-label, inherit)",
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        background: "currentColor",
        opacity: 0.85,
    },
    armed: { fontSize: 11, opacity: 0.75 },
    error: {
        color: "var(--dsw-alias-state-error-primary, #d33)",
        fontSize: 12,
        lineHeight: "18px",
    },
};

/**
 * Read the host's published value through the projection hook.
 *
 * The hook is optional because a host that mounts this seat without a session
 * source must still render a working control; an absent hook and an absent
 * value are the same thing to the chip, which is "nothing published yet".
 * @param props - the control's props.
 * @returns the published value, or undefined when none arrived.
 */
function readProjection(
    props: UltracodeControlProps,
): UltracodeWire | undefined {
    const hook = props.useProjection;
    if (typeof hook !== "function") return undefined;
    try {
        // The key comes from the protocol module rather than a literal, so renaming
        // the projection cannot leave the browser half reading a stale key. The
        // harness types a keyed read as the value that key merged into the
        // projection table, which is this plugin's own wire type.

        const read = hook as (key: string) => unknown;
        const value = read(ULTRACODE_KEY);
        if (typeof value !== "object" || value === null) return undefined;
        return value as UltracodeWire;
    } catch {
        // A host that cannot answer is a host with nothing published, not a reason
        // to throw inside the composer's render pass.
        return undefined;
    }
}

/**
 * Read one standard session flag through the composer's own selector hook.
 *
 * The composer hands this seat an empty owner object, so the runtime props it
 * does receive — the session selector hook among them — are the only way to
 * learn about the session. A removed session has no composer to carry this
 * control, and a delegated child session has no user to press it.
 * @param props - the control's props.
 * @param flag - the snapshot field to read.
 * @returns the field value, or undefined when the hook or field is absent.
 */
function readSessionFlag(
    props: UltracodeControlProps,
    flag: "removed" | "subagent",
): unknown {
    const hook = props.useSession;
    if (typeof hook !== "function") return undefined;
    try {
        // The snapshot is whatever this plugin's declared selector hook receives;
        // only the two flags a control can act on are read, and an absent field
        // reads as undefined rather than throwing.
        const select = hook as (fn: (snapshot: unknown) => unknown) => unknown;
        return select(
            (snapshot) =>
                (snapshot as Record<string, unknown> | null | undefined)?.[
                    flag
                ],
        );
    } catch {
        return undefined;
    }
}

/**
 * The composer control.
 * @param props - runtime props plus the host channel this plugin injected.
 * @returns the control, or null for a session that cannot carry one.
 */
export function UltracodeControl(
    props: UltracodeControlProps,
): ReactElement | null {
    const { sessionId, changeLevel } = props;
    // The locale seat's `t` is typed against this plugin's dictionary, so a
    // mistyped key is a build error. It is still read through an optional call:
    // the seat comes from the harness, so a host that composes these props without
    // this plugin's namespace registered leaves the member absent at runtime, and
    // the fallback table is what keeps the chip readable in that case.
    const t = (key: UltracodeKey): string =>
        props.t?.(key) ?? FALLBACK[key] ?? key;

    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const wire = readProjection(props);
    const view = chipView(wire, pending, failure, changeLevel !== undefined);

    const press = useCallback(async (): Promise<void> => {
        if (sessionId === undefined || changeLevel === undefined || pending)
            return;
        setPending(true);
        setFailure(null);
        try {
            const outcome = await changeLevel(sessionId, view.nextLevel);
            // The level on screen is deliberately not set here: the host publishes the
            // change through the projection and the chip follows that frame. The reply
            // only settles the in-flight state and reports a refusal.
            setFailure(
                outcome.ok ? null : (outcome.message ?? t("error.action")),
            );
        } catch (reason) {
            setFailure(
                reason instanceof Error ? reason.message : t("error.action"),
            );
        } finally {
            setPending(false);
        }
    }, [changeLevel, pending, sessionId, t, view.nextLevel]);

    const removed = readSessionFlag(props, "removed");
    const subagent = readSessionFlag(props, "subagent");
    if (removed === true || (subagent !== null && subagent !== undefined))
        return null;

    const chipStyle: CSSProperties = {
        ...STYLES.chip,
        ...(view.armed ? STYLES.chipArmed : {}),
    };
    const label = `${t(view.labelKey)}${view.pending ? ` · ${t("chip.busy")}` : ""}`;

    return (
        <span style={STYLES.wrap}>
            <button
                type="button"
                style={chipStyle}
                aria-label={t(view.ariaKey)}
                title={t(view.titleKey)}
                aria-pressed={view.armed}
                disabled={view.disabled}
                onClick={() => {
                    void press();
                }}
            >
                <span style={STYLES.dot} aria-hidden />
                {label}
                {view.keywordArmed ? (
                    <span style={STYLES.armed}>{t("chip.armed")}</span>
                ) : null}
            </button>
            {failure !== null ? (
                <span style={STYLES.error} role="alert" title={failure}>
                    {failure}
                </span>
            ) : null}
        </span>
    );
}
