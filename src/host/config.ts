/**
 * Plugin configuration defaults and resolution.
 *
 * This module is the configuration's single source of truth and depends on
 * nothing but itself, so it can be unit-tested without a host. The loader-facing
 * schema that validates a deployment's overrides lives in `schema.ts` and
 * applies the same defaults; a change to a default belongs in both places, and
 * `test/host-schema.test.mjs` pins the values that both must agree on.
 *
 * @module @dessera/dsh-ultracode/config
 */

/** Validated plugin configuration. */
export interface UltracodeConfig {
    /** Name under which this deployment registers the workflow tool. */
    workflowToolName: string;
    /** Language of every notice the plugin prints to the user. */
    language: "zh" | "en";
}

/** Default name of the workflow tool in a stock deployment. */
export const DEFAULT_TOOL_NAME = "workflow";

/** Read one field, falling back to a default when it is absent or unusable. */
function pick<T>(
    value: unknown,
    fallback: T,
    accept: (candidate: unknown) => candidate is T,
): T {
    return accept(value) ? value : fallback;
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Resolve one loader-supplied configuration object.
 *
 * A missing object yields the documented defaults, and an individual field
 * that is absent or of the wrong shape falls back to its own default. A blank
 * `workflowToolName` is fatal: the visibility check matches that name against a
 * tool that has to exist, so a deployment which cleared it could never arm
 * anything. The loader schema refuses a blank name as well, which makes this
 * throw the second line of defence rather than the only one.
 * @param raw - the loader-provided configuration, possibly absent.
 * @returns the resolved configuration.
 */
export function resolveConfig(raw: unknown): UltracodeConfig {
    const source =
        typeof raw === "object" && raw !== null
            ? (raw as Record<string, unknown>)
            : {};
    const toolName = pick(
        source.workflowToolName,
        DEFAULT_TOOL_NAME,
        isString,
    ).trim();
    if (toolName === "")
        throw new TypeError(
            "dsh-ultracode: workflowToolName must not be empty",
        );

    const language = source.language === "en" ? "en" : "zh";

    return { workflowToolName: toolName, language };
}
