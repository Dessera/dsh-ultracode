/**
 * Reasoning-effort pinning.
 *
 * While a session's level is not `off`, its requests ask for the strongest
 * reasoning effort the current model reports. The pin is applied on the
 * `agent/request` waterfall — after every other listener has resolved the call
 * configuration — and it changes one field only: the reasoning effort. Provider
 * and model stay exactly as resolved, so switching the model in the composer
 * keeps working and no model-switch notice is produced.
 *
 * The configuration a session was running before its first pin is remembered
 * in host memory and written back when the level returns to `off`. A host
 * restart forgets it; the session then falls back to the model's own default,
 * which is recorded as a known limitation.
 *
 * @module @dessera/dsh-ultracode/effort
 */

/** The subset of the LLM service this module needs. */
export interface EffortModelInfo {
    readonly reasoning?: {
        readonly efforts: readonly {
            readonly id: string;
            readonly name: string;
        }[];
        /**
         * Effort the adapter materializes when a caller requests none. The pin
         * deliberately ignores it: an armed session asks for the strongest effort
         * the route declares, in the order the route declares them.
         */
        readonly defaultEffort?: string;
    };
}

/** Reads route metadata for one exact provider/model pair. */
export type ResolveModelInfo = (
    provider: string,
    model: string,
    signal?: AbortSignal,
) => Promise<EffortModelInfo>;

/** A resolved answer for one provider/model route. */
export interface RouteEffort {
    /** Strongest effort the route reports, or undefined when it reports none. */
    readonly strongest?: string;
}

/** One request-level effort decision. */
export interface EffortPlan {
    /**
     * Effort to request. An explicitly undefined value clears the field, which
     * is why this property admits undefined and not only absence: a plan that
     * clears the field and a plan that decides nothing are different
     * instructions, even though both are applied the same way.
     */
    readonly effort?: string | undefined;
    /** How `adapterDefaults.reasoningEffort` must be set for that value. */
    readonly adapterDefault?: boolean;
}

/** The part of a call configuration that effort planning reads and writes. */
export interface EffortBearingConfig {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: unknown;
}

/**
 * Caches one route's effort metadata so a request never pays for the lookup
 * twice, and exposes the two decisions the request waterfall needs.
 */
export class EffortResolver {
    private readonly cache = new Map<string, Promise<RouteEffort>>();
    private readonly resolveModel: ResolveModelInfo;
    private readonly explicit: string | undefined;

    /**
     * @param resolveModel - route metadata reader, normally `ctx.llm.resolveModelInfo`.
     * @param explicit - configured effort id to pin instead of the strongest reported one.
     */
    constructor(resolveModel: ResolveModelInfo, explicit?: string) {
        const trimmed = explicit?.trim();
        this.resolveModel = resolveModel;
        this.explicit =
            trimmed === undefined || trimmed === "" ? undefined : trimmed;
    }

    /**
     * Read one route's effort metadata, caching both fulfillment and rejection.
     * @param provider - registered provider route.
     * @param model - provider-owned model id.
     * @returns the resolved route answer; a route that reports nothing resolves to
     *   an empty answer.
     */
    routeFor(provider: string, model: string): Promise<RouteEffort> {
        const key = `${provider}\u0000${model}`;
        let pending = this.cache.get(key);
        if (pending === undefined) {
            pending = this.lookup(provider, model).catch(() => ({}));
            this.cache.set(key, pending);
        }
        return pending;
    }

    /**
     * The effort to request while a session's level is armed.
     * @param config - the resolved call configuration.
     * @returns the effort to pin, or undefined when the route offers none.
     */
    async pinFor(config: EffortBearingConfig): Promise<EffortPlan> {
        const route = await this.routeFor(config.provider, config.model);
        const effort = this.explicit ?? route.strongest;
        if (effort === undefined) return {};
        return { effort, adapterDefault: false };
    }

    /**
     * The effort to request once a session's level returns to `off`.
     *
     * The plan carries the adapter-default flag only when the remembered value
     * really was adapter-owned. Writing an explicit `false` would add a field to
     * the persisted request header that a session running without this plugin
     * would not have, so the key is omitted for a caller-proposed value.
     * @param remembered - the effort the session was running before its first pin.
     * @returns the plan restoring the remembered configuration, or the plan that
     *   clears the field when nothing was remembered.
     */
    restorePlan(
        remembered:
            | { readonly effort: string; readonly adapterDefault: boolean }
            | undefined,
    ): EffortPlan {
        if (remembered === undefined || remembered.effort === "")
            return { effort: undefined };
        return remembered.adapterDefault
            ? { effort: remembered.effort, adapterDefault: true }
            : { effort: remembered.effort };
    }

    /**
     * Find the strongest effort one route declares.
     *
     * The adapter publishes its efforts in its own preferred display order, so
     * the last non-off entry is the strongest one it offers. That order is the
     * only one the harness guarantees; a hard-coded strength ranking would
     * silently pin a weaker level on a provider that names its levels differently.
     * @param provider - registered provider route.
     * @param model - provider-owned model id.
     * @returns the resolved route answer.
     */
    private async lookup(
        provider: string,
        model: string,
    ): Promise<RouteEffort> {
        const info = await this.resolveModel(provider, model);
        const efforts = info.reasoning?.efforts ?? [];
        for (let index = efforts.length - 1; index >= 0; index -= 1) {
            const effort = efforts[index];
            if (effort !== undefined && effort.id !== "off")
                return { strongest: effort.id };
        }
        return {};
    }
}

/**
 * Apply one effort plan to a resolved call configuration.
 *
 * `adapterDefaults.reasoningEffort` is the harness's own flag for "this value
 * came from the adapter rather than from a caller". Restoring a remembered
 * adapter-owned effort without setting it would leave the persisted header
 * reading as though the value had been requested explicitly, which is exactly
 * the state the session-controller avoids when it writes a selection.
 * @param config - the resolved call configuration.
 * @param plan - the effort plan for this request.
 * @returns the configuration to use for this request.
 */
export function withEffortPlan<
    T extends { reasoningEffort?: unknown; adapterDefaults?: unknown },
>(config: T, plan: EffortPlan): T {
    const nextDefaults =
        config.adapterDefaults === undefined
            ? undefined
            : {
                  ...(config.adapterDefaults as Record<string, unknown>),
                  ...(plan.adapterDefault === undefined
                      ? {}
                      : { reasoningEffort: plan.adapterDefault }),
              };
    const sameDefaults =
        nextDefaults === undefined ||
        JSON.stringify(nextDefaults) ===
            JSON.stringify(config.adapterDefaults as Record<string, unknown>);

    if (plan.effort === undefined) {
        if (config.reasoningEffort === undefined && sameDefaults) return config;
        const cleared = { ...config };
        delete (cleared as { reasoningEffort?: unknown }).reasoningEffort;
        if (nextDefaults === undefined) {
            delete (cleared as { adapterDefaults?: unknown }).adapterDefaults;
        } else {
            (cleared as { adapterDefaults?: unknown }).adapterDefaults =
                nextDefaults;
        }
        return cleared;
    }
    if (config.reasoningEffort === plan.effort && sameDefaults) return config;
    return {
        ...config,
        reasoningEffort: plan.effort,
        ...(nextDefaults === undefined
            ? {}
            : { adapterDefaults: nextDefaults }),
    } as T;
}
