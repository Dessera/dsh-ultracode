/**
 * Integration test for the host half.
 *
 * It drives the built plugin through a stubbed host context: the pre-step
 * waterfall, the request waterfall, a command invocation, and one route
 * request. That covers the wiring of all three channels — which nothing else
 * can check without booting a real host — while leaving the full acceptance
 * walkthrough to the real GUI.
 *
 * Every test here that needs a harness installation skips itself when none is
 * reachable, so the file never fails a checkout that has only this plugin.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    ULTRACODE_KEY,
    ULTRACODE_STATE_VERSION,
} from "../src/host/protocol.ts";
import { findPackage, loadHostBundle, root } from "./support/host-loader.mjs";

const bundlePath = join(root, "lib/index.js");
const available =
    existsSync(bundlePath) && findPackage("@deepseek-ai/dsh-llm") !== undefined;

/** Build one user-role message as the pre-step batch carries it. */
function humanMessage(text) {
    return {
        id: `m-${Math.random().toString(36).slice(2)}`,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
    };
}

/** Build a plugin-sourced message, as a synthetic context injection arrives. */
function syntheticMessage(text) {
    return {
        id: `m-${Math.random().toString(36).slice(2)}`,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "fixture" },
    };
}

/** A host context stub that records registrations and exposes one live agent. */
function makeContext(options = {}) {
    const listeners = new Map();
    const routes = [];
    const commands = [];
    /**
     * The projection units the plugin registered, keyed as the real registry keys
     * them. Answering `stateOf` from this map rather than from the last
     * registration is what makes a key mismatch a miss: the plugin registering one
     * key and reading another must not see a folded value, because the browser
     * would not see one either.
     */
    const projectors = new Map();
    /** The keys the plugin asked the registry to fold, in call order. */
    const queriedKeys = [];
    const session = {
        id: "sess-1",
        header: options.header ?? {},
        requestHeader: () =>
            options.requestHeader ?? {
                config: { provider: "p", model: "m", reasoningEffort: "low" },
                adapterDefaults: {},
            },
    };
    const agent = { session };
    /** The unit registered last, which is the only one this fixture serves. */
    const lastUnit = () => [...projectors.values()].at(-1);
    /**
     * Fold one log event through the registered unit, as the real registry does.
     * @param event - the session event to fold.
     */
    const feedFolded = (event) => {
        const unit = lastUnit();
        if (unit === undefined)
            throw new Error("no projection unit was registered");
        unit.state =
            unit.state === undefined
                ? unit.definition.apply(
                      unit.definition.init({ id: session.id }, 0),
                      event,
                  )
                : unit.definition.apply(unit.state, event);
    };
    return {
        listeners,
        routes,
        commands,
        agent,
        feedFolded,
        projectorCount: () => projectors.size,
        /** The definition the plugin registered, for contract assertions. */
        projection: () => lastUnit()?.definition,
        /** The keys the plugin read the fold under, in call order. */
        queriedKeys: () => [...queriedKeys],
        /** The state the registered unit currently folds, for assertions. */
        foldedState: () => lastUnit()?.state,
        ctx: {
            reflect: {
                get(key) {
                    if (key === "tools")
                        return (
                            options.tools ?? {
                                get: () => ({ name: "workflow" }),
                            }
                        );
                    if (key === "commands") {
                        return {
                            register(definition) {
                                commands.push(definition);
                                return () => {};
                            },
                        };
                    }
                    if (key === "llm") {
                        return {
                            resolveModelInfo: async () => ({
                                reasoning: {
                                    efforts: [
                                        { id: "off", name: "Off" },
                                        { id: "low", name: "Low" },
                                        { id: "high", name: "High" },
                                        { id: "max", name: "Max" },
                                    ],
                                    defaultEffort: "high",
                                },
                            }),
                        };
                    }
                    if (key === "agents")
                        return {
                            get: (id) => (id === "sess-1" ? agent : undefined),
                        };
                    if (key === "agentDefaultModel") {
                        const selection = options.defaultSelection;
                        if (selection === undefined) return undefined;
                        return { currentSelection: () => selection };
                    }
                    if (key === "sessionProjections") {
                        if (options.projections === false) return undefined;
                        return {
                            register(definition) {
                                projectors.set(definition.key, {
                                    definition,
                                    state: undefined,
                                });
                                return () => {
                                    projectors.delete(definition.key);
                                };
                            },
                            stateOf(_session, key) {
                                queriedKeys.push(key);
                                const unit = projectors.get(key);
                                if (
                                    unit === undefined ||
                                    unit.state === undefined
                                )
                                    return undefined;
                                // The real registry parses the view before handing it out.
                                return {
                                    wire: unit.definition.wire.viewSchema.parse(
                                        unit.definition.wire.view(unit.state),
                                    ),
                                };
                            },
                        };
                    }
                    if (key === "webServer") {
                        return {
                            register(route) {
                                routes.push(route);
                                return () => {};
                            },
                        };
                    }
                    return undefined;
                },
            },
            on(event, listener) {
                listeners.set(event, listener);
                return () => listeners.delete(event);
            },
            logger: { warn: () => {} },
        },
    };
}

