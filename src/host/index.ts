/**
 * Host half of the ultracode plugin.
 *
 * The plugin gives one session a three-position orchestration level. While the
 * level is not `off`, every turn that session opens carries a banner that
 * authorizes the workflow tool — the level is the whole gate, so the banner does
 * not depend on what the message says or how long it is. The turn that follows a
 * level being turned off carries a notice instead, because a banner is injected
 * only for a turn that is armed and the model has otherwise not been told that
 * the authorization ended. The level never enters
 * the log as a record of the plugin's own: a third-party plugin cannot register a
 * durable event type, so the projection unit derives the level from the command
 * lifecycle DSH already records for `/ultracode` and from the banner's own source
 * summary, and host memory holds a per-session mirror for the banner decision,
 * which cannot wait for a fold.
 *
 * The feature has three moving parts:
 *
 * - `agent/pre-step` inserts the banner — or the disarm notice — into the batch
 *   that enters the model.
 * - The `/ultracode` command changes the level from the message box.
 * - The session projection publishes the current level to the browser.
 *
 * The plugin reads session state and writes a projection of its own; it never
 * writes a field of the harness's call configuration, so the reasoning effort a
 * session runs at stays the user's own choice.
 *
 * @module @dessera/dsh-ultracode
 */
import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

import { resolveConfig } from "./config.ts";
import {
    COMMAND_NAME,
    isUltracodeLevel,
    isUltracodeSource,
    levelLabel,
    LEVEL_WORDS,
    nextUltracodeLevel,
    parseUltracodeLevel,
    type UltracodeLevel,
    type UltracodeWire,
} from "./protocol.ts";
import { createBannerMessage } from "./message.ts";
import { NOTICES } from "./notices.ts";
import {
    buildDisarmNotice,
    buildInjection,
    buildReminder,
    disarmSummary,
    injectionSummary,
} from "./prompt.ts";
import { ultracodeProjection, ULTRACODE_KEY } from "./projection.ts";
import { classifyCommandArgs } from "./reducer.ts";
import { Config } from "./schema.ts";
import { UltracodeStateStore } from "./state.ts";

/** Plugin name registered with the loader. */
export const name = "dsh-ultracode";

/**
 * Services this plugin reads. The loader waits for every one of them before
 * `apply` runs.
 */
export const inject = ["tools", "commands"];

export { Config };

/** One live agent. The registry's own type, so every member read below is checked. */
type AgentLike = Context["agents"] extends {
    get(id: string): infer A | undefined;
}
    ? A
    : never;

/**
 * The batch the pre-step waterfall carries, in the harness's own message type.
 *
 * This is the real `UserMessage`, not a local restatement: the listener already
 * ends in `as never` because the waterfall's payload mixes user and non-user
 * messages, and using the harness type here means the fields read off it — the
 * source kind and the content blocks — are checked against the shape the log
 * actually stores.
 */
type StepMessage = UserMessage;

/** One control request, as sent by the composer control or the command. */
interface ControlRequest {
    readonly action: "set-level" | "status";
    readonly level?: unknown;
}

/** The outcome of one control request. */
type ControlOutcome =
    | { readonly ok: true; readonly text?: string }
    | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * One service read out of the context by name.
 *
 * Every service this plugin uses is declared in `inject` or read guarded here,
 * and each one already has a type: the host package that provides it merges it
 * into the framework's `Context` interface, and `./contract.ts` pulls
 * those merges into this program with empty type-only imports. Indexing the
 * context by the key keeps the optional reads optional — a deployment without a
 * web server still gets the command channel — without restating any service
 * shape in this repository.
 * @param ctx - host context.
 * @param key - service name as the registry knows it.
 * @returns the service, or undefined when this composition does not provide it.
 */
function contextService<K extends keyof Context>(
    ctx: Context,
    key: K,
): Context[K] | undefined {
    return ctx.reflect.get(key as string) as Context[K] | undefined;
}

/**
 * Host plugin body.
 *
 * An arrow function on purpose: the loader treats a function with a prototype as
 * a class constructor and keeps that instance's own init hook rather than the
 * returned value, so the disposer below would be discarded. The listeners and the
 * command would still be released on unload, because each one is registered as an
 * effect of this plugin's fiber; the arrow keeps the release explicit and in one
 * place.
 * @param ctx - host context.
 * @param rawConfig - loader-provided configuration.
 * @returns a disposer that releases the command, the projection, and the listeners.
 */
