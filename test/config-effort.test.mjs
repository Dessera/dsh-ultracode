/**
 * Tests for configuration resolution and reasoning-effort planning.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/host/config.ts";
import { EffortResolver, withEffortPlan } from "../src/host/effort.ts";

test("a missing configuration resolves to the documented defaults", () => {
    const config = resolveConfig(undefined);
    assert.equal(config.workflowToolName, "workflow");
    assert.equal(config.language, "zh");
});

test("a partial configuration keeps the remaining defaults", () => {
    const config = resolveConfig({
        workflowToolName: "workflows",
        language: "en",
    });
    assert.equal(config.workflowToolName, "workflows");
    assert.equal(config.language, "en");
});

test("only the exact English tag selects English, anything else stays Chinese", () => {
    assert.equal(resolveConfig({ language: "en" }).language, "en");
    assert.equal(resolveConfig({ language: "fr" }).language, "zh");
    assert.equal(resolveConfig({ language: 42 }).language, "zh");
});

test("a field of the wrong shape falls back to its own default", () => {
    const config = resolveConfig({ workflowToolName: 42 });
    assert.equal(config.workflowToolName, "workflow");
});

test("an empty tool name is rejected at load time", () => {
    assert.throws(
        () => resolveConfig({ workflowToolName: "  " }),
        /workflowToolName/u,
    );
});

test("the pinned effort is the last effort the route reports", async () => {
    const resolver = new EffortResolver(async () => ({
        reasoning: {
            efforts: [
                { id: "off", name: "Off" },
                { id: "low", name: "Low" },
                { id: "high", name: "High" },
                { id: "max", name: "Max" },
            ],
            defaultEffort: "high",
        },
    }));
    const plan = await resolver.pinFor({ provider: "p", model: "m" });
    assert.deepEqual(plan, { effort: "max" });
});

test("the pinned effort is the last declared non-off entry when the order runs strongest first", async () => {
    const resolver = new EffortResolver(async () => ({
        reasoning: {
            efforts: [
                { id: "max", name: "Max" },
                { id: "minimal", name: "Minimal" },
                { id: "off", name: "Off" },
            ],
        },
    }));
    assert.deepEqual(await resolver.pinFor({ provider: "p", model: "m" }), {
        effort: "minimal",
    });
});

test("a route that reports only off offers no pin", async () => {
    const resolver = new EffortResolver(async () => ({
        reasoning: { efforts: [{ id: "off", name: "Off" }] },
    }));
    assert.deepEqual(await resolver.pinFor({ provider: "p", model: "m" }), {});
});

test("a route whose lookup rejects offers no pin and does not throw", async () => {
    const resolver = new EffortResolver(async () => {
        throw new Error("unknown route");
    });
    assert.deepEqual(await resolver.pinFor({ provider: "p", model: "m" }), {});
});

test("a route that reports no reasoning metadata at all offers no pin", async () => {
    const resolver = new EffortResolver(async () => ({}));
    assert.deepEqual(await resolver.pinFor({ provider: "p", model: "m" }), {});
});

test("an explicit effort overrides the reported strongest one", async () => {
    const resolver = new EffortResolver(
        async () => ({
            reasoning: { efforts: [{ id: "high", name: "High" }] },
        }),
        "medium",
    );
    assert.deepEqual(await resolver.pinFor({ provider: "p", model: "m" }), {
        effort: "medium",
    });
});

test("the release plan restores the remembered effort", () => {
    const resolver = new EffortResolver(async () => ({}));
    assert.deepEqual(resolver.restorePlan({ effort: "low" }), {
        effort: "low",
    });
});

test("a session with no remembered effort clears the field on release", () => {
    const resolver = new EffortResolver(async () => ({}));
    assert.deepEqual(resolver.restorePlan(undefined), { effort: undefined });
    assert.deepEqual(resolver.restorePlan({ effort: "" }), {
        effort: undefined,
    });
});

test("applying a plan changes only the effort fields", () => {
    const config = {
        provider: "p",
        model: "m",
        maxTokens: 100,
        reasoningEffort: "low",
    };
    assert.deepEqual(withEffortPlan(config, { effort: "max" }), {
        provider: "p",
        model: "m",
        maxTokens: 100,
        reasoningEffort: "max",
    });
});

test("clearing the effort removes the field instead of nulling it", () => {
    const config = { provider: "p", model: "m", reasoningEffort: "max" };
    assert.deepEqual(withEffortPlan(config, { effort: undefined }), {
        provider: "p",
        model: "m",
    });
});

test("a release with nothing remembered clears the pinned effort", () => {
    const resolver = new EffortResolver(async () => ({}));
    const config = { provider: "p", model: "m", reasoningEffort: "max" };
    assert.deepEqual(withEffortPlan(config, resolver.restorePlan(undefined)), {
        provider: "p",
        model: "m",
    });
});

test("an unchanged plan keeps the original object", () => {
    const config = { provider: "p", model: "m", reasoningEffort: "max" };
    assert.equal(withEffortPlan(config, { effort: "max" }), config);
});

test("a plan never writes an adapter-default marker", () => {
    const config = {
        provider: "p",
        model: "m",
        reasoningEffort: "max",
        adapterDefaults: { maxTokens: 10 },
    };
    // The harness recomputes that marking from whether the caller supplied the
    // field, so an applied plan leaves any marking it finds exactly as it was.
    assert.deepEqual(withEffortPlan(config, { effort: "low" }), {
        provider: "p",
        model: "m",
        reasoningEffort: "low",
        adapterDefaults: { maxTokens: 10 },
    });
});