/** Build a response stub that records what the route wrote. */
function makeResponse() {
    const state = { status: 0, body: "" };
    return {
        state,
        writeHead(status) {
            state.status = status;
        },
        end(body) {
            state.body = body ?? "";
        },
    };
}

/** Build a request stub carrying a JSON body. */
function makeRequest(method, url, body) {
    const listeners = new Map();
    const raw = body === undefined ? "" : JSON.stringify(body);
    return {
        method,
        url,
        on(event, listener) {
            listeners.set(event, listener);
            if (event === "data" && raw !== "") listener(raw);
            if (event === "end") listener();
        },
    };
}

/** Build a request stub whose body is exactly the text given, well-formed or not. */
function makeRawRequest(method, url, raw) {
    const listeners = new Map();
    return {
        method,
        url,
        on(event, listener) {
            listeners.set(event, listener);
            if (event === "data" && raw !== "") listener(raw);
            if (event === "end") listener();
        },
    };
}

test("a bundle that regains a bare import is refused with the specifier named", async () => {
    const staging = mkdtempSync(join(tmpdir(), "dsh-ultracode-bare-import-"));
    try {
        const staged = join(staging, "not-self-contained.mjs");
        writeFileSync(
            staged,
            'import { z } from "@deepseek-ai/dsh-llm";\nexport const zed = z;\n',
            "utf8",
        );
        await assert.rejects(
            loadHostBundle(staged),
            /imports "@deepseek-ai\/dsh-llm" by name/,
            "a bare import resolves only inside an installed profile, so the loader must name it",
        );
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
});

test(
    "the host half mounts its listeners, command, and route",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        const dispose = module.apply(harness.ctx, {});
        assert.equal(module.name, "dsh-ultracode");
        assert.deepEqual(module.inject, [
            "tools",
            "commands",
            "llm",
            "agents",
            "webServer",
        ]);
        assert.ok(
            harness.listeners.has("agent/pre-step"),
            "the pre-step listener must be mounted",
        );
        assert.ok(
            harness.listeners.has("agent/request"),
            "the request listener must be mounted",
        );
        assert.equal(harness.commands.length, 1);
        assert.equal(harness.commands[0].name, "ultracode");
        assert.equal(harness.routes.length, 1);
        assert.equal(harness.routes[0].path, "/dsh-ultracode/state");
        assert.equal(typeof dispose, "function");
        dispose();
        assert.equal(
            harness.listeners.size,
            0,
            "the disposer must release both listeners",
        );
    },
);

test(
    "an armed level injects one banner after the human message",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const preStep = harness.listeners.get("agent/pre-step");
        const request = harness.listeners.get("agent/request");

        // Select the ultra level through the route, which is what the control does.
        const route = harness.routes[0];
        const response = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "ultra",
            }),
            response,
        );
        assert.equal(response.state.status, 200);
        assert.equal(JSON.parse(response.state.body).level, "ultra");

        const synthetic = syntheticMessage("AGENTS.md contents follow");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            {
                agent: harness.agent,
                messages: [synthetic, human],
                turn: 1,
                step: 1,
            },
            async () => ({ kind: "enter", messages: [synthetic, human] }),
        );
        assert.equal(decision.messages.length, 3);
        assert.equal(
            decision.messages[1].id,
            human.id,
            "the banner goes directly after the human message",
        );
        const banner = decision.messages[2];
        assert.equal(banner.source.kind, "plugin");
        assert.equal(banner.source.plugin, "dsh-ultracode");
        assert.ok(banner.content[0].text.includes("Effort: ULTRA"));
        assert.ok(banner.content[0].text.includes("standing ultracode mode"));

        // A later step of the same turn must not stack a second banner.
        const again = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 2 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(again.messages.length, 1);

        // The request waterfall pins the strongest effort the route reports.
        const resolved = await request({ agent: harness.agent }, async () => ({
            provider: "p",
            model: "m",
            reasoningEffort: "low",
            maxTokens: 10,
        }));
        assert.equal(resolved.reasoningEffort, "max");
        assert.equal(resolved.maxTokens, 10);
    },
);