export const apply = (ctx: Context, rawConfig: unknown): (() => void) => {
    const config = resolveConfig(rawConfig);
    const t = NOTICES[config.language];
    const states = new UltracodeStateStore();

    const tools = contextService(ctx, "tools");
    const commands = contextService(ctx, "commands");
    // Read without declaring it in `inject`: the projection registry is the
    // plugin's display channel, not a precondition for the command channel, so a
    // deployment that mounts no projection registry must still arm turns. Every
    // read below tolerates its absence.
    const projections = contextService(ctx, "sessionProjections");

    if (commands === undefined) {
        throw new Error(
            "dsh-ultracode: the command registry is unavailable, so /ultracode cannot be registered",
        );
    }

    /** Whether the configured workflow tool resolves for one agent's scope. */
    const workflowVisible = (agent: AgentLike): boolean =>
        tools !== undefined &&
        tools.get(config.workflowToolName, agent) !== undefined;

    /**
     * Read the state the log fold reports for one session, when it is readable.
     *
     * The registry computes this without any process state, so the answer is the
     * same one the browser is shown and the same one a resumed session starts
     * from. A missing registry, an unregistered key, an error inside the fold, or
     * a malformed answer all yield `null`, and every caller then behaves as it did
     * before the projection existed — which is what keeps a projection problem
     * from breaking the command channel.
     * @param agent - the session's live agent.
     * @returns the folded client-visible state, or null when it cannot be read.
     */
    const foldWire = (agent: AgentLike): UltracodeWire | null => {
        if (projections === undefined) return null;
        try {
            const value = projections.stateOf(agent.session, ULTRACODE_KEY);
            const wire = value?.wire;
            return wire !== undefined && isUltracodeLevel(wire.level)
                ? wire
                : null;
        } catch (error) {
            ctx.logger.warn(
                `dsh-ultracode: reading the folded state failed: ${String(error)}`,
            );
            return null;
        }
    };

    /** Whether one agent drives a top-level session rather than a delegated child. */
    const isTopLevel = (agent: AgentLike): boolean => {
        const header = agent.session.header;
        if (header?.origin === "subagent") return false;
        if (
            typeof header?.delegationDepth === "number" &&
            header.delegationDepth > 0
        )
            return false;
        return true;
    };

    /**
     * Align one session's mirror with the log fold, once.
     *
     * The mirror is what banner injection reads, and it starts at `off` for every
     * session object. A session whose log already reports a level — because a
     * previous host process armed it, or because it was resumed — therefore has to
     * be seeded from the fold before anything reads the mirror, or the two would
     * silently disagree until the user touched the control again.
     * @param agent - the session's live agent.
     * @returns the folded state, or null when the fold is unreadable.
     */
    const adoptFolded = (agent: AgentLike): UltracodeWire | null => {
        const folded = foldWire(agent);
        if (folded !== null) states.adopt(agent.session, folded.level);
        return folded;
    };

    /**
     * Move one session to a level.
     * @param agent - the session's live agent.
     * @param level - the level to put in effect.
     * @returns whether the level actually changed.
     */
    const changeLevel = (agent: AgentLike, level: UltracodeLevel): boolean => {
        adoptFolded(agent);
        return states.select(agent.session, level).kind === "changed";
    };

    /**
     * Apply one control request, from the `/ultracode` command.
     * @param agent - the session's live agent.
     * @param request - the requested operation.
     * @returns a notice for a user-facing caller, or a typed refusal.
     */
    const control = (
        agent: AgentLike,
        request: ControlRequest,
    ): ControlOutcome => {
        adoptFolded(agent);
        const state = states.stateOf(agent.session);
        if (request.action === "set-level") {
            const level =
                typeof request.level === "string" ? request.level : "";
            if (!isUltracodeLevel(level)) {
                return {
                    ok: false,
                    code: "invalid-level",
                    message: t.unknownLevel(level),
                };
            }
            if (level !== "off" && !workflowVisible(agent)) {
                return {
                    ok: false,
                    code: "unavailable",
                    message: t.unavailable,
                };
            }
            const changed = changeLevel(agent, level);
            if (!changed) return { ok: true };
            return {
                ok: true,
                text:
                    level === "off"
                        ? t.levelOff
                        : level === "high"
                          ? t.levelHigh
                          : t.levelUltra,
            };
        }
        // The status answer reports the fold when it is readable, because the fold
        // is what the control displays and what a resumed session starts from; the
        // mirror is a convenience for the synchronous decisions, not a second
        // truth to report.
        const folded = foldWire(agent);
        return {
            ok: true,
            text: t.status(
                levelLabel(folded?.level ?? state.level, config.language),
                workflowVisible(agent),
            ),
        };
    };

    const disposers: Array<() => void> = [];

    // The banner opens the turn: it is inserted directly after the message the
    // turn was opened by, and therefore ahead of the context the runtime appends
    // to the same batch. Appending it at the end instead would place the standing
    // instruction baseline below the concrete request, which inverts the "more
    // specific instructions win" reading that the workspace instructions rely on.
    //
    // Every turn an armed session opens is injected, whatever its message says
    // and however short it is: the level is the whole gate, so a question, a
    // one-word follow-up, and a continuation round all carry the banner. What the
    // turn is injected with does vary — the level's block the first time, one
    // reminder line after that — and that difference is the only one.
    //
    // The turn that follows a level being turned off carries one notice instead,
    // which is why the off branch below is not the early return it used to be:
    // that notice is the turn's only account of the mode having ended.
    const removePreStep = ctx.on("agent/pre-step", (async (
        payload: { agent: AgentLike; messages: StepMessage[] },
        next: () => Promise<{ kind: string; messages: StepMessage[] }>,
    ) => {
        const decision = await next();
        if (decision.kind !== "enter") return decision;
        const agent = payload.agent;
        if (!isTopLevel(agent)) return decision;
        // Align the mirror once before reading it: a session that was armed before
        // this host process started, or that was resumed, carries its level in the
        // log and not in memory, so reading the mirror first would silently arm
        // nothing.
        adoptFolded(agent);
        const state = states.stateOf(agent.session);
        const stepLevel = state.level;
        // A turn with no opening message is not injected either way. The check
        // resolves before the level does, so a batch of this turn's own tool
        // results leaves any pending notice for the turn that does open.
        const anchorIndex = openingIndex(payload.messages);
        if (anchorIndex < 0) return decision;
        const anchor = payload.messages[anchorIndex];
        if (anchor === undefined) return decision;
        const position = decision.messages.findIndex(
            (message) => message.id === anchor.id,
        );
        if (position < 0) return decision;
        if (stepLevel === "off") {
            // Turning the level off is never announced to the model on its own,
            // because no banner is injected for a turn that is not armed. This
            // notice is the one thing an unarmed turn carries: it is owed by the
            // transition and delivered once, so the model stops reading the
            // standing instruction an earlier turn handed it.
            //
            // The claim writes the notice's own anchor field and leaves the
            // banner's alone: that one records which opening already carries an
            // arming banner, and a notice must not make a later arming look
            // delivered.
            if (!states.claimDisarm(agent.session, anchor.id)) return decision;
            states.consumeDisarm(agent.session);
            const notice = createBannerMessage(
                buildDisarmNotice(),
                disarmSummary(),
            );
            const messages = decision.messages.toSpliced(
                position + 1,
                0,
                notice as unknown as StepMessage,
            );
            return { ...decision, messages };
        }
        if (!workflowVisible(agent)) return decision;

        // Every reason to skip is resolved before anything is written back, because
        // the claim and the announcement are both one-shot: consuming either for a
        // step that does not actually inject would leave the opening that does
        // inject with a reminder, or with no banner at all.
        if (!states.claimInjection(agent.session, anchor.id)) return decision;

        const banner = createBannerMessage(
            states.announce(agent.session, stepLevel)
                ? buildInjection(stepLevel)
                : buildReminder(stepLevel),
            injectionSummary(stepLevel),
        );
        const messages = decision.messages.toSpliced(
            position + 1,
            0,
            banner as unknown as StepMessage,
        );
        return { ...decision, messages };
    }) as never);
    disposers.push(removePreStep as () => void);

    const removeCommand = commands.register({
        name: COMMAND_NAME,
        description:
            "Ultracode session mode: arm automatic multi-agent orchestration.",
        input: { hint: LEVEL_WORDS },
        handler: (invocation) => {
            const agent = invocation.agent;
            const rawInput = invocation.rawInput ?? "";
            // Align the mirror with the log before deciding anything: the rotation
            // below advances from the level the user is actually shown, and that level
            // comes from the fold rather than from the fresh mirror's default.
            const folded = adoptFolded(agent);
            const state = states.stateOf(agent.session);
            const currentLevel = folded?.level ?? state.level;
            // The words are read through the same classifier the log fold uses, so the
            // command a person types and the command the fold replays can never mean
            // different things.
            const classification = classifyCommandArgs(rawInput);

            if (classification === "rotate") {
                const next: UltracodeLevel = nextUltracodeLevel(currentLevel);
                const outcome = control(agent, {
                    action: "set-level",
                    level: next,
                });
                return settle(outcome, () =>
                    t.status(
                        levelLabel(next, config.language),
                        workflowVisible(agent),
                    ),
                );
            }
            if (classification === "status")
                return settle(control(agent, { action: "status" }), () => "");
            // Every other word is read as a level through the same vocabulary the
            // classifier used, so a word it refused is refused here as well.
            const word = rawInput.trim().split(/\s+/u)[0] ?? "";
            const level = parseUltracodeLevel(word.toLowerCase());
            if (level === undefined) {
                return {
                    kind: "error",
                    text: `${t.unknownLevel(word)}\n${t.usage}`,
                };
            }
            return settle(
                control(agent, { action: "set-level", level }),
                () => "",
            );
        },
    });
    disposers.push(removeCommand);

    // The projection unit is the plugin's display channel: the registry folds
    // every committed session event through it and notifies its change feed
    // whenever the view changes, and the session-control carrier turns that
    // notification into a frame for every connected browser, so no part of this
    // plugin has to poll, listen for focus, or answer a "what changed" question.
    // Its registration is best effort on purpose — a deployment without the
    // registry still gets the command channel and the banner injection — and it
    // is wrapped because a throw here would take the whole plugin row down,
    // including the command the user may need to recover with.
    if (projections !== undefined) {
        try {
            disposers.push(projections.register(ultracodeProjection()));
        } catch (error) {
            ctx.logger.warn(
                `dsh-ultracode: registering the state projection failed: ${String(error)}`,
            );
        }
    }

    return () => {
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            } catch (error) {
                ctx.logger.warn(
                    `dsh-ultracode: disposer failed: ${String(error)}`,
                );
            }
        }
    };
};

