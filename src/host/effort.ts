/**
 * Reasoning-effort pinning.
 *
 * While a session's level is not `off`, its requests ask for the strongest
 * reasoning effort of the route the pin was computed from. The pin is applied on
 * the `agent/request` waterfall — after every other listener has resolved the
 * call configuration — and it changes one field only: the reasoning effort.
 * Provider and model stay exactly as resolved, so switching the model in the
 * composer keeps working and no model-switch notice is produced.
 *
 * The decision is computed once per arming and reused for every later request. A
 * model switch made while the level stays armed therefore keeps its own provider
 * and model but not its own effort: the request still asks for the effort of the
 * route the plan was computed from, and the harness refuses a request whose
 * effort id the model in use does not declare.
 *
 * The configuration a session was running before its first pin is remembered in
 * host memory and written back when the level returns to `off`. A host restart
 * forgets it, so the release then clears the field: the request falls back to
 * the model's own default instead of staying pinned at the strongest effort.
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
    /**
     * The effort the pin selects for the route — the last non-off entry the route
     * declares — or undefined when it declares none.
     */
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
        return { effort };
    }

    /**
     * The effort to request once a session's level returns to `off`.
     *
     * A remembered value is written back as an explicit request. Nothing
     * remembered means the session found no effort it could read before the pin —
     * the state after a host restart, where the baseline lived only in the
     * previous process, or the state of a session with no usable request header
     * whose deployment provides no default model either — and the field is then
     * cleared, so the request falls back to the model's own default rather than
     * keeping the pinned effort.
     * @param remembered - the effort the session was running before its first pin.
     * @returns the plan restoring the remembered configuration, or the plan that
     *   clears the field when nothing was remembered.
     */
    restorePlan(
        remembered: { readonly effort: string } | undefined,
    ): EffortPlan {
        if (remembered === undefined || remembered.effort === "")
            return { effort: undefined };
        return { effort: remembered.effort };
    }

    /**
     * Find the strongest effort one route declares.
     *
     * The adapter publishes its efforts in its own preferred display order, and
     * the harness guarantees that order as a display order only — it does not
     * promise that the order runs weakest to strongest. The pin therefore takes
     * the last non-off entry and assumes that weakest-first ordering; a route that
     * declares its efforts strongest first makes the pin select the weaker entry,
     * which is still preferable to a hard-coded ranking that would break on a
     * provider naming its levels differently.
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
 * Only the `reasoningEffort` field is touched. The harness decides for itself
 * whether a value was adapter-defaulted, recomputing that marking from whether
 * the caller supplied the field, so a plan that wrote the marking would be
 * writing something the loop ignores — and the value it would write there
 * (`false`) is one the persisted header schema does not admit at all.
 * @param config - the resolved call configuration.
 * @param plan - the effort plan for this request.
 * @returns the configuration to use for this request.
 */
export function withEffortPlan<T extends { reasoningEffort?: unknown }>(
    config: T,
    plan: EffortPlan,
): T {
    if (plan.effort === undefined) {
        if (config.reasoningEffort === undefined) return config;
        const cleared = { ...config };
        delete (cleared as { reasoningEffort?: unknown }).reasoningEffort;
        return cleared;
    }
    if (config.reasoningEffort === plan.effort) return config;
    return { ...config, reasoningEffort: plan.effort } as T;
}