test(
    "a cleared turn is not injected again while the following turn still is",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const route = harness.routes[0];
        const armed = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "ultra",
            }),
            armed,
        );
        assert.equal(JSON.parse(armed.state.body).level, "ultra");

        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const enter = async () => ({ kind: "enter", messages: [human] });
        const first = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            enter,
        );
        assert.equal(
            first.messages.length,
            2,
            "the armed turn must be injected",
        );

        const cleared = harness.commands[0].handler({
            agent: harness.agent,
            rawInput: "clear",
            signal: undefined,
        });
        assert.equal(cleared.kind, "success");

        // The level is still ultra, so the clear covers this turn alone. A later step
        // of the same turn has to leave the batch untouched: the banner the turn
        // already carries is part of the conversation from here on, and injecting
        // again would put a second copy of it in front of the model.
        const laterStep = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 2 },
            enter,
        );
        assert.equal(
            laterStep.messages.length,
            1,
            "a cleared turn must not be injected a second time",
        );

        // The next turn claims its own injection, so clearing one turn is not the
        // same request as turning the level off.
        const nextTurn = await preStep(
            { agent: harness.agent, messages: [human], turn: 2, step: 1 },
            enter,
        );
        assert.equal(
            nextTurn.messages.length,
            2,
            "clearing a turn must leave the level in effect",
        );
    },
);

test(
    "a trigger word inside a substantive message arms the turn through the keyword path",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, { keywordTrigger: true });
        const route = harness.routes[0];
        const armed = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "high",
            }),
            armed,
        );
        assert.equal(JSON.parse(armed.state.body).level, "high");

        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("用 ultracode 跑一下这个模块的通知逻辑重构");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            decision.messages.length,
            2,
            "the trigger word must arm this turn",
        );
        const banner = decision.messages[1];
        const text = banner.content[0].text;
        assert.ok(
            text.includes("you typed the ultracode trigger word"),
            `the banner must name the keyword path: ${text}`,
        );
        assert.equal(
            text.includes("standing ultracode mode"),
            false,
            "the escape sentence belongs to the standing-level path, not to the trigger word",
        );
        assert.ok(
            banner.source.summary.endsWith("(keyword)"),
            `the summary must record the keyword path: ${banner.source.summary}`,
        );
    },
);

test(
    "an unarmed session is never injected and never pinned",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const preStep = harness.listeners.get("agent/pre-step");
        const request = harness.listeners.get("agent/request");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(decision.messages.length, 1);
        const resolved = await request({ agent: harness.agent }, async () => ({
            provider: "p",
            model: "m",
            reasoningEffort: "low",
        }));
        assert.equal(resolved.reasoningEffort, "low");
    },
);

test(
    "a delegated child session is skipped even while armed",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext({
            header: { origin: "subagent", delegationDepth: 1 },
        });
        module.apply(harness.ctx, {});
        const route = harness.routes[0];
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "high",
            }),
            makeResponse(),
        );
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(decision.messages.length, 1);
    },
);

test(
    "the route refuses to arm a session that cannot see the workflow tool",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext({ tools: { get: () => undefined } });
        module.apply(harness.ctx, {});
        const response = makeResponse();
        await harness.routes[0].handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "high",
            }),
            response,
        );
        assert.equal(response.state.status, 400);
        assert.equal(JSON.parse(response.state.body).error, "unavailable");
    },
);

