/**
 * Tests for the deployment schema's agreement with the resolver.
 *
 * `schema.ts` and `config.ts` each carry the same defaults: the loader
 * validates a deployment's patch row against the schema, while the plugin runs
 * on what the resolver returns. A default changed in one file alone therefore
 * produces a deployment whose validated value and live value disagree, and no
 * other test file imports the schema at all, so the two halves could drift
 * apart under a fully green suite. This file pins them to each other.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/host/config.ts";
import { Config } from "../src/host/schema.ts";

/**
 * The configuration fields the schema and the resolver share.
 *
 * Derived from the resolver rather than listed here, so a field added to one
 * half without the other shows up as a mismatch instead of passing unseen.
 * @returns the shared field names.
 */
function sharedFields() {
    return Object.keys(resolveConfig(undefined));
}

test("the schema applies the same defaults a missing configuration resolves to", () => {
    const parsed = Config({});
    const resolved = resolveConfig(undefined);
    const fields = sharedFields();

    assert.deepEqual(Object.keys(parsed).sort(), [...fields].sort());
    for (const field of fields) {
        assert.deepEqual(parsed[field], resolved[field], `default of ${field}`);
    }
});

test("a partial configuration keeps the same remaining defaults on both sides", () => {
    const partial = { language: "en" };
    const parsed = Config(partial);
    const resolved = resolveConfig(partial);

    assert.equal(parsed.language, "en");
    assert.equal(resolved.language, "en");
    for (const field of sharedFields()) {
        if (field === "language") continue;
        assert.deepEqual(
            parsed[field],
            resolved[field],
            `remaining default of ${field}`,
        );
    }
});

test("a blank tool name is refused by the schema and by the resolver alike", () => {
    // The loader validates a deployment row against the schema, and the plugin then
    // runs on what the resolver returns. A blank name the schema accepted would
    // pass validation and throw while the plugin was starting, which is the one
    // disagreement this pair must not have.
    assert.throws(() => Config({ workflowToolName: "  " }), /regexp/u);
    assert.throws(
        () => resolveConfig({ workflowToolName: "  " }),
        /workflowToolName/u,
    );
    // The pattern looks for one non-blank character rather than requiring a name
    // without any space in it, so a name that merely contains one stays usable.
    assert.equal(
        Config({ workflowToolName: "my tool" }).workflowToolName,
        "my tool",
    );
});
