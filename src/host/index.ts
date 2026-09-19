/**
 * Host half of the ultracode plugin.
 *
 * The plugin gives one session a three-position orchestration level. While the
 * level is not `off`, a substantive user turn carries a banner that authorizes
 * the workflow tool, and the session's requests ask for the strongest
 * reasoning effort its model reports. The level itself never enters the session
 * log: a third-party plugin cannot register a durable event type, so state is
 * kept in host memory, keyed by session, and disappears with the session.
 *
 * Three channels carry the feature:
 *
 * - `agent/pre-step` inserts the banner into the batch that enters the model.
 * - `agent/request` applies the reasoning-effort pin and its release.
 * - A host web-server route under the configured prefix serves the composer
 *   control its state and accepts level, keyword, and arming changes. The
 *   `/ultracode` command drives the same operations from the message box.
 *
 * @module @dessera/dsh-ultracode
 */
import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

import { resolveConfig, type ResolvedConfig } from "./config.ts";
import {
    EffortResolver,
    withEffortPlan,
    type EffortBearingConfig,
    type EffortPlan,
} from "./effort.ts";
import {
    buildKeywordPattern,
    isSubstantiveRequest,
    matchesKeyword,
} from "./heuristics.ts";
import {
    COMMAND_NAME,
    isUltracodeLevel,
    levelLabel,
    LEVEL_WORDS,
    nextUltracodeLevel,
    type UltracodeLevel,
    type UltracodeWire,
} from "./protocol.ts";
import { createBannerMessage } from "./message.ts";
import { NOTICES } from "./notices.ts";
import { buildInjection, injectionSummary } from "./prompt.ts";
import { ultracodeProjection, ULTRACODE_KEY } from "./projection.ts";
import {
    classifyCommandArgs,
    parseCommandLevel,
    type ArmReason,
} from "./reducer.ts";
import { Config } from "./schema.ts";
import { UltracodeStateStore, type RememberedEffort } from "./state.ts";

/** Plugin name registered with the loader. */
export const name = "dsh-ultracode";

/**
 * Services this plugin reads. The web server is declared so the loader waits
 * for it before `apply` runs and the control route is registered on time; a
 * deployment without a web server still gets the command channel, because
 * every read goes through `ctx.reflect.get`.
 */
export const inject = ["tools", "commands", "llm", "agents", "webServer"];

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
    readonly action: "set-level" | "status" | "clear-turn";
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
 * into the framework's `Context` interface, and `./host-contract.ts` pulls
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
 * Resolve a live agent from a session id that arrived as wire text.
 *
 * The registry addresses sessions by a branded id, while the id this plugin
 * receives comes from a query string or a JSON body, where the brand cannot
 * exist. This is the one place that boundary is crossed, and it is crossed in a
 * lookup: an id that names no live session simply resolves to undefined, so a
 * forged or stale string can only miss, never reach the wrong session.
 * @param agents - the agent registry, when this composition provides one.
 * @param id - session id read off the wire.
 * @returns the live agent, or undefined when no session has that id.
 */
function liveAgentOf(
    agents: Context["agents"] | undefined,
    id: string,
): AgentLike | undefined {
    return agents?.get(
        id as Parameters<NonNullable<Context["agents"]>["get"]>[0],
    );
}

/**
 * Host plugin body.
 *
 * An arrow function on purpose: the loader treats a function with a prototype
 * as a class constructor, which would discard the disposer this body returns
 * and leave the route and the listeners registered after an unload.
 * @param ctx - host context.
 * @param rawConfig - loader-provided configuration.
 * @returns a disposer that releases the route, the command, and the listeners.
 */
