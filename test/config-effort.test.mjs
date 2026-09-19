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
    assert.equal(config.keywordTrigger, false);
    assert.deepEqual(config.keywords, ["ultracode"]);
    assert.equal(config.language, "zh");
    assert.equal(config.statePath, "/dsh-ultracode/state");
});

test("a partial configuration keeps the remaining defaults", () => {
    const config = resolveConfig({
        workflowToolName: "workflows",
        keywordTrigger: true,
    });
    assert.equal(config.workflowToolName, "workflows");
    assert.equal(config.keywordTrigger, true);
    assert.deepEqual(config.keywords, ["ultracode"]);
});

test("blank keywords and aliases are dropped, and the route prefix is normalized", () => {
    const config = resolveConfig({
        keywords: ["", "  ", "go"],
        extraLevels: ["", "  ", " max "],
        routePrefix: "uc",
    });
    assert.deepEqual(config.keywords, ["go"]);
    assert.deepEqual(config.extraLevels, ["max"]);
    assert.equal(config.routePrefix, "/uc");
    assert.equal(config.statePath, "/uc/state");
});

test("a blank route prefix falls back to the default instead of an empty path", () => {
    const config = resolveConfig({ routePrefix: "  " });
    assert.equal(config.routePrefix, "/dsh-ultracode");
    assert.equal(config.statePath, "/dsh-ultracode/state");
});

test("only the exact English tag selects English, anything else stays Chinese", () => {
    assert.equal(resolveConfig({ language: "en" }).language, "en");
    assert.equal(resolveConfig({ language: "fr" }).language, "zh");
    assert.equal(resolveConfig({ language: 42 }).language, "zh");
});

test("a field of the wrong shape falls back to its own default", () => {
    const config = resolveConfig({
        keywords: "ultracode",
        keywordTrigger: "always",
    });
    assert.deepEqual(config.keywords, ["ultracode"]);
    assert.equal(config.keywordTrigger, false);
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
    assert.deepEqual(plan, { effort: "max", adapterDefault: false });
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
        adapterDefault: false,
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
        adapterDefault: false,
    });
});

test("the release plan restores the remembered effort with its adapter flag", () => {
    const resolver = new EffortResolver(async () => ({}));
    assert.deepEqual(
        resolver.restorePlan({ effort: "low", adapterDefault: true }),
        {
            effort: "low",
            adapterDefault: true,
        },
    );
});

test("a session with no remembered effort clears the field on release", () => {
    const resolver = new EffortResolver(async () => ({}));
    assert.deepEqual(resolver.restorePlan(undefined), { effort: undefined });
    assert.deepEqual(
        resolver.restorePlan({ effort: "", adapterDefault: false }),
        { effort: undefined },
    );
});

test("a caller-proposed release carries no adapter-default key", () => {
    const resolver = new EffortResolver(async () => ({}));
    // An explicit `false` would add a header field that a session running
    // without this plugin would not have, so the key must be absent instead.
    const plan = resolver.restorePlan({
        effort: "high",
        adapterDefault: false,
    });
    assert.deepEqual(plan, { effort: "high" });
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

test("an adapter-default release writes the flag and keeps the value", () => {
    const config = {
        provider: "p",
        model: "m",
        reasoningEffort: "max",
        adapterDefaults: { maxTokens: 10 },
    };
    assert.deepEqual(
        withEffortPlan(config, { effort: "low", adapterDefault: true }),
        {
            provider: "p",
            model: "m",
            reasoningEffort: "low",
            adapterDefaults: { maxTokens: 10, reasoningEffort: true },
        },
    );
});
