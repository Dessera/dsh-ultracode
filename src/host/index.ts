/**
 * Host half of the ultracode plugin.
 *
 * The plugin gives one session a three-position orchestration level. While the
 * level is not `off`, a substantive user turn carries a banner that authorizes
 * the workflow tool, and the session's requests ask for the strongest reasoning
 * effort of the route the pin was computed from. The level never enters the log
 * as a record of the plugin's own: a third-party plugin cannot register a
 * durable event type, so the projection unit derives the level from the command
 * lifecycle DSH already records for `/ultracode` and from the banner's own
 * source summary, and host memory holds a per-session mirror for the two
 * decisions that cannot wait for a fold.
 *
 * The feature has three moving parts:
 *
 * - `agent/pre-step` inserts the banner into the batch that enters the model.
 * - `agent/request` applies the reasoning-effort pin and its release.
 * - The `/ultracode` command changes the level from the message box, and the
 *   session projection publishes the current level to the browser.
 *
 * @module @dessera/dsh-ultracode
 */
import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

import { resolveConfig } from "./config.ts";
import {
    EffortResolver,
    withEffortPlan,
    type EffortBearingConfig,
    type EffortPlan,
} from "./effort.ts";
import { isSubstantiveRequest } from "./heuristics.ts";
import {
    COMMAND_NAME,
    isUltracodeLevel,
    levelLabel,
    LEVEL_WORDS,
    nextUltracodeLevel,
    parseUltracodeLevel,
    type UltracodeLevel,
    type UltracodeWire,
} from "./protocol.ts";
import { createBannerMessage } from "./message.ts";
import { NOTICES } from "./notices.ts";
import { buildInjection, injectionSummary } from "./prompt.ts";
import { ultracodeProjection, ULTRACODE_KEY } from "./projection.ts";
import { classifyCommandArgs } from "./reducer.ts";
import { Config } from "./schema.ts";
import { UltracodeStateStore, type RememberedEffort } from "./state.ts";

/** Plugin name registered with the loader. */
export const name = "dsh-ultracode";

/**
 * Services this plugin reads. The loader waits for every one of them before
 * `apply` runs.
 */