test(
    "the route answers a session that is not live with 404 on both methods",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const route = harness.routes[0];

        const read = makeResponse();
        await route.handler(
            makeRequest("GET", "/dsh-ultracode/state?sessionId=ghost"),
            read,
        );
        assert.equal(read.state.status, 404);
        assert.deepEqual(JSON.parse(read.state.body), {
            error: "session-not-live",
            sessionId: "ghost",
        });

        const write = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "ghost",
                action: "set-level",
                level: "high",
            }),
            write,
        );
        assert.equal(write.state.status, 404);
        assert.equal(JSON.parse(write.state.body).error, "session-not-live");

        // A request that names no session at all gets the same answer, with a null id
        // standing in for the one that is missing.
        const bare = makeResponse();
        await route.handler(makeRequest("GET", "/dsh-ultracode/state"), bare);
        assert.equal(bare.state.status, 404);
        assert.equal(JSON.parse(bare.state.body).sessionId, null);
    },
);

test(
    "the route refuses a method it does not serve",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const response = makeResponse();
        await harness.routes[0].handler(
            makeRequest("PUT", "/dsh-ultracode/state", { sessionId: "sess-1" }),
            response,
        );
        assert.equal(response.state.status, 405);
        assert.deepEqual(JSON.parse(response.state.body), {
            error: "method-not-allowed",
        });
    },
);

test(
    "the route refuses a level outside the vocabulary",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const response = makeResponse();
        await harness.routes[0].handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "turbo",
            }),
            response,
        );
        assert.equal(response.state.status, 400);
        const body = JSON.parse(response.state.body);
        assert.equal(body.error, "invalid-level");
        assert.ok(
            body.message.includes("turbo"),
            `the refusal must name the word it did not know: ${body.message}`,
        );
    },
);

test(
    "the route reports a body it cannot read as an internal failure",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const route = harness.routes[0];

        // A body that never parses fails inside the route, which answers as it does
        // for any other internal error rather than letting the connection hang.
        const truncated = makeResponse();
        await route.handler(
            makeRawRequest("POST", "/dsh-ultracode/state", '{"sessionId":'),
            truncated,
        );
        assert.equal(truncated.state.status, 500);
        assert.deepEqual(JSON.parse(truncated.state.body), {
            error: "internal",
        });

        // So does JSON that parses to a value the control cannot read fields from.
        const array = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", ["sess-1"]),
            array,
        );
        assert.equal(array.state.status, 500);
        assert.equal(JSON.parse(array.state.body).error, "internal");
    },
);

test(
    "an action outside the control vocabulary falls back to the status answer",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const response = makeResponse();
        await harness.routes[0].handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "rotate-somehow",
            }),
            response,
        );
        assert.equal(response.state.status, 200);
        const body = JSON.parse(response.state.body);
        assert.equal(
            body.level,
            "off",
            "an unknown action must not change the level",
        );
        assert.ok(
            body.notice.includes("档位：关闭"),
            `the answer must be the status notice: ${body.notice}`,
        );
    },
);

test(
    "the command drives the same level changes as the control route",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const command = harness.commands[0];
        const high = command.handler({
            agent: harness.agent,
            rawInput: " high",
        });
        assert.equal(high.kind, "success");
        assert.ok(high.text.includes("高阶"));
        const unknown = command.handler({
            agent: harness.agent,
            rawInput: " turbo",
        });
        assert.equal(unknown.kind, "error");
        const status = command.handler({
            agent: harness.agent,
            rawInput: " status",
        });
        assert.equal(status.kind, "success");
        assert.ok(status.text.includes("高阶"));
        const cleared = command.handler({
            agent: harness.agent,
            rawInput: " clear",
        });
        assert.equal(cleared.kind, "success");
        const off = command.handler({ agent: harness.agent, rawInput: " off" });
        assert.equal(off.kind, "success");
        assert.equal(
            command
                .handler({ agent: harness.agent, rawInput: " status" })
                .text.includes("关闭"),
            true,
        );
    },
);

