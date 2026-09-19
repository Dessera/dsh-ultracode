/**
 * Plugin configuration defaults and resolution.
 *
 * This module is the configuration's single source of truth and depends on
 * nothing but itself, so it can be unit-tested without a host. The loader-facing
 * schema that validates a deployment's overrides lives in `schema.ts` and
 * applies the same defaults; a change to a default belongs in both places, and
 * `test/config-effort.test.mjs` pins the values that both must agree on.
 *
 * @module @dessera/dsh-ultracode/config
 */

/** Validated plugin configuration. */
export interface UltracodeConfig {
    /** Name under which this deployment registers the workflow tool. */
    workflowToolName: string;
    /** Whether a trigger word inside a message arms that turn. */
    keywordTrigger: boolean;
    /** Trigger words matched while {@link keywordTrigger} is true. */
    keywords: string[];
    /** Extra level names the `/ultracode` command accepts as aliases. */
    extraLevels: string[];
    /** Language of every notice the plugin prints to the user. */
    language: "zh" | "en";
    /** Scope of the state route registered on the host web server. */
    routePrefix: string;
}

/** Configuration resolved from a possibly partial loader-provided object. */
export interface ResolvedConfig extends UltracodeConfig {
    /** The route path serving the control state, derived from the prefix. */
    readonly statePath: string;
}

/** Default trigger word, matched only while the keyword path is armed. */
export const DEFAULT_KEYWORDS: readonly string[] = ["ultracode"];

/** Default route prefix of the control-state route. */
export const DEFAULT_ROUTE_PREFIX = "/dsh-ultracode";

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
const isBoolean = (value: unknown): value is boolean =>
    typeof value === "boolean";
const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * Resolve one loader-supplied configuration object.
 *
 * A missing object yields the documented defaults, and an individual field
 * that is absent or of the wrong shape falls back to its own default. The two
 * string fields are not treated alike. A blank `routePrefix` is one more
 * unusable value and falls back to the default prefix, but a blank
 * `workflowToolName` is fatal: the visibility check matches that name against a
 * tool that has to exist, so a deployment which cleared it could never arm
 * anything. The loader schema refuses a blank name as well, which makes this
 * throw the second line of defence rather than the only one.
 * @param raw - the loader-provided configuration, possibly absent.
 * @returns the resolved configuration with its derived route path.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
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

    const prefix = pick(
        source.routePrefix,
        DEFAULT_ROUTE_PREFIX,
        isString,
    ).trim();
    const routePrefix =
        prefix === ""
            ? DEFAULT_ROUTE_PREFIX
            : prefix.startsWith("/")
              ? prefix
              : `/${prefix}`;
    const language = source.language === "en" ? "en" : "zh";

    return {
        workflowToolName: toolName,
        keywordTrigger: pick(source.keywordTrigger, false, isBoolean),
        keywords: pick(source.keywords, [...DEFAULT_KEYWORDS], isStringArray)
            .map((word) => word.trim())
            .filter((word) => word !== ""),
        extraLevels: pick(source.extraLevels, [] as string[], isStringArray)
            .map((word) => word.trim())
            .filter((word) => word !== ""),
        language,
        routePrefix,
        statePath: `${routePrefix}/state`,
    };
}