export const inject = ["tools", "commands", "llm"];

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
    const llm = contextService(ctx, "llm");
    // Read without declaring it in `inject`: the projection registry is the
    // plugin's display channel, not a precondition for the command channel, so a
    // deployment that mounts no projection registry must still arm turns and pin
    // effort. Every read below tolerates its absence.
    const projections = contextService(ctx, "sessionProjections");
    // Read without declaring it in `inject`: the deployment default is only a
    // fallback for the effort this plugin restores, so a composition that
    // mounts no default-model service must still get the rest of the feature.
    const defaultModel = contextService(ctx, "agentDefaultModel");

    if (commands === undefined) {
        throw new Error(
            "dsh-ultracode: the command registry is unavailable, so /ultracode cannot be registered",
        );
    }

    const effort =
        llm === undefined
            ? undefined
            : new EffortResolver((provider, model, signal) =>
                  llm.resolveModelInfo(provider, model, signal),
              );

    /**
     * Plans applied to the next request of one agent. The pin plan is computed
     * once per arming — at the moment a level is selected when the session
     * already carries a readable request header, and otherwise on the first
     * request of the armed session, which is where a provider and model first
     * become readable — and the release plan is computed when a level returns to
     * `off`.
     */
    const pinPlans = new WeakMap<object, EffortPlan>();
    const releasePlans = new WeakMap<object, EffortPlan>();
    /** Whether the pin plan has already been computed for one agent's level. */
    const pinResolved = new WeakSet<object>();

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

    /** Read the provider/model route one agent currently uses, when readable. */
    const routeOf = (agent: AgentLike): EffortBearingConfig | undefined => {
        const route = agent.session.requestHeader?.()?.config;
        if (
            route === undefined ||
            typeof route.provider !== "string" ||
            typeof route.model !== "string"
        ) {
            return undefined;
        }
        return {
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
        };
    };

    /**
     * Compute the pin plan for one agent, once per arming.
     *
     * The plan is computed lazily on the first request of the armed session,
     * because the route is only known after the session has produced its first
     * request header; every later request then reuses it synchronously.
     */
    const ensurePinPlan = async (
        agent: AgentLike,
    ): Promise<EffortPlan | undefined> => {
        if (effort === undefined) return undefined;
        const existing = pinPlans.get(agent);
        if (existing !== undefined) return existing;
        if (pinResolved.has(agent)) return undefined;
        const route = routeOf(agent);
        if (route === undefined) return undefined;
        pinResolved.add(agent);
        const plan = await effort.pinFor(route);
        if (plan.effort === undefined) return undefined;
        pinPlans.set(agent, plan);
        return plan;
    };

    /**
     * Read the reasoning effort one session's requests carry right now, as the
     * value to restore when the level returns to `off`.
     *
     * The session's own request header is the authoritative record, but a session
     * that has not made a request yet has none. In that case the effective value
     * is the deployment default, which is what the session controller itself
     * falls back to; reading it keeps the release faithful instead of clearing a
     * field the deployment had set.
     * @param agent - the session being armed.
     * @returns the effort to restore; an empty id means the release clears the field.
     */
    const captureEffort = (agent: AgentLike): RememberedEffort => {
        const header = agent.session.requestHeader?.();
        const recorded = header?.config?.reasoningEffort;
        if (typeof recorded === "string") return { effort: recorded };
        // No usable header: the session has not made a request yet, so ask the
        // deployment default the session controller would itself fall back to.
        if (
            header?.config?.provider === undefined &&
            defaultModel !== undefined
        ) {
            try {
                const fromDefault =
                    defaultModel.currentSelection()?.reasoningEffort;
                if (typeof fromDefault === "string")
                    return { effort: fromDefault };
            } catch {
                /* a failing default-model service leaves the effort unknown */
            }
        }
        // Nothing was in force, so releasing the pin clears the field rather than
        // inventing a value.
        return { effort: "" };
    };

    /**
     * Align one session's mirror with the log fold, once.
     *
     * The mirror is what banner injection and the effort pin read, and it starts
     * at `off` for every session object. A session whose log already reports a
     * level — because a previous host process armed it, or because it was resumed
     * — therefore has to be seeded from the fold before anything reads the
     * mirror, or the two would silently disagree until the user touched the
     * control again.
     * @param agent - the session's live agent.
     * @returns the folded state, or null when the fold is unreadable.
     */
    const adoptFolded = (agent: AgentLike): UltracodeWire | null => {
        const folded = foldWire(agent);
        if (folded !== null) states.adopt(agent.session, folded.level);
        return folded;
    };

    /**
     * Move one session to a level, capturing or restoring the reasoning effort
     * that belongs to the transition.
     * @param agent - the session's live agent.
     * @param level - the level to put in effect.
     * @returns whether the level actually changed.
     */
    const changeLevel = (agent: AgentLike, level: UltracodeLevel): boolean => {
        adoptFolded(agent);
        if (states.select(agent.session, level).kind === "unchanged")
            return false;
        if (level === "off") {
            const remembered = states.rememberedEffort(agent.session);
            states.forgetEffort(agent.session);
            pinPlans.delete(agent);
            pinResolved.delete(agent);
            // A release always writes a plan. With a remembered baseline it restores
            // that value; without one — the state of a session whose level came back
            // from the log after a host restart, where the baseline lived only in the
            // previous process — it clears the field, so the session stops asking for
            // the pinned effort instead of keeping it forever.
            if (effort !== undefined) {
                releasePlans.set(agent, effort.restorePlan(remembered));
            }
            return true;
        }
        if (states.rememberedEffort(agent.session) === undefined) {
            states.rememberEffort(agent.session, captureEffort(agent));
        }
        releasePlans.delete(agent);
        pinResolved.delete(agent);
        void ensurePinPlan(agent);
        return true;
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

    // The banner is inserted into the batch that enters the model, after the last
    // message the human actually wrote. Appending at the end would place the
    // standing instruction baseline below the concrete user request, which
    // inverts the "more specific instructions win" reading that the workspace
    // instructions rely on.
    const removePreStep = ctx.on("agent/pre-step", (async (
        payload: { agent: AgentLike; messages: StepMessage[]; turn: number },
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
        if (state.level === "off") return decision;
        if (!workflowVisible(agent)) return decision;

        const humanIndex = lastHumanIndex(decision.messages);
        if (humanIndex < 0) return decision;
        const text = textOf(decision.messages[humanIndex]);
        if (!isSubstantiveRequest(text)) return decision;

        if (!states.claimInjection(agent.session, payload.turn))
            return decision;

        const banner = createBannerMessage(
            buildInjection(state.level),
            name,
            injectionSummary(state.level),
        );
        const messages = decision.messages.toSpliced(
            humanIndex + 1,
            0,
            banner as unknown as StepMessage,
        );
        return { ...decision, messages };
    }) as never);
    disposers.push(removePreStep as () => void);

    // The effort pin is applied after every other listener has resolved the call
    // configuration, so it changes exactly one field of the final answer. The
    // value it writes is the plan computed for the route this arming started on,
    // so a model switch during an armed session keeps the provider and model
    // another listener resolved but not that model's own effort.
    const removeRequest = ctx.on("agent/request", (async (
        payload: { agent: AgentLike },
        next: () => Promise<Record<string, unknown>>,
    ) => {
        const resolved = await next();
        const agent = payload.agent;
        if (effort === undefined || !isTopLevel(agent)) return resolved;
        const state = states.stateOf(agent.session);

        if (state.level !== "off") {
            let plan = pinPlans.get(agent);
            if (plan === undefined) {
                const route = resolved as unknown as EffortBearingConfig;
                if (
                    typeof route.provider !== "string" ||
                    typeof route.model !== "string"
                )
                    return resolved;
                pinResolved.add(agent);
                const computed = await effort.pinFor(route);
                if (computed.effort === undefined) return resolved;
                plan = computed;
                pinPlans.set(agent, plan);
            }
            return withEffortPlan(resolved, plan) as Record<string, unknown>;
        }

        const release = releasePlans.get(agent);
        if (release === undefined) return resolved;
        releasePlans.delete(agent);
        return withEffortPlan(resolved, release) as Record<string, unknown>;
    }) as never);
    disposers.push(removeRequest as () => void);

    const removeCommand = commands.register({
        name: COMMAND_NAME,
        description:
            "Ultracode session mode: arm automatic multi-agent orchestration and pin the reasoning effort.",
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
    // Its
    // registration is best effort on purpose — a deployment without the registry
    // still gets the command channel, the banner injection, and the effort pin —
    // and it is wrapped because a throw here would take the whole plugin row
    // down, including the command the user may need to recover with.
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
 * Find the last message in one batch that a human wrote.
 *
 * A user-role message can be direct human input, plugin-injected context, or a
 * goal-continuation turn; only the message source tells them apart, so the
 * banner is anchored on the source rather than on position or length.
 * @param messages - the messages entering the step.
 * @returns the index of the last human message, or -1 when there is none.
 */
function lastHumanIndex(messages: readonly StepMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message !== undefined && message.source?.kind === "user")
            return index;
    }
    return -1;
}

/**
 * Read the plain text of one message.
 * @param message - the message to read.
 * @returns the concatenated text blocks.
 */
function textOf(message: StepMessage | undefined): string {
    if (message === undefined) return "";
    let text = "";
    for (const block of message.content ?? []) {
        if (
            typeof block === "object" &&
            block !== null &&
            (block as { type?: string }).type === "text"
        ) {
            const value = (block as { text?: unknown }).text;
            if (typeof value === "string") text += `${value}\n`;
        }
    }
    return text;
}