test(
    "an argument-less command rotates through the levels and wraps",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const command = harness.commands[0];

        // The plain `/ultracode` form asks for the next level rather than naming one,
        // so the answer has to be the level the rotation actually reached.
        const first = command.handler({ agent: harness.agent, rawInput: "" });
        assert.equal(first.kind, "success");
        assert.ok(
            first.text.includes("高阶"),
            `the first rotation must land on high: ${first.text}`,
        );
        assert.ok(
            command
                .handler({ agent: harness.agent, rawInput: " status" })
                .text.includes("档位：高阶"),
        );

        // Trailing whitespace is the same argument-less form, not an unknown word.
        const second = command.handler({
            agent: harness.agent,
            rawInput: "   ",
        });
        assert.equal(second.kind, "success");
        assert.ok(
            second.text.includes("极致"),
            `the second rotation must land on ultra: ${second.text}`,
        );

        const third = command.handler({ agent: harness.agent, rawInput: "" });
        assert.ok(
            third.text.includes("关闭"),
            `the third rotation must wrap to off: ${third.text}`,
        );

        const fourth = command.handler({ agent: harness.agent, rawInput: "" });
        assert.ok(
            fourth.text.includes("高阶"),
            `the rotation must start over from off: ${fourth.text}`,
        );
    },
);

test(
    "a pin taken on a fresh session releases to the deployment default",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        // No request header yet, which is the state of a session that has not sent
        // anything; the deployment default is the only record of the effort in force.
        const harness = makeContext({
            requestHeader: undefined,
            defaultSelection: {
                provider: "p",
                model: "m",
                reasoningEffort: "high",
            },
        });
        harness.agent.session.requestHeader = () => undefined;
        module.apply(harness.ctx, {});
        const route = harness.routes[0];
        const request = harness.listeners.get("agent/request");

        const armed = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "high",
            }),
            armed,
        );
        assert.equal(JSON.parse(armed.state.body).level, "high");

        // While armed, the strongest effort the route reports is requested.
        const pinned = await request({ agent: harness.agent }, async () => ({
            provider: "p",
            model: "m",
        }));
        assert.equal(pinned.reasoningEffort, "max");

        const released = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "off",
            }),
            released,
        );
        assert.equal(JSON.parse(released.state.body).level, "off");

        // Releasing restores the deployment default rather than clearing the field.
        const restored = await request({ agent: harness.agent }, async () => ({
            provider: "p",
            model: "m",
            reasoningEffort: "max",
        }));
        assert.equal(restored.reasoningEffort, "high");
        assert.equal("adapterDefaults" in restored, false);
    },
);

test(
    "a pin taken after a request releases to the effort that request recorded",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext({
            requestHeader: {
                config: { provider: "p", model: "m", reasoningEffort: "low" },
                adapterDefaults: {},
            },
            defaultSelection: {
                provider: "p",
                model: "m",
                reasoningEffort: "high",
            },
        });
        module.apply(harness.ctx, {});
        const route = harness.routes[0];
        const request = harness.listeners.get("agent/request");

        const armed = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "ultra",
            }),
            armed,
        );
        const pinned = await request({ agent: harness.agent }, async () => ({
            provider: "p",
            model: "m",
            reasoningEffort: "low",
        }));
        assert.equal(pinned.reasoningEffort, "max");

        const released = makeResponse();
        await route.handler(
            makeRequest("POST", "/dsh-ultracode/state", {
                sessionId: "sess-1",
                action: "set-level",
                level: "off",
            }),
            released,
        );
        // The logged header wins over the deployment default: it is what this
        // session was actually running.
        const restored = await request({ agent: harness.agent }, async () => ({
            provider: "p",
            model: "m",
            reasoningEffort: "max",
        }));
        assert.equal(restored.reasoningEffort, "low");
    },
);