/**
 * Settle one control outcome as a command result.
 * @param outcome - the control outcome.
 * @param fallback - text to produce when the outcome carries none.
 * @returns the command result.
 */
function settle(
    outcome: ControlOutcome,
    fallback: () => string,
): { kind: "success" | "error"; text: string } {
    if (!outcome.ok) return { kind: "error", text: outcome.message };
    const text = outcome.text ?? fallback();
    return { kind: "success", text };
}

/**
 * Find the message that opens one turn's batch.
 *
 * The batch the pre-step waterfall carries is not the whole request: it is what
 * the inbox handed over for this step, and the runtime's own context — the
 * snapshot, the workspace instructions, the skill catalog — is appended to it
 * afterwards. So the message that opens a turn is the last one in the batch that
 * still stands for something being asked of the model.
 *
 * Two sources do not. A tool result is this turn's own continuation rather than a
 * new opening, and a banner this plugin injected is either the injection this
 * very decision is about to make or one the runtime re-queued from an abandoned
 * step; anchoring on either would inject a second banner for the same opening.
 * The last remaining message is the anchor, because it is the newest thing the
 * model is being asked to act on and a batch can carry more than one.
 * @param messages - the batch the inbox handed to this step.
 * @returns the index of the anchoring message, or -1 when the batch holds none.
 */
function openingIndex(messages: readonly StepMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined) continue;
        const source = message.source as { kind?: unknown } | undefined;
        if (source?.kind === "tool") continue;
        if (isUltracodeSource(source)) continue;
        return index;
    }
    return -1;
}