export const apply = (ctx: Context, rawConfig: unknown): (() => void) => {
    const config: ResolvedConfig = resolveConfig(rawConfig);
    const t = NOTICES[config.language];
    const states = new UltracodeStateStore();
    const keywordPattern = buildKeywordPattern(config.keywords);

    const tools = contextService(ctx, "tools");
    const commands = contextService(ctx, "commands");
    const llm = contextService(ctx, "llm");
    const agents = contextService(ctx, "agents");
    const webServer = contextService(ctx, "webServer");
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
     * when a level is selected, so the request waterfall itself stays free of
     * asynchronous work; the release plan is computed when a level returns to
     * `off` for the same reason.
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

    /** Read the reasoning effort currently recorded for one agent, when readable. */
    const currentEffort = (agent: AgentLike): string | undefined => {
        const value = agent.session.requestHeader?.()?.config?.reasoningEffort;
        return typeof value === "string" ? value : undefined;
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
     * field the deployment had set. The value is marked as not adapter-defaulted
     * because that is how the default-model path reaches a request: the selection
     * is written into the call configuration explicitly.
     * @param agent - the session being armed.
     * @returns the effort to restore, or undefined when nothing is readable.
     */
    const captureEffort = (agent: AgentLike): RememberedEffort => {
        const header = agent.session.requestHeader?.();
        const recorded = header?.config?.reasoningEffort;
        if (typeof recorded === "string") {
            return {
                effort: recorded,
                adapterDefault:
                    header?.adapterDefaults?.reasoningEffort === true,
            };
        }
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
                    return { effort: fromDefault, adapterDefault: false };
            } catch {
                /* a failing default-model service leaves the effort unknown */
            }
        }
        // Nothing was in force, so releasing the pin clears the field rather than
        // inventing a value.
        return { effort: "", adapterDefault: false };
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
        if (folded === null) return null;
        if (states.adopted(agent.session)) {
            states.reconcile(agent.session, folded.level);
            return folded;
        }
        states.adopt(agent.session, folded.level);
        return folded;
    };

    /**
     * Move one session to a level, capturing or restoring the reasoning effort
     * that belongs to the transition.
     * @param agent - the session's live agent.
     * @param level - the level to put in effect.
     * @param force - apply the level even when the mirror already reports it.
     * @returns whether the level actually changed.
     */
    const changeLevel = (
        agent: AgentLike,
        level: UltracodeLevel,
        force = false,
    ): boolean => {
        adoptFolded(agent);
        const change = states.select(agent.session, level);
        if (change.kind === "unchanged" && !force) return false;
        if (level === "off") {
            const remembered = states.rememberedEffort(agent.session);
            states.forgetEffort(agent.session);
            pinPlans.delete(agent);
            pinResolved.delete(agent);
            if (remembered !== undefined && effort !== undefined) {
                releasePlans.set(agent, effort.restorePlan(remembered));
            }
            return change.kind === "changed";
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
     * Apply one control request. Both the route and the command funnel through
     * here so the two channels can never disagree about what a level means.
     * @param agent - the session's live agent.
     * @param request - the requested operation.
     * @param force - apply a level change even when the mirror already reports it.
     * @returns a notice for a user-facing caller, or a typed refusal.
     */
    const control = (
        agent: AgentLike,
        request: ControlRequest,
        force = false,
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
            const changed = changeLevel(agent, level, force);
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
        if (request.action === "clear-turn") {
            states.clearTurn(agent.session);
            return { ok: true, text: t.cleared };
        }
        // The status answer reports the fold when it is readable, because the fold
        // is what the control displays and what a resumed session starts from; the
        // mirror is a convenience for the two synchronous decisions, not a second
        // truth to report.
        const folded = foldWire(agent);
        return {
            ok: true,
            text: t.status(
                levelLabel(folded?.level ?? state.level, config.language),
                config.keywordTrigger,
                folded?.armedTurn ?? states.armedTurn(agent.session),
                workflowVisible(agent),
            ),
        };
    };

    /**
     * Build the view one session's control renders.
     *
     * The three display fields come from the log fold whenever it is readable, so
     * what the control shows is what the fold derived rather than a second value
     * the host happens to hold. The mirror stays the source for the two decisions
     * that cannot wait for a fold, and `available` stays a live question about the
     * agent's scope.
     */
    const viewFor = (agent: AgentLike): Record<string, unknown> => ({
        ...states.viewOf(
            agent.session,
            workflowVisible(agent),
            currentEffort(agent),
            config.statePath,
            foldWire(agent) ?? undefined,
        ),
    });

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

        const keywordHit =
            config.keywordTrigger && matchesKeyword(text, keywordPattern);
        const reason: ArmReason = keywordHit ? "keyword" : "level";
        if (!states.claimInjection(agent.session, payload.turn, reason))
            return decision;

        const banner = createBannerMessage(
            buildInjection(state.level, reason),
            name,
            injectionSummary(state.level, reason),
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
    // configuration, so it changes exactly one field of the final answer and
    // never disturbs a model switch another listener performed.
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
            const classification = classifyCommandArgs(
                rawInput,
                config.extraLevels,
            );

            if (classification === "rotate") {
                const next: UltracodeLevel = nextUltracodeLevel(currentLevel);
                const outcome = control(agent, {
                    action: "set-level",
                    level: next,
                });
                return settle(outcome, () =>
                    t.status(
                        levelLabel(next, config.language),
                        config.keywordTrigger,
                        states.armedTurn(agent.session),
                        workflowVisible(agent),
                    ),
                );
            }
            if (classification === "status")
                return settle(control(agent, { action: "status" }), () => "");
            if (classification === "clear")
                return settle(
                    control(agent, { action: "clear-turn" }),
                    () => "",
                );
            if (classification === "unknown-level") {
                const word = rawInput.trim().split(/\s+/u)[0] ?? "";
                return {
                    kind: "error",
                    text: `${t.unknownLevel(word)}\n${t.usage}`,
                };
            }
            const words = rawInput.trim().split(/\s+/u);
            const level = parseCommandLevel(
                (words[0] ?? "").toLowerCase(),
                config.extraLevels,
            );
            if (level === undefined) {
                return {
                    kind: "error",
                    text: `${t.unknownLevel(words[0] ?? "")}\n${t.usage}`,
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
    // every committed session event through it and pushes a frame to every
    // connected browser whenever the view changes, so no part of this plugin has
    // to poll, listen for focus, or answer a "what changed" question. Its
    // registration is best effort on purpose — a deployment without the registry
    // still gets the command channel, the banner injection, and the effort pin —
    // and it is wrapped because a throw here would take the whole plugin row
    // down, including the command the user may need to recover with.
    if (projections !== undefined) {
        try {
            const unit = ultracodeProjection({
                extraLevels: config.extraLevels,
            });
            disposers.push(projections.register(unit));
        } catch (error) {
            ctx.logger.warn(
                `dsh-ultracode: registering the state projection failed: ${String(error)}`,
            );
        }
    }

    // The HTTP route is both the read channel and the write channel the composer
    // control uses. It is a plain same-origin route rather than a Remote service,
    // so the plugin needs no generated client declaration and the control needs
    // no code-generation step.
    if (webServer !== undefined) {
        const removeRoute = webServer.register({
            kind: "exact",
            path: config.statePath,
            handler: async (request, response) => {
                const method = (request.method ?? "GET").toUpperCase();
                try {
                    if (method === "GET") {
                        const sessionId = sessionIdOf(request);
                        const agent =
                            sessionId === undefined
                                ? undefined
                                : liveAgentOf(agents, sessionId);
                        if (agent === undefined) {
                            sendJson(response, 404, {
                                error: "session-not-live",
                                sessionId: sessionId ?? null,
                            });
                            return;
                        }
                        // Align the mirror before reporting it. A session whose level was
                        // chosen before this host process started carries it in the log, so
                        // answering from the fresh mirror would report `off` for a session
                        // that is in fact armed.
                        adoptFolded(agent);
                        sendJson(response, 200, viewFor(agent));
                        return;
                    }
                    if (method === "POST") {
                        const body = await readJson(request);
                        const sessionId =
                            typeof body.sessionId === "string"
                                ? body.sessionId
                                : undefined;
                        const agent =
                            sessionId === undefined
                                ? undefined
                                : liveAgentOf(agents, sessionId);
                        if (agent === undefined) {
                            sendJson(response, 404, {
                                error: "session-not-live",
                                sessionId: sessionId ?? null,
                            });
                            return;
                        }
                        // The route is the channel the previously built browser half uses,
                        // and a tab that still runs it must keep working while the new half
                        // rolls out. It therefore applies the level even when the mirror
                        // already reports it: the mirror may only just have been seeded from
                        // the fold, in which case the caller's intent is still a real
                        // transition that has to take effect.
                        const outcome = control(
                            agent,
                            {
                                action: normalizeAction(body.action),
                                level: body.level,
                            },
                            true,
                        );
                        if (!outcome.ok) {
                            sendJson(response, 400, {
                                error: outcome.code,
                                message: outcome.message,
                            });
                            return;
                        }
                        sendJson(response, 200, {
                            ...viewFor(agent),
                            notice: outcome.text ?? null,
                        });
                        return;
                    }
                    sendJson(response, 405, { error: "method-not-allowed" });
                } catch (error) {
                    ctx.logger.warn(
                        `dsh-ultracode: control route failed: ${String(error)}`,
                    );
                    sendJson(response, 500, { error: "internal" });
                }
            },
        });
        disposers.push(removeRoute);
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
 * Narrow a wire action name onto the control vocabulary.
 * @param action - the raw wire value.
 * @returns the action, defaulting to `status` for an unknown value.
 */
function normalizeAction(action: unknown): ControlRequest["action"] {
    if (action === "set-level" || action === "clear-turn") return action;
    return "status";
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

/**
 * Read the session id from a request URL.
 * @param request - the incoming request, whose `url` is a possibly undefined
 *   property on a Node request rather than an absent one.
 * @returns the session id, or undefined when the query carries none.
 */
function sessionIdOf(request: {
    url?: string | undefined;
}): string | undefined {
    const url = request.url ?? "";
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const value = new URLSearchParams(query).get("sessionId");
    return value === null || value === "" ? undefined : value;
}

/**
 * Collect and parse a JSON request body.
 * @param request - the incoming request.
 * @returns the parsed body; an empty body parses to an empty object.
 */
async function readJson(request: {
    on(event: string, listener: (chunk?: unknown) => void): void;
}): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
        request.on("data", (chunk) => chunks.push(String(chunk)));
        request.on("end", () => resolve());
        request.on("error", (error) =>
            reject(error instanceof Error ? error : new Error(String(error))),
        );
    });
    const raw = chunks.join("");
    if (raw.trim() === "") return {};
    const parsed: unknown = JSON.parse(raw);
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new TypeError("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
}

/**
 * Write one JSON response.
 * @param response - the response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(
    response: {
        writeHead(status: number, headers?: Record<string, string>): void;
        end(body?: string): void;
    },
    status: number,
    payload: unknown,
): void {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(payload));
}
