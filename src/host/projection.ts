/**
 * The session projection unit that publishes the ultracode level.
 *
 * DSH's projection registry carries one unit per client-visible key. The
 * registry owns delivery: it folds every committed session event through the
 * unit, computes the view, and notifies its change feed when that view changes
 * by `Object.is`; the session-control carrier turns that notification into a
 * frame for every connected browser. That is why this module registers a unit
 * and then does nothing else — there is no publish call, no connection list, and
 * no polling anywhere in the plugin.
 *
 * The unit is a pure function of the session log. The registry erases the
 * definition into a fixed shape that forwards only `(state)` and
 * `(state, event)`, and it calls `wire.view` on cold paths as well, where no
 * live agent and no process state exist.
 *
 * @module @dessera/dsh-ultracode/projection
 */
/**
 * The unit definition's shape is the harness's own `ProjectionDefinition`,
 * narrowed to this plugin's key and state type. The two merge tables that key
 * lands in are declared by `./contract.ts` through the package's
 * pure-type outlet, and the outlet is what that file augments, so neither the
 * host-side context merges nor any runtime code reach either bundle.
 */
import type { UltracodeProjectionUnit } from "./contract.ts";

import {
    ProjectionStateSchema,
    UltracodeWireSchema,
    ULTRACODE_KEY,
    ULTRACODE_STATE_VERSION,
    type ParseSchema,
    type UltracodeWire,
} from "./protocol.ts";
import {
    applyProjectionEvent,
    initialProjectionState,
    type ProjectionState,
} from "./reducer.ts";

/** The projection key this unit owns, re-exported for the host entry. */
export { ULTRACODE_KEY, ULTRACODE_STATE_VERSION };

/**
 * The unit definition, in the shape the harness's registry accepts.
 *
 * The shape is the harness's own `ProjectionDefinition`, parameterized by this
 * plugin's key, so a change to the registry contract becomes a compile error
 * here rather than a runtime surprise. The state and view stay this plugin's own
 * types because `./contract.ts` registers this key in the registry's two
 * merge tables, which is what the parameterization resolves through.
 */
export type UltracodeProjection = UltracodeProjectionUnit;

/**
 * The unit's client view, in the harness's shape with the wire block required.
 *
 * The base definition makes `wire` conditional because a host-only unit has
 * none — the member is `never`, not `undefined`, for a key that is absent from
 * the client-visible table. This key is in that table, so the block is present;
 * `NonNullable` states that once, here, instead of repeating a guard at each use.
 */
type UltracodeWireBlock = NonNullable<UltracodeProjection["wire"]>;

/**
 * The unit as the registry's publishing overload accepts it.
 *
 * The two `register` overloads are discriminated by whether `wire` is present
 * and required, and the generic definition keeps `wire` conditional even for a
 * key that is in the client-visible table. This alias states the publishing form
 * once, so the registration site does not have to repeat the conditional.
 */
export type UltracodeRegistration = Omit<UltracodeProjection, "wire"> & {
    wire: UltracodeWireBlock;
};

/** The state a unit folds before any session event arrives. */
export const INITIAL_PROJECTION_STATE: ProjectionState =
    ProjectionStateSchema.parse(initialProjectionState());

/**
 * Present a local state validator where the registry demands the schema library's type.
 *
 * The registry declares `stateSchema` and `viewSchema` as that library's type,
 * while this plugin ships plain objects that implement `parse` and nothing else
 * — deliberately, because the plugin's own wire shapes are what the registry
 * validates, a schema library would add a dependency for no further guarantee,
 * and a validator that rebuilt the view on every call would break the reference
 * reuse the registry's change detection depends on. The runtime contract holds
 * because the registry only ever calls `parse`. These two functions are the only
 * place the difference is bridged, and they are why no schema library appears
 * among the plugin's dependencies.
 * @param schema - the plugin's own validator.
 * @returns the same object, typed as the registry declares it.
 */
const asStateSchema = (
    schema: ParseSchema<ProjectionState>,
): UltracodeProjection["stateSchema"] =>
    schema as unknown as UltracodeProjection["stateSchema"];

/**
 * Present a local view validator where the registry demands the schema library's type.
 * @param schema - the plugin's own validator.
 * @returns the same object, typed as the registry declares it.
 */
const asViewSchema = (
    schema: ParseSchema<UltracodeWire>,
): UltracodeWireBlock["viewSchema"] =>
    schema as unknown as UltracodeWireBlock["viewSchema"];

/**
 * Build the projection unit.
 *
 * The two validators pass through {@link asStateSchema} and {@link asViewSchema},
 * which bridge this plugin's plain `{ parse }` objects to the schema type the
 * registry declares. The unit's key, state, view and transition functions are
 * all checked against the harness's own `ProjectionDefinition`, so a change to
 * that contract fails here rather than at runtime.
 * @returns the unit definition to hand to the projection registry.
 */
export function ultracodeProjection(): UltracodeRegistration {
    return {
        key: ULTRACODE_KEY,
        stateVersion: ULTRACODE_STATE_VERSION,
        stateSchema: asStateSchema(ProjectionStateSchema),
        init: () => INITIAL_PROJECTION_STATE,
        apply: (state, event) =>
            applyProjectionEvent(
                state,
                event as Parameters<typeof applyProjectionEvent>[1],
            ),
        wire: {
            viewSchema: asViewSchema(UltracodeWireSchema),
            view: (state) => state.wire,
        },
    };
}