test(
    "the registered projection carries the browser key, its state version, and the fold",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        assert.equal(
            harness.projectorCount(),
            1,
            "the plugin must publish exactly one projection",
        );
        const definition = harness.projection();
        // The key and the state version are the two halves of the projection contract
        // with the browser: the state is published under the key the client reads, and
        // a stored state is restored through the version.
        assert.equal(
            definition.key,
            ULTRACODE_KEY,
            "the browser reads the state under this key",
        );
        assert.equal(
            definition.stateVersion,
            ULTRACODE_STATE_VERSION,
            "a checkpoint is restored through this version",
        );
        assert.equal(
            harness.foldedState(),
            undefined,
            "nothing is folded before the first event",
        );

        // Reading the state is how the plugin learns what the log already records, so
        // it has to ask under the key it registered.
        const view = makeResponse();
        await harness.routes[0].handler(
            makeRequest("GET", "/dsh-ultracode/state?sessionId=sess-1"),
            view,
        );
        assert.deepEqual(
            [...new Set(harness.queriedKeys())],
            [ULTRACODE_KEY],
            "the fold must be read under the registered key",
        );

        // The fold is what the control displays: these two events are the lifecycle a
        // level command leaves in the log.
        harness.feedFolded({
            type: "command/run",
            seq: 1,
            data: { commandId: "c1", name: "ultracode", args: "ultra" },
        });
        harness.feedFolded({
            type: "command/done",
            seq: 2,
            data: { commandId: "c1", kind: "success" },
        });
        const folded = harness.foldedState();
        assert.equal(
            folded.wire.level,
            "ultra",
            "the folded level must be the one the command named",
        );
        assert.equal(
            folded.wire.armedTurn,
            false,
            "no banner has entered the log yet",
        );
        assert.equal(
            definition.wire.view(folded),
            folded.wire,
            "the unit publishes exactly the wire the fold built",
        );
        assert.equal(
            harness.ctx.reflect.get("sessionProjections") !== undefined,
            true,
        );
    },
);

test(
    "a host without a projection registry keeps the command channel working",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext({ projections: false });
        const dispose = module.apply(harness.ctx, {});
        assert.equal(harness.projectorCount(), 0);
        const command = harness.commands[0];
        const result = command.handler({
            agent: harness.agent,
            rawInput: "ultra",
            signal: undefined,
        });
        assert.equal(result.kind, "success");
        // The banner injection reads the mirror, which the adoption path seeded from
        // the same command, so the feature works with no projection at all.
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            decision.messages.length,
            2,
            "the banner must still be injected",
        );
        assert.ok(
            decision.messages[1].content[0].text.includes("Effort: ULTRA"),
        );
        assert.equal(typeof dispose, "function");
    },
);

test(
    "a new host process restores the level the log already records",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        // The log is the only thing that survives a restart, so it is folded first and
        // the host is started against it afterwards.
        const harness = makeContext();
        module.apply(harness.ctx, {});
        harness.feedFolded({ type: "turn/start", seq: 1, data: { turn: 3 } });
        harness.feedFolded({
            type: "command/run",
            seq: 2,
            data: { commandId: "c1", name: "ultracode", args: "ultra" },
        });
        harness.feedFolded({
            type: "command/done",
            seq: 3,
            data: { commandId: "c1", kind: "success" },
        });
        harness.feedFolded({
            type: "user/message",
            seq: 4,
            data: {
                source: {
                    kind: "plugin",
                    plugin: "dsh-ultracode",
                    form: "notice",
                    summary: "ultracode ultra armed this turn (level)",
                },
            },
        });

        const route = harness.routes[0];
        const view = makeResponse();
        await route.handler(
            makeRequest("GET", "/dsh-ultracode/state?sessionId=sess-1"),
            view,
        );
        const body = JSON.parse(view.state.body);
        // The mirror starts at off in a fresh process; adoption is what makes the
        // reported level and the injection follow the log instead.
        assert.equal(body.level, "ultra");
        assert.equal(body.armedTurn, true);

        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 4, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            decision.messages.length,
            2,
            "a restored level must still arm the turn",
        );

        // The status answer reports the fold, which is what the control displays.
        const status = harness.commands[0].handler({
            agent: harness.agent,
            rawInput: "status",
            signal: undefined,
        });
        assert.equal(status.kind, "success");
        assert.ok(
            status.text.includes("极致"),
            `the status answer must name the folded level: ${status.text}`,
        );
    },
);

test(
    "with nothing in the log the reported level is off and the turn is not armed",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        harness.feedFolded({ type: "turn/start", seq: 1, data: { turn: 1 } });
        const route = harness.routes[0];
        const view = makeResponse();
        await route.handler(
            makeRequest("GET", "/dsh-ultracode/state?sessionId=sess-1"),
            view,
        );
        const body = JSON.parse(view.state.body);
        assert.equal(body.level, "off");
        assert.equal(body.armedTurn, false);
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            decision.messages.length,
            1,
            "an unarmed session must not be injected",
        );
    },
);
