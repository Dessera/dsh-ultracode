/**
 * Loader-facing configuration schema.
 *
 * The schema is what a deployment's patch row is validated against, and it is
 * kept apart from `config.ts` so that resolving a configuration in a unit test
 * pulls in no host dependency. Both modules apply the same defaults; a default
 * changed in one must be changed in the other, and the test suite pins the
 * values they share. Validation is pinned the same way: a value the resolver
 * treats as fatal has to be refused here as well, or a deployment the loader
 * accepts fails when the plugin starts instead.
 *
 * @module @dessera/dsh-ultracode/schema
 */
import z from "@deepseek-ai/schemastery";

import {
    DEFAULT_KEYWORDS,
    DEFAULT_ROUTE_PREFIX,
    DEFAULT_TOOL_NAME,
} from "./config.ts";

/** Configuration schema registered with the loader under the `Config` export. */
export const Config = z.object({
    workflowToolName: z
        .string()
        .pattern(/\S/u)
        .default(DEFAULT_TOOL_NAME)
        .description(
            "Name under which this deployment registers the workflow tool; it cannot be blank.",
        ),
    keywordTrigger: z
        .boolean()
        .default(false)
        .description(
            "Arm a turn when its message contains one of the trigger words.",
        ),
    keywords: z
        .array(z.string())
        .default([...DEFAULT_KEYWORDS])
        .description("Trigger words matched while the keyword path is armed."),
    extraLevels: z
        .array(z.string())
        .default([])
        .description(
            "Extra level names /ultracode accepts as aliases for the pushed level.",
        ),
    language: z
        .union([z.const("zh"), z.const("en")])
        .default("zh")
        .description("Language of the notices the plugin prints to the user."),
    routePrefix: z
        .string()
        .default(DEFAULT_ROUTE_PREFIX)
        .description(
            "Path prefix of the host route serving the control state.",
        ),
});
